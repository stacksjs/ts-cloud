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
    runtime = ['server', 'container'].includes(provider),
    sql = ['postgres', 'mysql', 'mariadb'].includes(engine),
    cache = engine === 'redis'
  const actions = {} as Record<DataAction, DataActionCapability>
  actions.create =
    provider === 'external'
      ? no('External services can be adopted as read-only inventory.')
      : yes(
          managed
            ? 'Provision through the provider API.'
            : 'Provision through the owning runtime driver.',
          'possible',
        )
  actions.observe =
    provider === 'external'
      ? no('External observation requires a configured provider adapter.')
      : yes('Provider/runtime health and endpoint metadata are observable.')
  actions.connect = yes(
    'Connection guidance uses secret references and never returns a password by default.',
  )
  actions.backup =
    sql && (managed || runtime)
      ? yes(
          managed
            ? 'Create a provider snapshot.'
            : 'Create a consistent engine-native dump.',
          'possible',
        )
      : no('This cache path is not a durable backup source.')
  actions.restore =
    managed && sql
      ? yes('Restore creates a reviewed provider target.', 'required', true)
      : no('Restore requires a configured provider restore runner.')
  actions.restart =
    provider === 'external'
      ? no('External restart requires a configured provider adapter.')
      : yes(
          managed
            ? 'Provider restart/failover semantics apply.'
            : 'Restart the owning service unit.',
          'required',
        )
  actions.resize = provider === 'aws_elasticache'
    ? no('ElastiCache resizing requires a replication-group migration runner.')
    : managed
    ? yes(
        'Provider plan/storage modification may enter a maintenance window.',
        'possible',
      )
    : runtime
      ? yes('Edit host/container resources and reconcile.', 'required')
      : no('External resize requires a configured provider adapter.')
  actions.version = runtime
    ? no('Runtime version upgrades require an explicit image migration runner.')
    : managed && provider !== 'aws_elasticache'
      ? yes(
          sql
            ? 'Major versions require compatibility preflight and backup.'
            : 'Engine upgrades require a maintenance window.',
          'required',
        )
      : no('External upgrades require a configured provider adapter.')
  actions.rotate =
    provider === 'aws_elasticache' ||
    provider === 'external' ||
    (runtime && !sql && !cache)
      ? no(
          'Credential rotation is not available for this provider/engine path.',
        )
      : yes(
          'Rotate through the secret backend, update the engine, then flag dependent releases.',
        )
  actions.expose = runtime
    ? no(
        'Direct container publishing is refused; use a reviewed firewall and proxy policy.',
      )
    : provider === 'aws_rds'
      ? yes(
        'Exposure is reconciled through security groups; public access defaults off.',
      )
      : no('Exposure changes require a provider-specific network runner.')
  actions.delete =
    provider === 'external'
      ? no('External deletion requires a configured provider adapter.')
      : yes(
          managed
            ? 'Final snapshot is supported where the provider allows it.'
            : 'A final engine backup is required unless explicitly retained.',
          'required',
          true,
        )
  actions.logs = runtime
    ? yes('Read bounded service logs from the runtime.')
    : no('Provider log export is not configured for this adapter.')
  actions.slow_queries =
    runtime && sql
      ? yes(
          'Read bounded runtime logs after engine slow-query logging is enabled.',
        )
      : no('A slow-query log runner is not configured for this provider.')
  actions.users =
    runtime && sql
      ? yes(
          'Logical users can be listed; creation requires a referenced secondary credential.',
        )
      : no('User management requires an engine connection runner.')
  actions.databases =
    runtime && sql
      ? yes(
          'Logical databases can be listed, created, and confirmation-gated for deletion.',
        )
      : no('Logical database management requires an engine connection runner.')
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
