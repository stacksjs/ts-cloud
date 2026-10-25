import type { SiteConfig } from '@ts-cloud/core'
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { buildSiteServicesScript } from '../../src/drivers/shared/app-services'
import { buildSiteDeployScript } from '../../src/drivers/shared/deploy-script'
import { buildPromoteStagedRelease, buildPruneReleases, buildResetReleaseDir, buildStrandedReleaseTrap, releasePaths } from '../../src/drivers/shared/releases'

// Generated units are the deployment boundary; a separate real-process case
// must qualify executable resolution and child PATH across release switching.
test('Stacks background units use the explicitly selected release-local Bun', () => {
  const site: SiteConfig = {
    root: '.',
    backgroundBun: 'pantry/bun.sh/v1.4.4/bin/bun',
    scheduler: { memoryHigh: '1G', memoryMax: '1536M' },
    queues: [{ queue: 'reports', tries: 5, stopWaitSecs: 120 }],
  }
  const script = buildSiteServicesScript({ slug: 'farm', siteName: 'main', appBase: '/srv/farm', releaseId: 'release-a', site }).join('\n')
  expect(script).toContain('ExecStart=/srv/farm/releases/release-a/pantry/bun.sh/v1.4.4/bin/bun node_modules/@stacksjs/ts-cloud/dist/bin/stacks-scheduler.js')
  expect(script).toContain('ExecStart=/srv/farm/releases/release-a/pantry/bun.sh/v1.4.4/bin/bun /srv/farm/releases/release-a/node_modules/@stacksjs/ts-cloud/dist/bin/stacks-queue-worker.js --queue=reports')
  expect(script).toContain('Environment="TS_CLOUD_BACKGROUND_BUN=pantry/bun.sh/v1.4.4/bin/bun"')
  expect(script).toContain('Environment="PATH=/srv/farm/releases/release-a/pantry/bun.sh/v1.4.4/bin:/usr/local/bin:/usr/bin:/bin"')
  expect(script).toContain('MemoryHigh=1G')
  expect(script).toContain('MemoryMax=1536M')
  expect(script).toContain('TimeoutStopSec=120')
  expect(script).not.toContain('ExecStart=/usr/local/bin/bun ')
  expect(script).not.toContain('/bin/sh -lc')
})


// The action is deliberately finite. It probes the actual native entry and a
// real Bun child, without running an application job or installed service.
for (const variant of ['next-id', 'same-id'] as const) for (const service of ['scheduler', 'queue-worker'] as const) test.skipIf(process.platform === 'win32')(`selected ${service} Bun retains its admitted release during ${variant} deployment`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ts-cloud-background-runtime-')))
  const releaseA = join(root, 'releases', 'a'), releaseB = join(root, 'releases', 'b')
  const relative = 'private-runtime/bin/bun'
  const runtimeA = join(releaseA, relative), runtimeB = join(releaseB, relative)
  const current = join(root, 'current'), outside = join(root, 'outside')
  let running: ReturnType<typeof Bun.spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stderrTask = Promise.resolve('')
  let stdout = '', stderr = '', completed = false
  let settledExitCode: number | null = null
  let deadlineFired = false, cleanupKill = false
  try {
    for (const path of [dirname(runtimeA), dirname(runtimeB), outside]) await mkdir(path, { recursive: true })
    await copyFile(process.execPath, runtimeA, constants.COPYFILE_EXCL)
    await chmod(runtimeA, 0o700)
    await copyFile(process.execPath, runtimeB, constants.COPYFILE_EXCL)
    await chmod(runtimeB, 0o700)
    await writeFile(join(releaseA, 'generation'), 'a')
    await writeFile(join(releaseB, 'generation'), 'b')
    await writeFile(join(releaseA, 'bunfig.toml'), 'preload=[]\n[install]\nauto="disable"\n')
    await writeFile(join(releaseA, 'package.json'), '{"type":"module","private":true}')
    await symlink(releaseA, current)

    const entry = join(releaseA, `node_modules/@stacksjs/ts-cloud/dist/bin/stacks-${service}.js`)
    await mkdir(dirname(entry), { recursive: true })
    const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, `../../bin/stacks-${service}.ts`)], target: 'bun' })
    assert(built.success, built.logs.map(String).join('\n'))
    assert(built.outputs[0])
    await writeFile(entry, await built.outputs[0].text())
    const action = join(releaseA, service === 'scheduler' ? 'node_modules/@stacksjs/actions/dist/schedule/run.js' : 'node_modules/@stacksjs/actions/dist/queue/work.js')
    await mkdir(dirname(action), { recursive: true })
    const drainSetup = variant === 'same-id'
      ? `const keepAlive = setInterval(() => {}, 100); const drained = new Promise(resolve => process.once('SIGTERM', () => { clearInterval(keepAlive); resolve() }))`
      : `const drained = new Response(Bun.stdin).text()`
    await writeFile(action, `import { realpathSync } from 'node:fs'
${drainSetup}
const parent = { pid: process.pid, executable: realpathSync(process.execPath), version: Bun.version, cwd: realpathSync(process.cwd()), args: process.argv.slice(2) }
console.log(JSON.stringify({ phase: 'ready', parent }))
await drained
const generation = await Bun.file('generation').text()
if (generation !== 'a') throw new Error('Admitted worker lost its generation: ' + generation)
const child = Bun.spawn(['bun', '--eval', 'import { realpathSync } from "node:fs";console.log(JSON.stringify({executable:realpathSync(process.execPath),version:Bun.version,cwd:process.cwd()}))'], { cwd: ${JSON.stringify(outside)}, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
if (exitCode !== 0 || stderr) throw new Error('Finite child failed: ' + stderr)
console.log(JSON.stringify({ phase: 'done', parent, generation, child: JSON.parse(stdout) }))
`)
    const site: SiteConfig = { root: '.', backgroundBun: relative, ...(service === 'scheduler' ? { scheduler: true } : { queues: [{ queue: 'reports,urgent', sleep: 1, tries: 5, timeout: 90 }] }) }
    const script = buildSiteServicesScript({ slug: 'test', siteName: 'app', appBase: root, releaseId: 'a', site }).join('\n')
    const command = script.split('\n').find(line => line.startsWith('ExecStart='))
    assert(command)
    const env = Object.fromEntries(script.split('\n').filter(line => line.startsWith('Environment="')).map(line => {
      const value = line.slice('Environment="'.length, -1), at = value.indexOf('=')
      return [value.slice(0, at), value.slice(at + 1)]
    }))
    const child = running = Bun.spawn(command.slice('ExecStart='.length).split(' '), { cwd: current, env: { ...env, TMPDIR: root }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    const workerExited = child.exited.then(code => { settledExitCode = code; return code })
    stderrTask = new Response(child.stderr).text()
    timer = setTimeout(() => { if (settledExitCode === null && child.exitCode === null) { deadlineFired = true; child.kill('SIGKILL') } }, 15000)
    const reader = child.stdout.getReader(), decoder = new TextDecoder()
    try {
      while (!stdout.includes('\n')) {
        const chunk = await reader.read()
        assert(!chunk.done, 'Native scheduler entry exited before its finite action became ready')
        stdout += decoder.decode(chunk.value, { stream: true })
        assert(stdout.length <= 16384)
      }
      const ready = JSON.parse(stdout.slice(0, stdout.indexOf('\n')))
      assert.equal(ready.phase, 'ready')
      assert.equal(ready.parent.pid, child.pid)
      assert.deepEqual(ready.parent.args, service === 'scheduler' ? [] : ['--queue=reports,urgent', '--sleep=1', '--tries=5', '--timeout=90'])
      assert.equal(ready.parent.executable, runtimeA)
      assert.equal(ready.parent.cwd, releaseA)
      if (variant === 'next-id') {
        const next = join(root, 'next')
        await symlink(releaseB, next)
        await rename(next, current)
        // Independent positive control: current now selects the replacement's
        // actual Bun, while the generated service must retain its physical release.
        const trap = Bun.spawn(['/usr/bin/env', 'bun', '--eval', 'import { realpathSync } from "node:fs"; console.log(JSON.stringify({executable:realpathSync(process.execPath),version:Bun.version}))'], { cwd: outside, env: { PATH: dirname(join(current, relative)) }, stdout: 'pipe', stderr: 'pipe' })
        const [trapCode, trapOut, trapErr] = await Promise.all([trap.exited, new Response(trap.stdout).text(), new Response(trap.stderr).text()])
        assert.equal(trapCode, 0)
        assert.equal(JSON.parse(trapOut).executable, runtimeB)
        assert.equal(JSON.parse(trapOut).version, Bun.version)
        assert.equal(trapErr, '')
        assert(await Bun.file(runtimeA).exists(), 'The admitted worker retains its release until it drains')
        child.stdin.write('continue\n'); child.stdin.end()
      }
      else {
        const paths = releasePaths(root, 'a')
        const drain = [`kill -TERM ${child.pid}`, `for i in $(seq 1 500); do if ! kill -0 ${child.pid} 2>/dev/null; then break; fi; sleep 0.01; done; ! kill -0 ${child.pid} 2>/dev/null`]
        const artifact = buildSiteDeployScript({ slug: 'test', siteName: 'app', appDir: root, releaseId: 'a', artifactFetch: [], execStart: runtimeA, envEntries: {}, beforeResetCommands: drain })
        const marker = artifact.indexOf(drain[0])
        const reset = buildResetReleaseDir(paths)
        const resetAt = artifact.indexOf(reset[0])
        assert(marker > 0, 'Same-ID replacement must emit the drain phase')
        assert(resetAt > marker)
        const guardEnd = artifact.indexOf('fi', marker)
        const trap = artifact.indexOf(buildStrandedReleaseTrap(paths))
        assert(guardEnd > marker && guardEnd < resetAt && trap > 0)
        assert(artifact[marker - 1].startsWith('if [ -e '))
        const before = artifact.filter((_, at) => at === 0 || at === trap || (at >= marker - 1 && at <= guardEnd))
        const program = [...before, ...reset, `cp -R ${releaseB}/. "$TS_CLOUD_STAGED"`, ...buildPromoteStagedRelease(paths)].join('\n')
        const replacing = Bun.spawn(['/bin/bash', '-c', program], { cwd: root, env: { PATH: '/usr/bin:/bin' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
        const replaceTimer = setTimeout(() => { if (replacing.exitCode === null) replacing.kill('SIGKILL') }, 6000)
        let replaceCode: number, replaceOut: string, replaceErr: string
        try { [replaceCode, replaceOut, replaceErr] = await Promise.all([replacing.exited, new Response(replacing.stdout).text(), new Response(replacing.stderr).text()]) }
        finally { clearTimeout(replaceTimer); if (replacing.exitCode === null) { replacing.kill('SIGKILL'); await replacing.exited } }
        assert.equal(replaceCode, 0, `${replaceOut}\n${replaceErr}`)
        assert.equal(await workerExited, 0)
      }
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        stdout += decoder.decode(chunk.value, { stream: true })
        assert(stdout.length <= 16384)
      }
      stdout += decoder.decode()
      const code = settledExitCode = await workerExited
      stderr = await stderrTask
      assert.equal(code, 0, `${stdout}\n${stderr}`)
      assert.equal(stderr, '')
      const done = JSON.parse(stdout.trim().split('\n').at(-1)!)
      assert.equal(done.phase, 'done')
      assert.equal(done.parent.executable, runtimeA)
      assert.equal(done.child.executable, runtimeA)
      assert.equal(done.child.version, done.parent.version)
      assert.equal(done.child.cwd, outside)
      assert.equal(done.generation, 'a')
      if (variant === 'next-id') {
        await utimes(releaseA, new Date('2000-01-01'), new Date('2000-01-01'))
        await utimes(releaseB, new Date('2026-01-01'), new Date('2026-01-01'))
        const pruning = Bun.spawn(['/bin/bash', '-euo', 'pipefail', '-c', buildPruneReleases(releasePaths(root, 'b'), 1).join('\n')], { cwd: root, env: { PATH: '/usr/bin:/bin' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
        const pruneTimer = setTimeout(() => { if (pruning.exitCode === null) pruning.kill('SIGKILL') }, 6000)
        let pruneCode: number, pruneOut: string, pruneErr: string
        try { [pruneCode, pruneOut, pruneErr] = await Promise.all([pruning.exited, new Response(pruning.stdout).text(), new Response(pruning.stderr).text()]) }
        finally { clearTimeout(pruneTimer); if (pruning.exitCode === null) { pruning.kill('SIGKILL'); await pruning.exited } }
        assert.equal(pruneCode, 0, `${pruneOut}\n${pruneErr}`)
        assert.equal(pruneErr, '')
        assert.equal(await Bun.file(runtimeA).exists(), false, 'The original keep1 policy still retires the drained release')
        assert.equal(await Bun.file(runtimeB).exists(), true)
        assert.equal(await realpath(current), releaseB)
        console.log(JSON.stringify({ oracle: 'native-background-prune-after-drain', service, workerExit: code, oldRuntimeRemoved: true, currentRuntimePreserved: true, keepReleases: 1 }))
      }
      else {
        assert.equal(await realpath(current), releaseA)
        assert.equal(await Bun.file(join(releaseA, 'generation')).text(), 'b')
        console.log(JSON.stringify({ oracle: 'native-background-same-id-replacement-after-drain', service, workerExit: code, admittedGeneration: done.generation, replacementGeneration: 'b' }))
      }
      completed = true
    }
    finally { await reader.cancel().catch(() => {}) }
  }
  finally {
    if (timer) clearTimeout(timer)
    if (running?.exitCode === null && settledExitCode === null) { cleanupKill = true; running.kill('SIGKILL') }
    if (running) settledExitCode = await running.exited
    stderr = await stderrTask
    const artifacts = await Promise.allSettled([
      writeFile(join(root, 'original.stdout'), stdout),
      writeFile(join(root, 'original.stderr'), stderr),
      writeFile(join(root, 'lifecycle.json'), JSON.stringify({ settledExitCode, exitProperty: running?.exitCode ?? null, signal: running?.signalCode ?? null, deadlineFired, cleanupKill, completed })),
    ])
    if (completed && artifacts.every(result => result.status === 'fulfilled')) await rm(root, { recursive: true })
    else console.error('BACKGROUND_RUNTIME_FIXTURE_RETAINED', root)
  }
}, 30000)


for (const service of ['scheduler', 'queue-worker'] as const) test.skipIf(process.platform === 'win32')(`selected ${service} runtime is admitted before application work`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ts-cloud-background-admission-')))
  const release = join(root, 'releases', 'a'), selected = 'runtime/bin/bun'
  const runtime = join(release, selected), alias = join(release, 'alias/bin/bun'), escaped = join(release, 'escaped/bin/bun')
  const marker = join(root, 'action-ran')
  const observations: object[] = []
  let child: ReturnType<typeof Bun.spawn> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let settledExitCode: number | null = null, deadlineFired = false, cleanupKill = false, completed = false
  try {
    for (const path of [dirname(runtime), dirname(alias), dirname(escaped)]) await mkdir(path, { recursive: true })
    await copyFile(process.execPath, runtime, constants.COPYFILE_EXCL)
    await chmod(runtime, 0o700)
    await symlink(runtime, alias)
    await symlink(process.execPath, escaped)
    await writeFile(join(release, 'bunfig.toml'), 'preload=[]\n[install]\nauto="disable"\n')
    await writeFile(join(release, 'package.json'), '{"type":"module","private":true}')
    const entry = join(release, `node_modules/@stacksjs/ts-cloud/dist/bin/stacks-${service}.js`)
    await mkdir(dirname(entry), { recursive: true })
    const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, `../../bin/stacks-${service}.ts`)], target: 'bun' })
    assert(built.success, built.logs.map(String).join('\n'))
    assert(built.outputs[0])
    await writeFile(entry, await built.outputs[0].text())
    const action = join(release, service === 'scheduler' ? 'node_modules/@stacksjs/actions/dist/schedule/run.js' : 'node_modules/@stacksjs/actions/dist/queue/work.js')
    await mkdir(dirname(action), { recursive: true })
    await writeFile(action, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'invoked'); console.log('APP_WORK_INVOKED')`)
    const cases = [
      { name: 'selected', executable: runtime, selected, path: dirname(runtime), allowed: true },
      { name: 'contained-alias', executable: alias, selected: 'alias/bin/bun', path: dirname(alias), allowed: true },
      { name: 'missing-selected-runtime', executable: runtime, selected: 'missing/bin/bun', path: dirname(runtime), allowed: false },
      { name: 'different-running-executable', executable: process.execPath, selected, path: dirname(runtime), allowed: false },
      { name: 'external-symlink', executable: escaped, selected: 'escaped/bin/bun', path: dirname(escaped), allowed: false },
      { name: 'unsafe-selection', executable: runtime, selected: '../outside/bun', path: dirname(runtime), allowed: false },
      { name: 'wrong-launch-path', executable: runtime, selected, path: '/usr/bin', allowed: false },
    ]
    for (const scenario of cases) {
      await rm(marker, { force: true })
      settledExitCode = null
      deadlineFired = false
      const running = child = Bun.spawn([scenario.executable, '--no-install', '--no-env-file', entry], { cwd: release, env: { APP_ENV: 'test', NODE_ENV: 'test', TS_CLOUD_BACKGROUND_BUN: scenario.selected, PATH: `${scenario.path}:/usr/bin:/bin` }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      const exited = running.exited.then(code => { settledExitCode = code; return code })
      timer = setTimeout(() => { if (settledExitCode === null) { deadlineFired = true; running.kill('SIGKILL') } }, 6000)
      const [code, stdout, stderr] = await Promise.all([exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      clearTimeout(timer)
      timer = undefined
      const invoked = await readFile(marker, 'utf8').catch(() => null)
      observations.push({ scenario: scenario.name, pid: running.pid, code, exitProperty: running.exitCode, signal: running.signalCode, deadlineFired, invoked, stdout, stderr })
      assert(stdout.length <= 16384 && stderr.length <= 16384)
      assert.equal(deadlineFired, false, scenario.name)
      assert.equal(code, scenario.allowed ? 0 : 1, `${scenario.name}: ${stdout}\n${stderr}`)
      assert.equal(invoked, scenario.allowed ? 'invoked' : null, scenario.name)
      assert.equal(stdout.includes('APP_WORK_INVOKED'), scenario.allowed, scenario.name)
      if (scenario.allowed) assert.equal(stderr, '')
    }
    completed = true
  }
  finally {
    if (timer) clearTimeout(timer)
    if (child && settledExitCode === null) { cleanupKill = true; child.kill('SIGKILL') }
    if (child) settledExitCode = await child.exited
    const artifacts = await Promise.allSettled([
      writeFile(join(root, 'observations.json'), JSON.stringify(observations, null, 2)),
      writeFile(join(root, 'lifecycle.json'), JSON.stringify({ settledExitCode, exitProperty: child?.exitCode ?? null, signal: child?.signalCode ?? null, deadlineFired, cleanupKill, completed })),
    ])
    if (completed && artifacts.every(result => result.status === 'fulfilled')) await rm(root, { recursive: true })
    else console.error('BACKGROUND_RUNTIME_ADMISSION_RETAINED', root)
  }
}, 60000)


test('selected background queue options cannot introduce unit arguments or directives', () => {
  const invalid: unknown[] = [
    { queue: 'reports --timeout=0' },
    { queue: 'reports\nExecStart=/bad' },
    { queue: 'reports%n' },
    { queue: '$QUEUE' },
    { queue: 'reports\\urgent' },
    { sleep: '1 --tries=0' },
    { tries: '3\nUser=root' },
    { timeout: Number.NaN },
    { timeout: Number.POSITIVE_INFINITY },
    { processes: Number.NaN },
    { stopWaitSecs: '90\nExecStart=/bad' },
  ]
  for (const worker of invalid) expect(() => buildSiteServicesScript({
    slug: 'test', siteName: 'app', appBase: '/srv/test', releaseId: 'a',
    site: { root: '.', backgroundBun: 'runtime/bin/bun', queues: [worker as NonNullable<SiteConfig['queues']>[number]] },
  })).toThrow('Stacks background queue options')
})

test('release-local runtime selection refuses unsafe paths and missing release identity', () => {
  for (const value of ['', '/usr/bin/bun', '../bin/bun', 'runtime/../bin/bun', 'runtime/bin/bun --eval bad', 'runtime/%n/bin/bun', 'runtime/$USER/bin/bun', 'runtime/bin/node']) {
    expect(() => buildSiteServicesScript({ slug: 'test', siteName: 'app', appBase: '/srv/test', releaseId: 'a', site: { root: '.', scheduler: true, backgroundBun: value } })).toThrow('backgroundBun')
  }
  for (const releaseId of [undefined, '../other', 'a/b', '%n', '$RELEASE', 'a b']) {
    expect(() => buildSiteServicesScript({ slug: 'test', siteName: 'app', appBase: '/srv/test', releaseId, site: { root: '.', scheduler: true, backgroundBun: 'runtime/bin/bun' } })).toThrow('releaseId')
  }
})


test.skipIf(process.platform === 'win32')('failed release reconciliation preserves old files before the actual prune phase', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ts-cloud-reconcile-prune-')))
  const old = join(root, 'releases', 'a'), next = join(root, 'releases', 'b')
  const observations: object[] = []
  let completed = false
  try {
    for (const directory of [old, next]) await mkdir(directory, { recursive: true })
    await writeFile(join(old, 'asset'), 'old')
    await writeFile(join(next, 'asset'), 'new')
    await symlink(next, join(root, 'current'))
    await utimes(old, new Date('2000-01-01'), new Date('2000-01-01'))
    await utimes(next, new Date('2026-01-01'), new Date('2026-01-01'))
    for (const command of ['false', 'true']) {
      const artifact = buildSiteDeployScript({ slug: 'test', siteName: 'app', appDir: root, releaseId: 'b', artifactFetch: [], execStart: '/usr/local/bin/bun server.ts', envEntries: {}, keepReleases: 1, postActivateCommands: [command] })
      const start = artifact.indexOf(command)
      assert(start > 0)
      const pruning = buildPruneReleases(releasePaths(root, 'b'), 1)
      assert.deepEqual(artifact.slice(start + 1, start + 1 + pruning.length), pruning)
      const phase = [artifact[0], ...artifact.slice(start, start + 1 + pruning.length)].join('\n')
      const child = Bun.spawn(['/bin/bash', '-c', phase], { cwd: root, env: { PATH: '/usr/bin:/bin' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      const timeout = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 6000)
      let code: number, stdout: string, stderr: string
      try { [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]) }
      finally { clearTimeout(timeout); if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited } }
      observations.push({ command, code, signal: child.signalCode, stdout, stderr, oldAssetRemains: await Bun.file(join(old, 'asset')).exists(), nextAssetRemains: await Bun.file(join(next, 'asset')).exists() })
      assert.equal(code, command === 'false' ? 1 : 0, `${stdout}\n${stderr}`)
      assert.equal(await Bun.file(join(old, 'asset')).exists(), command === 'false')
      assert.equal(await Bun.file(join(next, 'asset')).exists(), true)
      assert.equal(await realpath(join(root, 'current')), next)
    }
    completed = true
  }
  finally {
    const written = await writeFile(join(root, 'observations.json'), JSON.stringify(observations, null, 2)).then(() => true, () => false)
    if (completed && written) await rm(root, { recursive: true })
    else console.error('BACKGROUND_RECONCILIATION_PRUNE_RETAINED', root)
  }
}, 20000)
