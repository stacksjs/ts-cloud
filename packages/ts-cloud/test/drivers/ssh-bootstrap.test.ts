import type { CloudConfig } from '@ts-cloud/core'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { generateUbuntuAppCloudInit } from '../../src/drivers/hetzner/cloud-init'
import { assertArchSupported, buildSshBootstrapScript, SSH_BOOTSTRAP_VERSION, sshBootstrapMarkerPath } from '../../src/drivers/ssh/bootstrap'

const config: CloudConfig = {
  project: { name: 'Pi App', slug: 'pi-app', region: 'home' },
  environments: { production: { type: 'production' } },
  cloud: { provider: 'ssh' },
  ssh: { hosts: [{ host: 'pi.local', user: 'pi' }], profile: 'raspberry-pi' },
  sites: {
    web: {
      domain: 'pi-app.example.com',
      port: 3000,
      root: '.output',
      start: 'bun run server.ts',
    },
  },
  infrastructure: {
    compute: {
      runtime: 'bun',
      proxy: { engine: 'rpx' },
      systemPackages: ['jq'],
    },
  },
}

const pi = (overrides: Partial<Parameters<typeof buildSshBootstrapScript>[0]> = {}) =>
  buildSshBootstrapScript({ config, environment: 'production', profile: 'raspberry-pi', ...overrides })

describe('buildSshBootstrapScript', () => {
  it('never probes cloud-init: the driver decides that before the script runs', () => {
    const script = pi()
    expect(script).not.toContain('cloud-init status')
    expect(script).not.toContain('command -v cloud-init')
  })

  it('installs psmisc and ca-certificates alongside the configured packages', () => {
    const script = pi()
    expect(script).toMatch(/apt-get install -y jq psmisc ca-certificates/)
  })

  it('waits for time sync before anything touches apt', () => {
    const script = pi()
    const wait = script.indexOf('timedatectl show -p NTPSynchronized')
    const apt = script.indexOf('apt-get update')
    expect(wait).toBeGreaterThan(-1)
    expect(wait).toBeLessThan(apt)
    expect(script).toContain('seq 1 60')
    expect(script).toContain('systemctl start systemd-time-wait-sync')
  })

  it('is guarded by a version marker and refreshes only the gateway fragment on a rerun', () => {
    const script = pi()
    const marker = sshBootstrapMarkerPath()
    expect(marker).toBe(`/var/lib/ts-cloud/bootstrap.v${SSH_BOOTSTRAP_VERSION}`)
    expect(script).toContain(`if [ -e '${marker}' ]; then`)
    // The rerun branch carries the fragment refresh and exits before apt.
    const branch = script.slice(script.indexOf(`if [ -e '${marker}' ]`), script.indexOf('  exit 0\nfi'))
    expect(branch).toContain('/etc/rpx/sites.d/pi-app.json')
    expect(branch).not.toContain('apt-get')
    // The marker is written last.
    expect(script.lastIndexOf(`> '${marker}'`)).toBeGreaterThan(script.lastIndexOf('bun.sh/install'))
  })

  it('raspberry-pi: 1 GB swap and a bounded journal', () => {
    const script = pi()
    expect(script).toContain('fallocate -l 1G /swapfile')
    expect(script).toContain('/etc/systemd/journald.conf.d/99-ts-cloud-sd.conf')
    expect(script).toContain('SystemMaxUse=128M')
    expect(script).toContain('MaxRetentionSec=7day')
    expect(script).toContain('Compress=yes')
    expect(script).toContain('systemctl restart systemd-journald')
  })

  it('an explicit compute.swapGb wins over the profile', () => {
    const explicit: CloudConfig = { ...config, infrastructure: { compute: { ...config.infrastructure!.compute, swapGb: 4 } } }
    expect(pi({ config: explicit })).toContain('fallocate -l 4G /swapfile')
  })

  it('generic: the shared recipe unchanged (2 GB swap, no journal drop-in)', () => {
    const script = pi({ profile: 'generic' })
    expect(script).toContain('fallocate -l 2G /swapfile')
    expect(script).not.toContain('99-ts-cloud-sd.conf')
  })

  it('a sudo user gets group-writable upload directories and its own authorized_keys', () => {
    const script = pi({ sudoUser: 'pi' })
    expect(script).toContain(`install -d -m 2775 -g "$(id -gn 'pi')" /var/ts-cloud/artifacts /var/ts-cloud/staging`)
    expect(script).toContain('/home/pi/.ssh/authorized_keys')
    expect(script).not.toContain('/root/.ssh/authorized_keys')
    expect(script).toContain(`chown -R 'pi':"$(id -gn 'pi')" '/home/pi/.ssh'`)
    // The directories are created before the shared recipe's mkdir -p, so
    // the mode is ours, not mkdir's default.
    expect(script.indexOf('install -d -m 2775')).toBeLessThan(script.indexOf('mkdir -p /var/www'))
  })

  it('root deploys keep root authorized_keys', () => {
    expect(pi()).toContain('/root/.ssh/authorized_keys')
  })

  it('refuses Vitess on an ARM host before contact, and on facts', () => {
    const vitess: CloudConfig = {
      ...config,
      infrastructure: { compute: { ...config.infrastructure!.compute, managedServices: { vitess: true } } },
    }
    expect(() => pi({ config: vitess })).toThrow('Vitess publishes only x86_64')
    expect(() => buildSshBootstrapScript({ config: vitess, environment: 'production', profile: 'generic', facts: { arch: 'aarch64' } })).toThrow(
      'Vitess publishes only x86_64',
    )
    expect(() => assertArchSupported(vitess, 'generic', 'x86_64')).not.toThrow()
    expect(() => assertArchSupported(config, 'raspberry-pi')).not.toThrow()
  })

  it('writes the gateway fragment to the same path as the Hetzner bootstrap', () => {
    const script = pi()
    const hetzner = generateUbuntuAppCloudInit({ runtime: 'bun' })
    expect(script).toContain('/etc/rpx/sites.d/pi-app.json')
    expect(script).toContain('bun add @stacksjs/rpx')
    // Same recipe underneath: the bun install and the deploy directories.
    for (const line of ['curl -fsSL https://bun.sh/install | bash', 'mkdir -p /var/www /var/ts-cloud/staging /var/ts-cloud/releases']) {
      expect(hetzner).toContain(line)
      expect(script).toContain(line)
    }
  })

  it('starts with one shebang and strips the shared recipe\'s own head', () => {
    const script = pi()
    expect(script.startsWith('#!/bin/bash\nset -euo pipefail\n')).toBe(true)
    // The shared recipe's `#!/bin/bash` + `set -euo pipefail` would land mid-script.
    expect(script.match(/^#!\/bin\/bash$/gm)).toHaveLength(1)
    expect(script).not.toContain('\n#!/bin/bash\n')
    const head = script.slice(0, script.indexOf('if [ -e'))
    expect(head.match(/^set -euo pipefail$/gm)).toHaveLength(1)
  })
})

/**
 * The generated script has to be valid bash, which only bash can decide.
 *
 * Every assertion above checks that some text is present. None of them can see
 * a here-document whose terminator is indented, and bash only accepts one at
 * column 0. That mistake is invisible in a string comparison and fatal on the
 * box: the terminator is not recognised, the rest of the script is swallowed as
 * document text, and the whole file dies with "unexpected end of file". It
 * shipped once, in the idempotence guard, which indented the fragment refresh
 * to match its enclosing `if`.
 */
describe('the generated bootstrap parses as bash', () => {
  const parse = async (script: string): Promise<{ ok: boolean, error: string }> => {
    const file = join(tmpdir(), `ts-cloud-bootstrap-${crypto.randomUUID()}.sh`)
    await Bun.write(file, script)
    try {
      const proc = Bun.spawn(['bash', '-n', file], { stdout: 'pipe', stderr: 'pipe' })
      const [error, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
      return { ok: code === 0, error }
    }
    finally {
      await Bun.file(file).delete().catch(() => {})
    }
  }

  it.each([['raspberry-pi'], ['generic']] as const)('parses for the %s profile', async (profile) => {
    const script = buildSshBootstrapScript({
      config: config,
      environment: 'production',
      profile,
      sudoUser: 'pi',
    })
    const result = await parse(script)
    expect(result.error).toBe('')
    expect(result.ok).toBe(true)
  })

  it('parses when run as root, with no sudo user', async () => {
    const script = buildSshBootstrapScript({ config: config, environment: 'production', profile: 'raspberry-pi' })
    expect((await parse(script)).ok).toBe(true)
  })

  it('closes the idempotence guard rather than losing it to a here-document', async () => {
    const script = buildSshBootstrapScript({
      config: config,
      environment: 'production',
      profile: 'raspberry-pi',
      sudoUser: 'pi',
    })
    const lines = script.split('\n')

    // Every here-document terminator must start at column 0, or bash keeps
    // reading and the guard's own `exit 0` and `fi` become document text.
    for (const [index, line] of lines.entries()) {
      const opener = /<<-?'?([A-Za-z_][A-Za-z0-9_]*)'?/.exec(line)
      if (!opener)
        continue

      const terminator = opener[1] as string
      const closes = lines.findIndex((candidate, at) => at > index && candidate === terminator)
      const indented = lines.findIndex((candidate, at) => at > index && candidate !== terminator && candidate.trim() === terminator)
      expect({ terminator, closes: closes !== -1, indentedInstead: indented !== -1 && (closes === -1 || indented < closes) })
        .toEqual({ terminator, closes: true, indentedInstead: false })
    }

    expect(lines.some(line => line === 'fi')).toBe(true)
  })
})
