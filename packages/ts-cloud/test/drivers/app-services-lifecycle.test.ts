import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSiteServicesScript } from '../../src/drivers/shared/app-services'
import { buildSiteDeployScript, buildStaticSiteDeployScript } from '../../src/drivers/shared/deploy-script'
import { buildPruneReleases, buildResetReleaseDir, buildStrandedReleaseTrap, releasePaths } from '../../src/drivers/shared/releases'

// The external systemctl port refuses or accepts each lifecycle operation. Actual generated
// shell and filesystem effects must preserve the old unit/release on refusal.
for (const fault of ['stop', 'disable'] as const) test.skipIf(process.platform === 'win32')(`a refused stale-service ${fault} prevents unit removal and release pruning`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ts-cloud-stop-refusal-')))
  const units = join(root, 'units'), cron = join(root, 'cron'), bin = join(root, 'bin')
  const old = join(root, 'releases', 'a'), current = join(root, 'releases', 'b')
  const unit = join(units, 'fixture-app-scheduler.service')
  const sibling = join(units, 'fixture-app-extra-scheduler.service')
  const operationCode = join(root, 'operation-code'), trace = join(root, 'manager-trace')
  const observations: object[] = []
  let completed = false
  try {
    for (const directory of [units, cron, bin, old, current]) await mkdir(directory, { recursive: true })
    await writeFile(unit, 'managed unit')
    await writeFile(sibling, 'unrelated site unit')
    await writeFile(join(old, 'asset'), 'old')
    await writeFile(join(current, 'asset'), 'current')
    await symlink(current, join(root, 'current'))
    await utimes(old, new Date('2000-01-01'), new Date('2000-01-01'))
    await utimes(current, new Date('2026-01-01'), new Date('2026-01-01'))
    await writeFile(join(bin, 'systemctl'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$MANAGER_TRACE"\nif [ "$1" = "$FAIL_ACTION" ]; then exit "$(cat "$OPERATION_CODE")"; fi\nexit 0\n')
    await chmod(join(bin, 'systemctl'), 0o700)
    const generated = ['set -euo pipefail', ...buildSiteServicesScript({ slug: 'fixture', siteName: 'app', appBase: root, site: { root: '.', scheduler: false, queues: [], daemons: [] } }), ...buildPruneReleases(releasePaths(root, 'b'), 1)].join('\n')
    // Map only the provider's system directories into the owned fixture.
    const program = generated.replaceAll('/etc/systemd/system/', `${units}/`).replaceAll('/etc/cron.d/', `${cron}/`)
    assert(!program.includes('/etc/'))
    for (const code of [23, 0]) {
      await writeFile(operationCode, String(code))
      const child = Bun.spawn(['/bin/bash', '-c', program], { cwd: root, env: { PATH: `${bin}:/usr/bin:/bin`, OPERATION_CODE: operationCode, MANAGER_TRACE: trace, FAIL_ACTION: fault }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 6000)
      let exitCode: number, stdout: string, stderr: string
      try { [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]) }
      finally { clearTimeout(timer); if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited } }
      observations.push({ fault, operationCode: code, exitCode, exitProperty: child.exitCode, signal: child.signalCode, stdout, stderr, unitRemains: await Bun.file(unit).exists(), oldAssetRemains: await Bun.file(join(old, 'asset')).exists() })
      expect(exitCode).toBe(code)
      expect(await Bun.file(unit).exists()).toBe(code !== 0)
      expect(await Bun.file(join(old, 'asset')).exists()).toBe(code !== 0)
      expect(await readFile(sibling, 'utf8')).toBe('unrelated site unit')
      expect(await Bun.file(join(current, 'asset')).exists()).toBe(true)
      expect((await readFile(trace, 'utf8')).includes('stop fixture-app-extra-scheduler.service')).toBe(false)
    }
    completed = true
  }
  finally {
    const written = await writeFile(join(root, 'observations.json'), JSON.stringify(observations, null, 2)).then(() => true, () => false)
    if (completed && written) await rm(root, { recursive: true })
    else console.error('BACKGROUND_STOP_REFUSAL_RETAINED', root)
  }
}, 20000)

for (const kind of ['app', 'static'] as const) test.skipIf(process.platform === 'win32')(`reset drain and real EXIT trap preserve ownership for ${kind}`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ts-cloud-reset-drain-')))
  const active = join(root, 'releases', 'a'), target = join(root, 'releases', 'b')
  const observations: object[] = []
  let completed = false
  try {
    await mkdir(active, { recursive: true })
    await writeFile(join(active, 'asset'), 'active')
    await symlink(active, join(root, 'current'))
    for (const [index, callback] of ['false', 'false', 'true', 'true'].entries()) {
      if (index === 1) await writeFile(join(target, 'asset'), 'existing target')
      const options = { slug: 'fixture', siteName: 'app', appDir: root, releaseId: 'b', artifactFetch: [], beforeResetCommands: [callback] }
      const artifact = kind === 'app' ? buildSiteDeployScript({ ...options, execStart: '/usr/local/bin/bun server.ts', envEntries: {} }) : buildStaticSiteDeployScript(options)
      const hook = artifact.indexOf(callback)
      const resetting = buildResetReleaseDir(releasePaths(root, 'b'))
      const reset = artifact.indexOf(resetting[0])
      assert(hook > 0 && reset > hook)
      const guardEnd = artifact.indexOf('fi', hook)
      const trap = artifact.indexOf(buildStrandedReleaseTrap(releasePaths(root, 'b')))
      assert(trap > 0 && guardEnd > hook && guardEnd < reset)
      assert(artifact[hook - 1].startsWith('if [ -e '))
      // Execute the actual production trap in its actual order, including
      // failure before reset and failure after this deploy owns a new target.
      const phase = artifact.filter((_, at) => at === 0 || at === trap || (at >= hook - 1 && at <= guardEnd) || (at >= reset && at < reset + resetting.length))
      if (index === 3) phase.push('false')
      const child = Bun.spawn(['/bin/bash', '-c', phase.join('\n')], { cwd: root, env: { PATH: '/usr/bin:/bin' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 6000)
      let code: number, stdout: string, stderr: string
      try { [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]) }
      finally { clearTimeout(timer); if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited } }
      observations.push({ index, callback, code, signal: child.signalCode, stdout, stderr, targetAssetRemains: await Bun.file(join(target, 'asset')).exists() })
      expect(code).toBe(index === 1 || index === 3 ? 1 : 0)
      expect(await readFile(join(active, 'asset'), 'utf8')).toBe('active')
      expect(await Bun.file(join(target, 'asset')).exists()).toBe(index === 1)
      expect(await realpath(join(root, 'current'))).toBe(active)
      expect(await realpath(target).catch(() => null)).toBe(index === 3 ? null : target)
    }
    completed = true
  }
  finally {
    const written = await writeFile(join(root, 'observations.json'), JSON.stringify(observations, null, 2)).then(() => true, () => false)
    if (completed && written) await rm(root, { recursive: true })
    else console.error('BACKGROUND_RESET_DRAIN_RETAINED', root)
  }
}, 30000)
