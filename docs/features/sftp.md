# SFTP File Transfer

ts-cloud provisions an [AWS Transfer Family](https://aws.amazon.com/aws-transfer-family/)
SFTP endpoint from your `cloud.config.ts` — server, CloudWatch logging role,
service-managed users, and a per-user IAM role scoped to that user's home
directory.

## Providers

| Provider | Server | Storage options |
| --- | --- | --- |
| `aws` | AWS Transfer Family | On the server (EFS) or a bucket (S3) |
| `hetzner`, box deploys | [ts-sftp](https://github.com/stacksjs/ts-sftp) as a systemd unit | On the server (a directory) |

The same `infrastructure.sftp` block drives both. On AWS it becomes a Transfer
Family server; on a box provider it installs and runs ts-sftp, generating a
host key once and keeping it, so a redeploy does not change the fingerprint
clients have pinned. Bucket-backed storage asks for S3 specifically, so
configuring it on a non-AWS provider fails the deploy with that explanation
rather than quietly doing nothing.

Files can live in either of two places:

| Storage | Config | What users get |
| --- | --- | --- |
| **On the server** | `storage: { type: 'efs' }` | A POSIX file system (directories, renames, symlinks, in-place appends), shared with anything else that mounts it |
| **In a bucket** | `storage: { type: 's3' }` | Objects in S3, ready for lifecycle rules, event notifications, and the rest of the S3 ecosystem |

Everything else — users, keys, endpoint type, logging — is the same either way.

## Storage on the server (EFS)

Point the server at an EFS file system and each user gets a real home directory
on it:

```ts
infrastructure: {
  fileSystem: {
    uploads: { encrypted: true },
  },
  sftp: {
    storage: {
      type: 'efs',
      fileSystem: 'uploads', // an infrastructure.fileSystem entry
      posixProfile: { uid: 1000, gid: 1000 },
    },
    users: {
      deploy: {
        sshPublicKeys: ['ssh-ed25519 AAAA... deploy@example.com'],
        homeDirectory: 'incoming/deploy',
      },
    },
  },
}
```

`fileSystem` names an entry in `infrastructure.fileSystem`, so one deploy creates
the file system, its mount targets, and the server in front of it. To use a file
system that already exists, give its ID instead:

```ts
storage: { type: 'efs', fileSystemId: 'fs-01234567', posixProfile: { uid: 1000, gid: 1000 } }
```

Every user on an EFS-backed server needs a POSIX identity — the uid/gid that
owns the files they write. Set `posixProfile` on the storage for a shared
default, or per user to keep them apart:

```ts
users: {
  vendor: {
    sshPublicKeys: ['ssh-ed25519 AAAA... vendor@example.com'],
    posixProfile: { uid: 1001, gid: 1001, secondaryGids: [1002] },
  },
}
```

Each user's generated role grants `elasticfilesystem:ClientMount`,
`ClientWrite`, and `DescribeMountTargets` on that one file system.

## Storage in a bucket (S3)

```ts
infrastructure: {
  storage: {
    uploads: {},
  },
  sftp: {
    storage: { type: 's3', storageBucket: 'uploads' }, // an infrastructure.storage entry
    users: {
      deploy: {
        sshPublicKeys: ['ssh-ed25519 AAAA... deploy@example.com'],
        homeDirectory: 'incoming/deploy',
      },
    },
  },
}
```

`storageBucket` names an entry in `infrastructure.storage` and resolves to the
bucket that entry generates. For a bucket that already exists, name it directly:

```ts
storage: { type: 's3', bucket: 'my-app-production-uploads' }
```

`bucket: 'my-app-production-uploads'` at the top level of `sftp` is shorthand for
the same thing. Each user's role is scoped to `bucket/homeDirectory/*`, with
`ListBucket` limited to that prefix.

## Users

- `sshPublicKeys` — one or more public keys; the server is `SERVICE_MANAGED`, so
  keys are the only credential.
- `homeDirectory` — path within the bucket or file system. Defaults to the
  username. Users are chrooted to it.
- `roleArn` — bring your own role instead of the generated one.
- `posixProfile` — uid/gid for EFS-backed servers.

## Endpoint

Servers are public by default. For a private endpoint inside your VPC:

```ts
sftp: {
  endpointType: 'VPC',
  endpointDetails: {
    vpcId: 'vpc-0123456789abcdef0',
    subnetIds: ['subnet-0123456789abcdef0'],
    securityGroupIds: ['sg-0123456789abcdef0'],
  },
  // ...
}
```

Set `securityPolicyName` to pin a Transfer security policy, and `logging: false`
to skip the CloudWatch logging role.

## On box providers

A Hetzner (or other box) deploy serves a directory on the server:

```ts
infrastructure: {
  compute: { instanceType: 'cpx21' },
  sftp: {
    storage: { type: 'efs', path: '/srv/uploads' }, // defaults to /var/sftp/<slug>
    port: 2222,
    users: {
      deploy: {
        sshPublicKeys: ['ssh-ed25519 AAAA... deploy@example.com'],
        homeDirectory: 'incoming/deploy',
      },
    },
  },
}
```

ts-cloud installs ts-sftp under `/opt/ts-sftp`, writes each user's keys to
`/etc/ts-sftp/users/<name>.pub`, runs the server as the `ts-sftp` system
account under systemd (`<slug>-sftp.service`), and opens the port in the
provider firewall. Port 2222 is the default, since sshd already owns 22.

Box-only options:

| Option | Default | Description |
| --- | --- | --- |
| `port` | `2222` | Port the server listens on |
| `readOnly` | `false` | Reject every write |
| `version` | `latest` | ts-sftp version installed on the box |
| `serviceUser` | `ts-sftp` | System account the server runs as |
| `storage.path` | `/var/sftp/<slug>` | Directory served |

## Deploying and connecting

An `sftp` block deploys with the rest of your infrastructure — no sites or
compute required in the config:

```bash
cloud deploy
```

The stack exports `SftpServerId`, `SftpEndpoint`, and `SftpStorageDomain` (`EFS`
or `S3`). Connect with the matching private key:

```bash
sftp -i ~/.ssh/id_ed25519 deploy@s-1234567890abcdef0.server.transfer.us-east-1.amazonaws.com
```
