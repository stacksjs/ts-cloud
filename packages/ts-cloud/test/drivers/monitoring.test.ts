import { describe, expect, it } from 'bun:test'
import { buildMonitoringScript, METRICS_PATH } from '../../src/drivers/shared/monitoring'

describe('buildMonitoringScript', () => {
  it('returns nothing when disabled (false or { enabled: false })', () => {
    expect(buildMonitoringScript(false)).toEqual([])
    expect(buildMonitoringScript({ enabled: false })).toEqual([])
  })

  it('installs the collector + minute timer when enabled', () => {
    const s = buildMonitoringScript(true).join('\n')
    expect(s).toContain('apt-get install -y -qq sysstat')
    expect(s).toContain('systemctl enable --now sysstat.service')
    expect(s).toContain('/usr/local/bin/ts-cloud-metrics.sh')
    expect((s.match(/free -m/g) ?? [])).toHaveLength(1)
    // Written atomically (temp + rename) so readers never see a partial file.
    expect(s).toContain(`cat > ${METRICS_PATH}.tmp`)
    expect(s).toContain(`mv -f ${METRICS_PATH}.tmp ${METRICS_PATH}`)
    // Numeric fields are defaulted so a missing reading can't emit invalid JSON.
    expect(s).toContain('LOAD=${LOAD:-0}')
    expect(s).toContain('DISK_PCT=${DISK_PCT:-0}')
    expect(s).toContain('/etc/systemd/system/ts-cloud-metrics.timer')
    expect(s).toContain('OnCalendar=*-*-* *:*:00')
    expect(s).toContain('Persistent=true')
    expect(s).toContain('systemctl enable --now ts-cloud-metrics.timer')
    expect(s).toContain('systemctl start ts-cloud-metrics.service')
  })

  it('collects network throughput, swap, uptime, and per-service health', () => {
    const s = buildMonitoringScript(true).join('\n')
    expect(s).toContain('/proc/net/dev')
    expect(s).toContain('"network":{"rxBytes":$RX_BYTES,"txBytes":$TX_BYTES,')
    expect(s).toContain('SWAP_USED')
    expect(s).toContain('UPTIME_SEC')
    // TCP probes for the standard services.
    expect(s).toContain('exec 3<>/dev/tcp/127.0.0.1/$1')
    expect(s).toContain('SVC_NGINX=$(probe 80)')
    expect(s).toContain('SVC_MYSQL=$(probe 3306)')
    expect(s).toContain('SVC_HTTPS=$(probe 443)')
    expect(s).toContain('SVC_TYPESENSE=$(probe 8108)')
    expect(s).toContain('SVC_SMTP=$(probe 25)')
    expect(s).toContain('"nginx":"$SVC_NGINX"')
  })

  it('uses default alert thresholds and fires the notifier on transition', () => {
    const s = buildMonitoringScript(true).join('\n')
    expect(s).toContain('-v t=2 ') // cpuLoadPerCore default 2 in the awk check
    expect(s).toContain('-ge 90') // mem + disk default 90
    expect(s).toContain('/usr/local/bin/ts-cloud-notify')
    expect(s).toContain('resource alert')
    expect(s).toContain('back to normal')
  })

  it('honours custom alert thresholds', () => {
    const s = buildMonitoringScript({ alerts: { cpuLoadPerCore: 4, memPercent: 80, diskPercent: 75 } }).join('\n')
    expect(s).toContain('-v t=4 ')
    expect(s).toContain('-ge 80')
    expect(s).toContain('-ge 75')
  })
})

describe('bandwidth accounting', () => {
  it('turns since-boot counters into rates and period totals', () => {
    const s = buildMonitoringScript(true).join('\n')
    // Previous sample is persisted, so the collector can compute a delta at all.
    expect(s).toContain('/var/lib/ts-cloud/bandwidth-state')
    expect(s).toContain('PREV_EPOCH=$NOW_EPOCH')
    expect(s).toContain('DELTA_RX=$(( RX_BYTES - PREV_RX ))')
    expect(s).toContain('RX_RATE=$(( DELTA_RX / ELAPSED ))')
    // Day and month buckets, emitted alongside the raw counters.
    expect(s).toContain('MONTH_RX=$(( MONTH_RX + DELTA_RX ))')
    expect(s).toContain('"rxBytesPerSec":$RX_RATE')
    expect(s).toContain('"rxBytesMonth":$MONTH_RX')
    expect(s).toContain('"monthKey":"$MONTH_KEY"')
  })

  it('treats a reboot or first run as no traffic rather than a huge burst', () => {
    const s = buildMonitoringScript(true).join('\n')
    // A counter that went backwards means the interface counters reset; naive
    // subtraction would add a bogus multi-TB spike to the month on every reboot.
    expect(s).toContain('[ "$RX_BYTES" -lt "$PREV_RX" ]')
    expect(s).toContain('[ "$PREV_EPOCH" -le 0 ]')
    expect(s).toContain('DELTA_RX=0; DELTA_TX=0; ELAPSED=0')
  })

  it('rolls the day and month buckets before accumulating into them', () => {
    const s = buildMonitoringScript(true).join('\n')
    const reset = s.indexOf('if [ "$MONTH_KEY" != "$MONTH" ]')
    const accumulate = s.indexOf('MONTH_RX=$(( MONTH_RX + DELTA_RX ))')
    expect(reset).toBeGreaterThan(-1)
    expect(accumulate).toBeGreaterThan(reset)
  })

  it('omits budget alerting when no allowance is configured', () => {
    const s = buildMonitoringScript(true).join('\n')
    expect(s).toContain('"budgetBytes":0')
    expect(s).not.toContain('bandwidth-alert-state')
  })

  it('alerts on its own state once a configured allowance is mostly spent', () => {
    const s = buildMonitoringScript({ alerts: { bandwidthTb: 5 } }).join('\n')
    // Decimal TB: providers quote and bill "5.0 TB" as 5 * 1000^4.
    expect(s).toContain('"budgetBytes":5000000000000')
    expect(s).toContain('BW_PCT=$(( BW_TOTAL * 100 / 5000000000000 ))')
    expect(s).toContain('if [ "$BW_PCT" -ge 80 ]; then')
    // Separate state file, so a load spike clearing the resource alert cannot
    // also clear (and later re-fire) the bandwidth alert.
    expect(s).toContain('/var/lib/ts-cloud/bandwidth-alert-state')
    expect(s).toContain('monthly allowance')
  })

  it('honours a custom bandwidth alert threshold', () => {
    const s = buildMonitoringScript({ alerts: { bandwidthTb: 20, bandwidthPercent: 60 } }).join('\n')
    expect(s).toContain('if [ "$BW_PCT" -ge 60 ]; then')
    expect(s).toContain('"budgetBytes":20000000000000')
  })
})
