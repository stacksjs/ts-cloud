import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'bun:test'
import { LocalBoxDriver } from '../../src/drivers/local-box/driver'
import { ownedScriptRunner, runLeasedCommand } from '../../src/drivers/shared/owned-script'

function identity(pid: number): string {
  try {
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim()
    if (!state || state.startsWith('Z')) return ''
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim()
  } catch { return '' }
}

it('ends only the cancelled deployment and its descendants after abrupt controller loss', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-cloud-controller-loss-'))
  const driver = resolve(import.meta.dir, '../../src/drivers/local-box/driver.ts')
  const workerFile = join(root, 'worker.pid')
  const childFile = join(root, 'child.pid')
  const ready = join(root, 'ready')
  const controllerFile = join(root, 'controller.ts')
  writeFileSync(controllerFile, `
    import { LocalBoxDriver } from ${JSON.stringify(driver)}
    const result = await new LocalBoxDriver().runRemoteDeploy({
      targets: [{ id: 'synthetic', publicIp: '127.0.0.1', status: 'running' }],
      commands: [${JSON.stringify([
        "trap '' TERM",
        `echo $$ > '${workerFile}'`,
        'sleep 60 &',
        `echo $! > '${childFile}'`,
        `touch '${ready}'`,
        'wait',
      ].join('\n'))}],
    })
    console.log(JSON.stringify(result))
  `)
  const unrelated = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' })
  const controller = Bun.spawn([process.execPath, '--no-env-file', '--config=/dev/null', controllerFile], {
    stdout: Bun.file(join(root, 'controller.stdout')), stderr: Bun.file(join(root, 'controller.stderr')),
  })
  const owned = new Map<number, string>()
  try {
    const admission = Date.now() + 5000
    while (!existsSync(ready) && identity(controller.pid) && Date.now() < admission)
      await Bun.sleep(20)
    if (!existsSync(ready)) throw new Error(`Controller did not start: ${readFileSync(join(root, 'controller.stderr'), 'utf8')}`)
    for (const file of [workerFile, childFile]) {
      const pid = Number(readFileSync(file, 'utf8').trim())
      const fingerprint = identity(pid)
      expect(fingerprint.length).toBeGreaterThan(0)
      owned.set(pid, fingerprint)
    }
    controller.kill('SIGKILL')
    await controller.exited
    const deadline = Date.now() + 7000
    while ([...owned.keys()].some(pid => identity(pid)) && Date.now() < deadline)
      await Bun.sleep(50)
    expect([...owned.keys()].filter(pid => identity(pid))).toEqual([])
    expect(identity(unrelated.pid).length).toBeGreaterThan(0)
  } finally {
    if (identity(controller.pid)) controller.kill('SIGKILL')
    for (const [pid, fingerprint] of owned) {
      if (identity(pid) === fingerprint) process.kill(pid, 'SIGKILL')
    }
    unrelated.kill('SIGKILL')
    await unrelated.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)

it('preserves success, failure and private staging without sharing the lease with commands', async () => {
  const result = await runLeasedCommand(['bash', '-c', ownedScriptRunner()], [
    'echo "$0"',
    'test -r "$0"',
    'cat > /dev/null',
    "echo 'Grüße 🏃'",
    'echo diagnostic >&2',
    'exit 7',
  ].join('\n'))
  expect(result.code).toBe(7)
  expect(result.stdout.split('\n').slice(1)).toEqual(['Grüße 🏃', ''])
  expect(result.stderr).toBe('diagnostic\n')
  const staged = result.stdout.split('\n')[0]!
  expect(staged).toMatch(/^\/tmp\/ts-cloud-owned\.[^/]+\/script$/)
  expect(existsSync(staged)).toBe(false)
})

it('reclaims descendants left behind by a successfully completed script', async () => {
  const result = await new LocalBoxDriver().runRemoteDeploy({
    targets: [{ id: 'synthetic', publicIp: '127.0.0.1', status: 'running' }],
    commands: ['sleep 60 &', 'echo $!'],
  })
  const pid = Number(result.perInstance[0]!.output!.trim())
  const fingerprint = Number.isSafeInteger(pid) && pid > 0 ? identity(pid) : ''
  try {
    expect(result.success).toBe(true)
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
    expect(identity(pid)).toBe('')
  } finally {
    if (fingerprint && identity(pid) === fingerprint) process.kill(pid, 'SIGKILL')
  }
})

it('expires a silent controller even while its input pipe remains open', async () => {
  const script = 'sleep 60\necho lease-was-ignored\n'
  const child = Bun.spawn(['bash', '-c', ownedScriptRunner({ leaseSeconds: 2 })], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  })
  const guard = setTimeout(() => child.kill('SIGTERM'), 8000)
  try {
    child.stdin.write(`${Buffer.byteLength(script)}\n${script}ts-cloud-alive\n`)
    await child.stdin.flush()
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(status).toBe(125)
    expect(stdout).not.toContain('lease-was-ignored')
    expect(stderr).toContain('controller lease ended')
  } finally {
    clearTimeout(guard)
    try { child.stdin.end() } catch {}
    await child.exited
  }
}, 10_000)

it('refuses to execute the payload when process ownership cannot be verified', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-cloud-group-admission-'))
  const marker = join(root, 'executed')
  writeFileSync(join(root, 'ps'), '#!/bin/sh\nprintf "0\\n"\n', { mode: 0o755 })
  const script = `touch '${marker}'`
  const child = Bun.spawn(['bash', '-c', ownedScriptRunner()], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
  })
  try {
    child.stdin.write(`${Buffer.byteLength(script)}\n${script}ts-cloud-alive\n`)
    await child.stdin.flush()
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])
    expect(status).toBe(125)
    expect(stderr).toContain('Cannot establish deployment process ownership')
    expect(existsSync(marker)).toBe(false)
  } finally {
    try { child.stdin.end() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})
