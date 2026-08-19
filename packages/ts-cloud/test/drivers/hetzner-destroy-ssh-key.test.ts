/**
 * Teardown removes the SSH key ts-cloud created for a project — and only that
 * key. A key that was already on the account (reused rather than created) or
 * that belongs to another project or environment must survive.
 */

import type { HetznerClient, HetznerSshKey } from '../../src/drivers/hetzner/client'
import type { CloudConfig } from '@ts-cloud/core'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { HetznerDriver } from '../../src/drivers/hetzner/driver'
import { matchesTsCloudLabels, matchesTsCloudProject } from '../../src/drivers/hetzner/instance-sizes'

const config: CloudConfig = {
  project: { name: 'My App', slug: 'my-app', region: 'fsn1' },
  environments: { production: { type: 'production' } },
  cloud: { provider: 'hetzner' },
  infrastructure: { compute: { size: 'small' } },
}

function labels(slug: string, environment: string, role = 'app'): Record<string, string> {
  return {
    'ts-cloud/project': slug,
    'ts-cloud/environment': environment,
    'ts-cloud/role': role,
    'ts-cloud/managed': 'true',
  }
}

function fakeClient(sshKeys: HetznerSshKey[]): { client: HetznerClient; deletedKeyIds: number[]; keys: HetznerSshKey[] } {
  const keys = [...sshKeys]
  const deletedKeyIds: number[] = []

  const client = {
    listLoadBalancers: mock(async () => []),
    listServers: mock(async () => []),
    deleteServer: mock(async () => ({ id: 1, status: 'success' as const })),
    listFirewalls: mock(async () => []),
    deleteFirewall: mock(async () => {}),
    listNetworks: mock(async () => []),
    deleteNetwork: mock(async () => {}),
    // The real client builds a fresh array per call.
    listSshKeys: mock(async () => [...keys]),
    deleteSshKey: mock(async (id: number) => {
      deletedKeyIds.push(id)
      const index = keys.findIndex((key) => key.id === id)
      if (index >= 0) keys.splice(index, 1)
    }),
  } as unknown as HetznerClient

  return { client, deletedKeyIds, keys }
}

function sshKey(id: number, name: string, keyLabels?: Record<string, string>): HetznerSshKey {
  return { id, name, fingerprint: `aa:bb:${id}`, public_key: `ssh-ed25519 AAAAKey${id}`, labels: keyLabels }
}

describe('destroyCompute and SSH keys', () => {
  let originalCwd: string
  let tempCwd: string

  beforeEach(async () => {
    originalCwd = process.cwd()
    tempCwd = `${originalCwd}/.tmp-hetzner-ssh-key-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await mkdir(tempCwd, { recursive: true })
    process.chdir(tempCwd)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempCwd, { recursive: true, force: true })
  })

  async function destroy(keys: HetznerSshKey[]): Promise<{ destroyed: string[]; deletedKeyIds: number[]; left: HetznerSshKey[] }> {
    const { client, deletedKeyIds, keys: remaining } = fakeClient(keys)
    const driver = new HetznerDriver({ client, apiToken: 'test-token' })
    const result = await driver.destroyCompute!({ config, environment: 'production' })
    return { destroyed: result.destroyed, deletedKeyIds, left: remaining }
  }

  it('deletes the key it created for this project', async () => {
    const result = await destroy([sshKey(1, 'my-app-production-deploy', labels('my-app', 'production'))])

    expect(result.deletedKeyIds).toEqual([1])
    expect(result.destroyed).toContain('ssh key my-app-production-deploy')
    expect(result.left).toHaveLength(0)
  })

  it('leaves a reused key alone', async () => {
    // `ensureSshKey` matches on the public key body, so a key already on the
    // account is reused as-is and never labelled — it belongs to the operator.
    const result = await destroy([sshKey(2, 'chris@laptop')])

    expect(result.deletedKeyIds).toEqual([])
    expect(result.left.map((key) => key.name)).toEqual(['chris@laptop'])
  })

  it('leaves another project and another environment alone', async () => {
    const result = await destroy([
      sshKey(3, 'other-app-production-deploy', labels('other-app', 'production')),
      sshKey(4, 'my-app-staging-deploy', labels('my-app', 'staging')),
      sshKey(5, 'my-app-production-deploy', labels('my-app', 'production')),
    ])

    expect(result.deletedKeyIds).toEqual([5])
    expect(result.left.map((key) => key.name).sort()).toEqual(['my-app-staging-deploy', 'other-app-production-deploy'])
  })

  it('removes every key of this project, whatever role created it', async () => {
    const result = await destroy([
      sshKey(6, 'my-app-production-deploy', labels('my-app', 'production', 'app')),
      sshKey(7, 'my-app-production-services', labels('my-app', 'production', 'services')),
    ])

    expect(result.deletedKeyIds.sort()).toEqual([6, 7])
  })

  it('keeps tearing down when a key cannot be deleted', async () => {
    const { client } = fakeClient([sshKey(8, 'my-app-production-deploy', labels('my-app', 'production'))])
    ;(client as unknown as { deleteSshKey: unknown }).deleteSshKey = mock(async () => {
      throw new Error('ssh key is in use')
    })

    const driver = new HetznerDriver({ client, apiToken: 'test-token' })
    const result = await driver.destroyCompute!({ config, environment: 'production' })

    // The failure is not reported as a success, and teardown still returns.
    expect(result.destroyed).not.toContain('ssh key my-app-production-deploy')
  })

  it('survives an account whose keys cannot be listed', async () => {
    const { client } = fakeClient([])
    ;(client as unknown as { listSshKeys: unknown }).listSshKeys = mock(async () => {
      throw new Error('rate limited')
    })

    const driver = new HetznerDriver({ client, apiToken: 'test-token' })
    await expect(driver.destroyCompute!({ config, environment: 'production' })).resolves.toBeDefined()
  })
})

describe('label matching', () => {
  it('matches a project and environment regardless of role', () => {
    expect(matchesTsCloudProject(labels('my-app', 'production', 'services'), 'my-app', 'production')).toBe(true)
    expect(matchesTsCloudProject(labels('my-app', 'staging'), 'my-app', 'production')).toBe(false)
    expect(matchesTsCloudProject(labels('other', 'production'), 'my-app', 'production')).toBe(false)
    expect(matchesTsCloudProject(undefined, 'my-app', 'production')).toBe(false)
    expect(matchesTsCloudProject({}, 'my-app', 'production')).toBe(false)
  })

  it('still requires the role where the role matters', () => {
    expect(matchesTsCloudLabels(labels('my-app', 'production', 'app'), 'my-app', 'production', 'app')).toBe(true)
    expect(matchesTsCloudLabels(labels('my-app', 'production', 'services'), 'my-app', 'production', 'app')).toBe(false)
    expect(matchesTsCloudLabels(undefined, 'my-app', 'production')).toBe(false)
  })
})
