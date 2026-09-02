# Cloud Providers

ts-cloud deploys to **AWS**, **Hetzner Cloud**, or **your own Linux hosts over SSH** for compute, and can put object storage on **AWS S3**, **Backblaze B2**, or **Hetzner Object Storage**, independently of where compute runs. You pick all of this in `cloud.config.ts`; there is no separate provider plugin to install.

## Choosing a compute provider

Set `cloud.provider` in your config. It defaults to `'aws'`.

```typescript
import type { CloudConfig } from '@stacksjs/ts-cloud'

const config: CloudConfig = {
  project: {
    name: 'My App',
    slug: 'my-app',
    region: 'us-east-1',
  },
  environments: {
    production: { type: 'production', region: 'us-east-1' },
  },

  // Compute provider: 'aws' (default), 'hetzner' or 'ssh'
  cloud: {
    provider: 'aws',
  },
}

export default config
```

Provider selection is resolved by `resolveCloudProvider(config)`, which follows this order:

1. `cloud.provider`, if set.
2. `'ssh'` if `ssh.hosts` lists a host.
3. `'hetzner'` if `hetzner.apiToken` is present.
4. `'aws'` otherwise.

### AWS

AWS is the default. Compute infrastructure is expressed as **CloudFormation** templates (the AWS driver sets `usesCloudFormation = true`). Optional AWS-specific settings live in the `aws` block:

```typescript
const config: CloudConfig = {
  project: { name: 'My App', slug: 'my-app', region: 'us-east-1' },
  environments: { production: { type: 'production', region: 'us-east-1' } },

  cloud: { provider: 'aws' },

  aws: {
    region: 'us-east-1',   // overrides project.region for AWS calls
    profile: 'default',    // AWS named profile
    accountId: '123456789012',
  },
}
```

The driver uses the region from `aws.region` / `project.region`. Credentials come from the standard AWS chain (named profile, environment variables, or instance role) — ts-cloud makes signed API calls directly with Signature V4, so no AWS SDK or CLI is required.

### Hetzner Cloud

Hetzner provisions a server over the Hetzner Cloud API and deploys to it over SSH (Forge-style). Set `cloud.provider` to `'hetzner'` and provide a `hetzner` block:

```typescript
const config: CloudConfig = {
  project: { name: 'My App', slug: 'my-app', region: 'fsn1' },
  environments: { production: { type: 'production', region: 'fsn1' } },

  cloud: { provider: 'hetzner' },

  hetzner: {
    // falls back to HCLOUD_TOKEN / HETZNER_API_TOKEN if omitted
    apiToken: process.env.HCLOUD_TOKEN,
    location: 'fsn1',                       // fsn1, nbg1, hel1, … (default: fsn1)
    image: 'ubuntu-24.04',                  // default: ubuntu-24.04
    sshPrivateKeyPath: '~/.ssh/id_ed25519', // key used for deploy commands
    sshUser: 'root',                        // default: root
  },
}
```

`HetznerConfig` fields:

| Field | Description | Default |
| --- | --- | --- |
| `apiToken` | Hetzner Cloud API token | `HCLOUD_TOKEN` / `HETZNER_API_TOKEN` env |
| `location` | Location slug (`fsn1`, `nbg1`, `hel1`, …) | `fsn1` |
| `image` | Server image slug | `ubuntu-24.04` |
| `sshPrivateKeyPath` | SSH private key for deploy commands | `~/.ssh/id_ed25519` |
| `sshUser` | SSH user for deploy commands | `root` |

If you set `hetzner.apiToken` but no `cloud.provider`, the provider resolves to `'hetzner'` automatically.

### SSH (bring your own host)

The `ssh` provider deploys to a Linux host you already have: a Raspberry Pi on the LAN, a colocated box, a VM from a provider ts-cloud has no API driver for. Nothing is created or destroyed on your behalf. ts-cloud **adopts** the host: it pins the host key, runs a preflight (`cloud ssh:preflight`), bootstraps the same stack the Hetzner driver installs at first boot, and from then on deploys exactly as it would to a cloud box.

```typescript
const config: CloudConfig = {
  project: { name: 'Pi App', slug: 'pi-app', region: 'home' },
  environments: { production: { type: 'production' } },

  cloud: { provider: 'ssh' },

  ssh: {
    hosts: [{ host: 'pi-app.local', user: 'pi' }], // exactly one host today
    hostKey: 'pin',                                 // pin | accept-new | insecure (default: pin)
    profile: 'raspberry-pi',                        // raspberry-pi | generic (default: generic)
  },

  infrastructure: {
    compute: { runtime: 'bun', proxy: { engine: 'rpx' } },
  },
}
```

`SshConfig` fields:

| Field | Description | Default |
| --- | --- | --- |
| `hosts[].host` | Hostname or IP. Env: `TS_CLOUD_SSH_HOST` | required |
| `hosts[].user` | SSH user. Non-root users need passwordless sudo. Env: `TS_CLOUD_SSH_USER` | `root` |
| `hosts[].port` | SSH port. Env: `TS_CLOUD_SSH_PORT` | `22` |
| `hosts[].privateKeyPath` | Private key for deploy commands. Env: `TS_CLOUD_SSH_KEY` | `~/.ssh/id_ed25519` |
| `hostKey` | `pin` records the key on first contact in `<stateDir>/ssh/known_hosts` and refuses any other afterwards. Env: `TS_CLOUD_SSH_HOST_KEY` | `pin` |
| `sudo` | Run remote scripts through `sudo -n` | `true` unless the user is `root` |
| `profile` | `raspberry-pi` tunes swap, journald and the clock wait for an SD-card ARM board. Env: `TS_CLOUD_SSH_PROFILE` | `generic` |
| `publicIp` | Address DNS should point at: `auto` or a literal | `auto` |
| `lan` | `{ hostname, tls }` for a host only reachable on the LAN. See below | unset |

Listing `ssh.hosts` without a `cloud.provider` selects the ssh provider. The sizing keys under `infrastructure.compute` (`size`, `appServers`, `image`, ...) have no effect and are reported as warnings; `cloud.attachTo`, more than one host, and `managedServices.vitess` on ARM are refused. Teardown (`cloud compute:destroy`) clears local state only and never touches the host.

#### TLS on a host with no public DNS

`ssh.lan` is the only setting that changes how the gateway terminates TLS, and it applies to the `ssh` provider alone: a cloud box has no LAN an operator can reach, so `ssh.lan` on an AWS or Hetzner deploy is ignored rather than acted on.

| `lan.tls` | What the gateway does |
| --- | --- |
| unset or `'local-ca'` | Creates a certificate authority in `/etc/rpx/local-ca`, signs one certificate covering the LAN names, installs the CA in the box's own trust store, and renews before expiry. Served per server name and as the default TLS context, so an IP-literal URL with no SNI gets it too. |
| `'off'` | Plain HTTP. rpx binds the HTTP port only and nothing on `:443`. |

The certificate covers `lan.hostname` (default `<project.slug>.local`), `dashboard.<that name>` when the project deploys the management dashboard, every site `domain` that is a `.local` or bare single-label name, and the box's LAN address as an IP SAN when the preflight found one. Nothing is guessed: an address ts-cloud does not know is left off the certificate.

The CA certificate is written to `/etc/rpx/local-ca/rpx-root-ca.crt`. `cloud deploy` prints the path and the command to fetch it, and the driver returns it as `lanCaCertPath`. Trusting it on a laptop and on a phone, and when plain HTTP is the better trade, are covered in [Raspberry Pi](/guide/raspberry-pi#the-lan-certificate-authority); the certificate mechanism itself is rpx's `localCa`, documented there.

One hostname cannot be both LAN and public. A name claimed by `ssh.lan` and by `compute.proxy.onDemandTls` is refused at build time, naming the host and both sources, because the two issuance paths would otherwise fight over one SNI name and ACME would be asked for a name it can never issue.

For the Raspberry Pi flow end to end, see [Raspberry Pi](/guide/raspberry-pi).

## Choosing an object storage provider

Object storage is configured separately via the `objectStorage` block. AWS S3, Backblaze B2, and Hetzner Object Storage are all S3-compatible and authenticate with Signature V4, so a single client drives all three — only the endpoint, addressing style, and credentials differ. This lets you keep compute on AWS while moving static assets, release artifacts, or registry tarballs onto cheaper storage.

```typescript
const config: CloudConfig = {
  project: { name: 'My App', slug: 'my-app', region: 'us-east-1' },
  environments: { production: { type: 'production', region: 'us-east-1' } },

  cloud: { provider: 'aws' },

  // Move object storage to Backblaze B2 (compute still on AWS)
  objectStorage: {
    provider: 'backblaze',
    region: 'us-west-004',
    // endpoint and forcePathStyle default to the provider's standard values
  },
}
```

`ObjectStorageConfig` fields:

| Field | Description | Default |
| --- | --- | --- |
| `provider` | `'aws'`, `'backblaze'`, or `'hetzner'` | `'aws'` |
| `region` | Region / location slug | aws: `us-east-1`, backblaze: `us-west-004`, hetzner: `fsn1` |
| `endpoint` | HTTP(S) endpoint origin or host, e.g. `https://<account>.r2.cloudflarestorage.com` | provider's standard endpoint |
| `forcePathStyle` | Use path-style addressing (bucket in path) | `false` (virtual-hosted) |

Credentials are resolved from provider-specific environment variables when not supplied programmatically:

- **AWS** — the standard AWS chain (profile / `AWS_*` env / instance role).
- **Backblaze** — `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` (falls back to `S3_*` / `AWS_*`).
- **Hetzner** — `HETZNER_S3_ACCESS_KEY` / `HETZNER_S3_SECRET_KEY` (falls back to `S3_*` / `AWS_*`).

You can also drive object storage entirely from the environment with `OBJECT_STORAGE_PROVIDER` (or `STORAGE_PROVIDER`).

## Programmatic access

If you need a storage client outside the deploy flow, the resolution helpers are exported from the package root:

```typescript
import { createObjectStorageClient, resolveObjectStorage } from '@stacksjs/ts-cloud'

// Inspect the resolved config (pure, no side effects)
const resolved = resolveObjectStorage({ provider: 'backblaze', region: 'us-west-004' })
console.log(resolved.endpoint, resolved.publicBaseUrl('my-bucket'))

// Get a ready-to-use S3-compatible client
const s3 = createObjectStorageClient({
  provider: 'backblaze',
  region: 'us-west-004',
  credentials: { accessKeyId: keyId, secretAccessKey: appKey },
})
await s3.putObject({ bucket: 'my-bucket', key: 'a.txt', body: 'hi' })
```

The client also accepts an options object directly. Use virtual-hosted addressing for R2 and path-style addressing for local MinIO:

```typescript
const r2 = new S3Client({
  region: 'auto',
  endpoint: 'https://<account-id>.r2.cloudflarestorage.com',
  credentials: { accessKeyId, secretAccessKey },
})

const minio = new S3Client({
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:9000',
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
})
```

The selected endpoint and addressing style are shared by object reads/writes, multipart uploads, and presigned URLs. Signature V4 always signs the exact host and canonical path sent over the wire. Endpoint URLs must be origins without a path, query, or fragment.

For how providers are wired internally — and why there is no user-facing "custom provider" plugin API — see [Custom Providers](/advanced/providers).

## Next Steps

- [Getting Started](/guide/getting-started) - Setup guide
- [Deployment](/guide/deployment) - Deploy infrastructure
- [Custom Providers](/advanced/providers) - Driver architecture
