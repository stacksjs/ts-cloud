import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import type { ContainerImageDependencies } from './container-image'
import { buildAndPushContainerImage, hashContainerContext } from './container-image'

const context = join(import.meta.dir, 'fixtures/container')

describe('container image artifacts', () => {
  it('hashes the complete filtered context deterministically', () => {
    const first = hashContainerContext(context)
    const second = hashContainerContext(context)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(second).toBe(first)
  })

  it('creates a scanned immutable repository and resolves the pushed digest', async () => {
    const calls: string[] = []
    const dependencies: ContainerImageDependencies = {
      ecr: {
        describeRepositories: async () => {
          throw Object.assign(new Error('missing'), { code: 'RepositoryNotFoundException' })
        },
        createRepository: async (options) => {
          calls.push(`repository:${options.imageTagMutability}:${options.imageScanningConfiguration?.scanOnPush}`)
          return { repository: { repositoryUri: '923076644019.dkr.ecr.us-east-1.amazonaws.com/example' } }
        },
        putLifecyclePolicy: async () => {
          calls.push('lifecycle')
          return {}
        },
        getAuthorizationToken: async () => ({
          authorizationData: [
            { authorizationToken: 'token', proxyEndpoint: 'https://923076644019.dkr.ecr.us-east-1.amazonaws.com' },
          ],
        }),
        describeImages: async () => ({ imageDetails: [{ imageDigest: `sha256:${'b'.repeat(64)}` }] }),
      },
      run: (command, args) => {
        calls.push(`${command}:${args[0]}`)
      },
    }
    const result = await buildAndPushContainerImage({ context, repository: 'example' }, dependencies)
    expect(result.tag).toStartWith('sha-')
    expect(result.digestUri).toBe(`923076644019.dkr.ecr.us-east-1.amazonaws.com/example@sha256:${'b'.repeat(64)}`)
    expect(calls).toEqual(['repository:IMMUTABLE:true', 'lifecycle', 'docker:version', 'docker:build', 'docker:push'])
  })
})
