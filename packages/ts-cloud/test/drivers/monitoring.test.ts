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

import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('reports each filesystem, detects missing mounts, and retries failed notifications without repeat spam', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ts-cloud-metrics-'))
  try {
    const bin = join(directory, 'bin'); mkdirSync(bin)
    const fixture = (name: string, script: string): void => writeFileSync(join(bin, name), `#!/bin/bash\n${script}\n`, { mode: 0o755 })
    fixture('cut', 'case "$*" in *loadavg*) echo 0;; *uptime*) echo 1000;; *) /usr/bin/cut "$@";; esac')
    fixture('free', 'printf "Mem: 1000 200 100 0 0 800\\nSwap: 100 0 100\\n"')
    fixture('nproc', 'echo 8')
    fixture('mountpoint', '[ "${MISSING_MOUNT:-0}" != 1 ] || [ "${@: -1}" != /mnt/deployments ]')
    fixture('df', 'PCT=30; if [ "${@: -1}" = /mnt/deployments ]; then PCT=${VOLUME_USAGE:-94}; fi; printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/test 1000 300 700 %s%% %s\\n" "$PCT" "${@: -1}"')
    const notifier = join(directory, 'notify')
    writeFileSync(notifier, '#!/bin/bash\nprintf "%s\\n" "$1" >> "$NOTIFICATION_LOG"\nexit "${NOTIFY_EXIT:-0}"\n', { mode: 0o755 })
    const commands = buildMonitoringScript({ filesystems: ['/', { path: '/mnt/deployments', requiredMount: true }] })
    let body = commands.slice(commands.indexOf("cat > /usr/local/bin/ts-cloud-metrics.sh <<'TS_CLOUD_METRICS_EOF'") + 1, commands.indexOf('TS_CLOUD_METRICS_EOF')).join('\n')
    body = body.replaceAll('/var/lib/ts-cloud', directory).replaceAll('/usr/local/bin/ts-cloud-notify', notifier)
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NOTIFICATION_LOG: join(directory, 'notifications') }
    const execute = (extra: Record<string, string> = {}): void => {
      const result = Bun.spawnSync(['bash', '-c', body], { env: { ...env, ...extra } })
      expect(result.exitCode).toBe(0)
      expect(() => JSON.parse(readFileSync(join(directory, 'metrics.json'), 'utf8'))).not.toThrow()
    }
    execute({ NOTIFY_EXIT: '22' })
    expect(existsSync(join(directory, 'alert-state'))).toBe(false)
    execute(); execute()
    const report = JSON.parse(readFileSync(join(directory, 'metrics.json'), 'utf8'))
    expect(report.diskUsedPct).toBe(94)
    expect(report.disks.map((disk: any) => disk.usedPercent)).toEqual([30, 94])
    expect(readFileSync(join(directory, 'notifications'), 'utf8').split('\n').filter(Boolean)).toHaveLength(2)
    execute({ MISSING_MOUNT: '1' })
    const missing = JSON.parse(readFileSync(join(directory, 'metrics.json'), 'utf8'))
    expect(missing.disks[1]).toEqual({ path: '/mnt/deployments', usedPercent: null, mounted: false })
    execute({ VOLUME_USAGE: '60' })
    expect(readFileSync(join(directory, 'alert-state'), 'utf8').trim()).toBe('ok')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
