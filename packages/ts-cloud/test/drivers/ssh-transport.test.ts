import type { CommandResult, SshTransportOptions } from '../../src/drivers/shared/ssh-transport'
import { describe, expect, it } from 'bun:test'
import {
  buildScpArgsFor,
  buildSshArgsFor,
  findKnownHostKey,
  knownHostsLine,
  scanHostKey,
  SSH_INSECURE_HOST_KEY_OPTS,
  sshHostKeyFingerprint,
  SystemSshTransport,
} from '../../src/drivers/shared/ssh-transport'

const KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExampleEx'
const FINGERPRINT = sshHostKeyFingerprint(KEY)

const pinned: SshTransportOptions = {
  user: 'pi',
  port: 2222,
  identityFile: '/home/me/.ssh/id_ed25519',
  hostKey: { policy: 'pin', knownHostsFile: '/srv/app/.ts-cloud/ssh/known_hosts' },
}

function ok(stdout = ''): CommandResult {
  return { code: 0, stdout, stderr: '' }
}

/** A recording runner: every invocation, with the stdin it was given. */
function recorder(responses: Array<CommandResult | ((command: string[]) => CommandResult)> = []) {
  const calls: Array<{ command: string[]; input?: string }> = []
  const run = async (command: string[], input?: string): Promise<CommandResult> => {
    calls.push({ command, input })
    const next = responses.shift()
    if (typeof next === 'function') return next(command)
    return next ?? ok()
  }
  return { calls, run }
}

describe('ssh argument building', () => {
  it('passes the port, the identity and the pinned known_hosts to ssh', () => {
    const args = buildSshArgsFor(pinned, 'pi.local')
    expect(args.slice(0, 4)).toEqual(['-i', '/home/me/.ssh/id_ed25519', '-p', '2222'])
    expect(args).toContain('StrictHostKeyChecking=yes')
    expect(args).toContain('UserKnownHostsFile=/srv/app/.ts-cloud/ssh/known_hosts')
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('ServerAliveInterval=15')
    expect(args.at(-1)).toBe('pi@pi.local')
  })

  it('spells the port -P for scp', () => {
    const args = buildScpArgsFor(pinned, 'pi.local', '/tmp/release.tar.gz', '/var/ts-cloud/artifacts/.x.tmp')
    expect(args.slice(0, 4)).toEqual(['-i', '/home/me/.ssh/id_ed25519', '-P', '2222'])
    expect(args).not.toContain('-p')
    expect(args.slice(-2)).toEqual(['/tmp/release.tar.gz', 'pi@pi.local:/var/ts-cloud/artifacts/.x.tmp'])
  })

  it('defaults the port to 22', () => {
    expect(buildSshArgsFor({ ...pinned, port: undefined }, 'pi.local')).toContain('22')
  })

  it('uses accept-new with the same known_hosts file', () => {
    const args = buildSshArgsFor({ ...pinned, hostKey: { policy: 'accept-new', knownHostsFile: '/k' } }, 'pi.local')
    expect(args).toContain('StrictHostKeyChecking=accept-new')
    expect(args).toContain('UserKnownHostsFile=/k')
  })

  it('insecure is exactly what the cloud drivers pass', () => {
    const args = buildSshArgsFor({ ...pinned, hostKey: 'insecure' }, 'pi.local')
    const at = args.indexOf('StrictHostKeyChecking=no') - 1
    expect(args.slice(at, at + SSH_INSECURE_HOST_KEY_OPTS.length)).toEqual([...SSH_INSECURE_HOST_KEY_OPTS])
    expect(SSH_INSECURE_HOST_KEY_OPTS).toEqual([
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'LogLevel=ERROR',
    ])
  })
})

describe('known_hosts handling', () => {
  it('writes and finds [host]:port entries for a non-default port', () => {
    const line = knownHostsLine('pi.local', 2222, { algorithm: 'ssh-ed25519', key: KEY })
    expect(line).toBe(`[pi.local]:2222 ssh-ed25519 ${KEY}`)
    expect(findKnownHostKey(`${line}\n`, 'pi.local', 2222)).toEqual({ algorithm: 'ssh-ed25519', key: KEY })
    expect(findKnownHostKey(`${line}\n`, 'pi.local', 22)).toBeNull()
  })

  it('uses the bare host on port 22 and matches comma-separated host lists', () => {
    expect(knownHostsLine('pi.local', 22, { algorithm: 'ssh-ed25519', key: KEY })).toBe(`pi.local ssh-ed25519 ${KEY}`)
    expect(findKnownHostKey(`pi.local,192.168.1.7 ssh-ed25519 ${KEY}\n`, '192.168.1.7', 22)?.key).toBe(KEY)
  })

  it('parses ssh-keyscan output and fails loudly on none', async () => {
    const { calls, run } = recorder([ok(`# pi.local:2222 SSH-2.0\n[pi.local]:2222 ssh-ed25519 ${KEY}\n`)])
    expect(await scanHostKey('pi.local', 2222, run)).toEqual({ algorithm: 'ssh-ed25519', key: KEY })
    expect(calls[0].command).toEqual(['ssh-keyscan', '-T', '10', '-p', '2222', '-t', 'ed25519', 'pi.local'])

    const empty = recorder([{ code: 1, stdout: '', stderr: 'connection refused' }])
    await expect(scanHostKey('pi.local', 2222, empty.run)).rejects.toThrow('SSH host-key scan failed: connection refused')
  })
})

describe('SystemSshTransport.ensureHostKey', () => {
  it('pins on first contact: scans, appends, reports the fingerprint', async () => {
    const appended: string[] = []
    const transport = new SystemSshTransport(pinned, {
      scan: async () => ({ algorithm: 'ssh-ed25519', key: KEY }),
      readKnownHosts: async () => '',
      appendKnownHosts: async (_file, line) => {
        appended.push(line)
      },
    })
    expect(await transport.ensureHostKey('pi.local')).toEqual({ fingerprint: FINGERPRINT, pinnedNow: true })
    expect(appended).toEqual([`[pi.local]:2222 ssh-ed25519 ${KEY}`])
  })

  it('is strict once pinned: no scan, no write, the recorded key', async () => {
    let scanned = 0
    const transport = new SystemSshTransport(pinned, {
      scan: async () => {
        scanned++
        return { algorithm: 'ssh-ed25519', key: 'AAAAother' }
      },
      readKnownHosts: async () => `[pi.local]:2222 ssh-ed25519 ${KEY}\n`,
      appendKnownHosts: async () => {
        throw new Error('must not write')
      },
    })
    expect(await transport.ensureHostKey('pi.local')).toEqual({ fingerprint: FINGERPRINT, pinnedNow: false })
    expect(scanned).toBe(0)
  })

  it('accept-new learns the fingerprint but leaves the recording to ssh', async () => {
    const transport = new SystemSshTransport(
      { ...pinned, hostKey: { policy: 'accept-new', knownHostsFile: '/k' } },
      {
        scan: async () => ({ algorithm: 'ssh-ed25519', key: KEY }),
        readKnownHosts: async () => '',
        appendKnownHosts: async () => {
          throw new Error('must not write')
        },
      },
    )
    expect(await transport.ensureHostKey('pi.local')).toEqual({ fingerprint: FINGERPRINT, pinnedNow: false })
  })

  it('insecure never fails on a scan it cannot do', async () => {
    const transport = new SystemSshTransport(
      { ...pinned, hostKey: 'insecure' },
      {
        scan: async () => {
          throw new Error('no ssh-keyscan')
        },
      },
    )
    expect(await transport.ensureHostKey('pi.local')).toEqual({ fingerprint: '', pinnedNow: false })
  })
})

describe('SystemSshTransport.exec', () => {
  it('feeds the script over stdin to the staged runner, sudo variant on request', async () => {
    const { calls, run } = recorder([ok('done\n'), ok('done\n')])
    const transport = new SystemSshTransport(pinned, { run })
    expect(await transport.exec('pi.local', 'echo hi')).toBe('done\n')
    expect(calls[0].command[0]).toBe('ssh')
    expect(calls[0].command.at(-2)).toBe('pi@pi.local')
    expect(calls[0].command.at(-1)).toContain('bash "$ts_cloud_script" < /dev/null')
    expect(calls[0].command.at(-1)).not.toContain('sudo')
    expect(calls[0].input).toBe('echo hi')

    await transport.exec('pi.local', 'echo hi', { sudo: true })
    expect(calls[1].command.at(-1)).toContain('sudo -n -H bash "$ts_cloud_script" < /dev/null')
  })

  it('reports a failure without echoing the script', async () => {
    const { run } = recorder([{ code: 1, stdout: '', stderr: 'DB_PASSWORD=hunter2\nservice failed its health gate' }])
    const transport = new SystemSshTransport(pinned, { run })
    const error = await transport.exec('pi.local', 'APP_SECRET=do-not-log\nfalse').catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('Remote SSH command failed (exit 1)')
    expect((error as Error).message).toContain('service failed its health gate')
    expect((error as Error).message).not.toContain('hunter2')
    expect((error as Error).message).not.toContain('do-not-log')
  })
})

describe('SystemSshTransport.scp and probe', () => {
  it('retries scp three times before giving up', async () => {
    const failure = { code: 1, stdout: '', stderr: 'lost connection' }
    const { calls, run } = recorder([failure, failure, ok()])
    const transport = new SystemSshTransport(pinned, { run })
    await transport.scp('pi.local', '/tmp/r.tar.gz', '/var/ts-cloud/artifacts/.x.tmp')
    expect(calls).toHaveLength(3)
    expect(calls[0].command[0]).toBe('scp')
    expect(calls[0].command).toContain('-P')

    const exhausted = recorder([failure, failure, failure])
    await expect(new SystemSshTransport(pinned, { run: exhausted.run }).scp('pi.local', '/tmp/r.tar.gz', '/x')).rejects.toThrow('lost connection')
    expect(exhausted.calls).toHaveLength(3)
  })

  it('probes with a short connect timeout and a trivial command', async () => {
    const { calls, run } = recorder([ok(), { code: 255, stdout: '', stderr: 'refused' }])
    const transport = new SystemSshTransport(pinned, { run })
    expect(await transport.probe('pi.local')).toBe(true)
    expect(calls[0].command).toContain('ConnectTimeout=5')
    expect(calls[0].command.at(-1)).toBe('true')
    expect(await transport.probe('pi.local')).toBe(false)
  })
})
