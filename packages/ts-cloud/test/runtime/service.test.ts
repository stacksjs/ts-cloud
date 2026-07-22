import { describe, expect, it } from 'bun:test'
import type { CloudConfig, CloudDriver } from '@ts-cloud/core'
import { createRuntimeAdapters, discoverRuntimeInventory, EcsRuntimeAdapter, LambdaRuntimeAdapter } from '../../src/runtime'

const context = { project: 'acme', environment: 'production', now: new Date('2026-07-21T12:00:00Z') }

describe('AWS runtime adapters', () => {
  it('paginates and filters Lambda functions to the project environment', async () => {
    const calls: any[] = []
    const adapter = new LambdaRuntimeAdapter({
      async listFunctions(input) {
        calls.push(input)
        return input?.Marker
          ? { Functions: [{ FunctionName: 'other-production-http' }] }
          : { Functions: [{ FunctionName: 'acme-production-http', State: 'Active' }], NextMarker: 'next' }
      },
    }, 'acme-production')
    const workloads = await adapter.discover(context)
    expect(calls).toHaveLength(2)
    expect(workloads.map(item => item.name)).toEqual(['acme-production-http'])
  })

  it('paginates ECS and batches service/task descriptions', async () => {
    const adapter = new EcsRuntimeAdapter({
      async listClusters(input) { return input.nextToken ? { clusterArns: ['cluster-b'] } : { clusterArns: ['cluster-a'], nextToken: 'next' } },
      async listServices(cluster) { return { serviceArns: [`arn/service/${cluster}/acme-production-api`, `arn/service/${cluster}/foreign-api`] } },
      async describeServices({ cluster, services }) { return { services: services.map(serviceArn => ({ serviceArn, serviceName: serviceArn.split('/').at(-1), clusterArn: cluster, status: 'ACTIVE', desiredCount: 1, runningCount: 1 })) } },
      async listTasks(cluster, service) { return { taskArns: [`arn/task/${cluster}/${service}`] } },
      async describeTasks(cluster, tasks) { return { tasks: tasks.map(taskArn => ({ taskArn, clusterArn: cluster, lastStatus: 'RUNNING' })) } },
    }, 'acme-production')
    const workloads = await adapter.discover(context)
    expect(workloads).toHaveLength(2)
    expect(workloads.every(item => item.replicas.length === 1)).toBeTrue()
  })
})

describe('live server runtime discovery', () => {
  it('creates isolated systemd and Docker sources per compute target', async () => {
    const driver = {
      name: 'aws', usesCloudFormation: false,
      async findComputeTargets() { return [{ id: 'i-one' }, { id: 'i-two' }] },
      async runRemoteDeploy(options: any) {
        const docker = options.comment.endsWith('docker')
        return { success: true, instanceCount: 1, perInstance: [{ instanceId: options.targets[0].id, status: 'Success', output: docker ? '[]' : `TSCLOUD_SYSTEMD\tapi.service\tloaded\tactive\trunning\tAPI\tenabled\t1\t10\t0\t2026-07-21T11:00:00Z\t/etc/api.service` }] }
      },
    } as unknown as CloudDriver
    const config = { project: { name: 'Acme', slug: 'acme', region: 'us-east-1' }, cloud: { provider: 'hetzner' }, mode: 'server', environments: { production: {} } } as CloudConfig
    const adapters = await createRuntimeAdapters(config, 'production', { driver })
    expect(adapters.map(item => item.id)).toEqual(['systemd:i-one', 'docker:i-one', 'systemd:i-two', 'docker:i-two'])
    const inventory = await discoverRuntimeInventory(adapters, context)
    expect(inventory.workloads).toHaveLength(2)
    expect(inventory.sources.every(item => item.status === 'fresh')).toBeTrue()
  })
})
