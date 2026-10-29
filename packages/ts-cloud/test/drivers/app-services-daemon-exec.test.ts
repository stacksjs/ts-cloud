import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSiteServicesScript } from '../../src/drivers/shared/app-services'

for (const custom of [false, true]) test.skipIf(process.platform === 'win32')(`a relative daemon executable starts from its ${custom ? 'custom' : 'release'} directory`, async () => {
  const base = await mkdtemp(join(tmpdir(), 'ts-cloud-daemon-'))
  const directory = join(base, custom ? 'custom' : 'current')
  try {
    await mkdir(join(directory, 'scripts'), { recursive: true })
    const entry = join(directory, 'scripts/start-production.sh')
    await writeFile(entry, '#!/bin/sh\nprintf "daemon:%s" "$1"\n')
    await chmod(entry, 0o700)
    const lines = buildSiteServicesScript({ slug: 'example', siteName: 'api', appBase: base, site: { root: '.', daemons: [{ name: 'worker', command: '  ./scripts/start-production.sh ready  ', ...(custom ? { directory } : {}) }] } }).join('\n').split('\n')
    const start = lines.find(line => line.startsWith('ExecStart='))!
    expect(start).toBe(`ExecStart=${entry} ready`)
    expect(lines).toContain(`WorkingDirectory=${directory}`)
    expect(lines).toContain(`EnvironmentFile=-${base}/current/.env`)
    // Execute the generated absolute command from elsewhere, so process cwd
    // cannot hide the invalid ExecStart that systemd refused on a fresh host.
    const child = Bun.spawn(start.slice('ExecStart='.length).split(' '), { cwd: base, env: { PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe('daemon:ready')
    expect(await new Response(child.stderr).text()).toBe('')
  }
  finally { await rm(base, { recursive: true, force: true }) }
})

test('bare shell and absolute daemon executables retain their command semantics', () => {
  for (const command of ['sh scripts/start-local-speech.sh', '/usr/bin/example --flag=value']) {
    const script = buildSiteServicesScript({ slug: 'example', siteName: 'api', site: { root: '.', daemons: [{ command }] } }).join('\n')
    expect(script).toContain(`ExecStart=${command}\n`)
    expect(script).not.toContain('ExecStart=/usr/local/bin/bun ')
  }
})
