import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceBinding, SourceDeployKey } from './types'
import { cloneSourceBinding, discoverGitRefs } from './git-workspace'

function executable(script: string): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'ts-cloud-fake-git-'))
  const path = join(directory, 'git')
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o700 })
  chmodSync(path, 0o700)
  return { directory, path }
}

function binding(input: Partial<SourceBinding> = {}): SourceBinding {
  return {
    id: 'binding-1',
    projectId: 'project-1',
    connectionId: 'connection-1',
    repositoryFullName: 'acme/web',
    defaultBranch: 'main',
    monorepoRoot: '.',
    includePaths: [],
    excludePaths: [],
    submodules: false,
    autoDeploy: true,
    pullRequestPreviews: true,
    status: 'active',
    version: 1,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...input,
  }
}

describe('bounded Git workspace', () => {
  it('discovers branches and tags with HTTPS credentials outside process arguments', async () => {
    const fake = executable(`
if [ "$GIT_CONFIG_KEY_0" != "http.extraHeader" ]; then exit 21; fi
case "$*" in *fixture-value*) exit 22;; esac
printf '${'a'.repeat(40)} refs/heads/main\\n${'b'.repeat(40)} refs/heads/feature/source\\n${'c'.repeat(40)} refs/tags/v1.0.0\\n${'d'.repeat(40)} refs/tags/v1.0.0^{}\\n'
`)
    try {
      const refs = await discoverGitRefs('https://git.example/acme/web.git', {
        credential: { username: 'deploy', token: 'fixture-value' },
        executable: fake.path,
        timeoutMs: 1_000,
      })
      expect(refs.branches.map((ref) => ref.name)).toEqual(['feature/source', 'main'])
      expect(refs.tags).toEqual([{ name: 'v1.0.0', commitSha: 'c'.repeat(40) }])
    } finally {
      rmSync(fake.directory, { recursive: true, force: true })
    }
  })

  it('enforces the same pinned SSH host and strict host-key checking', async () => {
    const fake = executable(`
case "$GIT_SSH_COMMAND" in *StrictHostKeyChecking=yes*) ;; *) exit 23;; esac
case "$GIT_SSH_COMMAND" in *UserKnownHostsFile=*) ;; *) exit 24;; esac
case "$GIT_SSH_COMMAND" in *IdentitiesOnly=yes*) ;; *) exit 25;; esac
printf '${'a'.repeat(40)} refs/heads/main\\n'
`)
    const deployKey: SourceDeployKey & { privateKey: string } = {
      id: 'key-1',
      connectionId: 'connection-1',
      name: 'Readonly',
      publicKey: `ssh-ed25519 ${Buffer.from('public').toString('base64')}`,
      publicKeyFingerprint: 'sha256:public',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----',
      host: 'git.example',
      hostKey: `ssh-ed25519 ${Buffer.from('host').toString('base64')}`,
      hostKeyFingerprint: 'sha256:host',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    }
    try {
      expect(
        (await discoverGitRefs('git@git.example:acme/web.git', { deployKey, executable: fake.path })).branches,
      ).toHaveLength(1)
      expect(discoverGitRefs('git@other.example:acme/web.git', { deployKey, executable: fake.path })).rejects.toThrow(
        'same host',
      )
    } finally {
      rmSync(fake.directory, { recursive: true, force: true })
    }
  })

  it('clones a selected branch with bounded options and returns the monorepo root', async () => {
    const fake = executable(`
case "$*" in *rev-parse*) printf '${'e'.repeat(40)}\\n';; *clone*) exit 0;; *) exit 24;; esac
`)
    const destination = join(fake.directory, 'checkout')
    try {
      const result = await cloneSourceBinding(
        {
          remote: 'https://git.example/acme/web.git',
          binding: binding({ monorepoRoot: 'apps/web', cloneDepth: 20, submodules: true }),
          destination,
          ref: 'release/v2',
        },
        { executable: fake.path },
      )
      expect(result).toEqual({ directory: join(destination, 'apps/web'), commitSha: 'e'.repeat(40) })
    } finally {
      rmSync(fake.directory, { recursive: true, force: true })
    }
  })

  it('uses safe cone-mode sparse checkout when paths are selected', async () => {
    const fake = executable(`
case "$*" in *rev-parse*) printf '${'f'.repeat(40)}\n';; *clone*--filter=blob:none*--no-checkout*) exit 0;; *sparse-checkout*set*--cone*apps/web*) exit 0;; *checkout*--force*) exit 0;; *) exit 24;; esac
`)
    try {
      expect(
        await cloneSourceBinding(
          {
            remote: 'https://git.example/acme/web.git',
            binding: binding(),
            destination: join(fake.directory, 'sparse'),
            sparsePaths: ['apps/web'],
            ref: 'main',
          },
          { executable: fake.path },
        ),
      ).toMatchObject({ commitSha: 'f'.repeat(40) })
      expect(
        cloneSourceBinding(
          {
            remote: 'https://git.example/acme/web.git',
            binding: binding(),
            destination: join(fake.directory, 'unsafe-sparse'),
            sparsePaths: ['../secret'],
          },
          { executable: fake.path },
        ),
      ).rejects.toThrow('Sparse checkout paths')
    } finally {
      rmSync(fake.directory, { recursive: true, force: true })
    }
  })

  it('fetches, checks out, and verifies the exact immutable webhook commit', async () => {
    const sha = 'd'.repeat(40)
    const fake = executable(`
case "$*" in *fetch*origin*${sha}*) exit 0;; *checkout*--detach*${sha}*) exit 0;; *rev-parse*) printf '${sha}\n';; *clone*) exit 0;; *) exit 25;; esac
`)
    try {
      expect(
        await cloneSourceBinding(
          {
            remote: 'https://git.example/acme/web.git',
            binding: binding(),
            destination: join(fake.directory, 'exact'),
            ref: 'feature',
            commitSha: sha,
          },
          { executable: fake.path },
        ),
      ).toMatchObject({ commitSha: sha })
      expect(
        cloneSourceBinding(
          {
            remote: 'https://git.example/acme/web.git',
            binding: binding(),
            destination: join(fake.directory, 'moving'),
            ref: 'feature',
            commitSha: 'main',
          },
          { executable: fake.path },
        ),
      ).rejects.toThrow('immutable')
    } finally {
      rmSync(fake.directory, { recursive: true, force: true })
    }
  })

  it('bounds hung Git processes and rejects secret-bearing remotes and unsafe refs', async () => {
    const fake = executable('sleep 2')
    try {
      expect(
        discoverGitRefs('https://git.example/acme/web.git', { executable: fake.path, timeoutMs: 100 }),
      ).rejects.toThrow('exceeded 100ms')
      expect(
        discoverGitRefs('https://user:password@git.example/acme/web.git', { executable: fake.path }),
      ).rejects.toThrow('cannot contain credentials')
      expect(
        cloneSourceBinding(
          {
            remote: 'https://git.example/acme/web.git',
            binding: binding(),
            destination: join(fake.directory, 'unsafe'),
            ref: '--upload-pack=bad',
          },
          { executable: fake.path },
        ),
      ).rejects.toThrow('ref')
    } finally {
      rmSync(fake.directory, { recursive: true, force: true })
    }
  })
})
