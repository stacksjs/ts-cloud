import type { CLI } from '@stacksjs/clapp'
import type { EnvironmentType } from '@ts-cloud/core'
import type { DataAction, DataEngine, DataProvider, DataService, JsonValue } from '../../src'
import * as output from '../../src/utils/cli'
import { resolveAuthEncryptionKey } from '../../src/auth'
import { AwsAuroraDataAdapter, AwsAuroraTransport, AwsElastiCacheDataAdapter, AwsElastiCacheTransport, AwsRdsDataAdapter, AwsRdsTransport, connectionGuidance, ContainerDataAdapter, dataServiceCapabilities, DataServiceLifecycle, DataServiceStore, DockerDataTransport, EncryptedDataSecretStore, ServerDataAdapter } from '../../src/data-services'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { DurableOperationQueue } from '../../src/queue'
import { loadValidatedConfig } from './shared'

const ENGINES: readonly DataEngine[] = [
  'postgres',
  'mysql',
  'mariadb',
  'redis',
  'mongodb',
  'libsql',
],
PROVIDERS: readonly DataProvider[] = [
  'aws_rds',
  'aws_aurora',
  'aws_elasticache',
  'server',
  'container',
  'external',
],
ACTIONS: readonly DataAction[] = [
  'observe',
  'connect',
  'backup',
  'restore',
  'restart',
  'resize',
  'version',
  'rotate',
  'expose',
  'delete',
  'logs',
  'slow_queries',
  'users',
  'databases',
]

interface DataCommandOptions {
  env?: string
  json?: boolean
  engine?: string
  provider?: string
  placement?: string
  plan?: string
  engineVersion?: string
  storage?: string
  username?: string
  database?: string
  subnetGroup?: string
  securityGroups?: string
  highAvailability?: boolean
  public?: boolean
  cidrs?: string
  readonly?: boolean
  execute?: boolean
  retention?: string
  confirm?: string
  backupId?: string
  compatibilityReviewed?: boolean
  minCapacity?: string
  maxCapacity?: string
  reveal?: boolean
  resource?: string
  dynamic?: boolean
  remove?: boolean
}

async function context(environment?: string, serviceHint?: string) {
  const config = await loadValidatedConfig(),
  controlPlane = initializeDashboardControlPlane(process.cwd(), config),
  store = new DataServiceStore(controlPlane.store),
  hintedService = !environment && serviceHint
    ? store.get(serviceHint) ??
  store.list(controlPlane.project.id).find(item => item.name === serviceHint)
    : undefined,
  hintedEnvironment = hintedService?.environmentId
    ? controlPlane.store
    .listEnvironments(controlPlane.project.id)
    .find(item => item.id === hintedService.environmentId)?.slug
    : undefined,
  env = (environment ??
  hintedEnvironment ??
  Object.keys(config.environments ?? {})[0] ??
  'production') as EnvironmentType,
  environmentRecord = controlPlane.environments.get(env)
  if (!environmentRecord) {
    controlPlane.store.close()
    throw new Error(`Environment ${env} was not found.`)
  }
  const queue = new DurableOperationQueue(controlPlane.store, {
    workerId: `cli:${process.pid}`,
  }),
  secrets = new EncryptedDataSecretStore(
    controlPlane.store,
    resolveAuthEncryptionKey(process.cwd()),
  ),
  lifecycle = new DataServiceLifecycle(store, queue, secrets),
  actor = controlPlane.store.getActorByExternalId('system', 'cli') ??
    controlPlane.store.createActor({
      kind: 'system',
      externalId: 'cli',
      displayName: 'ts-cloud CLI',
    }),
  adapters = {
    aws_rds: new AwsRdsDataAdapter(new AwsRdsTransport()),
    aws_aurora: new AwsAuroraDataAdapter(new AwsAuroraTransport()),
    aws_elasticache: new AwsElastiCacheDataAdapter(
      new AwsElastiCacheTransport(),
    ),
    server: new ServerDataAdapter(new DockerDataTransport()),
    container: new ContainerDataAdapter(new DockerDataTransport()),
  } as const
  return {
    config,
    controlPlane,
    environmentRecord,
    env,
    store,
    queue,
    secrets,
    lifecycle,
    actor,
    resolveAdapter: (service: Pick<DataService, 'provider'>) =>
    adapters[service.provider as keyof typeof adapters],
  }
}

type DataContext = Awaited<ReturnType<typeof context>>

async function withContext<T>(
  environment: string | undefined,
  callback: (value: DataContext) => Promise<T>,
  hint?: string,
): Promise<T> {
  const value = await context(environment, hint)
  try {
    return await callback(value)
  } finally {
    value.controlPlane.store.close()
  }
}

async function run(callback: () => Promise<void>): Promise<void> {
  try {
    await callback()
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error))
  }
}

function engine(value: string | undefined): DataEngine {
  if (!ENGINES.includes(value as DataEngine))
    throw new Error(`--engine must be ${ENGINES.join(', ')}.`)
  return value as DataEngine
}

function provider(value: string | undefined): DataProvider {
  if (!PROVIDERS.includes(value as DataProvider))
    throw new Error(`--provider must be ${PROVIDERS.join(', ')}.`)
  return value as DataProvider
}

function findService(value: DataContext, idOrName: string): DataService {
  const services = value.store.list(value.controlPlane.project.id, value.environmentRecord.id),
  service = value.store.get(idOrName) ??
  services.find(item => item.name === idOrName)
  if (!service || service.environmentId !== value.environmentRecord.id)
    throw new Error(`Data service ${idOrName} was not found in ${value.env}.`)
  return service
}

export function dataServiceRows(services: DataService[]): string[][] {
  return services.map(item => [
    item.id,
    item.name,
    item.engine,
    item.provider,
    item.status,
    item.plan,
    item.publicExposure ? 'public allowlist' : 'private',
    item.managementEnabled ? 'managed' : 'read-only',
  ])
}

export function dataActionChanges(options: DataCommandOptions): Record<string, JsonValue> {
  const changes: Record<string, JsonValue> = {}
  if (options.plan) changes.plan = options.plan
  if (options.storage != null) changes.storageGb = Number(options.storage)
  if (options.engineVersion) changes.engineVersion = options.engineVersion
  if (options.retention) changes.retention = options.retention
  if (options.confirm) changes.confirm = options.confirm
  if (options.backupId) changes.backupId = options.backupId
  if (options.compatibilityReviewed) changes.compatibilityReviewed = true
  if (options.minCapacity != null)
    changes.minCapacity = Number(options.minCapacity)
  if (options.maxCapacity != null)
    changes.maxCapacity = Number(options.maxCapacity)
  if (options.public != null) changes.publicExposure = options.public
  if (options.cidrs)
    changes.allowedCidrs = options.cidrs
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  return changes
}

function endpoints(service: DataService) {
  const host = typeof service.observedState.endpoint === 'string'
      ? service.observedState.endpoint
      : service.placement,
    port = Number(service.observedState.port) ||
      (service.engine === 'postgres'
        ? 5432
        : service.engine === 'redis'
          ? 6379
          : 3306),
    database = typeof service.observedState.database === 'string'
      ? service.observedState.database
      : undefined
  return [
    {
      type: service.publicExposure ? ('external' as const) : ('internal' as const),
      host,
      port,
      database,
      tls: true,
    },
    { type: 'tunnel' as const, host, port, database, tls: true },
  ]
}

function createOptions(command: ReturnType<CLI['command']>): void {
  command
    .option('--env <environment>', 'Target environment')
    .option('--engine <engine>', 'postgres, mysql, mariadb, redis, mongodb, or libsql', { default: 'postgres' })
    .option('--provider <provider>', 'aws_rds, aws_aurora, aws_elasticache, server, container, or external', { default: 'aws_rds' })
    .option('--placement <id>', 'Provider identifier or runtime placement')
    .option('--plan <plan>', 'Provider plan or instance type', { default: 'db.t4g.micro' })
    .option('--engine-version <version>', 'Engine version')
    .option('--storage <gb>', 'Allocated storage in GB', { default: '20' })
    .option('--username <name>', 'Generated credential username', { default: 'app' })
    .option('--database <name>', 'Initial logical database')
    .option('--subnet-group <name>', 'Private subnet group')
    .option('--security-groups <ids>', 'Comma-separated security group IDs')
    .option('--high-availability', 'Enable provider high availability')
    .option('--public', 'Request a public endpoint; requires narrow --cidrs')
    .option('--cidrs <ranges>', 'Comma-separated narrow public CIDRs')
}

export function registerDatabaseCommands(app: CLI): void {
  app
    .command('data:list', 'List first-class databases and caches')
    .option('--env <environment>', 'Target environment')
    .option('--json', 'Print structured JSON')
    .action((options: DataCommandOptions) =>
  run(() =>
  withContext(options.env, async (value) => {
    const services = value.store.list(
      value.controlPlane.project.id,
      value.environmentRecord.id,
    )
    if (options.json) output.info(JSON.stringify(services, null, 2))
    else
      output.table(
      [
        'ID',
        'Name',
        'Engine',
        'Provider',
        'Status',
        'Plan',
        'Exposure',
        'Management',
      ],
      dataServiceRows(services),
    )
  }),
),
)

app
  .command('data:capabilities <engine> <provider>', 'Explain lifecycle support before taking action')
  .action((engineName: string, providerName: string) =>
run(async () => {
  output.info(
    JSON.stringify(
      dataServiceCapabilities(engine(engineName), provider(providerName)),
      null,
      2,
    ),
  )
}),
)

const create = app.command(
  'data:create <name>',
  'Provision an encrypted, private-by-default data service',
)
createOptions(create)
create.action((name: string, options: DataCommandOptions) =>
run(() =>
withContext(options.env, async (value) => {
  const selectedEngine = engine(options.engine),
  selectedProvider = provider(options.provider),
  adapter = value.resolveAdapter({ provider: selectedProvider })
  if (!adapter || !adapter.engines.includes(selectedEngine))
    throw new Error(
    `No ${selectedProvider}/${selectedEngine} provisioning adapter is configured. Use data:adopt for read-only inventory.`,
  )
  const desiredState: Record<string, JsonValue> = {
    ...(options.database ? { database: options.database } : {}),
    ...(options.subnetGroup ? { subnetGroup: options.subnetGroup } : {}),
    ...(options.securityGroups
      ? {
      securityGroupIds: options.securityGroups
        .split(',')
        .map(item => item.trim())
        .filter(Boolean),
    }
      : {}),
  }
  const created = await value.lifecycle.create({
    organizationId: value.controlPlane.organization.id,
    projectId: value.controlPlane.project.id,
    environmentId: value.environmentRecord.id,
    name,
    engine: selectedEngine,
    provider: selectedProvider,
    placement: options.placement ?? name,
    engineVersion: options.engineVersion,
    plan: options.plan ?? 'db.t4g.micro',
    storageGb: Number(options.storage) || undefined,
    highAvailability: options.highAvailability === true,
    publicExposure: options.public === true,
    allowedCidrs: options.cidrs
      ? options.cidrs.split(',').map(item => item.trim()).filter(Boolean)
      : [],
    desiredState,
    observedState: {},
    origin: 'managed',
    managementEnabled: true,
    ownerActorId: value.actor.id,
    username: options.username,
  })
  output.success(
    `Queued ${created.service.name} as operation ${created.operationId}.`,
  )
  if (created.credential) {
    output.warning('One-time credential — copy it now:')
    output.info(`Username: ${created.credential.username}`)
    output.info(`Password: ${created.credential.password}`)
    output.info(`Reference: ${created.credential.secretRef}`)
  }
}),
),
)

const adopt = app.command(
  'data:adopt <name>',
  'Adopt an existing provider resource as read-only inventory',
)
createOptions(adopt)
adopt.action((name: string, options: DataCommandOptions) =>
run(() =>
withContext(options.env, async (value) => {
  const service = value.store.create({
    organizationId: value.controlPlane.organization.id,
    projectId: value.controlPlane.project.id,
    environmentId: value.environmentRecord.id,
    name,
    engine: engine(options.engine),
    provider: provider(options.provider),
    placement: options.placement ?? name,
    engineVersion: options.engineVersion,
    plan: options.plan ?? 'external',
    storageGb: Number(options.storage) || undefined,
    highAvailability: options.highAvailability === true,
    publicExposure: options.public === true,
    allowedCidrs: options.cidrs
      ? options.cidrs.split(',').map(item => item.trim()).filter(Boolean)
      : [],
    desiredState: {},
    observedState: {},
    credentialRef: undefined,
    status: 'adopted',
    origin: 'adopted',
    managementEnabled: false,
    ownerActorId: value.actor.id,
  })
  output.success(`Adopted ${service.name} (${service.id}) read-only.`)
}),
),
)

app
  .command('data:show <service>', 'Show safe service, capability, dependency, and operation metadata')
  .option('--env <environment>', 'Target environment')
  .option('--reveal', 'Reveal the encrypted credential with exact confirmation')
  .option('--confirm <name>', 'Exact service name required with --reveal')
  .action((id: string, options: DataCommandOptions) =>
run(() =>
withContext(options.env, async (value) => {
  const service = findService(value, id),
  credential = value.store.credential(service.id)
  const safe = {
    ...service,
    credentialRef: undefined,
    credential: credential
      ? {
      configured: true,
      username: credential.username,
      version: credential.version,
      rotatedAt: credential.rotatedAt,
    }
      : undefined,
    dependencies: value.store.dependencies(service.id).map(item => ({
      resourceId: item.resourceId,
      requiresRedeploy: item.requiresRedeploy,
    })),
    operations: value.queue
      .list({ projectId: service.projectId, limit: 250 })
      .filter(item => item.input.serviceId === service.id),
  }
  output.info(JSON.stringify(safe, null, 2))
  if (options.reveal) {
    if (options.confirm !== service.name)
      throw new Error(`Credential reveal requires --confirm ${service.name}.`)
    if (!credential) throw new Error('No managed credential is configured.')
    output.warning('Credential value follows; it will not be logged or persisted by ts-cloud:')
    output.info(`Username: ${credential.username}`)
    output.info(`Password: ${await value.secrets.resolve(credential.secretRef)}`)
  }
}, id),
),
)

app
  .command('data:connect <service>', 'Print secret-free connection and tunnel guidance')
  .option('--env <environment>', 'Target environment')
  .action((id: string, options: DataCommandOptions) =>
run(() =>
withContext(options.env, async (value) => {
  const service = findService(value, id)
  output.table(
    ['Type', 'Command', 'Credential reference'],
    connectionGuidance(service, endpoints(service)).map(item => [
      item.type,
      item.command,
      item.secretRef ?? '—',
    ]),
  )
}, id),
),
)

app
  .command('data:action <service> <action>', 'Preview or enqueue a durable lifecycle action')
  .option('--env <environment>', 'Target environment')
  .option('--execute', 'Enqueue after validation; default is preview only')
  .option('--plan <plan>', 'New provider plan')
  .option('--storage <gb>', 'New storage allocation')
  .option('--engine-version <version>', 'Target engine version')
  .option('--min-capacity <acu>', 'Aurora minimum capacity')
  .option('--max-capacity <acu>', 'Aurora maximum capacity')
  .option('--public', 'Enable public exposure')
  .option('--cidrs <ranges>', 'Comma-separated narrow public CIDRs')
  .option('--retention <choice>', 'final_backup or retain for deletion')
  .option('--confirm <name>', 'Exact service name for destructive actions')
  .option('--backup-id <id>', 'Required backup for a major version change')
  .option('--compatibility-reviewed', 'Confirm major-version compatibility review')
  .action((id: string, actionName: string, options: DataCommandOptions) =>
run(() =>
withContext(options.env, async (value) => {
  if (!ACTIONS.includes(actionName as DataAction))
    throw new Error(`Action must be ${ACTIONS.join(', ')}.`)
  const service = findService(value, id),
  action = actionName as DataAction,
  changes = dataActionChanges(options),
  plan = value.lifecycle.plan(service, action, changes)
  output.info(JSON.stringify({ ...plan, productionExecutionCreated: false }, null, 2))
  if (!options.execute) return
  const operationId = value.lifecycle.enqueue(
    service,
    action,
    changes,
    value.actor.id,
  )
  output.success(`Queued ${action} as ${operationId}.`)
}, id),
),
)

app
  .command('data:management <service>', 'Enable reviewed management of an adopted service')
  .option('--env <environment>', 'Target environment')
  .option('--confirm <name>', 'Exact service name')
  .action((id: string, options: DataCommandOptions) =>
run(() =>
withContext(options.env, async (value) => {
  const service = findService(value, id)
  if (service.origin !== 'adopted' || options.confirm !== service.name)
    throw new Error(`Enabling adopted management requires --confirm ${service.name}.`)
  const updated = value.store.update(service.id, service.version, {
    managementEnabled: true,
  })
  output.success(`${updated.name} management is enabled.`)
}, id),
),
)

app
  .command('data:dependency <service> <resource>', 'Register or remove an application credential dependency')
  .option('--env <environment>', 'Target environment')
  .option('--dynamic', 'Dependency consumes a dynamic reference and does not need redeploy')
  .option('--remove', 'Remove the dependency')
  .action((id: string, resourceId: string, options: DataCommandOptions) =>
run(() =>
withContext(options.env, async (value) => {
  const service = findService(value, id),
  resource = value.controlPlane.store
    .listResources(value.controlPlane.project.id, value.environmentRecord.id)
    .find(item => item.id === resourceId || item.slug === resourceId)
  if (!resource) throw new Error(`Resource ${resourceId} was not found in ${value.env}.`)
  if (options.remove) {
    output.info(value.store.removeDependency(service.id, resource.id) ? 'Dependency removed.' : 'Dependency was not registered.')
    return
  }
  value.store.addDependency({
    serviceId: service.id,
    resourceId: resource.id,
    secretRef:
    service.credentialRef ??
    `secret://data-services/${service.projectId}/${service.name}`,
    requiresRedeploy: !options.dynamic,
  })
  output.success(`Registered dependency ${resource.slug} -> ${service.name}.`)
}, id),
),
)

// Compatibility aliases retain established automation while removing the
// former mocked output and sleep-based behavior.
app
  .command('db:list', 'Alias for data:list')
  .option('--env <environment>', 'Target environment')
  .action((options: DataCommandOptions) =>
run(() =>
withContext(options.env, async (value) =>
output.table(
  ['ID', 'Name', 'Engine', 'Provider', 'Status', 'Plan', 'Exposure', 'Management'],
  dataServiceRows(value.store.list(value.controlPlane.project.id, value.environmentRecord.id)),
),
),
),
)
app
  .command('db:connect <service>', 'Alias for data:connect')
  .option('--env <environment>', 'Target environment')
  .action((id: string, options: DataCommandOptions) =>
run(() =>
withContext(options.env, async (value) => {
  const service = findService(value, id)
  output.table(
    ['Type', 'Command', 'Credential reference'],
    connectionGuidance(service, endpoints(service)).map(item => [item.type, item.command, item.secretRef ?? '—']),
  )
}, id),
),
)
for (const alias of ['backup', 'snapshot'] as const)
  app
  .command(`db:${alias} <service>`, `Alias for data:action ${alias === 'backup' ? 'backup' : 'backup'}`)
  .option('--env <environment>', 'Target environment')
  .option('--execute', 'Enqueue the backup; default previews')
  .action((id: string, options: DataCommandOptions) =>
run(() =>
withContext(options.env, async (value) => {
  const service = findService(value, id),
  plan = value.lifecycle.plan(service, 'backup')
  output.info(JSON.stringify({ ...plan, productionExecutionCreated: false }, null, 2))
  if (options.execute)
    output.success(`Queued backup as ${value.lifecycle.enqueue(service, 'backup', {}, value.actor.id)}.`)
}, id),
),
)
}
