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
