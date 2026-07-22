import { describe, expect, it } from 'bun:test'
import { discoverRuntimeInventory, dockerWorkloads, ecsWorkloads, lambdaWorkloads, normalizeRuntimeStatus, parseDockerInspect, parseSystemdRecords, redactRuntimeConfig, runtimeId, systemdWorkloads } from '../../src/runtime'

const context = { project: 'acme', environment: 'production', server: 'box-1', now: new Date('2026-07-21T12:00:00Z') }

describe('runtime model', () => {
  it('builds stable escaped composite identities', () => {
    expect(runtimeId('ecs', 'cluster/acme', 'service:api')).toBe('ecs:cluster%2Facme:service%3Aapi')
  })

  it('normalizes provider states without hiding raw state', () => {
    expect(normalizeRuntimeStatus('ACTIVE')).toBe('running')
    expect(normalizeRuntimeStatus('draining')).toBe('stopping')
    expect(normalizeRuntimeStatus('OOMKilled')).toBe('failed')
    expect(normalizeRuntimeStatus('brand-new-state')).toBe('unknown')
  })

  it('redacts nested secret-shaped fields', () => {
    expect(redactRuntimeConfig({ env: { DB_PASSWORD: 'secret', APP_ENV: 'prod' }, token: 'abc', items: [{ apiKey: 'x' }] })).toEqual({
      env: { DB_PASSWORD: '[REDACTED]', APP_ENV: 'prod' }, token: '[REDACTED]', items: [{ apiKey: '[REDACTED]' }],
    })
  })
})

describe('systemd adapter fixtures', () => {
  it('parses and normalizes service records', () => {
    const output = 'TSCLOUD_SYSTEMD\tacme-web@r1.service\tloaded\tactive\trunning\tAcme web\tenabled\t431\t1048576\t2\t2026-07-21T11:00:00Z\t/etc/systemd/system/acme.service\t/var/www/web/releases/r1\tweb\nnoise'
    const records = parseSystemdRecords(output)
    const [workload] = systemdWorkloads(records, context, 'systemd:box-1')
    expect(workload).toMatchObject({ provider: 'systemd', name: 'acme-web@r1', status: 'running', runningReplicas: 1, restartCount: 2, ageSeconds: 3600 })
    expect(workload.capabilities.scale.supported).toBeFalse()
    expect(workload.capabilities.exec).toMatchObject({ supported: true, requiresRecentAuth: true })
    expect(workload.links).toMatchObject({ service: 'web', release: 'r1' })
    expect(workload.mounts).toEqual([{ target: '/var/www/web/releases/r1', type: 'working-directory' }])
  })

  it('rejects unsafe unit names', () => {
    expect(parseSystemdRecords('TSCLOUD_SYSTEMD\tbad;rm.service\tloaded\tactive\trunning')).toEqual([])
  })
})

describe('container and cloud adapter fixtures', () => {
  it('maps Docker config, networks, mounts, and secret names only', () => {
    const records = parseDockerInspect(JSON.stringify([{ Id: 'abc123', Name: '/api', Config: { Image: 'acme/api@sha256:1', Labels: { 'ts-cloud.service': 'api', 'ts-cloud.release': 'r1' }, Env: ['APP_ENV=prod', 'API_TOKEN=hidden'] }, State: { Status: 'running', StartedAt: '2026-07-21T11:30:00Z' }, RestartCount: 3, HostConfig: { NetworkMode: 'bridge', Memory: 1024 }, Mounts: [{ Source: '/srv/api', Destination: '/app', Type: 'bind', RW: false }], NetworkSettings: { Networks: { bridge: { NetworkID: 'net1', IPAddress: '172.17.0.2' } }, Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] } } }]))
    const [workload] = dockerWorkloads(records, context, 'docker:box-1')
    expect(workload).toMatchObject({ name: 'api', image: 'acme/api@sha256:1', status: 'running', restartCount: 3, links: { service: 'api', release: 'r1' } })
    expect(workload.networks[0].ports?.[0]).toEqual({ container: 3000, host: 8080, protocol: 'tcp', address: '127.0.0.1' })
    expect(workload.mounts[0]).toEqual({ source: '/srv/api', target: '/app', type: 'bind', readOnly: true })
    expect(workload.config).toEqual({ image: 'acme/api@sha256:1', labels: { 'ts-cloud.service': 'api', 'ts-cloud.release': 'r1' }, environmentKeys: ['APP_ENV', 'API_TOKEN'], networkMode: 'bridge' })
  })

  it('maps ECS services and tasks', () => {
    const [workload] = ecsWorkloads([{ serviceArn: 'arn/service/acme/api', serviceName: 'api', clusterArn: 'arn/cluster/acme', status: 'ACTIVE', desiredCount: 2, runningCount: 1, pendingCount: 1, taskDefinition: 'arn/task-definition/api:42', launchType: 'FARGATE' }], [{ taskArn: 'arn/task/one', clusterArn: 'arn/cluster/acme', lastStatus: 'RUNNING', containers: [{ name: 'api', lastStatus: 'RUNNING' }] }], context, 'ecs:aws', [{ taskDefinitionArn: 'arn/task-definition/api:42', networkMode: 'awsvpc', containerDefinitions: [{ name: 'api', image: 'registry/acme/api@sha256:42', portMappings: [{ containerPort: 3000, protocol: 'tcp' }], mountPoints: [{ sourceVolume: 'data', containerPath: '/app/data', readOnly: false }], logConfiguration: { options: { 'awslogs-group': '/ecs/acme-api' } } }] }])
    expect(workload).toMatchObject({ provider: 'ecs', name: 'api', status: 'degraded', desiredReplicas: 2, runningReplicas: 1, version: 'api:42', image: 'registry/acme/api@sha256:42' })
    expect(workload.replicas).toHaveLength(1)
    expect(workload.capabilities.scale.supported).toBeTrue()
    expect(workload.capabilities.logs.supported).toBeTrue()
    expect(workload.mounts[0]).toMatchObject({ source: 'data', target: '/app/data' })
    expect(workload.networks[0].ports?.[0]).toMatchObject({ container: 3000, protocol: 'tcp' })
  })

  it('does not attach another ECS service task to this workload', () => {
    const workloads = ecsWorkloads([
      { serviceName: 'api', clusterArn: 'cluster', status: 'ACTIVE', desiredCount: 1, runningCount: 1 },
      { serviceName: 'worker', clusterArn: 'cluster', status: 'ACTIVE', desiredCount: 1, runningCount: 1 },
    ], [
      { taskArn: 'api-task', clusterArn: 'cluster', group: 'service:api', lastStatus: 'RUNNING' },
      { taskArn: 'worker-task', clusterArn: 'cluster', group: 'service:worker', lastStatus: 'RUNNING' },
    ], context)
    expect(workloads.find(item => item.name === 'api')?.replicas.map(item => item.name)).toEqual(['api-task'])
    expect(workloads.find(item => item.name === 'worker')?.replicas.map(item => item.name)).toEqual(['worker-task'])
  })

  it('maps Lambda without exposing environment values', () => {
    const [workload] = lambdaWorkloads([{ FunctionName: 'acme-production-http', FunctionArn: 'arn:lambda:http', Runtime: 'provided.al2023', State: 'Active', MemorySize: 1024, Environment: { Variables: { APP_ENV: 'prod', DB_PASSWORD: 'hidden' } } }], context)
    expect(workload).toMatchObject({ provider: 'lambda', kind: 'function', status: 'running', runtime: 'provided.al2023' })
    expect(workload.config).toMatchObject({ environmentKeys: ['APP_ENV', 'DB_PASSWORD'] })
    expect(JSON.stringify(workload)).not.toContain('hidden')
    expect(workload.capabilities.exec.supported).toBeFalse()
  })
})

describe('runtime inventory degradation', () => {
  it('keeps healthy sources when another source fails', async () => {
    const inventory = await discoverRuntimeInventory([
      { id: 'good', provider: 'systemd', discover: async () => systemdWorkloads([{ unit: 'api.service', active: 'active', sub: 'running' }], context, 'good') },
      { id: 'bad', provider: 'docker', discover: async () => { throw new Error('host unreachable') } },
    ], context, { timeoutMs: 100 })
    expect(inventory.workloads).toHaveLength(1)
    expect(inventory.degraded).toBeTrue()
    expect(inventory.sources).toEqual([
      expect.objectContaining({ id: 'good', status: 'fresh', itemCount: 1 }),
      expect.objectContaining({ id: 'bad', status: 'unreachable', itemCount: 0 }),
    ])
  })
})
