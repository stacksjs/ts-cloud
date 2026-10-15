# Persistent compute storage

The Hetzner compute owner can declare block volumes and deployment placement in
`config/cloud.ts`. Attached projects inherit the host policy when they deploy.
Existing volumes are adopted by exact name and are never reformatted or shrunk.

```typescript
compute: {
  size: 'xlarge', // CX53
  resize: { whenUnavailable: 'keep-current', upgradeDisk: true },
  volumes: {
    deployments: {
      size: 250,
      mountPath: '/var/lib/deployments',
      deleteProtection: true,
    },
  },
  deploymentStorage: {
    volume: 'deployments',
    migrateExisting: true,
    includeBackups: true,
  },
  monitoring: {
    filesystems: ['/', { path: '/var/lib/deployments', requiredMount: true }],
  },
}
```

Preview with `buddy cloud:apply --dry-run`; apply with
`buddy cloud:apply --yes`. The ts-cloud CLI exposes the same operation as
`cloud apply`. An unavailable server type remains pending while storage is
applied. A server resize requires a restart; volume placement copies online,
verifies under deployment locks, and keeps running processes on their current
release. Shared databases stay at their existing paths.

Mounts persist by filesystem UUID. Bind mounts preserve `/var/www` release and
backup paths, and systemd dependencies prevent applications from starting on
unmounted storage. Every minute, the storage check verifies volume identity and
deployment mounts; the metrics collector reports each configured filesystem.
Inactive root copies are reclaimed hourly, preserving active and current code.
The dashboard exposes filesystem usage and mount health. Declare additional
writer locks in `deploymentStorage.locks` and systemd consumers in
`deploymentStorage.dependentUnits`; the owner configuration keeps these
host-specific integrations alongside the volume declaration.

Keep webhook secrets on the host with a typed reference:

```typescript
notifications: {
  discord: {
    webhookUrl: { envFile: '/etc/myapp/notifications.env', variable: 'DISCORD_WEBHOOK_URL' },
  },
}
```

The notifier reads assignments as data and retries failed deliveries through
monitoring's persisted state. Storage policy lives at
`/etc/ts-cloud/compute-storage.json`; reports and migration health comparisons
live under `/var/lib/ts-cloud`. The runtime is TypeScript executed by Bun.

## Linux mount integration check

The storage agent keeps its root recovery view private before binding releases.
Cleanup also verifies the original directory is on the root filesystem and is a
different inode from the deployment destination. This prevents shared mount
propagation from redirecting cleanup onto the volume.

An opt-in Linux test runs the actual agent in an isolated mount namespace with
fixture configuration, locks and services. It needs root and an existing ext4
volume, and removes only its uniquely named temporary fixture directory:

```sh
TS_CLOUD_TEST_VOLUME_PATH=/var/lib/stacks-deployments \
TS_CLOUD_TEST_VOLUME_DEVICE=/dev/disk/by-id/scsi-0HC_Volume_ID \
bun test packages/ts-cloud/test/integration/compute-storage-mounts.test.ts
```
