# CloudFront origin failover

Origin failover gives a CloudFront distribution a second origin to fall back on.
CloudFront sends every cache miss to the primary origin. When the primary returns
one of the configured status codes, refuses the connection (503) or times out
(504), CloudFront retries the same request against the secondary origin. See
[Optimize high availability with CloudFront origin failover](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html).

ts-cloud expresses this as a CloudFront **origin group**: the primary and
secondary origins, the status codes that trigger failover, and a default cache
behavior that targets the group instead of a single origin.

Verified against a live distribution: S3 origins in `us-east-1` and `us-west-2`,
an object missing from the primary served from the secondary, and every object
served from the secondary once the primary refused all reads
([stacksjs/stacks#1159](https://github.com/stacksjs/stacks/issues/1159)).

## A replicated bucket in another region

Add `failover` to a website bucket in `infrastructure.storage`:

```ts
export default {
  project: { name: 'My App', slug: 'my-app', region: 'us-east-1' },
  infrastructure: {
    dns: { domain: 'example.com', hostedZoneId: 'Z0123456789' },
    ssl: { enabled: true },
    storage: {
      public: {
        website: true,
        failover: { region: 'us-west-2' },
      },
    },
  },
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `region` | `string` | required | Region of the replica. Must differ from the stack's region. |
| `bucket` | `string` | `<bucket>-<region>` | Replica bucket name. |
| `statusCodes` | `number[]` | `[403, 404, 500, 502, 503, 504]` | Primary responses that send a request to the replica. |
| `connectionAttempts` | `number` | CloudFront's 3 | Connection attempts to the primary, 1-3. |
| `connectionTimeout` | `number` | CloudFront's 10 | Seconds to wait for the primary to accept a connection, 1-10. |
| `replicate` | `boolean` | `true` | Replicate the primary into the replica with S3 replication. |

The default codes include 403 and 404: a bucket behind origin access control
answers a missing object with 403, so they cover an object the primary lost,
and the 5xx codes cover the bucket or region failing.

What gets generated:

- On the primary bucket: versioning, a `ReplicationConfiguration` that copies
  every object and delete marker to the replica, and an IAM role S3 assumes to
  do it, scoped to the two buckets.
- On the distribution: a second S3 origin for the replica (same origin access
  control), an origin group, and a default cache behavior that targets it.
  Compute routes keep their own origin.
- Outputs `<name>CloudFrontDistributionArn` and `<name>FailoverBucketName`, and
  template metadata `TsCloud::StorageFailover` listing the replicas.

The replica itself is **not** in the stack: a CloudFormation stack can only
create buckets in its own region. `cloud deploy` handles it around the stack:

1. `ensureFailoverReplicaBuckets` before the stack: creates the replica if it
   is missing (private, AES256, versioned). S3 rejects a replication rule whose
   destination is missing or unversioned, so this has to come first.
2. `grantFailoverReplicaAccess` after the stack: adds one statement to the
   replica's bucket policy letting that distribution, by ARN, read it. Other
   statements are kept.
3. `seedFailoverReplicas` after uploads: copies objects the replica lacks (or
   holds at another size), since S3 replication only copies writes made after
   it was turned on.

All three, and `storageFailoverReplicasFromTemplate`, are exported for
deployers that create stacks themselves. `deleteFailoverReplicaBuckets` empties
and removes replicas; nothing calls it automatically, since the replica is the
copy meant to survive losing the stack.

Failover needs the bucket to have its own distribution: `website: true`, not
mounted under another bucket's `path`, with `dns.domain` and SSL configured.
Generation throws otherwise.

## Standalone CDN distributions

Add `failoverOrigin` to an entry in `infrastructure.cdn`:

```ts
export default {
  infrastructure: {
    cdn: {
      frontend: {
        origin: 'my-app-production-frontend.s3.us-east-1.amazonaws.com',
        failoverOrigin: 'my-app-production-frontend-replica.s3.us-west-2.amazonaws.com',
        // Optional. Defaults to [500, 502, 503, 504].
        failoverStatusCodes: [500, 502, 503, 504],
        // Optional tuning of the primary origin.
        connectionAttempts: 1,
        connectionTimeout: 3,
      },
    },
  },
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `failoverOrigin` | `string \| { domain, originPath?, connectionAttempts?, connectionTimeout? }` | none | Origin CloudFront fails over to. An S3 REST endpoint becomes an S3 origin, any other host an HTTPS-only custom origin. |
| `failoverStatusCodes` | `number[]` | `[500, 502, 503, 504]` | Status codes from `origin` that trigger failover. |
| `connectionAttempts` | `number` | CloudFront's 3 | Connection attempts to `origin`, 1-3. |
| `connectionTimeout` | `number` | CloudFront's 10 | Seconds to connect to `origin`, 1-10. |

The generated distribution gains a second origin
(`S3-<slug>-<env>-<name>-cdn-failover`), an `OriginGroups` block, and a default
cache behavior whose `TargetOriginId` is the group
(`S3-<slug>-<env>-<name>-cdn-failover-group`):

```json
"OriginGroups": {
  "Quantity": 1,
  "Items": [{
    "Id": "S3-my-app-production-frontend-cdn-failover-group",
    "FailoverCriteria": { "StatusCodes": { "Quantity": 4, "Items": [500, 502, 503, 504] } },
    "Members": {
      "Quantity": 2,
      "Items": [
        { "OriginId": "S3-my-app-production-frontend-cdn" },
        { "OriginId": "S3-my-app-production-frontend-cdn-failover" }
      ]
    }
  }]
}
```

With `routeCompute: true`, the compute paths (`/api/*` and the rest) keep
targeting the compute origin. Only the default behavior uses the group.

Without `failoverOrigin`, the distribution is byte-for-byte what it was before
this option existed. This path creates and replicates nothing; keep the
secondary in sync yourself.

## Self-hosted origins (`buildCloudFrontOriginConfig`)

For CloudFront in front of your own boxes (see
[CDN in front of a Hetzner origin](./cdn-hetzner-origin.md)), pass a second box:

```ts
import { buildCloudFrontOriginConfig } from '@stacksjs/ts-cloud'

const config = buildCloudFrontOriginConfig({
  aliases: ['example.com'],
  originDomain: 'origin.example.com',
  failoverOriginDomain: 'origin-dr.example.com',
  failoverStatusCodes: [502, 503, 504],
  connectionAttempts: 1, // primary only; default 3
  connectionTimeout: 3, // primary only; default 10
  viewerCertificateArn: 'arn:aws:acm:us-east-1:…:certificate/…',
  behaviors: [{ pathPattern: '/api/*', kind: 'dynamic' }],
  originSecret: process.env.ORIGIN_SECRET,
})
```

The failover box follows the same rules as `originDomain`: it must not be one of
the aliases, and it receives the same origin secret header, so lock it down the
same way. The default (static) behavior targets the group; `dynamic` path
behaviors stay on the primary, because they accept writes.

## Low-level module

`CDN.createDistribution({ ..., failoverOrigin: { domainName, statusCodes?, selectionCriteria?, connectionAttempts?, connectionTimeout?, primary? } })`
and `CDN.addOriginFailover(distribution, { domainName })` apply the same change
to a distribution built with the `CDN` module. `primary` tunes the primary
origin's connection; the top-level `connectionAttempts`/`connectionTimeout`
tune the secondary.

The pure builders behind every path are exported from `@ts-cloud/core`:
`buildOriginGroups`, `resolveFailoverStatusCodes`, `resolveOriginConnection`,
`assertOriginGroupMethods`, `validateOriginGroups`, `resolveStorageFailover`,
`buildReplicationRole`, `buildReplicationConfiguration` and
`buildFailoverReplicaPolicyStatement`.

`selectionCriteria` sets the group's `SelectionCriteria`: `default` (primary
first) or `media-quality-based`, which only works between AWS Elemental
MediaPackage v2 origins and is rejected for anything else.

## Rules ts-cloud enforces

`validateOriginGroups` runs on every distribution ts-cloud generates, in the
CloudFormation and the CloudFront API shape, so a bad config fails before it
reaches AWS:

- **Two members.** Each origin group has exactly two members, both origins of
  the distribution, and different from each other. Group ids are unique and do
  not reuse an origin id. `Quantity` fields match their `Items`.
- **Status codes.** Only the codes CloudFront accepts: 400, 403, 404, 416, 429,
  500, 502, 503 and 504 (all nine accepted by a live distribution). Anything
  else, or an empty list, throws.
- **Read-only behaviors.** Any cache behavior, default or path, that targets an
  origin group may only allow `GET`, `HEAD` and `OPTIONS`. CloudFront never
  fails over a write, so a behavior allowing `POST`, `PUT`, `PATCH` or `DELETE`
  throws. Put write paths in their own behavior on a single origin.
- **Known targets.** Every cache behavior targets an existing origin or group.
- **Connection tuning.** `ConnectionAttempts` is a whole number 1-3 and
  `ConnectionTimeout` 1-10, on every origin.
- **Replica.** The replica's region differs from the primary's, and its name is
  a valid bucket name different from the primary's.

Values that are CloudFormation intrinsics (`Ref`, `Fn::Sub`) are skipped, since
they only resolve at deploy time.

CloudFront only fails over `OPTIONS` requests when `OPTIONS` is also a cached
method. The website-bucket and `infrastructure.cdn` default behaviors cache
`GET`, `HEAD` and `OPTIONS`.

## Failing over faster

By default CloudFront tries the primary for up to 30 seconds (3 connection
attempts of 10 seconds) before it fails over. Lower `connectionAttempts` and
`connectionTimeout` on the primary to shorten that; `1` and `3` bound it at 3
seconds. The same settings decide how quickly an origin outside a group returns
a 504.
