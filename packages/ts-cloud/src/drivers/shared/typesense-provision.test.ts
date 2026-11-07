import { expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServicesProvisionScript } from './db-provision'
import { buildOwnedServicesReconcileScript } from './compute-provision'
import { buildManagedServicesProbeScript, declaredManagedServices } from './managed-services-probe'
import { buildTypesenseEnv, buildTypesenseProvisionScript } from './typesense-provision'

const key = 'fixture-typesense-administrator-key-0123456789'

it('provisions the declared Typesense engine instead of silently ignoring it', () => {
  const script = buildServicesProvisionScript({ typesense: { version: '30.2', apiKey: key } }).join('\n')
  expect(script).toContain('typesense.org@30.2')
  expect(script).toContain('EnvironmentFile=/etc/ts-cloud/typesense.env')
  expect(script).toContain('--api-address 127.0.0.1')
})

it('reconciles declared search on reused owned hosts and leaves attached hosts alone', () => {
  const config = { environments: {}, project: { name: 'owned', slug: 'owned', region: 'fsn1' }, cloud: { provider: 'hetzner' as const }, infrastructure: { compute: { managedServices: { typesense: { apiKey: key, version: '30.2' } } } } }
  expect(buildOwnedServicesReconcileScript(config, 'production').join('\n')).toContain('EnvironmentFile=/etc/ts-cloud/typesense.env')
  expect(buildOwnedServicesReconcileScript({ ...config, cloud: { ...config.cloud, attachTo: 'another-owner' } }, 'production')).toEqual([])
  expect(buildOwnedServicesReconcileScript({ ...config, infrastructure: {} }, 'production')).toEqual([])
})

it('leaves undeclared search alone and rejects unsafe or unauthenticated declarations', () => {
  expect(buildTypesenseProvisionScript(undefined)).toEqual([])
  expect(buildTypesenseProvisionScript(false)).toEqual([])
  expect(buildTypesenseEnv(undefined)).toEqual({})
  for (const value of [true, {}, { apiKey: 'xyz' }, { apiKey: `${key}\nOTHER=1` }, { apiKey: key, version: '30.2;whoami' }, { apiKey: key, bindAddress: 'localhost;whoami' }, { apiKey: key, port: 1 }])
    expect(() => buildTypesenseProvisionScript(value as any)).toThrow('managedServices.typesense')
  expect(() => buildTypesenseProvisionScript({ apiKey: key }, { bindPrivate: true })).toThrow('explicit private bindAddress')
  expect(buildTypesenseProvisionScript({ apiKey: key, bindAddress: '10.0.0.4' }, { bindPrivate: true }).join('\n')).toContain('--api-address 10.0.0.4')
})

it('wires matching authenticated application settings and custom attach-mode probes', () => {
  const config = { apiKey: key, port: 8208 }
  expect(buildTypesenseEnv(config)).toEqual({ TYPESENSE_HOST: '127.0.0.1', TYPESENSE_PORT: '8208', TYPESENSE_PROTOCOL: 'http', TYPESENSE_API_KEY: key })
  expect(buildTypesenseEnv({ ...config, bindAddress: '10.0.0.4' }, '10.0.0.4').TYPESENSE_HOST).toBe('10.0.0.4')
  expect(declaredManagedServices({ typesense: config })).toEqual(['typesense'])
  expect(declaredManagedServices({ typesense: false })).toEqual([])
  expect(buildManagedServicesProbeScript(['typesense'], { typesense: config }).join('\n')).toContain('ts_cloud_probe typesense 8208 typesense-server')
})

/** Run the actual generated POSIX shell against owned files and simulated OS
 * commands. No system service, user, package or listener on the host is touched. */
function withProvisionFixture(run: (fixture: { root: string, execute: (config?: { apiKey: string, port?: number }) => Bun.SyncSubprocess<'pipe', 'pipe'>, calls: () => string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'typesense-provision-'))
  const bin = join(root, 'bin')
  const writeCommand = (name: string, body: string): void => {
    const file = join(bin, name)
    writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`)
    chmodSync(file, 0o755)
  }
  try {
    mkdirSync(bin)
    mkdirSync(join(root, 'etc/systemd/system'), { recursive: true })
    mkdirSync(join(root, 'opt/pantry'), { recursive: true })
    mkdirSync(join(root, 'var/lock'), { recursive: true })
    writeCommand('pantry', 'if [ "$1" = env ]; then printf \'export LD_LIBRARY_PATH=/fixture/libs\\n\'; fi')
    writeCommand('typesense-server', 'exit 0')
    // The fixture binary is already a regular file; the Linux resolver's
    // contract here is just to return its absolute executable path.
    writeCommand('readlink', 'printf \'%s\\n\' "$2"')
    writeCommand('ss', 'cat "$FIXTURE_ROOT/listeners" 2>/dev/null || true')
    writeCommand('id', 'exit 0')
    writeCommand('sleep', 'exit 0')
    writeCommand('flock', 'exit 0')
    writeCommand('sha256sum', process.platform === 'darwin' ? 'exec /usr/bin/shasum -a 256 "$@"' : 'exec /usr/bin/sha256sum "$@"')
    writeCommand('systemctl', `printf '%s\\n' "$*" >> "$FIXTURE_ROOT/calls"
case "$1" in
  is-active) test -f "$FIXTURE_ROOT/active" ;;
  show) if [ -f "$FIXTURE_ROOT/active" ]; then echo 111; else echo 0; fi ;;
  restart) sed -n 's/^TYPESENSE_API_KEY=//p' "$FIXTURE_ROOT/etc/ts-cloud/typesense.env" > "$FIXTURE_ROOT/active-key"; touch "$FIXTURE_ROOT/active" ;;
esac`)
    writeCommand('curl', `case "$*" in
  */health) printf '{"ok":true}'; exit 0 ;;
  *) input=$(cat); test ! -f "$FIXTURE_ROOT/auth-failure"; expected=$(cat "$FIXTURE_ROOT/active-key"); test "$input" = "header = \\"X-TYPESENSE-API-KEY: $expected\\"" ;;
esac`)
    const calls = (): string => existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8') : ''
    const execute = (config = { apiKey: key }): Bun.SyncSubprocess<'pipe', 'pipe'> => {
      const script = buildTypesenseProvisionScript(config).join('\n')
        .replaceAll('/etc/', `${root}/etc/`).replaceAll('/opt/pantry', `${root}/opt/pantry`)
        .replaceAll('/var/lock/', `${root}/var/lock/`)
      return Bun.spawnSync(['sh', '-c', script], { env: { PATH: `${bin}:/usr/bin:/bin`, FIXTURE_ROOT: root }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    }
    run({ root, execute, calls })
  }
  finally { rmSync(root, { recursive: true, force: true }) }
}

it('installs private credentials once, preserves them on replay and keeps them out of units and output', () => {
  withProvisionFixture(({ root, execute, calls }) => {
    const first = execute()
    expect(first.exitCode).toBe(0)
    const environment = join(root, 'etc/ts-cloud/typesense.env')
    expect(statSync(environment).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'etc/ts-cloud/typesense.applied')).mode & 0o777).toBe(0o600)
    const before = statSync(environment).ino
    expect(readFileSync(environment, 'utf8')).toContain(`TYPESENSE_API_KEY=${key}`)
    const unit = readFileSync(join(root, 'etc/systemd/system/ts-cloud-typesense.service'), 'utf8')
    expect(unit).not.toContain(key)
    expect(unit).toContain('StateDirectoryMode=0700')
    expect(unit).toContain('User=ts-cloud-typesense')
    expect(Buffer.from(first.stdout).toString() + Buffer.from(first.stderr).toString()).not.toContain(key)
    expect(execute().exitCode).toBe(0)
    expect(statSync(environment).ino).toBe(before)
    expect(calls().match(/restart ts-cloud-typesense.service/g)).toHaveLength(1)
  })
})

it('refuses foreign listeners and unknown units before writing a key or restarting anything', () => {
  withProvisionFixture(({ root, execute, calls }) => {
    writeFileSync(join(root, 'listeners'), 'LISTEN 0 128 127.0.0.1:8108 0.0.0.0:* users:(("foreign",pid=42,fd=1))\n')
    expect(execute().exitCode).not.toBe(0)
    expect(existsSync(join(root, 'etc/ts-cloud/typesense.env'))).toBe(false)
    expect(calls()).not.toContain('restart')
    writeFileSync(join(root, 'listeners'), '')
    writeFileSync(join(root, 'etc/systemd/system/ts-cloud-typesense.service'), '# another owner\n')
    expect(execute().exitCode).not.toBe(0)
    expect(calls()).not.toContain('restart')
  })
})

it('rejects a healthy listener that refuses the configured administrator key', () => {
  withProvisionFixture(({ root, execute }) => {
    writeFileSync(join(root, 'auth-failure'), '')
    const result = execute()
    expect(result.exitCode).not.toBe(0)
    expect(Buffer.from(result.stderr).toString()).toContain('Authenticated Typesense readiness failed')
    expect(Buffer.from(result.stderr).toString()).not.toContain(key)
  })
})

it('recovers a credential update interrupted before the service restarted', () => {
  withProvisionFixture(({ root, execute, calls }) => {
    expect(execute().exitCode).toBe(0)
    const nextKey = 'fixture-next-typesense-administrator-key-0123456789'
    const environment = join(root, 'etc/ts-cloud/typesense.env')
    // The first attempt installed its new file, then lost its process before
    // restarting. The old process still authenticates with its old key.
    writeFileSync(environment, readFileSync(environment, 'utf8').replace(key, nextKey))
    const result = execute({ apiKey: nextKey })
    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(root, 'active-key'), 'utf8').trim()).toBe(nextKey)
    expect(calls().match(/restart ts-cloud-typesense.service/g)).toHaveLength(2)
  })
})
