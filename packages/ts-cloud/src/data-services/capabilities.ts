import type {
  DataAction,
  DataActionCapability,
  DataEngine,
  DataProvider,
  DataServiceCapabilities,
} from './model'

const yes = (
  explanation: string,
  downtime: DataActionCapability['downtime'] = 'none',
  destructive = false,
): DataActionCapability => ({
  supported: true,
  downtime,
  destructive,
  explanation,
})
const no = (explanation: string): DataActionCapability => ({
  supported: false,
  downtime: 'none',
  destructive: false,
  explanation,
})
export function dataServiceCapabilities(
  engine: DataEngine,
  provider: DataProvider,
): DataServiceCapabilities {
  const managed = ['aws_rds', 'aws_aurora', 'aws_elasticache'].includes(
      provider,
    ),
    sql = ['postgres', 'mysql', 'mariadb'].includes(engine),
    cache = engine === 'redis'
  const actions = {} as Record<DataAction, DataActionCapability>
  actions.create = yes(
    managed
      ? 'Provision through the provider API.'
      : 'Provision through the owning runtime driver.',
    'possible',
  )
  actions.observe = yes(
    'Provider/runtime health and endpoint metadata are observable.',
  )
  actions.connect = yes(
    'Connection guidance uses secret references and never returns a password by default.',
  )
  actions.backup = sql
    ? yes(
        managed
          ? 'Create a provider snapshot.'
          : 'Create a consistent engine-native dump.',
        'possible',
      )
    : no('This cache path is not a durable backup source.')
  actions.restore = sql
    ? yes('Restore creates or replaces a reviewed target.', 'required', true)
    : no('Restore is not supported for this engine path.')
  actions.restart = yes(
    managed
      ? 'Provider restart/failover semantics apply.'
      : 'Restart the owning service unit.',
    'required',
  )
  actions.resize = managed
    ? yes(
        'Provider plan/storage modification may enter a maintenance window.',
        'possible',
      )
    : yes('Edit host/container resources and reconcile.', 'required')
  actions.version = sql
    ? yes(
        'Major versions require compatibility preflight and backup.',
        'required',
      )
    : yes('Engine upgrades require a maintenance window.', 'required')
  actions.rotate = yes(
    'Rotate through the secret backend, update the engine, then flag dependent releases.',
  )
  actions.expose = yes(
    'Exposure is reconciled through security groups or firewall rules; public access defaults off.',
  )
  actions.delete = yes(
    managed
      ? 'Final snapshot is supported where the provider allows it.'
      : 'A final engine backup is required unless explicitly retained.',
    'required',
    true,
  )
  actions.logs = yes(
    managed
      ? 'Provider logs are available when export is enabled.'
      : 'Read bounded service logs from the runtime.',
  )
  actions.slow_queries = sql
    ? yes('Slow-query support depends on engine configuration.')
    : no('Slow queries do not apply to this engine.')
  actions.users = sql
    ? yes('Database users are managed with generated referenced credentials.')
    : no('User management is not exposed for this engine.')
  actions.databases = sql
    ? yes('Logical database lifecycle is supported.')
    : no('Logical databases are not exposed for this engine.')
  return {
    actions,
    endpointTypes: managed
      ? ['internal', 'external', 'tunnel']
      : ['internal', 'tunnel'],
    metrics: cache
      ? ['connections', 'memory', 'evictions', 'hit_rate', 'latency']
      : [
          'connections',
          'cpu',
          'storage',
          'read_latency',
          'write_latency',
          'iops',
        ],
  }
}
