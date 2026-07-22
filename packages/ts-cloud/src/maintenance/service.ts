import type { ControlPlaneOperation } from '../control-plane'
import type { CleanupDriver, CleanupPlan, DisasterRecoveryDrill, MaintenanceWindow, UpgradeCampaign } from './types'
import { DurableOperationQueue } from '../queue'
import { MaintenanceStore } from './store'

export function maintenanceWindowOpen(window: MaintenanceWindow, now: Date = new Date()): boolean {
  if (!window.enabled) return false
  const start = new Date(window.schedule)
  if (!Number.isNaN(start.getTime()))
    return now >= start && now.getTime() <= start.getTime() + window.durationMinutes * 60_000
  const match = /^(\d{2}):(\d{2})$/.exec(window.schedule)
  if (!match) return false
  const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: window.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now),
    minute =
      Number(parts.find((v) => v.type === 'hour')?.value) * 60 + Number(parts.find((v) => v.type === 'minute')?.value),
    begin = Number(match[1]) * 60 + Number(match[2])
  return minute >= begin && minute < begin + window.durationMinutes
}
export class MaintenanceService {
  readonly queue: DurableOperationQueue
  constructor(
    readonly store: MaintenanceStore,
    queue?: DurableOperationQueue,
    private now: () => Date = () => new Date(),
  ) {
    this.queue = queue ?? new DurableOperationQueue(store.control)
  }
  enqueueCampaign(
    id: string,
    input: { approvedBy?: string; overrideWindow?: boolean } = {},
  ): { campaign: UpgradeCampaign; operation: ControlPlaneOperation } {
    const campaign = this.store.campaign(id)
    if (!campaign) throw new Error('Upgrade campaign was not found.')
    const window = campaign.windowId ? this.store.window(campaign.windowId) : undefined
    if (window && !window.allowedOperations.includes('platform.upgrade'))
      throw new Error('Maintenance window does not permit platform upgrades.')
    if (window && !input.overrideWindow && !maintenanceWindowOpen(window, this.now()))
      throw new Error('Upgrade is outside its maintenance window.')
    if (window?.requireApproval && !input.approvedBy && !campaign.approvedBy)
      throw new Error('Maintenance approval is required.')
    const operation = this.queue.enqueue({
      projectId: campaign.projectId,
      actorId: input.approvedBy,
      kind: 'maintenance.upgrade',
      input: { campaignId: id },
      lockKey: 'platform-upgrade',
      providerKey: 'platform',
      timeoutSeconds: 7200,
      cancellationMode: 'cooperative',
      resumePolicy: 'fail',
    }).operation
    return { campaign: this.store.updateCampaign(id, { status: 'queued' }), operation }
  }
  async previewCleanup(
    input: { projectId: string; kind: CleanupPlan['kind']; criteria: CleanupPlan['criteria'] },
    drivers: readonly CleanupDriver[],
  ): Promise<CleanupPlan> {
    const driver = drivers.find((item) => item.kind === input.kind)
    if (!driver) throw new Error(`No ${input.kind} cleanup driver is configured.`)
    return this.store.createCleanup({ ...input, candidates: await driver.discover(input.criteria) })
  }
  enqueueCleanup(id: string, confirmation: string): { plan: CleanupPlan; operation: ControlPlaneOperation } {
    const plan = this.store.cleanup(id)
    if (!plan || plan.status !== 'preview') throw new Error('A current cleanup preview is required.')
    if (new Date(plan.expiresAt) <= this.now()) throw new Error('Cleanup preview expired; generate it again.')
    const expected = `DELETE ${plan.candidates.length} ${plan.kind}`
    if (confirmation !== expected) throw new Error(`Exact confirmation ${expected} is required.`)
    const operation = this.queue.enqueue({
      projectId: plan.projectId,
      kind: 'maintenance.cleanup',
      input: { planId: id },
      lockKey: `cleanup:${plan.kind}`,
      providerKey: 'cleanup',
      timeoutSeconds: 3600,
      cancellationMode: 'cooperative',
    }).operation
    return { plan: this.store.updateCleanup(id, { status: 'approved', confirmation }), operation }
  }
  enqueueDrill(id: string): { drill: DisasterRecoveryDrill; operation: ControlPlaneOperation } {
    const drill = this.store.drill(id)
    if (!drill || drill.status !== 'planned') throw new Error('A planned DR drill is required.')
    const operation = this.queue.enqueue({
      projectId: drill.projectId,
      kind: 'maintenance.drill',
      input: { drillId: id },
      lockKey: `drill:${drill.scenario}:${drill.id}`,
      providerKey: 'recovery',
      timeoutSeconds: 7200,
      cancellationMode: 'cooperative',
    }).operation
    return { drill: this.store.updateDrill(id, { status: 'queued', operationId: operation.id }), operation }
  }
}
