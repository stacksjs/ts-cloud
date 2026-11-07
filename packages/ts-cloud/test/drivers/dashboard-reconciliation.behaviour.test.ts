import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManagementDashboardServiceReconciliationScript } from '../../src/drivers/shared/compute-deploy'

// Execute the generated shell against real disposable files. Only the host
// paths and systemd command are substituted; no live service is touched.
for (const serverOwner of [false, true]) {
  test(`dashboard reconciliation preserves desired service families (server owner: ${serverOwner})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-units-'))
    const units = join(root, 'units'), bin = join(root, 'bin'), log = join(root, 'systemctl.log')
    const desired = 'stacks-dashboard-stacksjs-com', old = 'stacks-dashboard-old-stacksjs-com', foreign = 'hq-dashboard-hq-training'
    const family = (base: string) => [`${base}.service`, `${base}@.service`, `${base}@abc123.service`, `${base}-liveness.service`, `${base}-liveness.timer`]
    const preserved = [...family(desired), ...family('stacks-dashboard-live-liveness'), 'reviewos-api.service', 'reviewos-api.timer', ...(serverOwner ? [] : family(foreign))]
    const removed = [...family(old), 'stacks-dashboard-orphan-liveness.timer', ...(serverOwner ? family(foreign) : [])]
    try {
      for (const path of [units, bin, join(root, 'routes'), join(root, 'run'), join(root, 'data')]) mkdirSync(path)
      for (const name of new Set([...preserved, ...removed])) writeFileSync(join(units, name), `Original unit ${name}\n`)
      writeFileSync(join(root, 'data', 'original.sqlite'), 'Original persistent dashboard data')
      writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$DASHBOARD_TEST_LOG"
if [ "$1" = list-units ]; then
  for arg; do pattern="$arg"; done
  for unit in '${old}@runtime.service' '${foreign}@runtime.service'; do
    case "$unit" in $pattern) printf '%s loaded active running Dashboard\\n' "$unit" ;; esac
  done
fi
`, { mode: 0o755 })
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      const script = buildManagementDashboardServiceReconciliationScript('stacks', ['dashboard-stacksjs-com', 'dashboard-live-liveness'], serverOwner, ['dashboard.stacksjs.com']).join('\n')
        .replaceAll('/etc/systemd/system', units)
        .replaceAll('/etc/rpx/sites.d', join(root, 'routes'))
        .replaceAll('/run/ts-cloud-dashboard-routes-changed', join(root, 'run', 'routes-changed'))
        .replaceAll('/var/www/', `${join(root, 'data')}/`)
        .replaceAll('/usr/local/bin/bun', quote(process.execPath))
      const proc = Bun.spawn(['/bin/bash', '-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DASHBOARD_TEST_LOG: log }, stdout: 'pipe', stderr: 'pipe' })
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text(), new Response(proc.stdout).text()])
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
      for (const name of preserved) expect(readFileSync(join(units, name), 'utf8')).toBe(`Original unit ${name}\n`)
      for (const name of removed) expect(existsSync(join(units, name))).toBe(false)
      expect(readdirSync(units).sort()).toEqual(preserved.sort())
      expect(readFileSync(join(root, 'data', 'original.sqlite'), 'utf8')).toBe('Original persistent dashboard data')
      const commands = readFileSync(log, 'utf8').trim().split('\n')
      expect(commands).not.toContain('reset-failed')
      expect(commands).toContain(`disable --now ${old}-liveness.timer`)
      expect(commands).toContain(`disable --now ${old}@runtime.service`)
      expect(commands.indexOf(`disable --now ${old}-liveness.timer`)).toBeLessThan(commands.indexOf(`disable --now ${old}-liveness.service`))
      expect(commands.some(command => command.includes(desired))).toBe(false)
      expect(commands.some(command => command.includes('reviewos-api'))).toBe(false)
      if (!serverOwner) expect(commands.some(command => command.includes(foreign))).toBe(false)
      const again = Bun.spawn(['/bin/bash', '-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DASHBOARD_TEST_LOG: log }, stdout: 'pipe', stderr: 'pipe' })
      const [againCode, againError] = await Promise.all([again.exited, new Response(again.stderr).text(), new Response(again.stdout).text()])
      expect({ code: againCode, stderr: againError }).toEqual({ code: 0, stderr: '' })
      expect(readFileSync(log, 'utf8').trim().split('\n').slice(commands.length)).toEqual(['daemon-reload'])
      for (const name of preserved) expect(readFileSync(join(units, name), 'utf8')).toBe(`Original unit ${name}\n`)
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  })
}
