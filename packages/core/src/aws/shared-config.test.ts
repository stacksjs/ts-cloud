import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearCredentialProcessCache,
  CredentialProcessError,
  loadProfileCredentials,
  loadProfileCredentialsSync,
  loadStaticProfileCredentials,
  resolveProfileName,
  splitCommandLine,
} from './shared-config'
import { fromCredentialProcess, fromSharedCredentials, resolveRegion } from './credentials'

// Every credential here is fake and exists only inside a temp dir.
const FAKE_KEY = 'AKIAFAKEFAKEFAKE0001'
const FAKE_SECRET = 'fake-secret-value-not-real'

let dir = ''
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AWS_')))
  for (const key of Object.keys(savedEnv)) delete process.env[key]
  dir = mkdtempSync(join(tmpdir(), 'ts-cloud-credproc-'))
  clearCredentialProcessCache()
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AWS_'))
      delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
  rmSync(dir, { recursive: true, force: true })
  clearCredentialProcessCache()
})

/** Write an executable sh script into the temp dir and return its path. */
function script(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** A script that counts its runs in `<name>.count` and prints the given JSON. */
function countingScript(name: string, json: string): { path: string, runs: () => number } {
  const counter = join(dir, `${name}.count`)
  const path = script(name, `echo run >> '${counter}'\ncat <<'JSON'\n${json}\nJSON`)
  return { path, runs: () => (existsSync(counter) ? readFileSync(counter, 'utf-8').trim().split('\n').length : 0) }
}

function creds(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ Version: 1, AccessKeyId: FAKE_KEY, SecretAccessKey: FAKE_SECRET, SessionToken: 'fake-token', ...extra })
}

/** Point the AWS_* file variables at a temp config (and optional credentials file). */
function useFiles(config: string, credentials = ''): void {
  const configFile = join(dir, 'config')
  const credentialsFile = join(dir, 'credentials')
  writeFileSync(configFile, config)
  writeFileSync(credentialsFile, credentials)
  process.env.AWS_CONFIG_FILE = configFile
  process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsFile
}

describe('credential_process', () => {
  it('runs the profile command and parses its JSON', async () => {
    const helper = countingScript('ok', creds())
    useFiles(`[profile ts-cloud]\ncredential_process = ${helper.path}\nregion = us-west-2\n`)

    const result = await loadProfileCredentials({ profile: 'ts-cloud' })
    expect(result).toEqual({ accessKeyId: FAKE_KEY, secretAccessKey: FAKE_SECRET, sessionToken: 'fake-token', expiration: undefined })
  })

  it('reads the profile from AWS_PROFILE, then AWS_DEFAULT_PROFILE, then default', async () => {
    const one = countingScript('one', creds({ AccessKeyId: 'AKIAONE' }))
    const two = countingScript('two', creds({ AccessKeyId: 'AKIATWO' }))
    const dflt = countingScript('dflt', creds({ AccessKeyId: 'AKIADEFAULT' }))
    useFiles(`[default]\ncredential_process = ${dflt.path}\n[profile one]\ncredential_process = ${one.path}\n[profile two]\ncredential_process = ${two.path}\n`)

    expect((await loadProfileCredentials())?.accessKeyId).toBe('AKIADEFAULT')
    process.env.AWS_DEFAULT_PROFILE = 'two'
    expect(resolveProfileName()).toBe('two')
    expect((await loadProfileCredentials())?.accessKeyId).toBe('AKIATWO')
    process.env.AWS_PROFILE = 'one'
    expect((await loadProfileCredentials())?.accessKeyId).toBe('AKIAONE')
    expect((await loadProfileCredentials({ profile: 'two' }))?.accessKeyId).toBe('AKIATWO')
  })

  it('caches credentials without an Expiration for the life of the process', async () => {
    const helper = countingScript('forever', creds())
    useFiles(`[profile p]\ncredential_process = ${helper.path}\n`)

    await loadProfileCredentials({ profile: 'p' })
    await loadProfileCredentials({ profile: 'p' })
    expect(loadProfileCredentialsSync({ profile: 'p' })?.accessKeyId).toBe(FAKE_KEY)
    expect(helper.runs()).toBe(1)
  })

  it('shares one run between concurrent callers', async () => {
    const helper = countingScript('concurrent', creds())
    useFiles(`[profile p]\ncredential_process = ${helper.path}\n`)

    await Promise.all([1, 2, 3, 4].map(() => loadProfileCredentials({ profile: 'p' })))
    expect(helper.runs()).toBe(1)
  })

  it('keeps credentials until five minutes before Expiration, then runs the helper again', async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const fresh = countingScript('fresh', creds({ Expiration: later }))
    const soon = countingScript('soon', creds({ Expiration: new Date(Date.now() + 2 * 60 * 1000).toISOString() }))
    useFiles(`[profile fresh]\ncredential_process = ${fresh.path}\n[profile soon]\ncredential_process = ${soon.path}\n`)

    const first = await loadProfileCredentials({ profile: 'fresh' })
    await loadProfileCredentials({ profile: 'fresh' })
    expect(first?.expiration?.toISOString()).toBe(later)
    expect(fresh.runs()).toBe(1)

    // Two minutes left is inside the five minute refresh window: never served from cache.
    await loadProfileCredentials({ profile: 'soon' })
    await loadProfileCredentials({ profile: 'soon' })
    expect(soon.runs()).toBe(2)
  })

  it('names the profile and command, never the output, when the JSON is invalid', async () => {
    const helper = script('junk', 'echo "SECRETLEAK-not-json {"')
    useFiles(`[profile p]\ncredential_process = ${helper}\n`)

    const error = await loadProfileCredentials({ profile: 'p' }).catch(e => e)
    expect(error).toBeInstanceOf(CredentialProcessError)
    expect(error.message).toContain('"p"')
    expect(error.message).toContain(helper)
    expect(error.message).toContain('not valid JSON')
    expect(error.message).not.toContain('SECRETLEAK')
  })

  it('rejects JSON that is missing keys or has the wrong Version, without echoing it', async () => {
    const noSecret = script('nosecret', `echo '{"Version":1,"AccessKeyId":"AKIAXYZ"}'`)
    const wrongVersion = script('v2', `echo '{"Version":2,"AccessKeyId":"AKIAXYZ","SecretAccessKey":"sssshh"}'`)
    const badDate = script('baddate', `echo '{"Version":1,"AccessKeyId":"AKIAXYZ","SecretAccessKey":"sssshh","Expiration":"tomorrow-ish"}'`)
    useFiles(`[profile a]\ncredential_process = ${noSecret}\n[profile b]\ncredential_process = ${wrongVersion}\n[profile c]\ncredential_process = ${badDate}\n`)

    for (const profile of ['a', 'b', 'c']) {
      const error = await loadProfileCredentials({ profile }).catch(e => e)
      expect(error).toBeInstanceOf(CredentialProcessError)
      expect(error.message).not.toContain('sssshh')
      expect(error.message).not.toContain('AKIAXYZ')
    }
  })

  it('fails with the exit code and stderr when the process exits non-zero', async () => {
    const helper = script('boom', 'echo "login expired" >&2\nexit 3')
    useFiles(`[profile p]\ncredential_process = ${helper}\n`)

    const error = await loadProfileCredentials({ profile: 'p' }).catch(e => e)
    expect(error).toBeInstanceOf(CredentialProcessError)
    expect(error.message).toContain('"p"')
    expect(error.message).toContain(helper)
    expect(error.message).toContain('exited with code 3')
    expect(error.message).toContain('login expired')
    expect(() => loadProfileCredentialsSync({ profile: 'p' })).toThrow('exited with code 3')
  })

  it('reports a command that cannot be started', async () => {
    useFiles(`[profile p]\ncredential_process = ${join(dir, 'does-not-exist')}\n`)
    const error = await loadProfileCredentials({ profile: 'p' }).catch(e => e)
    expect(error).toBeInstanceOf(CredentialProcessError)
    expect(error.message).toContain('could not be started')
  })

  it('kills a hung process and rejects at the timeout', async () => {
    const pidFile = join(dir, 'hung.pid')
    const helper = script('hung', `echo $$ > '${pidFile}'\nexec sleep 30`)
    useFiles(`[profile p]\ncredential_process = ${helper}\n`)

    const started = Date.now()
    const error = await loadProfileCredentials({ profile: 'p', timeoutMs: 300 }).catch(e => e)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(error).toBeInstanceOf(CredentialProcessError)
    expect(error.message).toContain('timed out after 300ms')
    expect(error.message).toContain(helper)

    await Bun.sleep(100)
    const pid = Number(readFileSync(pidFile, 'utf-8').trim())
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('times out the synchronous path too', () => {
    const helper = script('hung-sync', 'exec sleep 30')
    useFiles(`[profile p]\ncredential_process = ${helper}\n`)

    const started = Date.now()
    expect(() => loadProfileCredentialsSync({ profile: 'p', timeoutMs: 300 })).toThrow('timed out after 300ms')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('kills the helper\'s own children too when it hangs behind a wrapper', async () => {
    const pidFile = join(dir, 'child.pid')
    const helper = script('wrapper', `sleep 30 &\necho $! > '${pidFile}'\nwait`)
    useFiles(`[profile p]\ncredential_process = ${helper}\n`)

    const error = await loadProfileCredentials({ profile: 'p', timeoutMs: 300 }).catch(e => e)
    expect(error.message).toContain('timed out')
    await Bun.sleep(100)
    const pid = Number(readFileSync(pidFile, 'utf-8').trim())
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('splits the command like a shell: a quoted path with spaces and quoted arguments', async () => {
    const spaced = join(dir, 'with space')
    mkdirSync(spaced)
    const helper = join(spaced, 'echo-args')
    const argsFile = join(dir, 'args.txt')
    writeFileSync(helper, `#!/bin/sh\nprintf '%s|%s|%s|%s' "$1" "$2" "$3" "$#" > '${argsFile}'\necho '{"Version":1,"AccessKeyId":"AKIAARGS","SecretAccessKey":"x"}'\n`)
    chmodSync(helper, 0o755)
    useFiles(`[profile p]\ncredential_process = "${helper}" 'one two' "three \\"q\\"" four\\ five\n`)

    const result = await loadProfileCredentials({ profile: 'p' })
    expect(result?.accessKeyId).toBe('AKIAARGS')
    expect(readFileSync(argsFile, 'utf-8')).toBe('one two|three "q"|four five|3')
  })

  it('passes shell metacharacters as literal arguments instead of running them', async () => {
    const marker = join(dir, 'PWNED')
    const helper = script('meta', `printf '{"Version":1,"AccessKeyId":"AKIAMETA","SecretAccessKey":"x","SessionToken":"%s"}' "$1"`)
    useFiles(`[profile p]\ncredential_process = ${helper} 'a; touch ${marker}' $(touch ${marker}) \`touch ${marker}\`\n`)

    const result = await loadProfileCredentials({ profile: 'p' })
    expect(result?.sessionToken).toBe(`a; touch ${marker}`)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('profile files', () => {
  it('honors AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE', () => {
    useFiles('[profile p]\naws_access_key_id = AKIACONFIG\naws_secret_access_key = c\n', '[q]\naws_access_key_id = AKIACREDS\naws_secret_access_key = d\n')
    expect(loadStaticProfileCredentials({ profile: 'p' })?.accessKeyId).toBe('AKIACONFIG')
    expect(loadStaticProfileCredentials({ profile: 'q' })?.accessKeyId).toBe('AKIACREDS')
    expect(loadStaticProfileCredentials({ profile: 'missing' })).toBeNull()
  })

  it('lets explicit file options beat the environment', () => {
    useFiles('[profile p]\naws_access_key_id = AKIAENV\naws_secret_access_key = c\n')
    const other = join(dir, 'other-credentials')
    writeFileSync(other, '[p]\naws_access_key_id = AKIAOPTION\naws_secret_access_key = d\n')
    expect(loadStaticProfileCredentials({ profile: 'p', credentialsFile: other })?.accessKeyId).toBe('AKIAOPTION')
    expect(fromSharedCredentials({ profile: 'p', credentialsFile: other })?.accessKeyId).toBe('AKIAOPTION')
  })

  it('reads the [default] section of the config file', async () => {
    const helper = countingScript('dflt', creds())
    useFiles(`[default]\ncredential_process = ${helper.path}\n`)
    expect((await fromCredentialProcess())?.accessKeyId).toBe(FAKE_KEY)
  })

  it('prefers static keys over a credential_process, and the credentials file over config', async () => {
    const helper = countingScript('unused', creds({ AccessKeyId: 'AKIAPROCESS' }))
    useFiles(
      `[profile p]\naws_access_key_id = AKIACONFIG\naws_secret_access_key = c\ncredential_process = ${helper.path}\n`,
      '[p]\naws_access_key_id = AKIACREDS\naws_secret_access_key = d\n',
    )
    expect((await loadProfileCredentials({ profile: 'p' }))?.accessKeyId).toBe('AKIACREDS')
    expect(helper.runs()).toBe(0)
  })

  it('returns null for a profile that defines neither keys nor a process', async () => {
    useFiles('[profile p]\nregion = eu-west-1\n')
    expect(await loadProfileCredentials({ profile: 'p' })).toBeNull()
    expect(loadProfileCredentialsSync({ profile: 'p' })).toBeNull()
    expect(resolveRegion('p')).toBe('eu-west-1')
  })
})

describe('splitCommandLine', () => {
  it('splits on whitespace and honors quotes and escapes', () => {
    expect(splitCommandLine('a  b\tc')).toEqual(['a', 'b', 'c'])
    expect(splitCommandLine(`cmd 'it is' "x y"`)).toEqual(['cmd', 'it is', 'x y'])
    expect(splitCommandLine(`cmd "say \\"hi\\"" 'raw \\n'`)).toEqual(['cmd', 'say "hi"', 'raw \\n'])
    expect(splitCommandLine('cmd a\\ b')).toEqual(['cmd', 'a b'])
    expect(splitCommandLine(`cmd "" ''`)).toEqual(['cmd', '', ''])
    expect(splitCommandLine('')).toEqual([])
  })

  it('does not expand anything', () => {
    expect(splitCommandLine('cmd $HOME ~ * `x`')).toEqual(['cmd', '$HOME', '~', '*', '`x`'])
  })

  it('keeps backslashes literal on Windows', () => {
    expect(splitCommandLine('C:\\tools\\helper.exe --x', 'win32')).toEqual(['C:\\tools\\helper.exe', '--x'])
  })

  it('rejects an unterminated quote', () => {
    expect(() => splitCommandLine('cmd "oops')).toThrow('unterminated quote')
  })
})
