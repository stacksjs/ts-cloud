# Cloudflare

ts-cloud manages Cloudflare as a first-class provider: DNS records, the proxy
CDN in front of a self-hosted box, zone settings, cache rules, origin lockdown
and cache purge — all reconciled as part of `cloud deploy`.

The topology is **`viewer → Cloudflare edge → your box (rpx gateway)`**, the
Cloudflare counterpart to [CDN in front of a Hetzner
origin](./cdn-hetzner-origin.md).

## How Cloudflare differs from CloudFront

Worth reading once, because it changes what the config means.

CloudFront is a distribution you point at an origin **hostname**, and that
hostname can't be one of the distribution's own aliases — it would resolve back
to CloudFront and loop. That's why the CloudFront topology needs a dedicated
`origin.example.com`.

Cloudflare's CDN **is the DNS record**. A proxied ("orange cloud") `A` record
publishes a Cloudflare anycast address to the world, and Cloudflare forwards to
the address stored inside the record. Two consequences:

- **No origin hostname is needed**, and adding one is actively worse: it would
  be a publicly resolvable name pointing straight at the box — a documented way
  around the edge. `cloud deploy` warns if you set `originDomain` here.
- **The CDN and the DNS record can't drift apart**, because they're one object.
  This is why proxy state is *preserved* across upserts rather than re-derived
  (see [Proxy state is sticky](#proxy-state-is-sticky)).

## API token

Create a **custom token** at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens).
Scope it to the single zone you're deploying:

| Permission | Level | Needed for |
| --- | --- | --- |
| Zone → **DNS** → Edit | Zone | Creating/updating the proxied A/AAAA records |
| Zone → **Zone** → Read | Zone | Resolving the zone and reading its settings |
| Zone → **Zone Settings** → Edit | Zone | SSL mode, HSTS, Brotli, HTTP/3, min TLS |
| Zone → **Cache Purge** → Purge | Zone | Purging the edge cache after a deploy |
| Zone → **Cache Rules** → Edit | Zone | Per-extension edge/browser TTLs |
| Zone → **Transform Rules** → Edit | Zone | The origin-guard header (only if `secret` is set) |

Zone Resources: **Include → Specific zone → `<your domain>`**.

Then set the environment:

```bash
CLOUDFLARE_API_TOKEN=<token>
CLOUDFLARE_ZONE_ID=<zone id, from the zone's Overview page>
```

`CLOUDFLARE_ZONE_ID` is optional but strongly recommended, and it is what makes a
**single-zone token** work. Without it, ts-cloud has to find the zone through
`GET /zones?name=…` — an *account-level* listing that a zone-scoped token cannot
read. It returns an empty list, which is indistinguishable from "that domain
isn't in this account", so the failure reads as a missing zone rather than a
missing permission. Supplying the id also fixes record naming for multi-label
suffixes like `example.co.uk`, which the last-two-labels fallback gets wrong.

## Config

```ts
// cloud.config.ts
export default {
  infrastructure: {
    dns: {
      provider: 'cloudflare',
      domain: 'example.com',
    },
    compute: {
      mode: 'server',
      proxy: {
        engine: 'rpx',
        onDemandTls: true,
        onDemandTlsEmail: 'ops@example.com',
        cdn: {
          provider: 'cloudflare',
          frontedHosts: ['example.com', 'www.example.com'],
          // secret: process.env.ORIGIN_SECRET,  // see Origin lockdown
          cloudflare: {
            // zoneId: '…',                      // or CLOUDFLARE_ZONE_ID
            settings: {
              ssl: 'strict',
              alwaysUseHttps: true,
              minTlsVersion: '1.2',
              brotli: true,
              http3: true,
              hsts: { enabled: true, maxAge: 31536000, includeSubdomains: true },
            },
            cache: {
              assetEdgeTtl: 2592000,     // 30d for fingerprinted build output
              documentEdgeTtl: 3600,     // 1h for HTML
            },
          },
        },
      },
    },
  },
}
```

`frontedHosts` defaults to every hostname the gateway answers for, so it can be
omitted for the common case.

## What a deploy does

Ordered, and the order matters:

1. **Address records** — `A`/`AAAA` for each site domain, pointed at the box.
2. **Certificate renewal** — rpx/tlsx issues or renews the origin certificate.
3. **CDN reconcile** — proxy the records, apply zone settings, write cache
   rules, apply the origin guard, purge the edge.

### Why the CDN step runs last

There's a real chicken-and-egg here, and getting it wrong strands a site with no
certificate:

- the box issues its certificate with an ACME **HTTP-01** challenge, which needs
  the hostname to reach the box directly on `:80`;
- proxying the record makes the hostname resolve to **Cloudflare** instead, and
  with `Always Use HTTPS` the challenge is redirected to `:443`, where the box
  has no certificate yet. The handshake fails, the challenge fails, and the
  certificate is never issued.

So before proxying a host, ts-cloud **probes the origin**: it connects to the
box by address with the public hostname as SNI — exactly the connection
Cloudflare will make — and only proxies if the origin presents a certificate
that is valid for that name and chains to a public root.

If it doesn't, the record is published **DNS-only**, the deploy says so, and the
next deploy proxies it once the certificate exists. On a fresh zone this
resolves itself within a single deploy: records go up grey, step 2 issues the
certificate, step 3 finds it and flips them orange.

Set `cloudflare.skipOriginProbe: true` to skip the check when you know the
certificate is already in place.

## Proxy state is sticky

Cloudflare's record update is a **full PUT**, and its default for `proxied` is
`false`. Since every deploy re-upserts the box's address records, a naive
implementation would grey-cloud a proxied site on the very next deploy —
silently, because the record still resolves and the site still loads. You'd just
quietly lose the CDN and publish the origin IP.

So an upsert that says nothing about proxying **preserves whatever state the
record already has**. Pass `proxied` explicitly to change it, or set
`cloudflare.proxied: false` to keep a zone DNS-only.

## SSL mode

`ssl: 'strict'` (Full (strict)) is the default and the right answer: the box
holds a real Let's Encrypt certificate, so there's no reason to accept an
unverified origin.

- `full` accepts *any* certificate on the origin hop, including self-signed.
- `flexible` sends **plaintext** to the origin. Against an rpx gateway that
  redirects HTTP to HTTPS it also produces a redirect loop.

## Cache rules

The generated rules are scoped to the fronted hosts — a zone may serve names
that have nothing to do with this deploy, and an unscoped catch-all would start
caching someone else's dynamic responses. In order:

1. **bypass** — any `bypassPaths` prefixes, uncached.
2. **fingerprinted assets** — `.js`, `.css`, images, fonts, `.wasm` and friends:
   30d edge / 1y browser by default. Their URLs contain a content hash, so the
   bytes at a URL never change.
3. **documents** — everything else (HTML): 1h edge, browser revalidates. HTML
   carries the references to the fingerprinted files, so caching it as long
   would pin visitors to a stale deploy.

Rules ts-cloud writes are tagged `[ts-cloud]` in their description. Cloudflare
only offers a whole-list `PUT` for a phase entrypoint, so anything you add in the
dashboard would otherwise be deleted on the next deploy; the tag lets a reconcile
rewrite only its own rules and carry yours through untouched.

The edge cache is purged for the fronted hosts at the end of each deploy
(`cloudflare.purgeOnDeploy: false` to disable).

## Origin lockdown

Cloudflare's proxy hides the origin IP but doesn't prevent someone who discovers
it from connecting directly. Set `secret` and ts-cloud writes a Cloudflare
request-header transform rule that stamps the secret on every request forwarded
to the box, while rpx rejects any request to the fronted hosts that arrives
without it.

```ts
cdn: {
  provider: 'cloudflare',
  secret: process.env.ORIGIN_SECRET,
  secretHeader: 'X-Origin-Verify',   // default
}
```

ACME HTTP-01 paths stay exempt so renewal keeps working.

::: warning One secret per box
rpx enforces a single header/value pair for the whole gateway, so co-tenants on a
shared box (`cloud.attachTo`) cannot each bring their own secret. If a second
tenant declares a different one, its hosts are left **unguarded** rather than
being guarded with the wrong value — which would reject every request and take a
working host down. The mismatch is logged by the gateway assembler.
:::

## Declaring records (mail, verification, third-party)

A deploy can derive the address records for your sites, but not the rest of the
zone — mail, domain-verification tokens, third-party CNAMEs. Those are exactly
the records that vanish in a nameserver migration and are not noticed until
someone reports that mail stopped, because nothing in a normal deploy reads or
writes them.

Declare them and every deploy publishes them:

```ts
infrastructure: {
  dns: {
    provider: 'cloudflare',
    domain: 'example.com',
    records: [
      { type: 'MX',    name: '@',             content: 'example-com.mail.protection.outlook.com', priority: 0 },
      { type: 'TXT',   name: '@',             content: 'v=spf1 include:spf.protection.outlook.com ~all' },
      { type: 'TXT',   name: '_dmarc',        content: 'v=DMARC1; p=none' },
      { type: 'CNAME', name: 'autodiscover',  content: 'autodiscover.outlook.com' },
    ],
  },
}
```

`name` accepts `'@'` (or omission) for the apex, a bare label, or an FQDN.
Records default to **DNS-only** — mail records cannot be proxied at all, and a
proxied `autodiscover` CNAME resolves to Cloudflare instead of Microsoft and
breaks client auto-configuration.

### How records are matched

Reconciliation is **upsert-only** — ts-cloud never deletes a record it was not
asked to manage, because a real zone holds records owned by other tools and
people. What counts as "the same record" depends on the type:

- **A, AAAA, CNAME** — one value per name in practice, so an existing record with
  that name and type is updated in place.
- **MX, SRV, CAA, NS** — legitimately multi-valued, so a record is matched on its
  value and only created when that exact value is absent. An undeclared value at
  the same name is **reported, not removed**: a leftover MX from a previous
  provider splits mail delivery and you need to see it, but silently deleting
  someone else's record is the worse outcome.
- **TXT** — multi-valued in general, so verification tokens sit beside each other
  untouched. The exception is a **policy record**: two `v=spf1` records are not
  two policies but a permerror, and receivers conclude the domain has no usable
  SPF at all, so mail that used to pass starts failing. Two `v=DMARC1` records
  are likewise ignored wholesale. A TXT opening with a policy tag therefore
  *replaces* the record carrying the same tag, and the old one is removed before
  the new one is written — briefly having no SPF evaluates as neutral, whereas
  briefly having two is a hard failure.

## DNS-only zones

Cloudflare works as a plain DNS provider with no CDN at all — set
`infrastructure.dns.provider: 'cloudflare'` and omit the `cdn` block. Records are
then created unproxied and no zone settings, cache rules or purges are applied.

## R2 buckets

ts-cloud can provision [Cloudflare R2](https://developers.cloudflare.com/r2/)
buckets on every `cloud deploy`: the bucket itself, its CORS policy, lifecycle
rules, the public `r2.dev` URL, custom domains, and an edge cache rule for those
domains. R2 is independent of AWS and of the CDN block above; a project can use
it with any `cloud` provider.

```ts
// cloud.config.ts (or config/cloud.ts in a Stacks app)
export default {
  infrastructure: {
    r2: {
      buckets: {
        tiles: {
          name: 'my-app-tiles',
          locationHint: 'wnam',               // wnam | enam | weur | eeur | apac | oc
          customDomains: [
            'tiles.example.com',              // minTLS defaults to 1.2
            { domain: 'img.example.com', minTLS: '1.3' },
          ],
          cors: [
            {
              allowed: { origins: ['https://example.com'], methods: ['GET', 'HEAD'] },
              exposeHeaders: ['ETag'],
              maxAgeSeconds: 3600,
            },
          ],
          lifecycle: [
            { id: 'expire-tmp', prefix: 'tmp/', expireAfterDays: 7 },
            { id: 'abort-uploads', abortMultipartUploadsAfterDays: 1 },
          ],
          publicDevUrl: false,                // the rate-limited *.r2.dev URL; off by default
          cache: { edgeTtl: 86_400, browserTtl: 3_600 },
        },
      },
    },
  },
}
```

Credentials come from the same environment variables as the rest of the
Cloudflare integration:

| Variable | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Needs **Workers R2 Storage: Edit**. Custom domains also need **Zone: Read** on their zones, and `cache` needs **Zone: Cache Rules: Edit**. An account-owned token works. |
| `CLOUDFLARE_ACCOUNT_ID` | The account the buckets live in. Required. |
| `CLOUDFLARE_ZONE_ID` | Optional. Used for custom domains inside that zone; other domains have their zone looked up by apex. |

If the `r2` block is present but the token or account id is missing, the deploy
warns and skips R2 rather than failing.

### What a deploy does

For each bucket, in order, reading first and writing only what differs:

1. **Bucket.** Created when missing, with `locationHint` (and `jurisdiction`,
   for `eu` or `fedramp` buckets). Both only apply at creation; R2 cannot move a
   bucket afterwards.
2. **CORS.** Omit `cors` to leave the bucket's policy alone; `cors: []` removes
   it. Rules use Cloudflare's own shape, so they can be pasted from its docs.
3. **Lifecycle.** Each rule is flattened (`expireAfterDays`, `expireOn`,
   `abortMultipartUploadsAfterDays`, `infrequentAccessAfterDays`) and converted
   to R2's transition format. A declared list **replaces** the bucket's rules,
   including the multipart-abort rule R2 adds to new buckets, so re-declare that
   one if you want to keep it.
4. **`r2.dev` URL.** Turned on or off to match `publicDevUrl`.
5. **Custom domains.** Attached with `enabled: true` and the requested minimum
   TLS. Cloudflare creates the proxied DNS record itself, so the hostname must
   not already have a record; if it does, the attach fails with a warning and
   the rest of the deploy continues. A new domain shows as `pending` until
   Cloudflare has validated ownership and issued the edge certificate.
6. **Cache rule.** `cache` becomes one `set_cache_settings` rule scoped to the
   bucket's custom domains, tagged `[ts-cloud]` and merged into the zone's
   cache rules the same way the CDN's are (see [Cache rules](#cache-rules)).
   Rules you added in the dashboard are kept.

Nothing is ever deleted: removing a bucket or a custom domain from the config
leaves it in place. Detach or delete it in the dashboard when you mean it.

`cloud deploy --dry-run` runs the same reads and lists what would change
(`would create bucket`, `would attach custom domain tiles.example.com`, ...)
without writing anything.

The R2 step runs before the application is deployed, because the release may
depend on the buckets. A bucket that cannot be created stops the deploy. So does
an account where R2 has never been switched on: Cloudflare answers every R2 call
with error `10042` until R2 is enabled once in the dashboard (**R2 Object
Storage**), and ts-cloud reports that as an `R2NotEnabledError` saying exactly
that.

### Using R2 from code

Everything is exported from the package root:

```ts
import { R2Provider, r2S3Credentials, reconcileR2Buckets } from '@stacksjs/ts-cloud'

// Reconcile outside `cloud deploy` (this is what Stacks' buddy deploy calls).
const summary = await reconcileR2Buckets(config, {
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  zoneId: process.env.CLOUDFLARE_ZONE_ID,
  log: line => console.log(line),
})
// { buckets: [{ name, changes: string[], domains: [{ domain, status }] }], warnings: string[] }

// S3-compatible keys for the app, derived from the same API token.
const { accessKeyId, secretAccessKey, endpoint, region } = await r2S3Credentials({
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
})
```

`r2S3Credentials` follows Cloudflare's documented mapping: the access key id is
the token's id (read from `/accounts/{id}/tokens/verify`, falling back to
`/user/tokens/verify` for a user-owned token) and the secret is the lowercase
hex SHA-256 of the token value. The endpoint is
`https://{accountId}.r2.cloudflarestorage.com` and the region is `auto`.

## Workers

ts-cloud can deploy [Cloudflare Workers](https://developers.cloudflare.com/workers/)
on every `cloud deploy`: it bundles each Worker's entry with `Bun.build`,
uploads it as an ES module Worker with its bindings, and attaches its custom
domains. Like R2, Workers are independent of AWS and of the CDN block, and run
with any `cloud` provider.

```ts
// cloud.config.ts (or config/cloud.ts in a Stacks app)
export default {
  infrastructure: {
    r2: {
      buckets: {
        tiles: { name: 'my-app-tiles', locationHint: 'wnam' },
      },
    },
    workers: {
      tiles: {
        name: 'my-app-tiles',                 // the script name in Cloudflare
        entry: 'workers/tiles.ts',            // relative to the project root
        compatibilityDate: '2025-09-01',      // the default when omitted
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          r2Buckets: { TILES: 'my-app-tiles' }, // env.TILES is the bucket
          vars: { CACHE_SECONDS: '86400' },     // env.CACHE_SECONDS, plain text
        },
        customDomains: ['tiles.example.com'],
      },
    },
  },
}
```

```ts
// workers/tiles.ts
interface Env {
  TILES: R2Bucket
  CACHE_SECONDS: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const object = await env.TILES.get(new URL(request.url).pathname.slice(1))
    if (!object)
      return new Response('Not found', { status: 404 })
    return new Response(object.body, {
      headers: { 'Cache-Control': `public, max-age=${env.CACHE_SECONDS}` },
    })
  },
}
```

The token needs **Account → Workers Scripts → Edit**. Custom domains also need
**Zone → Workers Routes → Edit** and **Zone → Zone → Read** on their zones;
reading **Zone → DNS** and **Workers R2 Storage** lets the deploy explain a
conflicting hostname precisely (see below). `CLOUDFLARE_ACCOUNT_ID` is
required, `CLOUDFLARE_ZONE_ID` is used the same way as for R2. When Cloudflare
answers with a bare "Authentication error", the deploy reports which of these
permissions the call needed.

### What a deploy does

For each Worker, in order:

1. **Bundle.** The entry is built into one minified ES module
   (`target: 'browser'`, `format: 'esm'`; `cloudflare:*` imports stay external
   for the runtime). A build that fails, or that emits more than one file (an
   imported image or `.wasm`), stops the deploy with the reason.
2. **Upload, when changed.** The upload carries a plain-text binding,
   `TS_CLOUD_CONTENT_HASH`, holding a SHA-256 over the bundle, the bindings
   and the compatibility settings. Cloudflare returns plain-text bindings from
   the script's settings, so the next deploy compares hashes and reports
   `unchanged` instead of re-uploading. A binding edited in the dashboard since
   also triggers an upload, putting it back. The Worker itself can read
   `env.TS_CLOUD_CONTENT_HASH` to tell which build is live. Secrets set with
   `wrangler secret put` or in the dashboard are kept across uploads.
3. **Custom domains.** Each hostname not already attached to this Worker is
   attached as a [Workers Custom
   Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/);
   Cloudflare creates the DNS record and certificate, so a new domain shows as
   `pending` for a minute or two.

A hostname something else already serves is **never taken over**. The deploy
warns and leaves it alone when the hostname:

- is attached to an R2 bucket as a custom domain (on the account, or in the
  same config's `r2` block). Detach it from the bucket first; to serve the
  bucket through the Worker, bind it with `bindings.r2Buckets` as above.
- is attached to a different Worker. Detach it there first.
- has an existing DNS record. Delete the record first.

Nothing is deleted either: removing a Worker or a custom domain from the config
leaves it in place.

`cloud deploy --dry-run` bundles each Worker and reports `would upload` and
`would attach custom domain tiles.example.com` without writing anything. The
Workers step runs right after R2, before the application is deployed.

### Using Workers from code

```ts
import { bundleWorker, reconcileCloudflareWorkers, WorkersProvider } from '@stacksjs/ts-cloud'

// Reconcile outside `cloud deploy` (this is what Stacks' buddy deploy calls).
const summary = await reconcileCloudflareWorkers(config, {
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  zoneId: process.env.CLOUDFLARE_ZONE_ID,
  projectRoot: process.cwd(),
  log: line => console.log(line),
})
// { workers: [{ name, changes: ['bundled 4.2 KB', 'uploaded', ...], domains: [{ domain, status }] }], warnings: string[] }
```
