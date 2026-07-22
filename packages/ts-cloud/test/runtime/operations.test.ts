import { describe, expect, it } from 'bun:test'
import type { CloudConfig, CloudDriver } from '@ts-cloud/core'
import { authorizeRuntimePath, capabilities, RuntimeOperationService, type RuntimeWorkload } from '../../src/runtime'

const config = {
  project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
  cloud: { provider: 'hetzner' },
  mode: 'server',
  environments: { production: { type: 'production' } },
} as CloudConfig
const base: RuntimeWorkload = {
  id: 'systemd:box:api',
  provider: 'systemd',
  kind: 'service',
  name: 'api',
  status: 'running',
  tags: {},
  links: { project: 'acme', environment: 'production', service: 'api', server: 'box', providerId: 'api.service' },
  replicas: [],
  networks: [],
  mounts: [{ target: '/data/api' }],
  capabilities: capabilities(['start', 'stop', 'restart', 'logs', 'exec', 'inspect', 'files'], 'unsupported'),
  config: {},
  discoveredAt: new Date().toISOString(),
  sourceId: 'systemd:box',
}

describe('runtime file policy', () => {
  it('allows service roots and discovered mounts', () => {
    expect(authorizeRuntimePath(base, '/var/www/acme/api/storage/logs/app.log')).toEqual({
      ok: true,
      path: '/var/www/acme/api/storage/logs/app.log',
    })
    expect(authorizeRuntimePath(base, '/data/api/export.zip')).toEqual({ ok: true, path: '/data/api/export.zip' })
  })

  it('blocks traversal, sensitive, and unrelated paths', () => {
    expect(authorizeRuntimePath(base, '/../etc/shadow').ok).toBeFalse()
    expect(authorizeRuntimePath(base, '/etc/passwd').ok).toBeFalse()
    expect(authorizeRuntimePath(base, '/home/other/file').ok).toBeFalse()
  })
})

describe('runtime operations', () => {
  it('requires exact target confirmation', async () => {
    const service = new RuntimeOperationService(config, 'production', {
      inventory: async () => ({ generatedAt: '', sources: [], workloads: [base], degraded: false }),
    })
    expect(await service.run({ workloadId: base.id, action: 'restart', confirm: 'wrong' })).toMatchObject({
      ok: false,
      error: 'Type "api" to restart this workload.',
    })
  })

  it('runs a scoped systemd operation and bounds the target', async () => {
    let call: any
    const driver = {
      name: 'hetzner',
      usesCloudFormation: false,
      async findComputeTargets() {
        return [{ id: 'box' }, { id: 'other' }]
      },
      async runRemoteDeploy(input: any) {
        call = input
        return {
          success: true,
          instanceCount: 1,
          perInstance: [{ instanceId: 'box', status: 'Success', output: 'active\n' }],
        }
      },
    } as unknown as CloudDriver
    const service = new RuntimeOperationService(config, 'production', {
      driver,
      inventory: async () => ({ generatedAt: '', sources: [], workloads: [base], degraded: false }),
    })
    expect(await service.run({ workloadId: base.id, action: 'restart', confirm: 'api' })).toMatchObject({
      ok: true,
      command: 'systemctl restart api.service',
    })
    expect(call.targets).toEqual([{ id: 'box' }])
  })

  it('scales ECS through the provider API', async () => {
    let args: unknown[] = []
    const ecsWorkload = {
      ...base,
      id: 'ecs:aws:api',
      provider: 'ecs' as const,
      kind: 'service' as const,
      name: 'acme-production-api',
      links: { ...base.links, providerId: 'arn/service/api' },
      config: { clusterArn: 'arn/cluster/acme' },
      capabilities: capabilities(['scale'], 'unsupported'),
    }
    const service = new RuntimeOperationService(
      { ...config, cloud: { provider: 'aws' } } as CloudConfig,
      'production',
      {
        ecs: {
          async scaleService(...input: any[]) {
            args = input
            return {}
          },
          async forceNewDeployment() {
            return {}
          },
        },
        inventory: async () => ({ generatedAt: '', sources: [], workloads: [ecsWorkload], degraded: false }),
      },
    )
    expect(
      await service.run({ workloadId: ecsWorkload.id, action: 'scale', replicas: 3, confirm: ecsWorkload.name }),
    ).toMatchObject({ ok: true })
    expect(args).toEqual(['arn/cluster/acme', 'arn/service/api', 3])
  })

  it('reads bounded Lambda logs without crossing the named log group', async () => {
    let group = ''
    const lambda = {
      ...base,
      id: 'lambda:aws:http',
      provider: 'lambda' as const,
      kind: 'function' as const,
      name: 'acme-production-http',
      capabilities: capabilities(['logs'], 'unsupported'),
    }
    const service = new RuntimeOperationService(
      { ...config, cloud: { provider: 'aws' } } as CloudConfig,
      'production',
      {
        logs: {
          async filterLogEvents(input: any) {
            group = input.logGroupName
            return { events: [{ timestamp: 1, message: 'hello' }] }
          },
        },
        inventory: async () => ({ generatedAt: '', sources: [], workloads: [lambda], degraded: false }),
      },
    )
    expect((await service.logs(lambda.id)).lines[0].message).toBe('hello')
    expect(group).toBe('/aws/lambda/acme-production-http')
  })

  it('reads ECS logs only from its task-definition log group', async () => {
    let group = ''
    const ecs = {
      ...base,
      id: 'ecs:aws:api',
      provider: 'ecs' as const,
      kind: 'service' as const,
      capabilities: capabilities(['logs'], 'unsupported'),
      config: { logGroups: ['/ecs/acme-api'] },
    }
    const service = new RuntimeOperationService(
      { ...config, cloud: { provider: 'aws' } } as CloudConfig,
      'production',
      {
        logs: {
          async filterLogEvents(input: any) {
            group = input.logGroupName
            return { events: [{ message: 'task ready' }] }
          },
        },
        inventory: async () => ({ generatedAt: '', sources: [], workloads: [ecs], degraded: false }),
      },
    )
    expect((await service.logs(ecs.id)).lines[0].message).toBe('task ready')
    expect(group).toBe('/ecs/acme-api')
  })

  it('requires recent authentication and confines free-form exec to containers', async () => {
    const service = new RuntimeOperationService(config, 'production', {
      inventory: async () => ({ generatedAt: '', sources: [], workloads: [base], degraded: false }),
    })
    expect(await service.exec({ workloadId: base.id, preset: 'process', confirm: 'api' })).toMatchObject({
      ok: false,
      error: 'Sign in again before using elevated runtime access.',
    })
    expect(await service.exec({ workloadId: base.id, command: 'id', confirm: 'api', recentAuth: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining('isolated containers'),
    })
  })

  it('runs a bounded diagnostic preset against the exact workload server', async () => {
    let commands: string[] = []
    const driver = {
      name: 'hetzner',
      usesCloudFormation: false,
      async findComputeTargets() {
        return [{ id: 'box' }, { id: 'other' }]
      },
      async runRemoteDeploy(input: any) {
        commands = input.commands
        return {
          success: true,
          instanceCount: 1,
          perInstance: [{ instanceId: 'box', status: 'Success', output: 'active\n' }],
        }
      },
    } as unknown as CloudDriver
    const service = new RuntimeOperationService(config, 'production', {
      driver,
      inventory: async () => ({ generatedAt: '', sources: [], workloads: [base], degraded: false }),
    })
    expect(
      await service.exec({ workloadId: base.id, preset: 'process', confirm: 'api', recentAuth: true }),
    ).toMatchObject({ ok: true, stdout: 'active\n' })
    expect(commands.join('\n')).toContain('systemctl status api.service')
  })

  it('reads and writes only authorized paths with bounded base64 payloads', async () => {
    const seen: string[][] = []
    const driver = {
      name: 'hetzner',
      usesCloudFormation: false,
      async findComputeTargets() {
        return [{ id: 'box' }]
      },
      async runRemoteDeploy(input: any) {
        seen.push(input.commands)
        return {
          success: true,
          instanceCount: 1,
          perInstance: [
            {
              instanceId: 'box',
              status: 'Success',
              output: input.comment.endsWith('file-read') ? '__TSCLOUD_SIZE__=5\naGVsbG8=\n' : '',
            },
          ],
        }
      },
    } as unknown as CloudDriver
    const service = new RuntimeOperationService(config, 'production', {
      driver,
      inventory: async () => ({ generatedAt: '', sources: [], workloads: [base], degraded: false }),
    })
    expect(
      await service.readFile({ workloadId: base.id, path: '/data/api/hello.txt', confirm: 'api', recentAuth: true }),
    ).toMatchObject({ ok: true, size: 5, contentBase64: 'aGVsbG8=' })
    expect(
      await service.writeFile({
        workloadId: base.id,
        path: '/data/api/hello.txt',
        contentBase64: 'aGVsbG8=',
        confirm: 'api',
        recentAuth: true,
      }),
    ).toMatchObject({ ok: true, size: 5 })
    expect(
      await service.writeFile({
        workloadId: base.id,
        path: '/data/api/hello.txt',
        contentBase64: 'a',
        confirm: 'api',
        recentAuth: true,
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('canonical base64') })
    expect(
      await service.readFile({ workloadId: base.id, path: '/etc/shadow', confirm: 'api', recentAuth: true }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('Sensitive') })
    expect(seen.flat().join('\n')).toContain('realpath -m')
  })
})
