import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type { QueueExecutionContext, QueueOperationHandler } from '../queue'
import type { ReleaseActivationDriver } from './runtime'
import type { ReleaseRecord } from './types'
import { activateImmutableRelease, rollbackImmutableRelease } from './runtime'
import { ReleaseService } from './service'

export const RELEASE_QUEUE_KINDS = ['release.activate', 'release.rollback'] as const

function inputRecord(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {}
}

export type ReleaseDriverResolver = (
  release: ReleaseRecord,
) => ReleaseActivationDriver | Promise<ReleaseActivationDriver>

export function createReleaseQueueHandlers(input: {
  store: ControlPlaneStore
  resolveDriver: ReleaseDriverResolver
  resolveHealthGate?: (
    name: string,
    release: ReleaseRecord,
  ) => Promise<{ healthy: boolean; evidence?: JsonValue; message?: string }>
}): Record<string, QueueOperationHandler> {
  const releases = new ReleaseService(input.store)
  const handler: QueueOperationHandler = async (context: QueueExecutionContext) => {
    const operationInput = inputRecord(context.operation.input)
    const releaseId = typeof operationInput.releaseId === 'string' ? operationInput.releaseId : ''
    const release = releases.releases.get(releaseId)
    if (!release) throw new Error(`Queued release ${releaseId || '(missing)'} was not found`)
    if (
      release.projectId !== context.operation.projectId ||
      release.environmentId !== context.operation.environmentId ||
      release.resourceId !== context.operation.resourceId
    )
      throw new Error('Queued release does not match the operation scope')
    const artifact = releases.releases.getArtifact(release.artifactId)
    if (!artifact || artifact.digest !== releases.releases.getArtifact(release.artifactId)?.digest)
      throw new Error('Immutable release artifact is unavailable')
    const previousId =
      typeof operationInput.targetReleaseId === 'string' && operationInput.targetReleaseId
        ? operationInput.targetReleaseId
        : release.previousReleaseId
    const previous = previousId ? releases.releases.get(previousId) : undefined
    if (
      previous &&
      (previous.resourceId !== release.resourceId ||
        (previous.artifactId === release.artifactId && previous.id === release.id))
    )
      throw new Error('Rollback target does not match the release resource')
    const driver = await input.resolveDriver(release)
    context.checkpoint('verify', `Verifying ${artifact.digest} and ${release.configHash} for ${driver.name}.`)
    context.log(
      `Artifact ${artifact.digest}; source ${release.sourceSha ?? 'not recorded'}; config ${release.configHash}.`,
      { stream: 'system' },
    )
    context.throwIfCancellationRequested()
    let result
    try {
      result =
        context.operation.kind === 'release.rollback'
          ? await rollbackImmutableRelease(driver, { release, artifact, previous })
          : await activateImmutableRelease(driver, { release, artifact, previous })
    } catch (error) {
      if (context.operation.kind === 'release.activate' && releases.releases.get(release.id)?.status === 'activating')
        releases.completeHealthGate(release.id, {
          healthy: false,
          operationId: context.operation.id,
          message: error instanceof Error ? error.message : String(error),
        })
      throw error
    }
    for (const step of result.transitions) {
      releases.releases.progress(release.id, {
        message: `${context.operation.kind === 'release.rollback' ? 'Rollback' : 'Activation'} traffic at ${step.trafficPercent}%.`,
        trafficPercent: step.trafficPercent,
        health: step.observed,
        operationId: context.operation.id,
      })
      context.log(`Traffic ${step.trafficPercent}%: ${step.healthy ? 'healthy' : 'unhealthy'}.`, {
        stream: step.healthy ? 'step' : 'stderr',
        step: 'health',
      })
    }
    context.checkpoint('health', 'Evaluating the provider health result.')
    if (!result.activated || !result.healthy) {
      if (context.operation.kind === 'release.activate' && releases.releases.get(release.id)?.status === 'activating')
        releases.completeHealthGate(release.id, {
          healthy: false,
          operationId: context.operation.id,
          health: { resourceVersions: result.resourceVersions },
          message: result.error ?? 'Provider health gate failed.',
        })
      throw new Error(result.error ?? `${driver.name} reported an unhealthy release`)
    }
    if (context.operation.kind === 'release.activate' && release.healthGate?.name) {
      if (!input.resolveHealthGate) {
        releases.completeHealthGate(release.id, {
          healthy: false,
          operationId: context.operation.id,
          message: `Named health gate ${release.healthGate.name} is not available to this worker.`,
        })
        throw new Error(`Named health gate ${release.healthGate.name} is unavailable`)
      }
      context.checkpoint('named-health-gate', `Waiting on ${release.healthGate.name}.`)
      const gate = await input.resolveHealthGate(release.healthGate.name, release)
      context.log(
        `${release.healthGate.name}: ${gate.healthy ? 'healthy' : 'unhealthy'}${gate.message ? ` — ${gate.message}` : ''}.`,
        { stream: gate.healthy ? 'step' : 'stderr', step: 'health' },
      )
      if (!gate.healthy) {
        releases.completeHealthGate(release.id, {
          healthy: false,
          operationId: context.operation.id,
          health: gate.evidence,
          message: gate.message ?? `Named health gate ${release.healthGate.name} failed.`,
        })
        throw new Error(gate.message ?? `Named health gate ${release.healthGate.name} failed`)
      }
    }
    if (context.operation.kind === 'release.rollback') {
      const failed = releases.releases.get(release.id)!
      if (failed.status !== 'rolled_back')
        releases.releases.transition(failed.id, 'rolled_back', {
          message: `Traffic restored through ${driver.name}.`,
          operationId: context.operation.id,
          trafficPercent: 0,
          health: { resourceVersions: result.resourceVersions },
        })
      if (previous && previous.status !== 'active') {
        const activating =
          previous.status === 'activating'
            ? previous
            : releases.releases.transition(previous.id, 'activating', {
                message: 'Rollback target restoring traffic.',
                operationId: context.operation.id,
                trafficPercent: 0,
              })
        releases.releases.transition(activating.id, 'active', {
          message: 'Previous immutable release restored.',
          operationId: context.operation.id,
          trafficPercent: 100,
          health: { resourceVersions: result.resourceVersions },
        })
      }
    } else
      releases.completeHealthGate(release.id, {
        healthy: true,
        operationId: context.operation.id,
        health: { providerVersion: result.providerVersion ?? null, resourceVersions: result.resourceVersions },
        message: 'Provider activation and health gates completed.',
      })
    context.checkpoint('finalize', 'Persisted the terminal release state.')
    return {
      releaseId: release.id,
      artifactDigest: artifact.digest,
      provider: driver.name,
      providerVersion: result.providerVersion ?? null,
      resourceVersions: result.resourceVersions,
      status: releases.releases.get(release.id)!.status,
    }
  }
  return Object.fromEntries(RELEASE_QUEUE_KINDS.map((kind) => [kind, handler]))
}
