import type { PreflightContext, SshPreflightFacts } from '../../src/drivers/ssh/preflight'
import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  evaluatePreflight,
  formatPreflightFindings,
  parsePreflightFacts,
  preflightFailed,
  SSH_PREFLIGHT_SCRIPT,
} from '../../src/drivers/ssh/preflight'

const GIB = 1024 ** 3

/** A Raspberry Pi 5 (8 GB) running Raspberry Pi OS Trixie, deploy user `pi`, clock synced. */
const pi5: SshPreflightFacts = {
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

const ctx: PreflightContext = { user: 'pi', profile: 'raspberry-pi' }
const codes = (facts: SshPreflightFacts, context: PreflightContext = ctx) =>
  evaluatePreflight(facts, context).map((f) => `${f.severity}:${f.code}`)

describe('evaluatePreflight', () => {
  it('passes a Pi 5 on Pi OS Trixie as user pi, reporting only the model', () => {
    const findings = evaluatePreflight(pi5, ctx)
    expect(preflightFailed(findings)).toBe(false)
    expect(findings.map((f) => f.code)).toEqual(['pi.model'])
    expect(findings[0].message).toBe('Raspberry Pi 5 Model B Rev 1.0')
  })

  it('arch.not-aarch64: refuses a 32-bit ARM image on the Pi profile, and x86_64 only on generic', () => {
    expect(codes({ ...pi5, arch: 'armv7l' })).toContain('error:arch.not-aarch64')
    expect(codes({ ...pi5, arch: 'x86_64' })).toContain('error:arch.not-aarch64')
    expect(codes({ ...pi5, arch: 'x86_64', piModel: '' }, { user: 'pi', profile: 'generic' })).not.toContain('error:arch.not-aarch64')
    expect(codes({ ...pi5, arch: 'arm64' })).not.toContain('error:arch.not-aarch64')
  })

  it('os.unsupported: anything outside the debian family', () => {
    expect(codes({ ...pi5, osId: 'alpine', osIdLike: '' })).toContain('error:os.unsupported')
    expect(codes({ ...pi5, osId: 'ubuntu', osIdLike: 'debian' })).not.toContain('error:os.unsupported')
    expect(codes({ ...pi5, osId: 'raspbian', osIdLike: '' })).not.toContain('error:os.unsupported')
  })

  it('memory.low: an error under 1 GiB, a warning under 2 GiB', () => {
    expect(codes({ ...pi5, memoryBytes: 0.5 * GIB })).toContain('error:memory.low')
    expect(codes({ ...pi5, memoryBytes: 1.5 * GIB })).toContain('warning:memory.low')
    expect(codes({ ...pi5, memoryBytes: 2 * GIB })).not.toContain('warning:memory.low')
  })

  it('disk.low: under 4 GiB free', () => {
    expect(codes({ ...pi5, diskFreeBytes: 3 * GIB })).toContain('error:disk.low')
  })

  it('sudo.missing: only for a non-root user that cannot sudo', () => {
    expect(codes({ ...pi5, sudoOk: false })).toContain('error:sudo.missing')
    expect(codes({ ...pi5, sudoOk: false }, { user: 'root', profile: 'raspberry-pi' })).not.toContain('error:sudo.missing')
  })

  it('time.unsynced: a warning, since the bootstrap waits for it', () => {
    expect(codes({ ...pi5, timeSynced: false })).toContain('warning:time.unsynced')
  })

  it('https.blocked: an error, since nothing can be downloaded', () => {
    expect(codes({ ...pi5, httpsOk: false })).toContain('error:https.blocked')
  })

  it('cloud-init.running: info only when cloud-init exists and is running', () => {
    expect(codes({ ...pi5, cloudInitStatus: 'status: running' })).toContain('info:cloud-init.running')
    expect(codes({ ...pi5, cloudInitPresent: false, cloudInitStatus: 'status: running' })).not.toContain('info:cloud-init.running')
  })

  it('bits.32: a 32-bit userland on a 64-bit kernel', () => {
    expect(codes({ ...pi5, kernelBits: 32 })).toContain('error:bits.32')
  })

  it('formats findings as a readable table', () => {
    const text = formatPreflightFindings(evaluatePreflight({ ...pi5, sudoOk: false, timeSynced: false }, ctx))
    expect(text).toContain('error   sudo.missing')
    expect(text).toContain('warning time.unsynced')
    expect(text).toContain("NOPASSWD:ALL' to /etc/sudoers.d/ts-cloud")
    expect(formatPreflightFindings([])).toBe('No findings.')
  })
})

describe('SSH_PREFLIGHT_SCRIPT', () => {
  it('produces one complete JSON document even on a machine missing most of the tools', () => {
    // Run locally: on macOS most probes (timedatectl, /proc, cloud-init) are
    // absent, which is exactly the case the script must tolerate.
    const output = execFileSync('bash', ['-c', SSH_PREFLIGHT_SCRIPT], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } })
    const facts = parsePreflightFacts(output)
    expect(typeof facts.os).toBe('string')
    expect(typeof facts.arch).toBe('string')
    expect(typeof facts.memoryBytes).toBe('number')
    expect(typeof facts.diskFreeBytes).toBe('number')
    expect(typeof facts.timeSynced).toBe('boolean')
    expect(typeof facts.sudoOk).toBe('boolean')
    expect(typeof facts.cloudInitPresent).toBe('boolean')
    expect(typeof facts.cloudInitStatus).toBe('string')
    expect(typeof facts.piModel).toBe('string')
    expect(typeof facts.kernelBits).toBe('number')
    expect(['sudo', 'user']).toContain(facts.privilege)
  })

  it('never invokes cloud-init to decide anything: it only reports', () => {
    expect(SSH_PREFLIGHT_SCRIPT).not.toContain('cloud-init status --wait')
  })

  it('parsePreflightFacts takes the last line and rejects garbage', () => {
    expect(parsePreflightFacts('motd noise\n{"arch":"aarch64"}\n').arch).toBe('aarch64')
    expect(() => parsePreflightFacts('nothing here')).toThrow('Preflight returned no facts')
    expect(() => parsePreflightFacts('{not json')).toThrow('malformed')
  })
})
