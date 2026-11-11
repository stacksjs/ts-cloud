import { describe, expect, it } from 'bun:test'
import { interactiveSshOptions } from '../drivers/shared/ssh-transport'
import { buildRemoteCommandLine, buildSshCommand, shellQuoteArg, shellQuoteArgv, spawnProcessStream, streamSshCommand } from './process-stream'

const via = {
  host: '2001:db8::1',
  ssh: interactiveSshOptions({ user: 'deploy', identityFile: '/keys/id', port: 2222, hostKeyPolicy: 'pin', knownHostsFile: '/state/known_hosts' }),
}

describe('shell quoting', () => {
  it('quotes every argument, including the ones that look safe', () => {
    expect(shellQuoteArg('plain')).toBe(`'plain'`)
    expect(shellQuoteArg('')).toBe(`''`)
    expect(shellQuoteArg(`it's`)).toBe(`'it'\\''s'`)
    expect(shellQuoteArgv(['bun', 'run', '-'])).toBe(`'bun' 'run' '-'`)
    expect(() => shellQuoteArg('a\0b')).toThrow(/NUL/)
    expect(() => shellQuoteArgv([])).toThrow(/empty/)
  })

  it('round-trips through a real shell', async () => {
    const argv = ['printf', '%s|', 'a b', '$HOME', '`id`', '$(id)', `'"`, '*', 'x\ny', '']
    const result = await spawnProcessStream(['sh', '-c', shellQuoteArgv(argv)]).collect()
    expect(result.stdout).toBe(`a b|$HOME|\`id\`|$(id)|'"|*|x\ny||`)
  })
})

describe('remote command line', () => {
  it('execs the command so a closed connection takes it along', () => {
    expect(buildRemoteCommandLine(['bun', 'run', '-'])).toBe(`exec 'bun' 'run' '-'`)
  })

  it('changes directory, sets variables and elevates, in that order', () => {
    expect(buildRemoteCommandLine(['bun', 'run', '-'], { cwd: '/var/www/acme-api/current', env: { NODE_ENV: 'production', NOTE: `it's` }, sudo: true })).toBe(
      `cd '/var/www/acme-api/current' && exec sudo -n env NODE_ENV='production' NOTE='it'\\''s' 'bun' 'run' '-'`,
    )
  })

  it('refuses a variable name that is not one', () => {
    expect(() => buildRemoteCommandLine(['true'], { env: { 'A=1 rm -rf /;B': 'x' } })).toThrow(/Invalid environment variable name/)
  })

  it('builds ssh -T with the transport options and the policy it was given', () => {
    expect(buildSshCommand(via, ['bun', 'run', '-'], { cwd: '/srv/app' })).toEqual([
      'ssh',
      '-i',
      '/keys/id',
      '-p',
      '2222',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'UserKnownHostsFile=/state/known_hosts',
      '-o',
      'LogLevel=ERROR',
      '-o',
      'ConnectTimeout=30',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=4',
      '-o',
      'BatchMode=yes',
      '-T',
      'deploy@2001:db8::1',
      `cd '/srv/app' && exec 'bun' 'run' '-'`,
    ])
  })

  it('hands the script to the spawner as stdin, never as an argument', () => {
    const seen: Array<{ command: readonly string[]; stdin: unknown }> = []
    const script = 'console.log(await User.count())'
    streamSshCommand(via, ['bun', 'run', '-'], {
      cwd: '/srv/app',
      stdin: script,
      spawn: (command, options) => {
        seen.push({ command, stdin: options?.stdin })
        return spawnProcessStream(['true'])
      },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.stdin).toBe(script)
    expect(seen[0]!.command.join(' ')).not.toContain('User.count')
  })
})

describe('spawnProcessStream', () => {
  it('streams both pipes and reports the exit', async () => {
    const result = await spawnProcessStream(['sh', '-c', 'cat; echo err >&2; exit 4'], { stdin: 'in\n' }).collect()
    expect(result).toEqual({ code: 4, signal: null, stdout: 'in\n', stderr: 'err\n' })
  })

  it('gives a command with no stdin an immediate EOF', async () => {
    expect((await spawnProcessStream(['cat']).collect()).stdout).toBe('')
  })

  it('pipes a ReadableStream through', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('one '))
        controller.enqueue(new TextEncoder().encode('two'))
        controller.close()
      },
    })
    expect((await spawnProcessStream(['cat'], { stdin: source }).collect()).stdout).toBe('one two')
  })

  it('is killed by an already-aborted signal', async () => {
    const exit = await spawnProcessStream(['sleep', '30'], { signal: AbortSignal.abort() }).exited
    expect(exit.code).not.toBe(0)
  })

  it('refuses an empty command', () => {
    expect(() => spawnProcessStream([])).toThrow(/empty/)
  })
})
