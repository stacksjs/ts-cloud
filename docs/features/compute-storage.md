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
The dashboard exposes filesystem usage and mount health.

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
