import type { QueueExecutionContext, QueueOperationHandler } from '../queue'
import type { RegionalExecution, RegionalProviderDriver, RegionalTarget, RegionalTopology } from './types'
import { RegionStore } from './store'

const object = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
export function createRegionQueueHandlers(
  store: RegionStore,
  drivers: readonly RegionalProviderDriver[],
): Record<string, QueueOperationHandler> {
  const driver = (target: RegionalTarget) => {
    const value = drivers.find((item) => item.provider === target.provider)
    if (!value) throw new Error(`No ${target.provider} regional driver is configured.`)
    return value
  }
  const step = (context: QueueExecutionContext, execution: RegionalExecution, name: string) => {
    context.throwIfCancellationRequested()
    context.checkpoint(name, name)
    store.updateExecution(execution.id, {
      status: 'running',
      currentStep: name,
      completedSteps: [...store.execution(execution.id)!.completedSteps, name],
    })
  }
  const applyTraffic = async (topology: RegionalTopology, weights: Record<string, number>) => {
    const route = store.route(topology.id)
    if (!route) throw new Error('Regional traffic route was not found.')
    const primary =
      store.targets(topology.id).find((item) => item.region === topology.activeRegion) ?? store.targets(topology.id)[0]
    if (!primary) throw new Error('Regional traffic target was not found.')
    store.updateRoute(route.id, { status: 'applying', desiredWeights: weights })
    const result = await driver(primary).applyTraffic({ route: store.route(topology.id)!, topology, weights })
    store.updateRoute(route.id, {
      status: Object.values(weights).every((value) => value === 0) ? 'drained' : 'in_sync',
      weights,
      providerState: result.providerState,
    })
  }
  const rollout = async (
    context: QueueExecutionContext,
    execution: RegionalExecution,
    topology: RegionalTopology,
    input: Record<string, unknown>,
  ) => {
    store.updateTopology(topology.id, { status: 'provisioning' })
    const revision = execution.revision!,
      manifest = (input.manifest ?? {}) as any,
      targets = store.targets(topology.id).sort((a, b) => Number(a.role === 'primary') - Number(b.role === 'primary'))
    for (const target of targets) {
      step(context, execution, `apply:${target.region}`)
      store.updateTarget(target.id, { status: 'provisioning' })
      const result = await driver(target).applyStack({ target, revision, manifest, signal: context.signal })
      const health = await driver(target).health({
        target: store.updateTarget(target.id, { stackId: result.stackId, stackRevision: revision }),
      })
      if (!health.healthy) throw new Error(`Regional health gate failed in ${target.region}.`)
      store.updateTarget(target.id, {
        status: 'ready',
        health: health.evidence,
        lastHealthyAt: new Date().toISOString(),
      })
    }
    for (const channel of store.channels(topology.id)) {
      step(context, execution, `replicate:${channel.kind}:${channel.targetRegion}`)
      store.updateChannel(channel.id, { status: 'configuring' })
      const source = targets.find((item) => item.region === channel.sourceRegion)!
      const configured = await driver(source).configureReplication({ channel, topology })
      const verified = await driver(source).verifyReplication({
        channel: store.updateChannel(channel.id, {
          checkpoint: configured.checkpoint,
          lagSeconds: configured.lagSeconds,
        }),
        topology,
      })
      if (!verified.healthy || verified.lagSeconds > topology.dataPolicy.maxLagSeconds)
        throw new Error(`${channel.kind} replication to ${channel.targetRegion} exceeds the RPO.`)
      store.updateChannel(channel.id, {
        status: 'in_sync',
        checkpoint: verified.checkpoint,
        lagSeconds: verified.lagSeconds,
        lastVerifiedAt: new Date().toISOString(),
      })
    }
    step(context, execution, 'traffic:activate')
    const weights = Object.fromEntries(
      topology.regions.map((item) => [item.region, item.region === topology.activeRegion ? 100 : 0]),
    )
    await applyTraffic(topology, weights)
    store.updateTopology(topology.id, { status: 'ready', revision })
    return { revision, activeRegion: topology.activeRegion }
  }
  const switchRegion = async (
    context: QueueExecutionContext,
    execution: RegionalExecution,
    topology: RegionalTopology,
  ) => {
    const region = execution.requestedRegion!,
      target = store.targets(topology.id).find((item) => item.region === region)
    if (!target) throw new Error('Requested regional target was not found.')
    store.updateTopology(topology.id, { status: execution.kind === 'failover' ? 'failing_over' : 'failing_back' })
    step(context, execution, `health:${region}`)
    const health = await driver(target).health({ target })
    if (!health.healthy) throw new Error(`Target region ${region} is unhealthy.`)
    store.updateTarget(target.id, { status: 'ready', health: health.evidence, lastHealthyAt: new Date().toISOString() })
    step(context, execution, `replication:${region}`)
    for (const channel of store.channels(topology.id).filter((item) => item.targetRegion === region)) {
      const verified = await driver(target).verifyReplication({ channel, topology })
      if (!verified.healthy || verified.lagSeconds > topology.dataPolicy.maxLagSeconds)
        throw new Error(`${channel.kind} replication is outside the failover RPO.`)
      store.updateChannel(channel.id, {
        status: 'in_sync',
        checkpoint: verified.checkpoint,
        lagSeconds: verified.lagSeconds,
        lastVerifiedAt: new Date().toISOString(),
      })
    }
    step(context, execution, `traffic:${region}`)
    await applyTraffic(
      topology,
      Object.fromEntries(topology.regions.map((item) => [item.region, item.region === region ? 100 : 0])),
    )
    step(context, execution, `roles:${region}`)
    const regions = topology.regions.map((item) => ({
      ...item,
      role: item.region === region ? ('primary' as const) : ('secondary' as const),
    }))
    for (const item of store.targets(topology.id))
      store.updateTarget(item.id, { role: item.region === region ? 'primary' : 'secondary' })
    store.updateTopology(topology.id, {
      status: execution.kind === 'failover' ? 'failed_over' : 'ready',
      activeRegion: region,
      regions,
    })
    return { activeRegion: region }
  }
  const destroy = async (
    context: QueueExecutionContext,
    execution: RegionalExecution,
    topology: RegionalTopology,
    input: Record<string, unknown>,
  ) => {
    store.updateTopology(topology.id, { status: 'destroying' })
    step(context, execution, 'traffic:drain')
    await applyTraffic(topology, Object.fromEntries(topology.regions.map((item) => [item.region, 0])))
    const retainData = input.deleteData !== true
    for (const target of store
      .targets(topology.id)
      .sort((a, b) => Number(a.role === 'primary') - Number(b.role === 'primary'))) {
      step(context, execution, `delete:${target.region}`)
      store.updateTarget(target.id, { status: 'deleting' })
      await driver(target).deleteStack({ target, retainData, signal: context.signal })
      store.updateTarget(target.id, { status: 'deleted' })
    }
    step(context, execution, 'complete')
    store.updateTopology(topology.id, { status: 'destroyed' })
    return { destroyed: true, dataRetained: retainData }
  }
  const handler: QueueOperationHandler = async (context) => {
    const input = object(context.operation.input),
      execution = store.execution(String(input.executionId ?? ''))
    if (!execution) throw new Error('Regional execution was not found.')
    const topology = store.get(execution.topologyId)
    if (!topology) throw new Error('Regional topology was not found.')
    try {
      let result
      if (execution.kind === 'rollout') result = await rollout(context, execution, topology, input)
      else if (execution.kind === 'failover' || execution.kind === 'failback')
        result = await switchRegion(context, execution, topology)
      else if (execution.kind === 'destroy') result = await destroy(context, execution, topology, input)
      else throw new Error('Regional reconciliation is not configured.')
      store.updateExecution(execution.id, { status: 'succeeded', currentStep: undefined })
      return { executionId: execution.id, ...result }
    } catch (error) {
      store.updateExecution(execution.id, {
        status: context.cancellationRequested() ? 'cancelled' : 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      if (store.get(topology.id)?.status !== 'destroyed') store.updateTopology(topology.id, { status: 'failed' })
      throw error
    }
  }
  return {
    'region.rollout': handler,
    'region.failover': handler,
    'region.failback': handler,
    'region.destroy': handler,
    'region.reconcile': handler,
  }
}
