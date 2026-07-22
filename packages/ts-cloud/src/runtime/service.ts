import type { CloudConfig, CloudDriver, ComputeTarget, EnvironmentType } from '@ts-cloud/core'
import { resolveCloudProvider, resolveDeploymentMode } from '@ts-cloud/core'
import type { ECSClient, LambdaClient } from '../aws'
import { ECSClient as LiveECSClient, LambdaClient as LiveLambdaClient } from '../aws'
import { createCloudDriver } from '../drivers'
import { ecsWorkloads, lambdaWorkloads } from './adapters/aws'
import { DockerDiscoveryAdapter } from './adapters/docker'
import { SystemdDiscoveryAdapter } from './adapters/systemd'
import { discoverRuntimeInventory } from './inventory'
import type { RuntimeDiscoveryAdapter, RuntimeDiscoveryContext, RuntimeInventory } from './model'

interface EcsReader extends Pick<ECSClient, 'listClusters' | 'listServices' | 'describeServices' | 'listTasks' | 'describeTasks'> {}
interface LambdaReader extends Pick<LambdaClient, 'listFunctions'> {}

export interface RuntimeServiceDependencies {
  driver?: CloudDriver
  ecs?: EcsReader
  lambda?: LambdaReader
}

function commandOutput(result: Awaited<ReturnType<CloudDriver['runRemoteDeploy']>>, source: string): string {
  if (!result.success) throw new Error(result.error || result.perInstance?.[0]?.error || `${source} discovery failed`)
  return result.perInstance?.[0]?.output ?? ''
}

function systemdDiscoveryScript(): string[] {
  return [
    'set -uo pipefail',
    'command -v systemctl >/dev/null 2>&1 || { echo "systemctl is unavailable" >&2; exit 127; }',
    'systemctl list-units --type=service --all --plain --no-legend 2>/dev/null | awk \'{print $1}\' | while IFS= read -r unit; do',
    '  [ -n "$unit" ] || continue',
    '  clean() { printf "%s" "$1" | tr "\\t\\r\\n" "   "; }',
    '  load=$(systemctl show "$unit" -p LoadState --value 2>/dev/null || true)',
    '  active=$(systemctl show "$unit" -p ActiveState --value 2>/dev/null || true)',
    '  sub=$(systemctl show "$unit" -p SubState --value 2>/dev/null || true)',
    '  description=$(systemctl show "$unit" -p Description --value 2>/dev/null || true)',
    '  enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)',
    '  pid=$(systemctl show "$unit" -p MainPID --value 2>/dev/null || true)',
    '  memory=$(systemctl show "$unit" -p MemoryCurrent --value 2>/dev/null || true)',
    '  restarts=$(systemctl show "$unit" -p NRestarts --value 2>/dev/null || true)',
    '  since=$(systemctl show "$unit" -p ActiveEnterTimestamp --value 2>/dev/null || true)',
    '  fragment=$(systemctl show "$unit" -p FragmentPath --value 2>/dev/null || true)',
    '  printf "TSCLOUD_SYSTEMD\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$(clean "$unit")" "$(clean "$load")" "$(clean "$active")" "$(clean "$sub")" "$(clean "$description")" "$(clean "$enabled")" "$(clean "$pid")" "$(clean "$memory")" "$(clean "$restarts")" "$(clean "$since")" "$(clean "$fragment")"',
    'done',
  ]
}

function dockerDiscoveryScript(): string[] {
  return [
    'set -uo pipefail',
    'if ! command -v docker >/dev/null 2>&1; then echo "[]"; exit 0; fi',
    'ids=$(docker ps -aq)',
    'if [ -z "$ids" ]; then echo "[]"; else docker inspect $ids; fi',
  ]
}

function targetAdapter(
  provider: 'systemd' | 'docker',
  driver: CloudDriver,
  target: ComputeTarget,
  config: CloudConfig,
  environment: EnvironmentType,
): RuntimeDiscoveryAdapter {
  const id = `${provider}:${target.id}`
  const read = async (): Promise<string> => commandOutput(await driver.runRemoteDeploy({
    targets: [target],
    commands: provider === 'systemd' ? systemdDiscoveryScript() : dockerDiscoveryScript(),
    timeoutSeconds: 30,
    comment: `ts-cloud runtime discovery:${provider}`,
    tags: { Project: config.project.slug, Environment: environment, Role: 'app' },
  }), id)
  return provider === 'systemd' ? new SystemdDiscoveryAdapter(read, id) : new DockerDiscoveryAdapter(read, id)
}

async function collectPages<T>(read: (nextToken?: string) => Promise<{ items: T[], nextToken?: string }>, maxPages = 100): Promise<T[]> {
  const items: T[] = []
  let nextToken: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const result = await read(nextToken)
    items.push(...result.items)
    if (!result.nextToken) return items
    nextToken = result.nextToken
  }
  throw new Error(`Provider pagination exceeded ${maxPages} pages`)
}

export class EcsRuntimeAdapter implements RuntimeDiscoveryAdapter {
  readonly id = 'ecs:aws'
  readonly provider = 'ecs' as const
  constructor(private readonly client: EcsReader, private readonly prefix: string) {}

  async discover(context: RuntimeDiscoveryContext): Promise<import('./model').RuntimeWorkload[]> {
    const clusters = await collectPages(async nextToken => {
      const page = await this.client.listClusters({ nextToken, maxResults: 100 })
      return { items: page.clusterArns ?? [], nextToken: page.nextToken }
    })
    const services = []
    const tasks = []
    for (const cluster of clusters) {
      const serviceArns = (await collectPages(async nextToken => {
        const page = await this.client.listServices(cluster, { nextToken, maxResults: 100 })
        return { items: page.serviceArns ?? [], nextToken: page.nextToken }
      })).filter(arn => arn.split('/').at(-1)?.startsWith(this.prefix))
      for (let index = 0; index < serviceArns.length; index += 10) {
        const described = await this.client.describeServices({ cluster, services: serviceArns.slice(index, index + 10) })
        services.push(...(described.services ?? []))
      }
      for (const service of services.filter(item => item.clusterArn === cluster || !item.clusterArn)) {
        const taskArns = await collectPages(async nextToken => {
          const page = await this.client.listTasks(cluster, service.serviceName, { nextToken, maxResults: 100 })
          return { items: page.taskArns ?? [], nextToken: page.nextToken }
        })
        for (let index = 0; index < taskArns.length; index += 100) {
          const described = await this.client.describeTasks(cluster, taskArns.slice(index, index + 100))
          tasks.push(...(described.tasks ?? []))
        }
      }
    }
    return ecsWorkloads(services, tasks, context, this.id)
  }
}

export class LambdaRuntimeAdapter implements RuntimeDiscoveryAdapter {
  readonly id = 'lambda:aws'
  readonly provider = 'lambda' as const
  constructor(private readonly client: LambdaReader, private readonly prefix: string) {}
  async discover(context: RuntimeDiscoveryContext): Promise<import('./model').RuntimeWorkload[]> {
    const functions = (await collectPages(async Marker => {
      const page = await this.client.listFunctions({ Marker, MaxItems: 50 })
      return { items: page.Functions ?? [], nextToken: page.NextMarker }
    })).filter(fn => fn.FunctionName?.startsWith(this.prefix))
    return lambdaWorkloads(functions, context, this.id)
  }
}

export async function createRuntimeAdapters(
  config: CloudConfig,
  environment: EnvironmentType,
  dependencies: RuntimeServiceDependencies = {},
): Promise<RuntimeDiscoveryAdapter[]> {
  const adapters: RuntimeDiscoveryAdapter[] = []
  const mode = resolveDeploymentMode(config)
  const provider = resolveCloudProvider(config)
  const profile = config.aws?.profile
  const region = config.aws?.region ?? config.project.region ?? 'us-east-1'
  const prefix = `${config.project.slug}-${environment}`

  if (mode !== 'serverless') {
    const driver = dependencies.driver ?? createCloudDriver({ config })
    const targets = await driver.findComputeTargets({ slug: config.project.slug, environment, role: 'app' })
    for (const target of targets) {
      adapters.push(targetAdapter('systemd', driver, target, config, environment))
      adapters.push(targetAdapter('docker', driver, target, config, environment))
    }
  }
  if (provider === 'aws') {
    adapters.push(new EcsRuntimeAdapter(dependencies.ecs ?? new LiveECSClient(region, profile), prefix))
    adapters.push(new LambdaRuntimeAdapter(dependencies.lambda ?? new LiveLambdaClient(region, profile), prefix))
  }
  return adapters
}

export async function resolveRuntimeInventory(
  config: CloudConfig,
  environment: EnvironmentType,
  dependencies: RuntimeServiceDependencies = {},
): Promise<RuntimeInventory> {
  const context = { project: config.project.slug, environment }
  try {
    return await discoverRuntimeInventory(await createRuntimeAdapters(config, environment, dependencies), context)
  }
  catch (error: any) {
    return {
      generatedAt: new Date().toISOString(),
      workloads: [],
      sources: [{ id: 'runtime:bootstrap', provider: resolveCloudProvider(config) === 'aws' ? 'ecs' : 'systemd', status: 'error', discoveredAt: new Date().toISOString(), staleAfterSeconds: 60, itemCount: 0, message: String(error?.message ?? error).slice(0, 500) }],
      degraded: true,
    }
  }
}
