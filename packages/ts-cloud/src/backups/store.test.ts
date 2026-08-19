import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { BackupStore, validateBackupDestination } from './store'

const controls: ControlPlaneStore[] = []
function fixture() {
  const control = new ControlPlaneStore({ path: ':memory:' })
  controls.push(control)
  const organization = control.createOrganization({ slug: 'acme', name: 'Acme' }),
    project = control.createProject({ organizationId: organization.id, slug: 'web', name: 'Web' }),
    environment = control.createEnvironment({
      projectId: project.id,
      slug: 'production',
      name: 'Production',
      kind: 'production',
    }),
    resource = control.createResource({
      projectId: project.id,
      environmentId: environment.id,
      slug: 'uploads',
      name: 'Uploads',
      kind: 'volume',
    }),
    clock = { now: new Date('2026-07-21T12:00:00.000Z') },
    backups = new BackupStore(control, () => clock.now)
  return { control, organization, project, environment, resource, clock, backups }
}
afterEach(() => {
  for (const control of controls.splice(0)) control.close()
})

describe('backup recovery control plane', () => {
  it('validates explicit custom endpoint and encryption security policy', () => {
    const base = {
      organizationId: 'org',
      projectId: 'project',
      name: 'offsite',
      provider: 's3_compatible' as const,
      endpoint: 'https://minio.internal/',
      endpointPolicy: 'public_https' as const,
      bucket: 'backups',
      prefix: '',
      region: 'us-east-1',
      forcePathStyle: true,
      credentialRef: 'secret://backup/offsite',
      encryption: 'both' as const,
      encryptionKeyRef: 'secret://backup/key',
      immutability: {},
      status: 'untested' as const,
    }
    expect(() => validateBackupDestination(base)).toThrow('allow_private')
    expect(() => validateBackupDestination({ ...base, endpointPolicy: 'allow_private' })).not.toThrow()
    expect(() => validateBackupDestination({ ...base, endpoint: 'http://minio.internal/' })).toThrow('HTTPS')
  })

  it('requires client encryption for project-scoped control-plane backups', () => {
    const target = fixture(),
      providerOnly = target.backups.createDestination({
        organizationId: target.organization.id,
        projectId: target.project.id,
        name: 'provider-only',
        provider: 'aws_s3',
        endpointPolicy: 'public_https',
        bucket: 'acme',
        prefix: '',
        forcePathStyle: false,
        encryption: 'provider',
        immutability: {},
        status: 'healthy',
      }),
      encrypted = target.backups.createDestination({
        organizationId: target.organization.id,
        projectId: target.project.id,
        name: 'encrypted',
        provider: 'aws_s3',
        endpointPolicy: 'public_https',
        bucket: 'acme',
        prefix: '',
        forcePathStyle: false,
        encryption: 'both',
        encryptionKeyRef: 'secret://backup/key',
        immutability: {},
        status: 'healthy',
      }),
      input = {
        organizationId: target.organization.id,
        projectId: target.project.id,
        environmentId: target.environment.id,
        destinationId: providerOnly.id,
        name: 'control-daily',
        resourceKind: 'control_plane' as const,
        schedule: 'daily',
        timezone: 'UTC',
        retention: { keepLast: 7 },
        compression: 'none' as const,
        encryption: 'both' as const,
        includePatterns: [],
        excludePatterns: [],
        expectedRpoMinutes: 1440,
        expectedRtoMinutes: 120,
        enabled: true,
      }
    expect(() => target.backups.createPolicy(input)).toThrow('client-side')
    expect(target.backups.createPolicy({ ...input, destinationId: encrypted.id })).toMatchObject({
      resourceKind: 'control_plane',
      resourceId: undefined,
      dataServiceId: undefined,
    })
  })

  it('schedules policies, detects missed RPO, tracks verification, and enforces safe retention', () => {
    const target = fixture(),
      destination = target.backups.createDestination({
        organizationId: target.organization.id,
        projectId: target.project.id,
        name: 'archive',
        provider: 'aws_s3',
        endpointPolicy: 'public_https',
        bucket: 'acme-backups',
        prefix: 'production',
        region: 'us-west-2',
        forcePathStyle: false,
        encryption: 'provider',
        immutability: { objectLock: true, defaultRetentionDays: 30 },
        status: 'untested',
      }),
      healthy = target.backups.recordDestinationTest(destination.id, { ok: true }),
      policy = target.backups.createPolicy({
        organizationId: target.organization.id,
        projectId: target.project.id,
        environmentId: target.environment.id,
        resourceId: target.resource.id,
        destinationId: destination.id,
        name: 'uploads-hourly',
        resourceKind: 'volume',
        schedule: 'hourly',
        timezone: 'UTC',
        retention: { keepLast: 0, expireAfterDays: 7 },
        compression: 'zstd',
        encryption: 'destination',
        includePatterns: [],
        excludePatterns: ['*.tmp'],
        expectedRpoMinutes: 60,
        expectedRtoMinutes: 30,
        enabled: true,
      })
    expect(healthy).toMatchObject({ status: 'healthy', lastSuccessAt: target.clock.now.toISOString() })
    expect(policy.schedule).toBe('cron(0 * * * *)')
    expect(policy.nextRunAt).toBe('2026-07-21T13:00:00.000Z')
    expect(target.backups.coverage(target.project.id)).toMatchObject([
      { missedRpo: true, unverified: 0, destinationHealthy: true },
    ])

    const backupJob = target.backups.createJob({
        projectId: target.project.id,
        policyId: policy.id,
        kind: 'backup',
        status: 'succeeded',
        idempotencyKey: `${policy.id}:2026-07-21T11:30Z`,
        target: {},
        cancellability: 'safe',
        progress: {},
        startedAt: '2026-07-21T11:29:00.000Z',
        finishedAt: '2026-07-21T11:30:00.000Z',
      }),
      point = target.backups.createRecoveryPoint({
        projectId: target.project.id,
        policyId: policy.id,
        destinationId: destination.id,
        resourceId: target.resource.id,
        backupJobId: backupJob.id,
        kind: 'volume',
        pointInTime: '2026-07-21T11:30:00.000Z',
        uri: 's3://acme-backups/production/uploads.tar.zst',
        sizeBytes: 42,
        checksum: `sha256:${'a'.repeat(64)}`,
        manifest: { files: 3 },
        expiresAt: '2026-07-21T11:59:00.000Z',
        held: false,
        pinned: false,
        status: 'available',
        verificationState: 'unverified',
      })
    expect(target.backups.coverage(target.project.id)).toMatchObject([{ missedRpo: false, unverified: 1 }])
    expect(target.backups.retentionCandidates()).toEqual([point])
    target.backups.updateRecoveryPoint(point.id, { held: true })
    expect(target.backups.retentionCandidates()).toEqual([])
  })

  it('retains the newest point and tier representatives before expiry cleanup', () => {
    const target = fixture(),
      destination = target.backups.createDestination({
        organizationId: target.organization.id,
        projectId: target.project.id,
        name: 'archive',
        provider: 'aws_s3',
        endpointPolicy: 'public_https',
        bucket: 'acme',
        prefix: '',
        forcePathStyle: false,
        encryption: 'provider',
        immutability: {},
        status: 'healthy',
      }),
      policy = target.backups.createPolicy({
        organizationId: target.organization.id,
        projectId: target.project.id,
        environmentId: target.environment.id,
        resourceId: target.resource.id,
        destinationId: destination.id,
        name: 'tiered',
        resourceKind: 'volume',
        schedule: 'hourly',
        timezone: 'UTC',
        retention: { keepLast: 1, hourly: 2, daily: 2, expireAfterDays: 1 },
        compression: 'gzip',
        encryption: 'destination',
        includePatterns: [],
        excludePatterns: [],
        expectedRpoMinutes: 60,
        expectedRtoMinutes: 30,
        enabled: true,
      }),
      createPoint = (pointInTime: string) =>
        target.backups.createRecoveryPoint({
          projectId: target.project.id,
          policyId: policy.id,
          destinationId: destination.id,
          resourceId: target.resource.id,
          kind: 'volume',
          pointInTime,
          uri: `s3://acme/${pointInTime}`,
          sizeBytes: 1,
          checksum: `sha256:${'c'.repeat(64)}`,
          manifest: {},
          expiresAt: '2026-07-21T11:59:00.000Z',
          held: false,
          pinned: false,
          status: 'available',
          verificationState: 'verified',
        }),
      newest = createPoint('2026-07-21T11:45:00.000Z'),
      sameHour = createPoint('2026-07-21T11:15:00.000Z'),
      previousHour = createPoint('2026-07-21T10:45:00.000Z'),
      previousDay = createPoint('2026-07-20T10:00:00.000Z'),
      oldest = createPoint('2026-07-19T10:00:00.000Z')
    const candidateIds = target.backups.retentionCandidates().map((item) => item.id)
    expect(candidateIds).toHaveLength(2)
    expect(candidateIds).toContain(oldest.id)
    expect(candidateIds).toContain(sameHour.id)
    expect(candidateIds).not.toContain(newest.id)
    expect(candidateIds).not.toContain(previousHour.id)
    expect(candidateIds).not.toContain(previousDay.id)
  })

  it('deduplicates jobs and protects recovery points during restores', () => {
    const target = fixture(),
      destination = target.backups.createDestination({
        organizationId: target.organization.id,
        projectId: target.project.id,
        name: 'archive',
        provider: 'aws_s3',
        endpointPolicy: 'public_https',
        bucket: 'acme',
        prefix: '',
        forcePathStyle: false,
        encryption: 'provider',
        immutability: {},
        status: 'healthy',
      }),
      first = target.backups.createJob({
        projectId: target.project.id,
        kind: 'backup',
        status: 'queued',
        idempotencyKey: 'stable-key',
        target: {},
        cancellability: 'safe',
        progress: {},
      }),
      replay = target.backups.createJob({
        projectId: target.project.id,
        kind: 'backup',
        status: 'queued',
        idempotencyKey: 'stable-key',
        target: { changed: true },
        cancellability: 'safe',
        progress: {},
      })
    expect(replay.id).toBe(first.id)
    const point = target.backups.createRecoveryPoint({
      projectId: target.project.id,
      destinationId: destination.id,
      kind: 'files',
      pointInTime: '2026-07-20T00:00:00.000Z',
      uri: 's3://acme/files.tar',
      sizeBytes: 1,
      checksum: `sha256:${'b'.repeat(64)}`,
      manifest: {},
      expiresAt: '2026-07-20T01:00:00.000Z',
      held: false,
      pinned: false,
      status: 'available',
      verificationState: 'verified',
    })
    target.backups.createJob({
      projectId: target.project.id,
      recoveryPointId: point.id,
      kind: 'restore',
      status: 'running',
      idempotencyKey: 'restore-1',
      target: { path: '/isolated' },
      restoreMode: 'isolated',
      cancellability: 'checkpoint_only',
      progress: {},
    })
    expect(target.backups.retentionCandidates()).toEqual([])
  })
})
