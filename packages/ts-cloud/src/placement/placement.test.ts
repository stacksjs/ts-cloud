import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { FleetService, FleetStore } from '../fleet'
import type { FleetDriver, ServerProvider } from '../fleet'
import { PlacementService, PlacementStore } from './index'
import { RemoteBuildService, createRemoteBuildQueueHandlers } from './index'
import type { RemoteBuildDriver } from './index'
import { DurableQueueWorker } from '../queue'

const controls: ControlPlaneStore[] = []
afterEach(() => {
  while (controls.length) controls.pop()!.close()
})
class Driver implements FleetDriver {
  provider: ServerProvider = 'ssh'
  async discover() {
    return []
  }
  async test() {
    return { reachable: true, hostKeyAlgorithm: 'ssh-ed25519', hostKeyFingerprint: 'SHA256:test', latencyMs: 1 }
  }
  async validate() {
    return {
      arch: 'x86_64',
      cpuCores: 8,
      memoryBytes: 16_000,
      diskBytes: 100_000,
      dnsOk: true,
      timeSkewSeconds: 0,
      tools: { curl: '8', tar: '1' },
    }
  }
  async bootstrap() {
    return { version: '1' }
  }
  capabilities() {
    return { placement: { supported: true } }
  }
}
function fixture() {
  const control = new ControlPlaneStore({ path: ':memory:' })
  controls.push(control)
  const organization = control.createOrganization({ slug: 'acme', name: 'Acme' }),
    project = control.createProject({ organizationId: organization.id, slug: 'cloud', name: 'Cloud' }),
    environment = control.createEnvironment({
      projectId: project.id,
      slug: 'production',
      name: 'Production',
      kind: 'production',
    }),
    fleet = new FleetStore(control),
    fleetService = new FleetService(fleet, [new Driver()]),
    placements = new PlacementStore(control),
    service = new PlacementService(placements, fleet)
  return { control, organization, project, environment, fleet, fleetService, placements, service }
}
function server(target: ReturnType<typeof fixture>, name: string, roles: ('application' | 'build')[]) {
  const value = target.fleetService.enroll({
    organizationId: target.organization.id,
    projectId: target.project.id,
    name,
    provider: 'ssh',
    providerId: name,
    endpoint: `${name}.example.test`,
    sshUser: 'deploy',
    credentialRef: `secret://fleet/${name}`,
    roles,
    labels: { tier: roles[0]! },
  })
  return target.fleet.update(value.id, {
    status: 'ready',
    trustState: 'pinned',
    capacity: { cpu: 4, memoryBytes: 8_000, diskBytes: 50_000, gpu: 0 },
  })
}
function resource(target: ReturnType<typeof fixture>, slug: string) {
  return target.control.createResource({
    projectId: target.project.id,
    environmentId: target.environment.id,
    kind: 'application',
    slug,
    name: slug,
  })
}
function pool(
  target: ReturnType<typeof fixture>,
  name: string,
  purpose: 'application' | 'build',
  serverId: string,
  capacity = { cpu: 4, memoryBytes: 8_000, diskBytes: 50_000, gpu: 0 },
  costWeight = purpose === 'build' ? 0.5 : 1,
) {
  const value = target.placements.createPool({
    organizationId: target.organization.id,
    projectId: target.project.id,
    name,
    purpose,
    backend: 'server',
    region: 'west',
    architecture: 'x86_64',
    labels: { tier: purpose },
    requiredServerLabels: { tier: purpose },
    toleratedTaints: [],
    capacity,
    maxWorkloads: 4,
    costWeight,
    concurrency: purpose === 'build' ? 2 : 4,
    ephemeralWorkspaces: true,
    allowProductionSecrets: false,
    status: 'active',
  })
  target.placements.addMember(value.id, serverId)
  return value
}

describe('capacity placement', () => {
  it('routes application and build workloads into purpose-specific pools with explainable decisions', () => {
    const target = fixture(),
      appServer = server(target, 'app-1', ['application']),
      builder = server(target, 'build-1', ['build']),
      production = pool(target, 'production', 'application', appServer.id),
      build = pool(target, 'builders', 'build', builder.id),
      app = resource(target, 'api'),
      buildResource = resource(target, 'api-build')
    const appExplanation = target.service.explain(target.project.id, { purpose: 'application', resources: { cpu: 1 } })
    expect(appExplanation.find((item) => item.poolId === production.id)).toMatchObject({ eligible: true, reasons: [] })
    expect(appExplanation.find((item) => item.poolId === build.id)?.reasons).toContain('purpose is build')
    expect(
      target.service.place({
        projectId: target.project.id,
        environmentId: target.environment.id,
        resourceId: app.id,
        requirements: { purpose: 'application', resources: { cpu: 1 }, region: 'west', architecture: 'x86_64' },
      }).poolId,
    ).toBe(production.id)
    expect(
      target.service.place({
        projectId: target.project.id,
        resourceId: buildResource.id,
        requirements: { purpose: 'build', resources: { cpu: 1 } },
      }).poolId,
    ).toBe(build.id)
  })
  it('reserves capacity atomically without overcommit', async () => {
    const target = fixture(),
      node = server(target, 'app-1', ['application'])
    pool(target, 'production', 'application', node.id, { cpu: 2, memoryBytes: 2_000, diskBytes: 2_000, gpu: 0 })
    const first = resource(target, 'one'),
      second = resource(target, 'two'),
      results = await Promise.allSettled([
        Promise.resolve().then(() =>
          target.service.place({
            projectId: target.project.id,
            resourceId: first.id,
            requirements: { purpose: 'application', resources: { cpu: 2 } },
          }),
        ),
        Promise.resolve().then(() =>
          target.service.place({
            projectId: target.project.id,
            resourceId: second.id,
            requirements: { purpose: 'application', resources: { cpu: 2 } },
          }),
        ),
      ])
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1)
  })
  it('moves stateless workloads during drain and blocks stateful workloads', () => {
    const target = fixture(),
      a = server(target, 'app-a', ['application']),
      b = server(target, 'app-b', ['application']),
      first = pool(target, 'primary', 'application', a.id, undefined, 0),
      second = pool(target, 'secondary', 'application', b.id, undefined, 10),
      stateless = resource(target, 'web'),
      stateful = resource(target, 'database'),
      one = target.service.place({
        projectId: target.project.id,
        resourceId: stateless.id,
        requirements: { purpose: 'application', resources: { cpu: 1 }, autoReschedule: true },
      }),
      two = target.service.place({
        projectId: target.project.id,
        resourceId: stateful.id,
        requirements: { purpose: 'application', resources: { cpu: 1 }, stateful: true, autoReschedule: true },
      })
    target.service.activate(one.id)
    target.service.activate(two.id)
    const result = target.service.drainPool(first.id)
    expect(result.moved).toHaveLength(1)
    expect(result.moved[0]?.poolId).toBe(second.id)
    expect(result.blocked).toMatchObject([
      { resourceId: stateful.id, status: 'blocked', stateful: true, autoReschedule: false },
    ])
  })
})

describe('remote builds', () => {
  it('uses isolated short-lived credentials and publishes a verified artifact before cleanup', async () => {
    const target = fixture(),
      builder = server(target, 'build-1', ['build']),
      buildPool = pool(target, 'builders', 'build', builder.id),
      app = resource(target, 'builder-target'),
      builds = new RemoteBuildService(target.placements, target.service),
      events: string[] = [],
      driver: RemoteBuildDriver = {
        backend: 'server',
        run: async ({ build, pool, log }) => {
          expect(pool.id).toBe(buildPool.id)
          expect(build.credentialPolicy.productionSecrets).toBe(false)
          expect(build.workspace).toStartWith('build://')
          log('cache restored')
          events.push('run')
          return {
            artifactUri: 'oci://registry.example/app@sha256:verified',
            artifactDigest: `sha256:${'a'.repeat(64)}`,
            cacheKey: 'bun-lock-v1',
          }
        },
        cleanup: async () => {
          events.push('cleanup')
        },
      }
    const queued = builds.enqueue({
      projectId: target.project.id,
      resourceId: app.id,
      sourceSha: 'abcdef1234567',
      buildSpec: { command: 'bun run build' },
      requirements: { resources: { cpu: 1, memoryBytes: 100, diskBytes: 100 } },
    })
    expect(queued.status).toBe('queued')
    expect(
      await new DurableQueueWorker(builds.queue, createRemoteBuildQueueHandlers(target.placements, [driver])).drain(),
    ).toMatchObject([{ terminalState: 'succeeded' }])
    expect(target.placements.getBuild(queued.id)).toMatchObject({
      status: 'succeeded',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      artifactUri: 'oci://registry.example/app@sha256:verified',
      workspace: undefined,
    })
    expect(events).toEqual(['run', 'cleanup'])
  })
  it('rejects unverified artifacts and still cleans the ephemeral workspace', async () => {
    const target = fixture(),
      builder = server(target, 'build-1', ['build'])
    pool(target, 'builders', 'build', builder.id)
    const app = resource(target, 'bad-build'),
      builds = new RemoteBuildService(target.placements, target.service)
    let cleaned = false
    const driver: RemoteBuildDriver = {
      backend: 'server',
      run: async () => ({ artifactUri: '/tmp/app.tar', artifactDigest: 'latest' }),
      cleanup: async () => {
        cleaned = true
      },
    }
    const queued = builds.enqueue({
      projectId: target.project.id,
      resourceId: app.id,
      sourceSha: 'abcdef1234567',
      buildSpec: {},
      requirements: { resources: { cpu: 1, memoryBytes: 100, diskBytes: 100 } },
    })
    expect(
      await new DurableQueueWorker(builds.queue, createRemoteBuildQueueHandlers(target.placements, [driver])).drain(),
    ).toMatchObject([{ terminalState: 'failed' }])
    expect(target.placements.getBuild(queued.id)?.status).toBe('failed')
    expect(cleaned).toBe(true)
  })
})
