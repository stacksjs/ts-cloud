# CDN in front of a self-hosted (Hetzner) origin

This is the hybrid topology ts-cloud uses to move sites off AWS S3/EC2 while
keeping a CloudFront CDN in front: **`viewer → CloudFront → your box (rpx gateway)`**.
The box serves everything (app + static) via path routing; CloudFront adds edge
caching and keeps the public TLS/alias surface unchanged.

It exists because the same building blocks (`rpx`, `tlsx`, ts-cloud generators)
make each piece a config value instead of a manual console session.

## Why a dedicated origin hostname

A CloudFront **custom origin** must be a DNS hostname, and it **cannot** be one
of the distribution's own aliases:

- A bare IP isn't allowed as a custom origin.
- If the origin were `example.com` (an alias), CloudFront would resolve
  `example.com` → itself → an infinite loop.

With S3/EC2 origins you never saw this because AWS gave each service its own
hostname (`*.s3.amazonaws.com`, `ec2-….compute-1.amazonaws.com`). A self-hosted
box has none, so you point a dedicated record at it:

```
origin.example.com  A  <box-ip>
```

CloudFront connects to `origin.example.com` but **forwards `Host: example.com`**
(via the managed `AllViewer` origin-request policy), so the gateway still routes
by the public host. `origin.example.com` is invisible plumbing — no visitor sees it.

## Origin lockdown

Because `origin.example.com` is publicly resolvable, a client could hit the box
directly and bypass the CDN. Set a secret and the CDN injects it as a header on
the origin hop; the gateway rejects fronted-host requests that lack it
(`rpx` `createOriginGuard`). ACME HTTP-01 paths stay exempt so renewal works.

## Config

```ts
// config/cloud.ts
export default {
  // ...
  infrastructure: {
    compute: {
      proxy: {
        engine: 'rpx',
        certsDir: '/etc/rpx/certs',
        cdn: {
          originDomain: 'origin.example.com',     // A record → box; NOT an alias
          frontedHosts: ['example.com', 'www.example.com', 'origin.example.com'],
          secret: process.env.ORIGIN_SECRET,       // omit to leave the origin open
        },
      },
    },
  },
  sites: {
    main:   { domain: 'example.com', deploy: 'server', path: '/api', port: 3000, start: '…' },
    docs:   { domain: 'example.com', deploy: 'server', path: '/docs', root: 'dist/docs' },
    public: { domain: 'example.com', deploy: 'server', path: '/',     root: 'dist/public' },
  },
}
```

`buildRpxConfig` turns `sites` + `proxy.cdn` into the gateway config — path
routes plus an `originGuard` that `startProxies` enforces.

## The AWS side

`buildCloudFrontOriginConfig` produces a complete, correct `DistributionConfig`
for `CreateDistribution`/`UpdateDistribution`, baking in the settings that are
easy to get wrong:

```ts
import { buildCloudFrontOriginConfig } from '@stacksjs/ts-cloud'

const config = buildCloudFrontOriginConfig({
  aliases: ['example.com', 'www.example.com'],
  originDomain: 'origin.example.com',
  viewerCertificateArn: 'arn:aws:acm:us-east-1:…:certificate/…',
  behaviors: [
    { pathPattern: '/api/*', kind: 'dynamic' },  // CachingDisabled + all methods
    { pathPattern: '/docs',  kind: 'static' },    // CachingOptimized
    { pathPattern: '/docs/*', kind: 'static' },
  ],
  originSecret: process.env.ORIGIN_SECRET,        // → X-Origin-Verify header
})
```

What it guarantees (each a real bug seen in the wild):

| Setting | Why |
|---|---|
| One HTTPS-only custom origin | The box; no S3/EC2 origins |
| `AllViewer` origin-request policy | Forwards `Host` so the box routes by alias |
| `DefaultRootObject: ''` | `index.html` → gateway clean-URL `301 → /` **loop** |
| No Functions / Lambda@Edge | S3-era URL rewriters fight the gateway → `301` loops |
| `/api/*` → `CachingDisabled` + all methods | Dynamic app traffic isn't cached |
| `X-Origin-Verify` custom header | Pairs with the gateway's origin lockdown |

> After repointing an existing distribution's origin, **invalidate `/*`** —
> objects cached from the old origin (including cached redirects) otherwise persist.

## Cert renewal on the box

The origin host needs a TLS cert for the CloudFront→box hop. Issue and renew it
with `tlsx` against the gateway's own webroot — no extra listener:

```sh
tlsx acme:renew --dir /etc/rpx/certs --method http-01 \
  --webroot /var/www/acme-challenge --days 30 --prod
```

Run it from a daily systemd timer; it reloads the gateway only when a cert
changes. Hosts behind the CDN use AWS-managed ACM (auto-renewed); only the
box-direct hosts (origin + any non-CDN apps) need this.
