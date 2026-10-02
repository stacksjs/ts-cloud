# CloudFront origin failover

> **Experimental.** The templates follow the AWS documentation for
> `AWS::CloudFront::Distribution` origin groups and are covered by unit tests,
> but no live distribution has been deployed with them yet. Check the generated
> template before you rely on it in production.

Origin failover gives a CloudFront distribution a second origin to fall back on.
CloudFront sends every cache miss to the primary origin. When the primary returns
one of the configured status codes, refuses the connection (503) or times out
(504), CloudFront retries the same request against the secondary origin. See
[Optimize high availability with CloudFront origin failover](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html).

ts-cloud expresses this as a CloudFront **origin group**: the primary and
secondary origins, the status codes that trigger failover, and a default cache
behavior that targets the group instead of a single origin.

## Standalone CDN distributions

Add `failoverOrigin` to an entry in `infrastructure.cdn`:

```ts
export default {
  infrastructure: {
    cdn: {
      frontend: {
        origin: 'my-app-production-frontend.s3.us-east-1.amazonaws.com',
        // Experimental: a replica of the bucket in another region.
        failoverOrigin: 'my-app-production-frontend-replica.s3.us-west-2.amazonaws.com',
        // Optional. Defaults to [500, 502, 503, 504].
        failoverStatusCodes: [500, 502, 503, 504],
      },
    },
  },
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `failoverOrigin` | `string` | none | Domain CloudFront fails over to. An S3 REST endpoint becomes an S3 origin, any other host an HTTPS-only custom origin. |
| `failoverStatusCodes` | `number[]` | `[500, 502, 503, 504]` | Status codes from `origin` that trigger failover. |

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
this option existed.

ts-cloud does not replicate content to the secondary origin. Keep it in sync
yourself, for example with S3 cross-region replication.

## Self-hosted origins (`buildCloudFrontOriginConfig`)

For CloudFront in front of your own boxes (see
[CDN in front of a Hetzner origin](./cdn-hetzner-origin.md)), pass a second box:

```ts
import { buildCloudFrontOriginConfig } from '@stacksjs/ts-cloud'

const config = buildCloudFrontOriginConfig({
  aliases: ['example.com'],
  originDomain: 'origin.example.com',
  failoverOriginDomain: 'origin-dr.example.com', // experimental
  failoverStatusCodes: [502, 503, 504],
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

`CDN.createDistribution({ ..., failoverOrigin: { domainName, statusCodes? } })`
and `CDN.addOriginFailover(distribution, { domainName })` apply the same change to
a distribution built with the `CDN` module. The pure builders behind all three,
`buildOriginGroups`, `resolveFailoverStatusCodes` and
`assertOriginGroupMethods`, are exported from `@ts-cloud/core`.

## Rules ts-cloud enforces

These are checked when the template is generated, so a bad config fails before
it reaches CloudFormation:

- **Status codes.** Only the codes CloudFront accepts: 400, 403, 404, 416, 429,
  500, 502, 503 and 504. Anything else, or an empty list, throws.
- **Read-only behaviors.** A cache behavior that targets an origin group may only
  allow `GET`, `HEAD` and `OPTIONS`. CloudFront never fails over a write, so
  `CDN.addOriginFailover` throws on a behavior that allows `POST`, `PUT`,
  `PATCH` or `DELETE`. Put write paths in their own behavior on a single origin.
- **Two distinct origins.** The secondary must differ from the primary, and
  `failoverStatusCodes` without `failoverOrigin` is an error rather than a
  silent no-op.

CloudFront only fails over `OPTIONS` requests when `OPTIONS` is also a cached
method. ts-cloud's static default behavior caches `GET`, `HEAD` and `OPTIONS`.

## Failing over faster

By default CloudFront tries the primary for up to 30 seconds (3 connection
attempts of 10 seconds) before it fails over. ts-cloud does not tune
`ConnectionAttempts` or `ConnectionTimeout` on the generated origins yet.
