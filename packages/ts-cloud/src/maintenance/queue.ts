import type { QueueOperationHandler } from '../queue'
import type { CleanupDriver, DisasterRecoveryDriver, PlatformMaintenanceDriver, UpgradeTarget } from './types'
import { documentDigest } from './manifest'
import { MaintenanceStore } from './store'

const object = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
export function createMaintenanceQueueHandlers(input: {
  store: MaintenanceStore
  platform?: PlatformMaintenanceDriver
  cleanup?: readonly CleanupDriver[]
  recovery?: readonly DisasterRecoveryDriver[]
}): Record<string, QueueOperationHandler> {
  const upgrade: QueueOperationHandler = async (context) => {
    const campaign = input.store.campaign(String(object(context.operation.input).campaignId ?? ''))
    if (!campaign || !input.platform) throw new Error('Upgrade campaign or platform maintenance driver is unavailable.')
    const manifest = input.store.manifest(campaign.manifestId)
    if (!manifest?.compatibility.compatible || manifest.verificationStatus !== 'verified')
      throw new Error('Update manifest is no longer verified and compatible.')
    const artifact =
      manifest.document.artifacts.find(
        (item) => item.platform === process.platform && item.architecture === process.arch,
      ) ?? manifest.document.artifacts[0]
    if (!artifact) throw new Error('No update artifact matches this platform.')
    input.store.updateCampaign(campaign.id, { status: 'running', currentStage: 'preflight' })
    const installed: UpgradeTarget[] = []
    try {
      for (const cohort of [...new Set(input.store.targets(campaign.id).map((item) => item.cohort))].sort(
        (a, b) => a - b,
      )) {
        input.store.updateCampaign(campaign.id, { currentStage: `cohort:${cohort}` })
        for (const target of input.store.targets(campaign.id).filter((item) => item.cohort === cohort)) {
          context.throwIfCancellationRequested()
          context.checkpoint(`download:${target.target}`, 'Downloading signed platform artifact.')
          input.store.updateTarget(target.id, { status: 'downloading', startedAt: new Date().toISOString() })
          const downloaded = await input.platform.download({ target, artifact, signal: context.signal })
          if (downloaded.sha256 !== artifact.sha256) throw new Error(`Artifact checksum mismatch for ${target.target}.`)
          context.checkpoint(`install:${target.target}`, 'Installing verified artifact.')
          input.store.updateTarget(target.id, { status: 'installing' })
          await input.platform.install({
            target,
            path: downloaded.path,
            version: manifest.version,
            signal: context.signal,
          })
          installed.push(target)
          const health = await input.platform.health({ target, gate: campaign.healthGate })
          if (!health.healthy) throw new Error(`Upgrade health gate failed for ${target.target}.`)
          input.store.updateTarget(target.id, {
            status: 'healthy',
            evidence: health.evidence,
            finishedAt: new Date().toISOString(),
          })
        }
      }
      input.store.updateCampaign(campaign.id, { status: 'succeeded', currentStage: undefined })
      return { campaignId: campaign.id, version: manifest.version, targets: installed.length }
    } catch (error) {
      input.store.updateCampaign(campaign.id, { status: 'rolling_back', currentStage: 'rollback' })
      for (const target of installed.reverse()) {
        input.store.updateTarget(target.id, { status: 'rolling_back' })
        await input.platform.rollback({ target, version: target.previousVersion, signal: context.signal })
        input.store.updateTarget(target.id, { status: 'rolled_back', finishedAt: new Date().toISOString() })
      }
      input.store.updateCampaign(campaign.id, { status: 'rolled_back', currentStage: undefined })
      throw error
    }
  }
  const cleanup: QueueOperationHandler = async (context) => {
    const plan = input.store.cleanup(String(object(context.operation.input).planId ?? ''))
    if (!plan || plan.status !== 'approved') throw new Error('Approved cleanup plan was not found.')
    if (documentDigest([...plan.candidates].sort((a, b) => a.id.localeCompare(b.id))) !== plan.candidateDigest)
      throw new Error('Cleanup candidate set changed after preview.')
    const driver = input.cleanup?.find((item) => item.kind === plan.kind)
    if (!driver) throw new Error(`No ${plan.kind} cleanup driver is configured.`)
    input.store.updateCleanup(plan.id, { status: 'running' })
    const removed: string[] = [],
      failed: Array<{ id: string; error: string }> = []
    for (const candidate of plan.candidates) {
      context.throwIfCancellationRequested()
      try {
        await driver.remove(candidate)
        removed.push(candidate.id)
      } catch (error) {
        failed.push({ id: candidate.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const status = failed.length ? (removed.length ? 'partial' : 'failed') : 'succeeded'
    input.store.updateCleanup(plan.id, {
      status,
      result: {
        removed,
        failed,
        reclaimedBytes: plan.candidates
          .filter((item) => removed.includes(item.id))
          .reduce((sum, item) => sum + item.bytes, 0),
      },
    })
    if (failed.length) throw new Error(`Cleanup failed for ${failed.length} candidate(s).`)
    return { planId: plan.id, removed: removed.length, reclaimedBytes: plan.estimatedBytes }
  }
  const drill: QueueOperationHandler = async (context) => {
    const value = input.store.drill(String(object(context.operation.input).drillId ?? ''))
    if (!value) throw new Error('DR drill was not found.')
    const driver = input.recovery?.find((item) => item.scenario === value.scenario)
    if (!driver) throw new Error(`No ${value.scenario} recovery driver is configured.`)
    const started = new Date()
    input.store.updateDrill(value.id, { status: 'restoring', startedAt: started.toISOString() })
    let target = value.isolatedTarget,
      restoreEvidence = {},
      verifyEvidence = {}
    try {
      context.checkpoint('restore', 'Restoring into isolated drill target.')
      const restored = await driver.restore({ drill: value, signal: context.signal })
      if (!restored.target.startsWith('isolated://'))
        throw new Error('Recovery driver attempted a non-isolated target.')
      target = restored.target
      restoreEvidence = restored.evidence
      const rpo = (started.getTime() - new Date(restored.recoveryPointAt).getTime()) / 60_000
      input.store.updateDrill(value.id, {
        status: 'verifying',
        measuredRpoMinutes: rpo,
        evidence: { restore: restoreEvidence },
      })
      context.checkpoint('verify', 'Running recovery health checks without production traffic.')
      const verified = await driver.verify({ drill: value, target })
      verifyEvidence = verified.evidence
      const rto = (Date.now() - started.getTime()) / 60_000
      if (!verified.healthy || rpo > value.expectedRpoMinutes || rto > value.expectedRtoMinutes)
        throw new Error('DR drill failed its health, RPO, or RTO objective.')
      input.store.updateDrill(value.id, {
        measuredRpoMinutes: rpo,
        measuredRtoMinutes: rto,
        evidence: { restore: restoreEvidence, verify: verifyEvidence },
      })
    } catch (error) {
      input.store.updateDrill(value.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        evidence: { restore: restoreEvidence, verify: verifyEvidence },
      })
      throw error
    } finally {
      input.store.updateDrill(value.id, { status: 'cleaning' })
      try {
        await driver.cleanup({ drill: value, target })
        const current = input.store.drill(value.id)!
        input.store.updateDrill(value.id, {
          status: current.error ? 'failed' : 'passed',
          cleanupVerified: true,
          finishedAt: new Date().toISOString(),
        })
      } catch (error) {
        input.store.updateDrill(value.id, {
          status: 'cleanup_required',
          cleanupVerified: false,
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        })
      }
    }
    return { drillId: value.id, status: input.store.drill(value.id)!.status }
  }
  return { 'maintenance.upgrade': upgrade, 'maintenance.cleanup': cleanup, 'maintenance.drill': drill }
}
