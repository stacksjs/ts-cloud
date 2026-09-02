import type { CloudConfig } from '@ts-cloud/core'
import type { SshDriverState } from '../../src/drivers/shared/driver-state'
import type { SshExecOptions, SshTransport } from '../../src/drivers/shared/ssh-transport'
import type { SshPreflightFacts } from '../../src/drivers/ssh/preflight'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setStateDir } from '@ts-cloud/core'
import { readDriverState } from '../../src/drivers/shared/driver-state'
import { SSH_BOOTSTRAP_VERSION } from '../../src/drivers/ssh/bootstrap'
import { assertSshComputeConfig, SshDriver } from '../../src/drivers/ssh/driver'
import { SSH_PREFLIGHT_SCRIPT } from '../../src/drivers/ssh/preflight'

const GIB = 1024 ** 3

const facts: SshPreflightFacts = {
  os: 'Debian GNU/Linux 13 (trixie)',
  osId: 'debian',
  osIdLike: '',
  osVersionId: '13',
  arch: 'aarch64',
  cpuCores: 4,
  memoryBytes: 8 * GIB,
  diskBytes: 64 * GIB,
  diskFreeBytes: 50 * GIB,
  dnsOk: true,
  cloudInitPresent: true,
  cloudInitStatus: 'status: done',
  timeSynced: true,
  httpsOk: true,
  sudoOk: true,
  kernelBits: 64,
  piModel: 'Raspberry Pi 5 Model B Rev 1.0',
  lanIp: '192.168.1.42',
  tools: { curl: true, tar: true },
  privilege: 'sudo',
}

type Call =
  | { kind: 'exec'; host: string; script: string; sudo?: boolean }
  | { kind: 'scp'; host: string; localPath: string; remotePath: string }
  | { kind: 'probe'; host: string }
  | { kind: 'ensureHostKey'; host: string }

/** Records every call; answers exec by looking at the script it was given. */
class FakeTransport implements SshTransport {
  calls: Call[] = []
  facts: SshPreflightFacts = facts
  cached = false
  cloudInitPolls = ['status: done']
  failing: RegExp | null = null

  async exec(host: string, script: string, options: SshExecOptions = {}): Promise<string> {
    this.calls.push({ kind: 'exec', host, script, sudo: options.sudo })
    if (this.failing?.test(script)) throw new Error('Remote SSH command failed (exit 1)\nno psql on this box')
    if (script === SSH_PREFLIGHT_SCRIPT) return `motd\n${JSON.stringify(this.facts)}\n`
    if (script.includes('cloud-init status --long')) return this.cloudInitPolls.shift() ?? 'status: done'
    if (script.includes('test -s') && !this.cached) throw new Error('Remote SSH command failed (exit 1)')
    return '[ts-cloud] ok\n'
  }

  async scp(host: string, localPath: string, remotePath: string): Promise<void> {
    this.calls.push({ kind: 'scp', host, localPath, remotePath })
  }

  async probe(host: string): Promise<boolean> {
    this.calls.push({ kind: 'probe', host })
    return true
  }

  async ensureHostKey(host: string): Promise<{ fingerprint: string; pinnedNow: boolean }> {
    this.calls.push({ kind: 'ensureHostKey', host })
    return { fingerprint: 'SHA256:abc', pinnedNow: true }
  }

  execs(): Array<Call & { kind: 'exec' }> {
    return this.calls.filter((call): call is Call & { kind: 'exec' } => call.kind === 'exec')
  }
}

const config: CloudConfig = {
  project: { name: 'Pi App', slug: 'pi-app', region: 'home' },
  environments: { production: { type: 'production' } },
  cloud: { provider: 'ssh' },
  ssh: { hosts: [{ host: 'pi.local', user: 'pi' }], profile: 'raspberry-pi' },
  sites: { web: { domain: 'pi-app.example.com', port: 3000, root: '.output', start: 'bun run server.ts' } },
  infrastructure: { compute: { runtime: 'bun', proxy: { engine: 'rpx' } } },
}

let cwd: string
let transport: FakeTransport
const ENV = ['TS_CLOUD_SSH_HOST', 'TS_CLOUD_SSH_USER', 'TS_CLOUD_SSH_PORT', 'TS_CLOUD_SSH_KEY', 'TS_CLOUD_SSH_HOST_KEY', 'TS_CLOUD_SSH_PROFILE', 'TS_CLOUD_SSH_SKIP_BOOTSTRAP', 'TS_CLOUD_STATE_DIR']

function driver(overrides: Partial<ConstructorParameters<typeof SshDriver>[0]> = {}): SshDriver {
  return new SshDriver({
    hosts: config.ssh!.hosts,
    profile: 'raspberry-pi',
    transport,
    cwd,
    bootWait: { sshIntervalMs: 1, sshTimeoutMs: 50, cloudInitIntervalMs: 1, cloudInitTimeoutMs: 50 },
    ...overrides,
  })
}

beforeEach(() => {
  for (const name of ENV) delete process.env[name]
  setStateDir(null)
  cwd = mkdtempSync(join(tmpdir(), 'ts-cloud-ssh-driver-'))
  transport = new FakeTransport()
})
afterEach(() => {
  for (const name of ENV) delete process.env[name]
  setStateDir(null)
  rmSync(cwd, { recursive: true, force: true })
})

describe('SshDriver targets and outputs', () => {
  it('reports the single configured host as the app target', async () => {
    expect(await driver().findComputeTargets({ slug: 'pi-app', environment: 'production' })).toEqual([
      { id: 'pi.local', name: 'pi.local', publicIp: 'pi.local', status: 'running' },
    ])
  })

  it('answers only app-role queries', async () => {
    expect(await driver().findComputeTargets({ slug: 'pi-app', environment: 'production', role: 'lb' })).toEqual([])
    expect(await driver().findComputeTargets({ slug: 'pi-app', environment: 'production', role: 'services' })).toEqual([])
  })

  it('produces outputs without touching the network', async () => {
    expect(await driver().getComputeOutputs()).toEqual({
      appInstanceId: 'pi.local',
      appPublicIp: 'pi.local',
      sshUser: 'pi',
      deployStoragePath: '/var/ts-cloud/staging',
    })
    expect(transport.calls).toEqual([])
  })

  it('refuses more than one host', async () => {
    const two = driver({ hosts: [{ host: 'a.local' }, { host: 'b.local' }] })
    await expect(two.findComputeTargets({ slug: 'pi-app', environment: 'production' })).rejects.toThrow('multi-host ssh fleets are not supported yet')
  })
})

describe('SshDriver.uploadRelease', () => {
  let tarball: string
  beforeEach(() => {
    tarball = join(cwd, 'release.tar.gz')
    writeFileSync(tarball, 'fake tarball')
  })

  const upload = () => driver().uploadRelease({ config, environment: 'production', localPath: tarball, remoteKey: 'releases/web/abc123.tar.gz' })

  it('serves a cache hit from the host without scp', async () => {
    transport.cached = true
    const result = await upload()
    expect(transport.calls.filter((c) => c.kind === 'scp')).toHaveLength(0)
    expect(transport.execs()).toHaveLength(1)
    expect(transport.execs()[0].script).toContain("test -s '/var/ts-cloud/artifacts/")
    expect(result.artifactRef).toMatch(/^\/var\/ts-cloud\/staging\/web-abc123-[0-9a-f-]{36}\.tar\.gz$/)
  })

  it('uploads to a nonce path and publishes atomically on a cache miss', async () => {
    await upload()
    const scp = transport.calls.find((c): c is Call & { kind: 'scp' } => c.kind === 'scp')!
    expect(scp.localPath).toBe(tarball)
    expect(scp.remotePath).toMatch(/^\/var\/ts-cloud\/artifacts\/\.[0-9a-f]{64}-[0-9a-f-]{36}\.tmp$/)
    const publish = transport.execs()[1].script
    expect(publish).toContain(`mv -f -- '${scp.remotePath}' '/var/ts-cloud/artifacts/`)
    expect(publish).toContain('-mtime +7 -delete')
  })

  it('stages every upload under a unique name', async () => {
    const [a, b] = [await upload(), await upload()]
    expect(a.artifactRef).not.toBe(b.artifactRef)
    expect(a.artifactRef).toContain('web-abc123-')
  })

  it('runs its host-side scripts through sudo for a non-root user, and not for root', async () => {
    await upload()
    expect(transport.execs().every((call) => call.sudo === true)).toBe(true)

    transport = new FakeTransport()
    await driver({ hosts: [{ host: 'pi.local', user: 'root' }] }).uploadRelease({ config, environment: 'production', localPath: tarball, remoteKey: 'releases/web/abc.tar.gz' })
    expect(transport.execs().every((call) => call.sudo === false)).toBe(true)
  })
})

describe('SshDriver.runRemoteDeploy', () => {
  it('runs the joined script on each target and reports success', async () => {
    const result = await driver().runRemoteDeploy({ targets: [{ id: 'pi.local', publicIp: 'pi.local' }], commands: ['echo a', 'echo b'] })
    expect(result.success).toBe(true)
    expect(transport.execs()[0].script).toBe('echo a\necho b')
    expect(result.perInstance[0]).toMatchObject({ instanceId: 'pi.local', status: 'Success' })
  })

  it('summarises a failing host into the error', async () => {
    transport.failing = /echo a/
    const result = await driver().runRemoteDeploy({ targets: [{ id: 'pi.local', publicIp: 'pi.local' }], commands: ['echo a'] })
    expect(result.success).toBe(false)
    expect(result.error).toContain('One or more SSH deploy commands failed')
    expect(result.error).toContain('pi.local: Failed')
    expect(result.error).toContain('no psql on this box')
  })
})

describe('SshDriver.provisionComputeInfrastructure (LAN TLS)', () => {
  const lanConfig: CloudConfig = { ...config, ssh: { ...config.ssh!, lan: { hostname: 'pi-app.local' } } }

  it('reports where the LAN certificate authority lives, so it can be trusted', async () => {
    const outputs = await driver({ lan: { hostname: 'pi-app.local' } }).provisionComputeInfrastructure({
      config: lanConfig,
      environment: 'production',
    })
    expect(outputs.lanCaCertPath).toBe('/etc/rpx/local-ca/rpx-root-ca.crt')
  })

  it('puts the preflight address on the certificate as an iPAddress SAN', async () => {
    await driver({ lan: { hostname: 'pi-app.local' } }).provisionComputeInfrastructure({
      config: lanConfig,
      environment: 'production',
    })
    const bootstrap = transport.execs().at(-1)!
    expect(bootstrap.script).toContain('"192.168.1.42"')
    expect(bootstrap.script).toContain('"dir": "/etc/rpx/local-ca"')
  })

  it('reports no CA path when the operator chose plain HTTP', async () => {
    const outputs = await driver({ lan: { hostname: 'pi-app.local', tls: 'off' } }).provisionComputeInfrastructure({
      config: { ...config, ssh: { ...config.ssh!, lan: { hostname: 'pi-app.local', tls: 'off' } } },
      environment: 'production',
    })
    expect(outputs.lanCaCertPath).toBeUndefined()
  })

  it('reports no CA path for a host with no LAN configuration', async () => {
    const outputs = await driver().provisionComputeInfrastructure({ config, environment: 'production' })
    expect(outputs.lanCaCertPath).toBeUndefined()
  })
})

describe('SshDriver.provisionComputeInfrastructure (adopt)', () => {
  it('pins, waits, checks, bootstraps and records, in that order', async () => {
    const outputs = await driver().provisionComputeInfrastructure({ config, environment: 'production' })
    expect(outputs.appPublicIp).toBe('pi.local')

    const kinds = transport.calls.map((call) => call.kind)
    expect(kinds).toEqual(['ensureHostKey', 'probe', 'exec', 'exec'])
    const [preflight, bootstrap] = transport.execs()
    expect(preflight.script).toBe(SSH_PREFLIGHT_SCRIPT)
    expect(preflight.sudo).toBe(false)
    expect(bootstrap.script.startsWith('#!/bin/bash')).toBe(true)
    expect(bootstrap.script).toContain('99-ts-cloud-sd.conf')
    expect(bootstrap.script).toContain('/home/pi/.ssh/authorized_keys')
    expect(bootstrap.sudo).toBe(true)

    const state = await readDriverState('pi-app-production', cwd)
    expect(state).toMatchObject({
      provider: 'ssh',
      host: 'pi.local',
      sshUser: 'pi',
      sshPort: 22,
      hostKeyFingerprint: 'SHA256:abc',
      lanIp: '192.168.1.42',
      profile: 'raspberry-pi',
      bootstrapVersion: SSH_BOOTSTRAP_VERSION,
    })
    expect(state && 'bootstrappedAt' in state ? state.bootstrappedAt : undefined).toMatch(/^\d{4}-/)
  })

  it('waits for cloud-init only when it is present and running', async () => {
    transport.facts = { ...facts, cloudInitStatus: 'status: running' }
    transport.cloudInitPolls = ['status: running', 'status: done']
    await driver().provisionComputeInfrastructure({ config, environment: 'production' })
    const polls = transport.execs().filter((call) => call.script.includes('cloud-init status --long'))
    expect(polls).toHaveLength(2)
    expect(polls.every((call) => call.sudo === false)).toBe(true)
    // Bootstrap still ran, after the polls.
    expect(transport.execs().at(-1)!.script.startsWith('#!/bin/bash')).toBe(true)

    transport = new FakeTransport()
    transport.facts = { ...facts, cloudInitPresent: false, cloudInitStatus: '' }
    await driver().provisionComputeInfrastructure({ config, environment: 'production' })
    expect(transport.execs().some((call) => call.script.includes('cloud-init status --long'))).toBe(false)
  })

  it('refuses a host that fails the preflight, before any bootstrap', async () => {
    transport.facts = { ...facts, httpsOk: false, sudoOk: false }
    await expect(driver().provisionComputeInfrastructure({ config, environment: 'production' })).rejects.toThrow(/Preflight failed for pi\.local[\s\S]*sudo\.missing[\s\S]*https\.blocked/)
    expect(transport.execs()).toHaveLength(1)
    expect(await readDriverState('pi-app-production', cwd)).toBeNull()
  })

  it('skips the bootstrap when asked and state carries the current version', async () => {
    await driver().provisionComputeInfrastructure({ config, environment: 'production' })
    const first = await readDriverState('pi-app-production', cwd)
    transport = new FakeTransport()
    process.env.TS_CLOUD_SSH_SKIP_BOOTSTRAP = '1'
    await driver().provisionComputeInfrastructure({ config, environment: 'production' })
    expect(transport.execs().map((call) => call.script === SSH_PREFLIGHT_SCRIPT)).toEqual([true])
    const second = await readDriverState('pi-app-production', cwd)
    expect(second && 'bootstrappedAt' in second ? second.bootstrappedAt : null).toBe(first && 'bootstrappedAt' in first ? first.bootstrappedAt! : null)
  })

  it('rejects attachTo and multi-host configs before contact', async () => {
    await expect(driver().provisionComputeInfrastructure({ config: { ...config, cloud: { provider: 'ssh', attachTo: 'stacks' } }, environment: 'production' })).rejects.toThrow('cloud.attachTo is not supported')
    await expect(driver({ hosts: [{ host: 'a' }, { host: 'b' }] }).provisionComputeInfrastructure({ config, environment: 'production' })).rejects.toThrow('multi-host')
    expect(transport.calls).toEqual([])
  })

  it('rejects Vitess on the raspberry-pi profile before contact', async () => {
    const vitess: CloudConfig = { ...config, infrastructure: { compute: { runtime: 'bun', managedServices: { vitess: true } } } }
    await expect(driver().provisionComputeInfrastructure({ config: vitess, environment: 'production' })).rejects.toThrow('Vitess publishes only x86_64')
    expect(transport.calls).toEqual([])
  })

  it('warns about sizing keys it ignores', () => {
    const sized: CloudConfig = { ...config, infrastructure: { compute: { runtime: 'bun', size: 'small', appServers: 2, allowSsh: false } } }
    const warnings = assertSshComputeConfig(sized, { hosts: [{ host: 'pi.local', user: 'pi', port: 22, privateKeyPath: '/k', role: 'app' }], profile: 'generic' })
    expect(warnings.map((w) => w.split(' ')[0])).toEqual(['infrastructure.compute.size', 'infrastructure.compute.appServers', 'infrastructure.compute.allowSsh'])
  })
})

describe('SshDriver.destroyCompute', () => {
  it('clears local state only and touches nothing on the host', async () => {
    await driver().provisionComputeInfrastructure({ config, environment: 'production' })
    transport = new FakeTransport()
    const result = await driver().destroyCompute({ config, environment: 'production' })
    expect(result.destroyed).toEqual(['local state for pi-app-production'])
    expect(transport.calls).toEqual([])
    const state = await readDriverState<SshDriverState>('pi-app-production', cwd)
    expect(state?.provider).toBe('ssh')
    expect(state?.host).toBe('pi.local')
    expect(state?.bootstrapVersion).toBeUndefined()
    expect(state?.hostKeyFingerprint).toBeUndefined()
  })
})
