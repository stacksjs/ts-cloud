import type { SourceBinding, SourceCredential, SourceDeployKey, SourceRef } from './types'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export interface GitTransportOptions {
  credential?: SourceCredential
  deployKey?: SourceDeployKey & { privateKey: string }
  executable?: string
  timeoutMs?: number
}

export interface ClonedSource {
  directory: string
  commitSha: string
}

function validateRemote(value: string, deployKey?: GitTransportOptions['deployKey']): string {
  const remote = value.trim()
  if (/\r|\n|\0/.test(remote)) throw new Error('Git remote contains control characters')
  if (remote.startsWith('https://')) {
    const url = new URL(remote)
    if (url.username || url.password || url.search || url.hash) throw new Error('HTTPS Git remotes cannot contain credentials, queries, or fragments')
    return url.href
  }
  const host = remote.startsWith('ssh://') ? new URL(remote).hostname : remote.match(/^git@([A-Za-z0-9.-]+):/)?.[1]
  if (!host) throw new Error('Git remote must use credential-free HTTPS or SSH')
  if (!deployKey || deployKey.host.toLowerCase() !== host.toLowerCase()) throw new Error('SSH Git remote requires a deploy key with a pinned key for the same host')
  return remote
}

function sanitizedError(value: string, remote: string, credential?: SourceCredential): string {
  let output = value.replaceAll(remote, '[REMOTE]').slice(0, 4_000)
  for (const secret of [credential?.token, credential?.privateKey]) {
    if (secret) output = output.replaceAll(secret, '[REDACTED]')
  }
  return output
}

function transportEnvironment(options: GitTransportOptions): { env: Record<string, string>, cleanup: () => void } {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' }
  let directory: string | undefined
  if (options.credential?.token) {
    const username = options.credential.username ?? 'oauth2'
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader'
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`${username}:${options.credential.token}`).toString('base64')}`
  }
  if (options.deployKey) {
    directory = mkdtempSync(join(tmpdir(), 'ts-cloud-git-transport-'))
    const keyPath = join(directory, 'key')
    const knownHostsPath = join(directory, 'known_hosts')
    writeFileSync(keyPath, options.deployKey.privateKey, { mode: 0o600 })
    writeFileSync(knownHostsPath, `${options.deployKey.host} ${options.deployKey.hostKey}\n`, { mode: 0o600 })
    chmodSync(keyPath, 0o600); chmodSync(knownHostsPath, 0o600)
    env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHostsPath} -o GlobalKnownHostsFile=/dev/null -o BatchMode=yes`
  }
  return { env, cleanup: () => { if (directory) rmSync(directory, { recursive: true, force: true }) } }
}

async function runGit(args: string[], remote: string, options: GitTransportOptions): Promise<string> {
  const transport = transportEnvironment(options)
  const child = Bun.spawn([options.executable ?? 'git', ...args], { stdout: 'pipe', stderr: 'pipe', env: transport.env })
  const timeoutMs = Math.max(100, options.timeoutMs ?? 120_000)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { child.kill(); reject(new Error(`Git operation exceeded ${timeoutMs}ms`)) }, timeoutMs)
  })
  try {
    const completion = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const [exitCode, stdout, stderr] = await Promise.race([completion, timeout])
    if (exitCode !== 0) throw new Error(sanitizedError(stderr || `Git exited with ${exitCode}`, remote, options.credential))
    return stdout
  }
  finally {
    if (timer) clearTimeout(timer)
    transport.cleanup()
  }
}

function parseRefs(output: string, prefix: string): SourceRef[] {
  const refs = new Map<string, SourceRef>()
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^([a-f0-9]{40,64})\s+(.+)$/i)
    if (!match || !match[2]!.startsWith(prefix) || match[2]!.endsWith('^{}')) continue
    const name = match[2]!.slice(prefix.length)
    refs.set(name, { name, commitSha: match[1]! })
  }
  return [...refs.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export async function discoverGitRefs(remoteValue: string, options: GitTransportOptions = {}): Promise<{ branches: SourceRef[], tags: SourceRef[] }> {
  const remote = validateRemote(remoteValue, options.deployKey)
  const output = await runGit(['ls-remote', '--heads', '--tags', '--', remote], remote, options)
  return { branches: parseRefs(output, 'refs/heads/'), tags: parseRefs(output, 'refs/tags/') }
}

/** Clone/fetch is argv-only, timeout-bounded, non-interactive, and never embeds credentials in the remote URL. */
export async function cloneSourceBinding(input: { remote: string, binding: SourceBinding, destination: string, ref?: string, commitSha?: string, sparsePaths?: string[] }, options: GitTransportOptions = {}): Promise<ClonedSource> {
  const remote = validateRemote(input.remote, options.deployKey)
  const destination = resolve(input.destination)
  const reference = input.ref?.trim() || input.binding.defaultBranch
  if (!/^[A-Za-z0-9._/-]{1,255}$/.test(reference) || reference.startsWith('-') || reference.includes('..')) throw new Error('Git ref contains unsupported characters')
  const args = ['clone', '--no-tags', '--single-branch', '--branch', reference]
  const sparsePaths = [...new Set(input.sparsePaths ?? [])]
  if (sparsePaths.some(path => !path || path.startsWith('/') || path.split('/').includes('..') || /[\0\r\n]/.test(path))) throw new Error('Sparse checkout paths must stay inside the repository')
  if (sparsePaths.length) args.push('--filter=blob:none', '--no-checkout')
  if (input.binding.cloneDepth) args.push('--depth', String(input.binding.cloneDepth))
  if (input.binding.submodules) args.push('--recurse-submodules', '--shallow-submodules')
  args.push('--', remote, destination)
  await runGit(args, remote, options)
  if (sparsePaths.length) {
    await runGit(['-C', destination, 'sparse-checkout', 'set', '--cone', '--', ...sparsePaths], remote, options)
    await runGit(['-C', destination, 'checkout', '--force'], remote, options)
  }
  if (input.commitSha) {
    if (!/^[a-f0-9]{40,64}$/i.test(input.commitSha)) throw new Error('Expected source commit must be an immutable 40-64 character SHA')
    await runGit(['-C', destination, 'fetch', '--no-tags', '--depth', '1', 'origin', input.commitSha], remote, options)
    await runGit(['-C', destination, 'checkout', '--detach', '--force', input.commitSha], remote, options)
  }
  const commitSha = (await runGit(['-C', destination, 'rev-parse', 'HEAD'], remote, options)).trim()
  if (!/^[a-f0-9]{40,64}$/i.test(commitSha)) throw new Error('Git clone did not produce a valid commit SHA')
  if (input.commitSha && commitSha.toLowerCase() !== input.commitSha.toLowerCase()) throw new Error(`Git checkout resolved ${commitSha} instead of the requested immutable commit`)
  return { directory: input.binding.monorepoRoot === '.' ? destination : join(destination, input.binding.monorepoRoot), commitSha }
}
