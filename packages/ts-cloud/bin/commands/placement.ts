import type { CLI } from '@stacksjs/clapp'
import type { PoolBackend, PoolPurpose } from '../../src/placement'
import * as cli from '../../src/utils/cli'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { FleetStore } from '../../src/fleet'
import { PlacementService, PlacementStore } from '../../src/placement'
import { loadValidatedConfig } from './shared'

async function context() {
  const config = await loadValidatedConfig(),
    controlPlane = initializeDashboardControlPlane(process.cwd(), config),
    store = new PlacementStore(controlPlane.store),
    service = new PlacementService(store, new FleetStore(controlPlane.store))
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
const values = (input: string | undefined) =>
  Object.fromEntries(
    String(input ?? '')
      .split(',')
      .map((value) => value.split('='))
      .filter((value) => value[0] && value[1]),
  )
const resources = (input: string | undefined) =>
  Object.fromEntries(Object.entries(values(input)).map(([key, value]) => [key, Number(value)]))
export function registerPlacementCommands(app: CLI): void {
  app
    .command('pool:list', 'List capacity pools and reservations')
    .option('--json', 'Print structured JSON')
    .action(async (options: { json?: boolean }) =>
      use((value) => {
        const pools = value.store.listPools(value.controlPlane.project.id)
        if (options.json) console.log(JSON.stringify(pools, null, 2))
        else
          cli.table(
            ['Name', 'Purpose', 'Backend', 'Region / arch', 'Status', 'Capacity', 'Concurrency'],
            pools.map((pool) => [
              pool.name,
              pool.purpose,
              pool.backend,
              `${pool.region ?? 'any'} / ${pool.architecture ?? 'any'}`,
              pool.status,
              JSON.stringify(pool.capacity),
              String(pool.concurrency),
            ]),
          )
      }),
    )
  app
    .command('pool:create <name>', 'Create a capacity pool')
    .option('--purpose <purpose>', 'application, build, worker, monitoring, or backup', { default: 'application' })
    .option('--backend <backend>', 'server, ecs, or asg', { default: 'server' })
    .option('--capacity <values>', 'cpu=4,memoryBytes=8589934592,diskBytes=...')
    .option('--region <region>', 'Required region')
    .option('--arch <architecture>', 'Required architecture')
    .option('--labels <labels>', 'Pool key=value labels')
    .option('--selector <labels>', 'Required server labels')
    .option('--max <count>', 'Maximum workloads', { default: '10' })
    .option('--concurrency <count>', 'Build concurrency', { default: '1' })
    .action(async (name: string, options: any) =>
      use((value) => {
        const purpose = options.purpose as PoolPurpose,
          backend = options.backend as PoolBackend
        if (
          !['application', 'build', 'worker', 'monitoring', 'backup'].includes(purpose) ||
          !['server', 'ecs', 'asg'].includes(backend)
        )
          throw new Error('Unsupported pool purpose or backend.')
        const pool = value.store.createPool({
          organizationId: value.controlPlane.organization.id,
          projectId: value.controlPlane.project.id,
          name,
          purpose,
          backend,
          region: options.region,
          architecture: options.arch,
          labels: values(options.labels),
          requiredServerLabels: values(options.selector),
          toleratedTaints: [],
          capacity: { cpu: 0, memoryBytes: 0, diskBytes: 0, gpu: 0, ...resources(options.capacity) },
          maxWorkloads: Number(options.max),
          costWeight: 1,
          concurrency: Number(options.concurrency),
          ephemeralWorkspaces: true,
          allowProductionSecrets: false,
          status: 'active',
        })
        cli.success(`Created ${pool.name} (${pool.id}).`)
      }),
    )
  app
    .command('pool:add-server <pool> <server>', 'Attach an enrolled server to a pool')
    .action(async (poolName: string, serverName: string) =>
      use((value) => {
        const pool = value.store
            .listPools(value.controlPlane.project.id)
            .find((item) => item.id === poolName || item.name === poolName),
          server = new FleetStore(value.controlPlane.store)
            .list(value.controlPlane.project.id)
            .find((item) => item.id === serverName || item.name === serverName)
        if (!pool || !server) throw new Error('Pool or server was not found.')
        value.store.addMember(pool.id, server.id)
        cli.success(`Attached ${server.name} to ${pool.name}.`)
      }),
    )
  app
    .command('placement:explain', 'Explain eligible and rejected placement targets')
    .option('--purpose <purpose>', 'Workload purpose', { default: 'application' })
    .option('--resources <values>', 'Requested resources')
    .option('--region <region>', 'Required region')
    .option('--arch <architecture>', 'Required architecture')
    .option('--labels <labels>', 'Required pool labels')
    .option('--json', 'Print structured JSON')
    .action(async (options: any) =>
      use((value) => {
        const decisions = value.service.explain(value.controlPlane.project.id, {
          purpose: options.purpose,
          resources: resources(options.resources),
          region: options.region,
          architecture: options.arch,
          labels: values(options.labels),
        })
        if (options.json) console.log(JSON.stringify(decisions, null, 2))
        else
          cli.table(
            ['Pool', 'Server', 'Eligible', 'Available', 'Fit / spread / cost', 'Reasons'],
            decisions.map((item) => [
              item.poolName,
              item.serverId ?? 'provider-managed',
              item.eligible ? 'yes' : 'no',
              JSON.stringify(item.available),
              `${item.score.fit.toFixed(2)} / ${item.score.spread} / ${item.score.cost}`,
              item.reasons.join('; ') || 'eligible',
            ]),
          )
      }),
    )
  app
    .command('pool:drain <pool>', 'Move stateless placements and block stateful placements')
    .action(async (name: string) =>
      use((value) => {
        const pool = value.store
          .listPools(value.controlPlane.project.id)
          .find((item) => item.id === name || item.name === name)
        if (!pool) throw new Error('Pool was not found.')
        const result = value.service.drainPool(pool.id)
        cli.success(
          `Draining ${pool.name}: moved ${result.moved.length}, blocked ${result.blocked.length} stateful placement(s).`,
        )
      }),
    )
}
