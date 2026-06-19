import { describe, expect, it } from 'bun:test'
import { buildMonitoringScript, METRICS_PATH } from '../../src/drivers/shared/monitoring'

describe('buildMonitoringScript', () => {
  it('returns nothing when disabled (false or { enabled: false })', () => {
    expect(buildMonitoringScript(false)).toEqual([])
    expect(buildMonitoringScript({ enabled: false })).toEqual([])
  })

  it('installs the collector + minute timer when enabled', () => {
    const s = buildMonitoringScript(true).join('\n')
    expect(s).toContain('/usr/local/bin/ts-cloud-metrics.sh')
    // Written atomically (temp + rename) so readers never see a partial file.
    expect(s).toContain(`cat > ${METRICS_PATH}.tmp`)
    expect(s).toContain(`mv -f ${METRICS_PATH}.tmp ${METRICS_PATH}`)
    // Numeric fields are defaulted so a missing reading can't emit invalid JSON.
    expect(s).toContain('LOAD=${LOAD:-0}')
    expect(s).toContain('DISK_PCT=${DISK_PCT:-0}')
    expect(s).toContain('/etc/systemd/system/ts-cloud-metrics.timer')
    expect(s).toContain('OnUnitActiveSec=60')
    expect(s).toContain('systemctl enable ts-cloud-metrics.timer')
  })

  it('collects network throughput, swap, uptime, and per-service health', () => {
    const s = buildMonitoringScript(true).join('\n')
    expect(s).toContain('/proc/net/dev')
    expect(s).toContain('"network":{"rxBytes":$RX_BYTES,"txBytes":$TX_BYTES}')
    expect(s).toContain('SWAP_USED')
    expect(s).toContain('UPTIME_SEC')
    // TCP probes for the standard services.
    expect(s).toContain('exec 3<>/dev/tcp/127.0.0.1/$1')
    expect(s).toContain('SVC_NGINX=$(probe 80)')
    expect(s).toContain('SVC_MYSQL=$(probe 3306)')
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
