import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOX_PANTRY_BIN_DIR, BOX_PANTRY_CLI_DIR, boxResizeDecision, buildBoxConvergeScript, buildBoxDrainScript, parseBoxReport, provisionBox, renderBoxUnit, renderEnvFile, renderUsernsProfile } from './box-converge'

const runner = {
  name: 'ci-runner-1',
  size: 'cx23',
  pantryVersion: '0.11.99',
  packages: ['google.com/chrome@155.0.8059.84', 'git-scm.org@2.53.0'],
  user: { name: 'runner', groups: ['docker'] },
  services: {
    'ci-runner': {
      exec: '%h/ci-runner',
      workingDirectory: '%h/work',
      environmentFile: '%h/.config/ci-runner.env',
      environment: { LANG: 'C.UTF-8', NOTE: 'say "hi" \\ there' },
      path: ['%h/.bun/bin'],
    },
  },
}

describe('a declared box', () => {
  test('renders a user unit with the pantry packages on PATH after the declared directories', () => {
    const unit = renderBoxUnit('ci-runner', runner.services['ci-runner'], { userUnit: true })
    expect(unit).toContain('ExecStart=%h/ci-runner')
    expect(unit).toContain('WorkingDirectory=%h/work')
    expect(unit).toContain('EnvironmentFile=%h/.config/ci-runner.env')
    expect(unit).toContain('EnvironmentFile=%h/.config/ts-cloud/ci-runner.env')
    expect(unit).toContain(`Environment=PATH=%h/.bun/bin:${BOX_PANTRY_BIN_DIR}:/usr/local/bin:/usr/bin:/bin`)
    expect(unit).toContain('WantedBy=default.target')
    // The pantry CLI is never on a service's PATH.
    expect(unit).not.toContain(BOX_PANTRY_CLI_DIR)
  })

  test('puts pantry packages on PATH only for a box that declares some', () => {
    // The script carries each unit base64-encoded; decode them to read the PATH.
    const units = (box: typeof runner) => [...buildBoxConvergeScript(box).matchAll(/'([A-Za-z0-9+/=]{40,})'/g)]
      .map(match => Buffer.from(match[1]!, 'base64').toString('utf8'))
      .filter(text => text.includes('[Service]'))
    expect(units({ ...runner, packages: [] }).every(unit => !unit.includes(BOX_PANTRY_BIN_DIR))).toBe(true)
    expect(units(runner).some(unit => unit.includes(BOX_PANTRY_BIN_DIR))).toBe(true)
    expect(renderBoxUnit('ci-runner', runner.services['ci-runner'], { userUnit: true, pantryOnPath: false })).toContain('Environment=PATH=%h/.bun/bin:/usr/local/bin:/usr/bin:/bin')
  })

  test('escapes env file values for systemd', () => {
    expect(renderEnvFile({ NOTE: 'say "hi" \\ there' })).toBe('NOTE="say \\"hi\\" \\\\ there"\n')
    expect(() => renderEnvFile({ 'BAD NAME': 'x' })).toThrow()
  })

  test('is one script bash accepts, which installs the pinned pantry off PATH and the packages', () => {
    const script = buildBoxConvergeScript(runner)
    const check = Bun.spawnSync(['bash', '-n'], { stdin: Buffer.from(script) })
    expect(check.exitCode).toBe(0)
    expect(script).toContain(`PANTRY="${BOX_PANTRY_CLI_DIR}/pantry"`)
    expect(script).toContain('grep -q "pantry 0.11.99\\b"')
    expect(script).toContain("pantry install '\\''google.com/chrome@155.0.8059.84'\\'' '\\''git-scm.org@2.53.0'\\''")
    expect(script).toContain('loginctl enable-linger runner')
    expect(script).toContain('usermod -aG docker runner')
  })

  test('starts a stopped service, and leaves a running one for the operator unless it asked for a restart', () => {
    const patient = buildBoxConvergeScript(runner)
    expect(patient).toContain('svc start ci-runner.service')
    expect(patient).not.toContain('svc restart ci-runner.service')
    expect(patient).toContain('changed ci-runner; restart it to apply')
    const eager = buildBoxConvergeScript({ ...runner, services: { 'ci-runner': { ...runner.services['ci-runner'], restartOnChange: true } } })
    expect(eager).toContain('svc restart ci-runner.service')
  })

  test('refuses names that would need quoting in a unit path or a shell', () => {
    expect(() => buildBoxConvergeScript({ ...runner, user: { name: 'run ner' } })).toThrow()
    expect(() => buildBoxConvergeScript({ ...runner, services: { 'a;rm -rf /': { exec: 'x' } } })).toThrow()
  })

  test('refuses to install packages below the declared free space, before touching anything', () => {
    const script = buildBoxConvergeScript({ ...runner, minFreeDiskGb: 12 })
    const floor = script.indexOf('-lt 12582912')
    expect(floor).toBeGreaterThan(-1)
    expect(floor).toBeLessThan(script.indexOf('pantry install'))
    expect(script).toContain('the box declares at least 12 GB')
    expect(buildBoxConvergeScript(runner)).toContain('-lt 10485760')
  })

  test('applies the disk floor only when the declared packages changed since the last install', () => {
    const script = buildBoxConvergeScript(runner)
    const wanted = Buffer.from(['git-scm.org@2.53.0', 'google.com/chrome@155.0.8059.84'].join('\n') + '\n').toString('base64')
    expect(script).toContain(`WANTED_PACKAGES='${wanted}'`)
    expect(script.indexOf('MISSING=1')).toBeLessThan(script.indexOf('FREE_KB='))
    expect(script).toContain('if [ "$MISSING" = 1 ]; then')
    // The record is written only after pantry install succeeded (set -e).
    expect(script.indexOf('> /opt/pantry/pantry/.ts-cloud-packages')).toBeGreaterThan(script.indexOf('pantry install'))
  })

  test('gives pantry\'s Chrome its sandbox on Ubuntu, and nothing else', () => {
    const profile = renderUsernsProfile('ts-cloud-pantry-chrome', '/opt/pantry/pantry/google.com/chrome/*/lib/chrome-for-testing/chrome')
    expect(profile).toContain('profile ts-cloud-pantry-chrome /opt/pantry/pantry/google.com/chrome/*/lib/chrome-for-testing/chrome flags=(unconfined) {')
    expect(profile).toContain('  userns,')
    const script = buildBoxConvergeScript(runner)
    expect(script).toContain('/etc/apparmor.d/ts-cloud-pantry-chrome')
    expect(script).toContain('apparmor_parser -r /etc/apparmor.d/ts-cloud-pantry-chrome')
    expect(buildBoxConvergeScript({ ...runner, packages: ['git-scm.org@2.53.0'] })).not.toContain('apparmor')
  })

  test('reports only its own lines', () => {
    expect(parseBoxReport('noise\nts-cloud: started ci-runner\nts-cloud: converged\n')).toEqual(['started ci-runner', 'converged'])
  })
})

describe('resizing a declared box', () => {
  const draining = {
    ...runner,
    size: 'cx43',
    resize: { attemptUnavailable: true },
    services: { 'ci-runner': { exec: '%h/ci-runner', drainSignal: 'SIGUSR2', drainTimeoutSec: 600 }, 'log-shipper': { exec: '%h/ship' } },
  }
  const type = (name: string, cores: number, available: boolean) =>
    ({ name, cores, memory: cores * 2, disk: cores * 20, architecture: 'x86', locations: [{ name: 'fsn1', available }] }) as any
  const plan = (target: any, alreadyComplete = false) =>
    ({ serverId: 1, serverName: 'ci-runner-1', location: 'fsn1', currentType: type('cx23', 2, true), targetType: target, capacityAvailable: target.locations[0].available, alreadyComplete, upgradeDisk: true })

  test('drains only the services that declare a signal: signal, wait for the process, then stop the unit', () => {
    const script = buildBoxDrainScript(draining)
    expect(Bun.spawnSync(['bash', '-n'], { stdin: new TextEncoder().encode(script) }).exitCode).toBe(0)
    expect(script).toContain('svc kill --kill-who=main -s SIGUSR2 ci-runner.service')
    expect(script).toContain('kill -0 "$PID"')
    expect(script).toContain('-ge 600')
    // Stopped after the process left, so Restart= cannot start it again.
    expect(script.indexOf('svc stop ci-runner.service')).toBeGreaterThan(script.indexOf('kill -0 "$PID"'))
    expect(script).not.toContain('log-shipper')
    expect(script).toContain('sudo -u runner')
  })

  test('a changed unit of a draining service restarts gracefully, after its current work', () => {
    const script = buildBoxConvergeScript(draining)
    expect(script).toContain('then svc kill --kill-who=main -s SIGUSR2 ci-runner.service')
    // Without a drain signal it is still left for the operator.
    expect(script).toContain('changed log-shipper; restart it to apply')
    // on-failure would not bring a clean exit back, so no signal there.
    const onFailure = buildBoxConvergeScript({ ...draining, services: { 'ci-runner': { ...draining.services['ci-runner'], restart: 'on-failure' as const } } })
    expect(onFailure).not.toContain('svc kill ')
  })

  test('refuses a signal that is not a signal name', () => {
    expect(() => buildBoxDrainScript({ ...draining, services: { x: { exec: 'x', drainSignal: 'USR2; rm -rf /' } } })).toThrow()
  })

  test('a drain signal reaches the runner while its active job finishes normally', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'box-drain-job-'))
    const ready = join(directory, 'ready.json')
    const done = join(directory, 'job-finished')
    const fixture = join(directory, 'runner.ts')
    const systemctl = join(directory, 'systemctl')
    writeFileSync(fixture, `
      const job = Bun.spawn([process.execPath, '-e', 'setTimeout(() => { require("node:fs").writeFileSync(process.env.DRAIN_DONE, "finished"); process.exit(0) }, 800)'], { stdout: 'ignore', stderr: 'inherit' })
      process.on('SIGUSR2', () => {})
      await Bun.write(process.env.DRAIN_READY, JSON.stringify({ runner: process.pid, job: job.pid }))
      process.exit(await job.exited)
    `)
    // Model systemctl's documented target selection. The signal delivery and
    // job completion are real child processes, never the host's service manager.
    writeFileSync(systemctl, `#!${process.execPath}
      const ids = JSON.parse(require('node:fs').readFileSync(process.env.DRAIN_READY, 'utf8'))
      const args = process.argv.slice(2)
      if (args[0] === 'show') console.log(ids.runner)
      if (args[0] === 'kill') {
        process.kill(ids.runner, 'SIGUSR2')
        if (!args.includes('--kill-who=main')) process.kill(ids.job, 'SIGUSR2')
      }
    `, { mode: 0o755 })
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, DRAIN_READY: ready, DRAIN_DONE: done }
    const child = Bun.spawn([process.execPath, fixture], { env, stdout: 'ignore', stderr: 'pipe' })
    let shell: ReturnType<typeof Bun.spawn> | undefined
    try {
      const deadline = Date.now() + 5000
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(5)
      expect(existsSync(ready)).toBe(true)
      const script = buildBoxDrainScript({ ...draining, user: undefined })
      shell = Bun.spawn(['bash'], { env, stdin: Buffer.from(script), stdout: 'pipe', stderr: 'pipe' })
      expect(await shell.exited).toBe(0)
      expect(await child.exited).toBe(0)
      expect(existsSync(done)).toBe(true)
    }
    finally {
      shell?.kill()
      child.kill()
      await Promise.all([shell?.exited, child.exited])
      rmSync(directory, { recursive: true, force: true })
    }
  }, 15_000)

  test('resizes only when asked, and asks out of stock only when allowed', () => {
    expect(boxResizeDecision({ ...draining, resize: undefined }, plan(type('cx43', 8, true)))).toBe('none')
    expect(boxResizeDecision(draining, plan(type('cx43', 8, true), true))).toBe('none')
    expect(boxResizeDecision(draining, plan(type('cx43', 8, false)))).toBe('resize')
    expect(boxResizeDecision({ ...draining, resize: { whenUnavailable: 'keep-current' } }, plan(type('cx43', 8, false)))).toBe('unavailable')
    expect(() => boxResizeDecision({ ...draining, resize: {} }, plan(type('cx43', 8, false)))).toThrow(/out of stock/)
  })

  test('a dry run reads the provider and changes nothing', async () => {
    const calls: string[] = []
    const client = {
      listServers: async () => { calls.push('listServers'); return [{ id: 1, name: 'ci-runner-1', server_type: type('cx23', 2, true), public_net: { ipv4: { ip: '192.0.2.1' } }, location: { name: 'fsn1' } }] },
      getServer: async () => { calls.push('getServer'); return { id: 1, name: 'ci-runner-1', server_type: type('cx23', 2, true), location: { name: 'fsn1' } } },
      getServerType: async () => { calls.push('getServerType'); return type('cx43', 8, false) },
    } as any
    const result = await provisionBox({ box: draining, client, sshPublicKey: 'ssh-ed25519 AAAA test', identityFile: '/nonexistent', knownHostsFile: '/nonexistent', dryRun: true })
    expect(result.report[0]).toBe('would resize cx23 to cx43 (out of stock; asking placement anyway), draining ci-runner first')
    expect(result.report.at(-1)).toBe('would converge')
    expect(calls.every(call => ['listServers', 'getServer', 'getServerType'].includes(call))).toBe(true)
  })
})
