import type { CLI } from '@stacksjs/clapp'
import type { JsonValue } from '../../src/control-plane'
import type { BackupDestination, BackupPolicy, RecoveryPoint } from '../../src/backups'
import { resolveAuthEncryptionKey } from '../../src/auth'
import { BackupCoordinator, BackupStore, S3BackupDestinationAdapter } from '../../src/backups'
import { DataServiceStore, EncryptedDataSecretStore } from '../../src/data-services'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { DurableOperationQueue } from '../../src/queue'
import * as output from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

async function context(environment?: string) {
  const config = await loadValidatedConfig(),
    controlPlane = initializeDashboardControlPlane(process.cwd(), config),
    env = environment ?? Object.keys(config.environments ?? {})[0] ?? 'production',
    environmentRecord = controlPlane.environments.get(env as any)
  if (!environmentRecord) {
    controlPlane.store.close()
    throw new Error(`Environment ${env} was not found.`)
  }
  const queue = new DurableOperationQueue(controlPlane.store, { workerId: `cli:${process.pid}` }),
    store = new BackupStore(controlPlane.store),
    coordinator = new BackupCoordinator(store, queue),
    dataServices = new DataServiceStore(controlPlane.store),
    secrets = new EncryptedDataSecretStore(controlPlane.store, resolveAuthEncryptionKey(process.cwd())),
    actor = controlPlane.store.getActorByExternalId('system', 'cli') ?? controlPlane.store.createActor({ kind: 'system', externalId: 'cli', displayName: 'ts-cloud CLI' })
  return { config, controlPlane, env, environmentRecord, queue, store, coordinator, dataServices, secrets, actor }
}

type RecoveryContext = Awaited<ReturnType<typeof context>>
async function withContext<T>(environment: string | undefined, callback: (value: RecoveryContext) => Promise<T>): Promise<T> {
  const value = await context(environment)
  try { return await callback(value) }
  finally { value.controlPlane.store.close() }
}
async function run(callback: () => Promise<void>): Promise<void> {
  try { await callback() }
  catch (error) { output.error(error instanceof Error ? error.message : String(error)) }
}
function audit(value: RecoveryContext, type: string, payload: Record<string, JsonValue>, resourceId?: string): void {
  value.controlPlane.store.appendEvent({ organizationId: value.controlPlane.organization.id, projectId: value.controlPlane.project.id, resourceId, actorId: value.actor.id, type: `backup.${type}`, payload })
}
function policy(value: RecoveryContext, idOrName: string): BackupPolicy {
  const item = value.store.getPolicy(idOrName) ?? value.store.listPolicies(value.controlPlane.project.id, value.environmentRecord.id).find(candidate => candidate.name === idOrName)
  if (!item || item.environmentId !== value.environmentRecord.id) throw new Error(`Backup policy ${idOrName} was not found in ${value.env}.`)
  return item
}
function point(value: RecoveryContext, id: string): RecoveryPoint {
  const exact = value.store.getRecoveryPoint(id), candidates = value.store.listRecoveryPoints(value.controlPlane.project.id).filter(candidate => candidate.id.startsWith(id))
  const item = exact ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (!item) throw new Error(candidates.length > 1 ? `Recovery point prefix ${id} is ambiguous.` : `Recovery point ${id} was not found.`)
  return item
}
function destination(value: RecoveryContext, idOrName: string): BackupDestination {
  const item = value.store.getDestination(idOrName) ?? value.store.listDestinations(value.controlPlane.project.id).find(candidate => candidate.name === idOrName)
  if (!item) throw new Error(`Backup destination ${idOrName} was not found.`)
  return item
}
function targetFor(item: RecoveryPoint, target: string): Record<string, JsonValue> {
  return item.kind === 'volume' ? { volumeName: target } : item.kind === 'logical_database' ? { targetId: target, dataServiceId: target } : { targetId: target }
}
export function recoveryPointRows(points: RecoveryPoint[], policies: BackupPolicy[] = []): string[][] {
  const names = new Map(policies.map(item => [item.id, item.name]))
  return points.map(item => [item.id, item.status, item.verificationState, item.kind, names.get(item.policyId ?? '') ?? 'manual', item.pointInTime, item.sizeBytes ? `${item.sizeBytes} B` : 'provider', item.held ? 'hold' : item.pinned ? 'pinned' : 'retention'])
}

export function registerRecoveryCommands(app: CLI): void {
  app.command('recovery:list', 'Show backup coverage, destination health, and recent recovery points')
    .option('--env <environment>', 'Target environment').option('--json', 'Print structured JSON')
    .action(async (options: { env?: string, json?: boolean }) => run(async () => withContext(options.env, async value => {
      const policies = value.store.listPolicies(value.controlPlane.project.id, value.environmentRecord.id)
      const ids = new Set(policies.map(item => item.id))
      const points = value.store.listRecoveryPoints(value.controlPlane.project.id).filter(item => !item.policyId || ids.has(item.policyId))
      const result = { coverage: value.store.coverage(value.controlPlane.project.id).filter(item => ids.has(item.policy.id)), destinations: value.store.listDestinations(value.controlPlane.project.id).map(item => ({ ...item, credentialRef: undefined, encryptionKeyRef: undefined, credentialsConfigured: !!item.credentialRef, clientEncryptionConfigured: !!item.encryptionKeyRef })), policies, recoveryPoints: points, jobs: value.store.listJobs(value.controlPlane.project.id).filter(item => !item.policyId || ids.has(item.policyId)) }
      if (options.json) output.info(JSON.stringify(result, null, 2))
      else { output.table(['Policy', 'RPO', 'Destination', 'Latest point', 'Verification'], result.coverage.map(item => [item.policy.name, item.missedRpo ? 'MISSED' : 'protected', item.destinationHealthy ? 'healthy' : 'attention', item.lastRecoveryPoint?.pointInTime ?? 'none', item.lastRecoveryPoint?.verificationState ?? 'none'])); output.table(['ID', 'State', 'Verification', 'Kind', 'Policy', 'Point in time', 'Size', 'Protection'], recoveryPointRows(points, policies)) }
    })))

  app.command('recovery:jobs', 'List durable backup, verification, restore, drill, and cleanup jobs')
    .option('--env <environment>', 'Target environment').option('--json', 'Print structured JSON')
    .action(async (options: { env?: string, json?: boolean }) => run(async () => withContext(options.env, async value => {
      const policyIds = new Set(value.store.listPolicies(value.controlPlane.project.id, value.environmentRecord.id).map(item => item.id))
      const jobs = value.store.listJobs(value.controlPlane.project.id).filter(item => !item.policyId || policyIds.has(item.policyId))
      if (options.json) output.info(JSON.stringify(jobs, null, 2)); else output.table(['ID', 'Kind', 'State', 'Phase', 'Operation', 'Started', 'Finished', 'Error'], jobs.map(item => [item.id, item.kind, item.status, String(item.progress.phase ?? 'queued'), item.operationId ?? '—', item.startedAt ?? '—', item.finishedAt ?? '—', item.error ?? '—']))
    })))

  app.command('recovery:destination:add <name>', 'Connect an S3, S3-compatible, or AWS Backup destination')
    .option('--env <environment>', 'Target environment').option('--provider <provider>', 'aws_s3, s3_compatible, or aws_backup', { default: 'aws_s3' }).option('--bucket <bucket>', 'Object bucket').option('--endpoint <url>', 'Origin-only HTTPS endpoint').option('--allow-private', 'Allow a private endpoint').option('--path-style', 'Force path-style S3 URLs').option('--prefix <prefix>', 'Object key prefix').option('--region <region>', 'Destination region').option('--credentials-env <name>', 'Environment variable containing credential JSON').option('--encryption <mode>', 'provider, client_side, or both', { default: 'provider' }).option('--encryption-key-env <name>', 'Environment variable containing the client encryption key').option('--lock-days <days>', 'Default immutable retention days')
    .action(async (name: string, options: { env?: string, provider?: string, bucket?: string, endpoint?: string, allowPrivate?: boolean, pathStyle?: boolean, prefix?: string, region?: string, credentialsEnv?: string, encryption?: string, encryptionKeyEnv?: string, lockDays?: string }) => run(async () => withContext(options.env, async value => {
      if (!['aws_s3','s3_compatible','aws_backup'].includes(options.provider ?? '')) throw new Error('--provider must be aws_s3, s3_compatible, or aws_backup.')
      if (!['provider','client_side','both'].includes(options.encryption ?? '')) throw new Error('--encryption must be provider, client_side, or both.')
      const secretPrefix = `secret://data-services/backups/${value.controlPlane.project.id}/${name}`, refs: string[] = []
      try {
        let credentialRef: string | undefined, encryptionKeyRef: string | undefined
        if (options.credentialsEnv) { const secret = process.env[options.credentialsEnv]; if (!secret) throw new Error(`${options.credentialsEnv} is empty.`); credentialRef = `${secretPrefix}/credentials`; await value.secrets.put(credentialRef, secret); refs.push(credentialRef) }
        if (options.encryption !== 'provider') { if (!options.encryptionKeyEnv) throw new Error('Client encryption requires --encryption-key-env.'); const secret = process.env[options.encryptionKeyEnv]; if (!secret || secret.length < 32) throw new Error(`${options.encryptionKeyEnv} must contain at least 32 characters.`); encryptionKeyRef = `${secretPrefix}/encryption-key`; await value.secrets.put(encryptionKeyRef, secret); refs.push(encryptionKeyRef) }
        const item = value.store.createDestination({ organizationId: value.controlPlane.organization.id, projectId: value.controlPlane.project.id, name, provider: options.provider as BackupDestination['provider'], endpoint: options.endpoint, endpointPolicy: options.allowPrivate ? 'allow_private' : 'public_https', bucket: options.bucket, prefix: options.prefix ?? '', region: options.region ?? value.config.project.region, forcePathStyle: !!options.pathStyle, credentialRef, encryption: options.encryption as BackupDestination['encryption'], encryptionKeyRef, immutability: { objectLock: !!options.lockDays, defaultRetentionDays: options.lockDays ? Number(options.lockDays) : undefined }, status: 'untested' })
        audit(value, 'destination_created', { destinationId: item.id, provider: item.provider }); output.success(`Created destination ${item.name} (${item.id}); test it with cloud recovery:destination:test ${item.name}`)
      } catch (error) { for (const ref of refs) await value.secrets.remove(ref).catch(() => {}); throw error }
    })))

  app.command('recovery:destination:test <destination>', 'Write, read, verify, and clean a destination health object')
    .option('--env <environment>', 'Target environment')
    .action(async (id: string, options: { env?: string }) => run(async () => withContext(options.env, async value => {
      const item = destination(value, id); if (item.provider === 'aws_backup') throw new Error('AWS Backup is verified by creating a provider recovery point.')
      try { await new S3BackupDestinationAdapter(value.secrets).test(item); value.store.recordDestinationTest(item.id, { ok: true }); audit(value, 'destination_tested', { destinationId: item.id, ok: true }); output.success(`${item.name} passed write, read, checksum, and cleanup checks.`) }
      catch (error) { const message = error instanceof Error ? error.message : String(error); value.store.recordDestinationTest(item.id, { ok: false, error: message }); audit(value, 'destination_tested', { destinationId: item.id, ok: false }); throw error }
    })))

  app.command('recovery:policy:add <name>', 'Create a scheduled recovery policy')
    .option('--env <environment>', 'Target environment').option('--destination <id>', 'Destination ID or name').option('--kind <kind>', 'managed_database, logical_database, volume, files, or control_plane').option('--data-service <id>', 'Data service ID or name').option('--resource <id>', 'Resource ID or slug').option('--volume <name>', 'Named Docker volume').option('--include <path>', 'Project-relative include path (repeatable)').option('--exclude <pattern>', 'Archive exclude pattern (repeatable)').option('--schedule <expression>', 'Cron, rate, or preset', { default: 'daily' }).option('--timezone <timezone>', 'IANA timezone', { default: 'UTC' }).option('--rpo <minutes>', 'Recovery point objective', { default: '1440' }).option('--rto <minutes>', 'Recovery time objective', { default: '120' }).option('--keep <count>', 'Minimum latest points', { default: '7' }).option('--expire <days>', 'Expiry days', { default: '30' }).option('--compression <kind>', 'none, gzip, or zstd', { default: 'gzip' }).option('--disabled', 'Create disabled')
    .action(async (name: string, options: { env?: string, destination?: string, kind?: string, dataService?: string, resource?: string, volume?: string, include?: string | string[], exclude?: string | string[], schedule?: string, timezone?: string, rpo?: string, rto?: string, keep?: string, expire?: string, compression?: string, disabled?: boolean }) => run(async () => withContext(options.env, async value => {
      if (!options.destination) throw new Error('--destination is required.'); if (!['managed_database','logical_database','volume','files','control_plane'].includes(options.kind ?? '')) throw new Error('--kind must be managed_database, logical_database, volume, files, or control_plane.')
      const targetDestination = destination(value, options.destination)
      const services = value.dataServices.list(value.controlPlane.project.id, value.environmentRecord.id)
      const service = options.dataService ? value.dataServices.get(options.dataService) ?? services.find(item => item.name === options.dataService) : undefined
      const resources = value.controlPlane.store.listResources(value.controlPlane.project.id, value.environmentRecord.id)
      const resource = options.resource ? resources.find(item => item.id === options.resource || item.slug === options.resource) : undefined
      const includes = options.include ? Array.isArray(options.include) ? options.include : [options.include] : [], excludes = options.exclude ? Array.isArray(options.exclude) ? options.exclude : [options.exclude] : []
      if (['managed_database','logical_database'].includes(options.kind ?? '') && !service) throw new Error('--data-service must identify a service in this environment.'); if (options.kind === 'volume' && (!resource || !options.volume)) throw new Error('Volume policies require --resource and --volume.'); if (options.kind === 'files' && (!resource || !includes.length)) throw new Error('File policies require --resource and at least one --include path.')
      const item = value.store.createPolicy({ organizationId: value.controlPlane.organization.id, projectId: value.controlPlane.project.id, environmentId: value.environmentRecord.id, resourceId: resource?.id, dataServiceId: service?.id, destinationId: targetDestination.id, name, resourceKind: options.kind as BackupPolicy['resourceKind'], schedule: options.schedule ?? 'daily', timezone: options.timezone ?? 'UTC', retention: { keepLast: Number(options.keep) || 7, expireAfterDays: Number(options.expire) || 30 }, compression: options.compression as BackupPolicy['compression'], encryption: 'destination', includePatterns: options.volume ? [options.volume, ...includes] : includes, excludePatterns: excludes, expectedRpoMinutes: Number(options.rpo) || 1440, expectedRtoMinutes: Number(options.rto) || 120, enabled: !options.disabled })
      audit(value, 'policy_created', { policyId: item.id, resourceKind: item.resourceKind }, item.resourceId); output.success(`Created policy ${item.name} (${item.id}); next run ${item.nextRunAt}`)
    })))

  app.command('recovery:run <policy>', 'Queue an on-demand run of a recovery policy').option('--env <environment>', 'Target environment')
    .action(async (id: string, options: { env?: string }) => run(async () => withContext(options.env, async value => { const item = policy(value, id), job = value.coordinator.enqueueBackup(item, new Date().toISOString(), value.actor.id); audit(value, 'run_queued', { policyId: item.id, backupJobId: job.id }, item.resourceId); output.success(`Queued backup job ${job.id}; inspect it with cloud recovery:jobs`) })))

  app.command('recovery:verify <point>', 'Queue independent verification of a recovery point').option('--env <environment>', 'Target environment')
    .action(async (id: string, options: { env?: string }) => run(async () => withContext(options.env, async value => { const item = point(value, id), job = value.coordinator.enqueueVerification(item); audit(value, 'verification_queued', { recoveryPointId: item.id, backupJobId: job.id }, item.resourceId); output.success(`Queued verification job ${job.id}`) })))

  app.command('recovery:restore <point> <target>', 'Validate or queue an isolated, in-place, or drill restore')
    .option('--env <environment>', 'Target environment').option('--mode <mode>', 'isolated or in_place', { default: 'isolated' }).option('--drill', 'Validate health and clean the isolated target').option('--execute', 'Queue the validated restore').option('--confirm <target>', 'Exact in-place target confirmation').option('--ack-downtime', 'Acknowledge downtime and data replacement').option('--safety <point>', 'Distinct verified safety recovery point')
    .action(async (id: string, target: string, options: { env?: string, mode?: string, drill?: boolean, execute?: boolean, confirm?: string, ackDowntime?: boolean, safety?: string }) => run(async () => withContext(options.env, async value => {
      if (!['isolated','in_place'].includes(options.mode ?? '')) throw new Error('--mode must be isolated or in_place.'); if (options.drill && options.mode === 'in_place') throw new Error('Recovery drills require --mode isolated.')
      const item = point(value, id), input = { mode: options.mode as 'isolated'|'in_place', target: { ...targetFor(item, target), inPlace: options.mode === 'in_place' }, targetName: target, confirm: options.confirm, recentAuth: true, downtimeAcknowledged: !!options.ackDowntime, safetyBackupId: options.safety ? point(value, options.safety).id : undefined }, plan = value.coordinator.planRestore(item, input)
      if (!options.execute) { output.info(JSON.stringify({ ...plan, productionExecutionCreated: false }, null, 2)); return }
      const job = value.coordinator.enqueueRestore(item, { ...input, drill: !!options.drill, actorId: value.actor.id }); audit(value, options.drill ? 'drill_queued' : 'restore_queued', { recoveryPointId: item.id, backupJobId: job.id, mode: input.mode, target }, item.resourceId); output.success(`Queued ${options.drill ? 'drill' : 'restore'} job ${job.id}`)
    })))

  app.command('recovery:protect <point>', 'Pin, hold, or release retention protection').option('--env <environment>', 'Target environment').option('--pin', 'Pin the point').option('--unpin', 'Remove its pin').option('--hold', 'Place a legal hold').option('--release-hold', 'Release its legal hold')
    .action(async (id: string, options: { env?: string, pin?: boolean, unpin?: boolean, hold?: boolean, releaseHold?: boolean }) => run(async () => withContext(options.env, async value => { const item = point(value, id); if (![options.pin,options.unpin,options.hold,options.releaseHold].filter(Boolean).length) throw new Error('Choose --pin, --unpin, --hold, or --release-hold.'); const updated = value.store.updateRecoveryPoint(item.id, { pinned: options.pin ? true : options.unpin ? false : item.pinned, held: options.hold ? true : options.releaseHold ? false : item.held }); audit(value, 'protection_updated', { recoveryPointId: item.id, pinned: updated.pinned, held: updated.held }, item.resourceId); output.success(`${updated.id}: pinned=${updated.pinned} held=${updated.held}`) })))

  app.command('recovery:retention', 'Queue deletion of expired, unlocked, unheld recovery points').option('--env <environment>', 'Target environment')
    .action(async (options: { env?: string }) => run(async () => withContext(options.env, async value => { const jobs = value.coordinator.enqueueRetention(); audit(value, 'retention_queued', { jobs: jobs.length }); output.success(`Queued ${jobs.length} retention cleanup job${jobs.length === 1 ? '' : 's'}.`) })))
}
