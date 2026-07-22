import type { CLI } from '@stacksjs/clapp'
import type { RegionalOperationKind } from '../../src/regions'
import * as cli from '../../src/utils/cli'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { RegionService, RegionStore } from '../../src/regions'
import { loadValidatedConfig } from './shared'

async function context() {
  const config = await loadValidatedConfig(),
    controlPlane = initializeDashboardControlPlane(process.cwd(), config),
    store = new RegionStore(controlPlane.store),
    service = new RegionService(store)
  return { controlPlane, store, service }
}
async function use(callback: (value: Awaited<ReturnType<typeof context>>) => Promise<void> | void) {
  const value = await context()
  try {
    await callback(value)
  } catch (error) {
    cli.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    value.controlPlane.store.close()
  }
}
const find = (value: Awaited<ReturnType<typeof context>>, name: string) => {
  const topology = value.store
    .list(value.controlPlane.project.id)
    .find((item) => item.id === name || item.name === name)
  if (!topology) throw new Error('Regional topology was not found.')
  return topology
}
const regions = (input: string) =>
  input.split(',').map((value, index) => {
    const [region, provider = 'aws'] = value.split(':')
    return { region: String(region), provider, role: index === 0 ? ('primary' as const) : ('secondary' as const) }
  })
export const replicationKinds = (input: string): Array<'s3' | 'dynamodb' | 'secrets'> => {
  const allowed = new Set(['s3', 'dynamodb', 'secrets'])
  const values = input.split(',').map((value) => value.trim())
  const unsupported = values.find((value) => !allowed.has(value))
  if (unsupported) throw new Error(`Unsupported replication kind: ${unsupported}`)
  return values as Array<'s3' | 'dynamodb' | 'secrets'>
}
export function registerRegionCommands(app: CLI): void {
  app
    .command('region:list', 'List regional topology, traffic, and replication health')
    .option('--json', 'Print structured JSON')
    .action(async (options: { json?: boolean }) =>
      use((value) => {
        const result = value.store.list(value.controlPlane.project.id).map((topology) => ({
          topology,
          targets: value.store.targets(topology.id),
          channels: value.store.channels(topology.id),
          route: value.store.route(topology.id),
          executions: value.store.executions(topology.id),
        }))
        if (options.json) console.log(JSON.stringify(result, null, 2))
        else
          cli.table(
            ['Name', 'Hostname', 'Active', 'Status', 'Revision', 'Replication'],
            result.map((item) => [
              item.topology.name,
              item.topology.hostname,
              item.topology.activeRegion,
              item.topology.status,
              item.topology.revision ?? '—',
              `${item.channels.filter((channel) => channel.status === 'in_sync').length}/${item.channels.length} in sync`,
            ]),
          )
      }),
    )
  app
    .command('region:create <name>', 'Create a persistent multi-region topology')
    .option('--hostname <hostname>', 'Traffic hostname')
    .option('--regions <regions>', 'Comma-separated region[:provider], primary first')
    .option('--replicate <kinds>', 's3,dynamodb,secrets', { default: 's3,dynamodb,secrets' })
    .option('--max-lag <seconds>', 'Maximum failover lag', { default: '30' })
    .option('--cdn', 'Enable CloudFront edge state')
    .option('--waf', 'Enable WAF edge state')
    .action(async (name: string, options: any) =>
      use((value) => {
        if (!options.hostname || !options.regions) throw new Error('--hostname and --regions are required.')
        const topology = value.service.create({
          organizationId: value.controlPlane.organization.id,
          projectId: value.controlPlane.project.id,
          name,
          hostname: options.hostname,
          regions: regions(options.regions),
          trafficPolicy: 'active_passive',
          dataPolicy: {
            replicate: replicationKinds(String(options.replicate)),
            maxLagSeconds: Number(options.maxLag),
            retainOnDestroy: true,
          },
          dnsProvider: 'route53',
          cdnEnabled: !!options.cdn,
          wafEnabled: !!options.waf,
        })
        cli.success(`Created ${topology.name} (${topology.id}); run region:rollout with an immutable manifest.`)
      }),
    )
  app
    .command('region:plan <name> <operation>', 'Preview exact regional execution steps')
    .option('--target <region>', 'Failover or failback region')
    .action(async (name: string, operation: RegionalOperationKind, options: any) =>
      use((value) =>
        cli.table(
          ['Step'],
          value.service.plan(find(value, name).id, operation, options.target).map((step) => [step]),
        ),
      ),
    )
  app
    .command('region:rollout <name> <revision>', 'Queue secondary-first regional stack rollout')
    .option('--manifest <file>', 'Regional stack manifest JSON')
    .action(async (name: string, revision: string, options: any) =>
      use(async (value) => {
        const manifest = options.manifest ? await Bun.file(options.manifest).json() : {}
        const result = value.service.enqueue({ topologyId: find(value, name).id, kind: 'rollout', revision, manifest })
        cli.success(`Regional rollout queued: ${result.operation.id}`)
      }),
    )
  app
    .command('region:failover <name> <region>', 'Queue health and RPO-gated failover')
    .action(async (name: string, region: string) =>
      use((value) => {
        const result = value.service.enqueue({
          topologyId: find(value, name).id,
          kind: 'failover',
          targetRegion: region,
        })
        cli.success(`Failover queued: ${result.operation.id}`)
      }),
    )
  app
    .command('region:failback <name> <region>', 'Queue health and RPO-gated failback')
    .action(async (name: string, region: string) =>
      use((value) => {
        const result = value.service.enqueue({
          topologyId: find(value, name).id,
          kind: 'failback',
          targetRegion: region,
        })
        cli.success(`Failback queued: ${result.operation.id}`)
      }),
    )
  app
    .command('region:destroy <name>', 'Drain traffic and delete regional stacks while retaining data')
    .option('--confirm <name>', 'Exact topology name')
    .action(async (name: string, options: any) =>
      use((value) => {
        const result = value.service.enqueue({
          topologyId: find(value, name).id,
          kind: 'destroy',
          confirmation: options.confirm,
        })
        cli.success(`Regional teardown queued: ${result.operation.id}; replicated data remains retained.`)
      }),
    )
}
