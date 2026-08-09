# Edge Protection

Three layers, none of which substitutes for another:

| Layer | Question it answers | Where |
|---|---|---|
| **L3/L4** | Is this a packet flood? | `protection/ddos.ts` |
| **L7 content** | Is this request an attack? | `protection/waf.ts` → [zig-waf](https://github.com/zig-utils/zig-waf) |
| **L7 volume** | Is this caller asking for too much? | `protection/ratelimit.ts` |

Plus [recursion protection](#recursion-protection) for functions, which is a
cost problem wearing a correctness disguise.

::: warning What this is not
ts-cloud has no anycast scrubbing network. A 500 Gbps flood saturates your
uplink before any of this runs, and pretending otherwise would be dishonest.
What is covered is the attack traffic that actually reaches most self-hosted
infrastructure: SYN floods, connection exhaustion, slow-loris, amplified UDP,
single-source hammering, and application-layer abuse.
:::

## L3/L4: kernel-level mitigation

**On by default.** Every provisioned box gets the nftables ruleset and the
sysctl hardening, and the WAF in detection-only mode, without opting in. A
protection you have to switch on protects only the people who already knew they
needed it, which is never the box that gets hit.

```ts
// cloud.config.ts - the escape hatches
infrastructure: {
  compute: {
    ddos: false,                                    // or { thresholds, allowlist, monitorOnly }
    waf: { mode: 'detection', paranoiaLevel: 1 },   // or false
  },
}
```

UFW decides which ports are open; this decides what happens to traffic arriving
on them. They layer rather than compete: the nftables hook sits at priority -150
with `policy accept`, so it runs before UFW's filter chain and drops floods
without overriding UFW's port policy.

The ruleset includes itself from `/etc/nftables.conf`, because applying a
ruleset is not the same as persisting it — without that the box comes back up
from a reboot unprotected and nothing says so.

Generated as configuration rather than executed directly — the same pattern as
`ufw.ts` and the image recipes — so a rule survives a reprovision instead of
living only in a live table the next boot discards.

```ts
import { renderDdosInstallScript } from 'ts-cloud'

const script = renderDdosInstallScript({
  ports: [80, 443],
  allowlist: ['10.0.0.0/8'],            // monitoring, office IPs, a load balancer
  thresholds: { newConnectionsPerSecond: 50, concurrentPerSource: 100 },
  monitorOnly: true,                     // count without dropping, to start
})
```

### Kernel tunables

`sysctlHardening()` emits a drop-in sysctl file. The important one is
`tcp_syncookies`: without it a SYN flood fills the backlog with half-open
connections and the box stops accepting anything, at a packet rate a single
host can produce. The rest bound how much memory an attacker can make the
kernel hold on their behalf, drop spoofed sources (`rp_filter` strict mode),
refuse source routing and redirects, and stop the box answering broadcast pings
(the smurf amplifier).

### nftables ruleset

`renderNftablesRuleset()` emits the table; `renderDdosInstallScript()` wraps it
with the sysctl file and the validation step below.

nftables rather than iptables: sets and rate meters are first-class, so
per-source limiting is one rule against a hash table instead of a chain that
grows with the attack. The generated table is deleted and recreated atomically,
which makes a redeploy idempotent rather than additive.

The ruleset, in order:

1. Accept established traffic — already paid for, never re-inspect it.
2. Drop invalid packets and nonsense TCP flag combinations (scanners, stack
   fingerprinting).
3. Allowlist bypass, then blocklist and the auto-populated ban set.
4. Rate-limit ICMP echo: ping stays usable, ping floods do not.
5. A platform-wide SYN ceiling, above which the kernel falls back to cookies.
6. **Per-source new-connection rate** — what stops one host hammering. Offenders
   are added to a `banned` set with a timeout, so a ban self-expires.
7. **Per-source concurrency ceiling** — the slow-loris defence.
8. Optionally, origin protection: drop traffic that skipped the CDN and came
   straight to the box.

Operator-supplied CIDRs are validated before they reach the file. An entry going
unvalidated into a file the kernel parses is both a syntax error that leaves the
box with no rules and an injection vector into the generated script.

The install script runs `nft -c` before applying. A ruleset with one bad line
would otherwise leave the box unprotected, and finding that out during an attack
is the worst possible time.

### Adaptive mitigation

Traffic volume alone is a bad trigger: a launch and an attack look identical on
a request-rate graph, and mitigating a launch is a self-inflicted outage. The
distinguishing signal is *shape*.

```ts
const plan = planMitigation({
  requestsPerSecond: 5000,
  baselineRequestsPerSecond: 100,
  errorRate: 0.4,
  uniqueSources: 200,
  topSourceShare: 0.5,
  concurrentConnections: 3000,
})
// { level: 'lockdown', rateLimitFactor: 0.1, challengeEnabled: true, staticOnly: true, ... }
```

Escalation needs volume **plus** at least one shape signal — concentration on
few sources, a high error rate, an inhuman per-source request rate, or missing
browser agents. Volume by itself only ever reaches `monitor`. A 50× surge spread
across 100,000 sources with a normal error rate is a viral moment, and the plan
says so.

Levels: `off` → `monitor` → `rate_limit` → `challenge` → `lockdown`, each with a
rate-limit multiplier and a list of reasons in plain language.

## L7 volume: rate limiting

Two algorithms, because they answer different questions.

**Token bucket** allows a burst then a steady rate — right for interactive
traffic, where a page load legitimately fires twenty requests at once and then
goes quiet. **Sliding window** counts precisely over a period — right for quotas
("10 login attempts an hour") where a burst is exactly what you want to stop.

```ts
import { defaultRateLimitRules, EdgeRateLimiter, rateLimitHeaders } from 'ts-cloud'

const limiter = new EdgeRateLimiter(defaultRateLimitRules())
const decision = limiter.check({ ip, method, path, host, headers, cookies })
if (!decision.allowed) return new Response('Too Many Requests', {
  status: 429,
  headers: rateLimitHeaders(decision),
})
```

::: info Why `EdgeRateLimiter`
The class is `RateLimiter` inside `protection/ratelimit.ts`, but `@ts-cloud/core`
already exports an unrelated concurrency `RateLimiter`, so the package root
re-exports this one as `EdgeRateLimiter`. The rule type is likewise
`EdgeRateLimitRule` at the root, and the WAF config type is `EdgeWafConfig`.
Import from `ts-cloud/protection` to get the unprefixed names.
:::

The shipped defaults are chosen to be invisible to a human and expensive for a
script: 600 requests a minute per IP overall (ten a second), 120 on `/api/**`,
and 10 POSTs a minute to `/auth/**` with a challenge rather than a hard deny.

### Rules

```ts
{
  id: 'api-ip',
  limit: 120,
  windowMs: 60_000,
  burst: 30,
  algorithm: 'token_bucket',        // or 'sliding_window'
  path: '/api/**',                  // `*` within a segment, `**` across
  methods: ['POST'],
  host: '*.example.com',
  key: { source: 'ip' },            // ip | header | cookie | path | host | global
  action: 'deny',                   // allow | log | throttle | challenge | deny
  priority: 50,
}
```

`action: 'log'` observes without blocking — the way to trial a rule in
production before it refuses anything.

A rule keyed on a header or cookie **falls back to the client IP** when the
value is absent. Without that, an attacker omits the header and becomes
unlimited, which is worse than having no rule.

### Overlapping rules

`check` runs in two phases: every matching rule is tested, and only if all have
room does anything get consumed.

The order matters. Consuming as you go charges a request to the global counter
even when a per-IP rule already refused it — so a single hammering client
silently burns the budget protecting everyone else, and the global limit then
fires against innocent traffic. Consuming *all* rules for an allowed request is
equally necessary: stop at the first match and the lower-priority counters never
advance, and those rules quietly stop working.

### Memory

Tracked keys are bounded (100,000 by default). A source IP per request is
exactly what a botnet produces, and an unbounded map turns a rate limiter into
an OOM. `sweep()` drops state for keys that have gone quiet.

Everything is in-memory and clock-injected. A limiter that consults a shared
store on every request adds a network hop to the hot path of the thing it is
protecting, which is how rate limiting becomes the outage.

## L7 content: WAF via zig-waf

ts-cloud does not implement request inspection itself.
[zig-waf](https://github.com/zig-utils/zig-waf) already is that engine — a
ModSecurity/Coraza-compatible SecLang implementation with OWASP CRS anomaly
scoring, native SQLi detection, and a `validate` subcommand. A second, worse
regex-based inspector living here would be a liability, not defence in depth.

zig-waf has no rate limiting at all, which is why `ratelimit.ts` stays
in-process. The two compose; neither replaces the other.

```ts
import { renderWafConfig, renderWafInstallScript } from 'ts-cloud'

const { config, warnings, unmappedRateLimits } = renderWafConfig({
  mode: 'detection',        // 'off' | 'detection' | 'blocking'
  paranoiaLevel: 1,
  inboundThreshold: 5,
  exclusions: [{ ruleId: 942100, pathPattern: '^/search', reason: 'Search queries look like SQLi.' }],
}, rateLimitRules)
```

::: warning zig-waf is pre-alpha
Its README says so. Generated configs therefore **default to detection-only**:
rules evaluate, matches are logged and scored, nothing is blocked. Turning that
into enforcement is a deliberate act by an operator who has read their own
detection log — `renderWafConfig` warns loudly when asked for `blocking`.
:::

**Paranoia level 1 is the only one safe unattended.** It is tuned for near-zero
false positives; levels 3 and 4 will block legitimate traffic on almost any real
application until tuned, and the generator says so.

**Oversized bodies are rejected by default.** An attacker who can opt out of
inspection by padding a request has defeated the WAF. Setting
`rejectOversizedBody: false` is allowed and produces a warning.

**Every bypass path is reported as a warning.** Each one is an unguarded route.

Rate-limit rules are translated into SecLang *markers* — SecLang has no counters,
so the tag is set there and the counting stays in `ratelimit.ts`. A rule that
cannot be expressed is returned in `unmappedRateLimits` with a reason rather
than silently dropped; a rate limit that quietly stops existing is exactly the
failure this module exists to prevent.

The install script runs `zig-waf validate` before swapping the config in, and
skips the reload entirely when the rendered bytes are unchanged.

WAF events feed back into telemetry as `waf.blocked` and `waf.matched`. Blocks
are a spend signal as much as a security one: a scraper the WAF stops still
consumed the bandwidth to be stopped. The client IP is deliberately kept out of
the metric stream — it is personal data, the audit log already has it for
incident response, and the metric only needs counts.

## Recursion protection

The failure this exists for is mundane and expensive: a function writes to a
bucket, the bucket notifies a function, and the two bill an unbounded number of
invocations in an afternoon. Nothing is broken — each individual call is
correct — so nothing alerts, and the first symptom is the invoice.

Detection propagates the call chain in request headers:

| Header | Meaning |
|---|---|
| `x-ts-cloud-invoke-depth` | Depth of the current invocation |
| `x-ts-cloud-invoke-chain` | Dot-separated short hashes of every function in the chain |
| `x-ts-cloud-trace-id` | Correlates every hop of one logical request |

**It is automatic and on by default.** The serverless runtime inspects every
inbound invocation and wraps `fetch` so outbound calls carry the chain. No
application change is needed - only a redeploy, because the protection ships
inside the function bundle.

```ts
// Nothing to write. To watch before it blocks, or to opt out:
createHttpHandler(app.fetch, { recursionProtection: { detectionOnly: true } })
createHttpHandler(app.fetch, { recursionProtection: false })
```

```sh
# The environment wins over config, so an incident needs no redeploy.
TS_CLOUD_RECURSION_PROTECTION=0
TS_CLOUD_RECURSION_DETECTION_ONLY=1
```

The guard is still exported for a runtime the adapter does not cover:

```ts
import { propagationHeaders, RecursionGuard, recursionBlockedResponse } from 'ts-cloud'

const guard = new RecursionGuard()
const verdict = guard.check({ functionId, headers: request.headers })
if (!verdict.allowed) return Response.json(recursionBlockedResponse(verdict).body, { status: 508 })
await fetch(url, { headers: { ...propagationHeaders(verdict) } })
```

A chain catches loops a depth counter misses: `A → B → A → B` never exceeds
"depth 2" if you only count consecutive self-calls, but the repeated entries are
plainly visible in the chain. `maxRepeats` is 3, not 1, because legitimate
fan-out patterns re-enter the same handler — a recursive directory walk, a
paginated crawl. Two repeats is a pattern; five is a loop.

The chain is trusted over the depth header: the chain is self-describing, and a
truncated or forged depth cannot make a long chain look short. The header is
bounded and sanitized on parse, since it is attacker-controllable.

Because headers can be stripped entirely, two backstops sit behind them: a
per-trace invocation budget (100 by default, within a 60-second window) and a
circuit breaker that opens after repeated loop detections and closes on
cooldown. A breaker-open refusal does not itself count toward the breaker, so it
cannot latch forever. A blocked call does not consume trace budget.

State is in-memory on purpose: a loop runs in seconds, so the state that matters
is seconds old, and paying a database round trip per invocation to protect
against a cost problem would be its own cost problem. Each instance protects its
own process; the header chain carries protection across processes.

The invocation context uses `AsyncLocalStorage`, so a runtime handling
concurrent invocations in one process cannot attribute one invocation's outbound
calls to another's chain — which is both wrong and exactly the case where a loop
is hardest to see.

**Coverage, stated plainly.** This covers `fetch`. A handler that reaches for
`node:http` directly, or opens a raw socket, is not covered; the depth header
still catches those when the receiving side is one of ours, but the chain does
not.

Blocked invocations return **508 Loop Detected**, as the RFC intends.

## Attack mode and mitigation controls

The levers for when the ordinary case is not what is happening:

```sh
cloud protect:status
cloud protect:attack-mode on --hours 2 --reason 'Credential stuffing from one ASN'
cloud protect:block 203.0.113.0/24
cloud protect:allow 10.0.0.0/8
cloud protect:pause on --reason 'Office proxy is being caught'   # you are billed for what this admits
cloud protect:apply                                              # print the ruleset it produces
```

**Both dangerous controls are time-boxed, in opposite directions.** Attack mode
challenges real users, so leaving it on is a slow outage; pausing mitigation
means paying for whatever arrives, so leaving that on is a slow invoice. Attack
mode defaults to 4 hours, pausing to 24, and neither can exceed 24. They lift
themselves, so nobody has to remember at 2am.

Attack mode does not tighten the numbers — it changes the *action*. A limit low
enough to stop an attack by counting would also stop a real user, whereas a
challenge lets a browser through and a script not. It still allows a small burst
so an API client is not broken on its first call.

Pausing switches the packet filter to counting rather than removing the rules,
so the counters stay useful for deciding whether it is safe to resume.

Allow wins over block: a CIDR cannot sit on both lists, because the ruleset
checks allow first and a surviving block entry would be dead while the UI
implied protection that was not there.

All of it is on the dashboard's **Firewall** page, gated on `security:read` to
look and `security:manage` to change.

## Composing the layers

A reasonable production posture:

Layers 1, 2, and 4 are already on after a deploy. What is left to compose is the
rate limiter, which runs in your request path:

```ts
// Kernel filtering, the WAF, and recursion protection: nothing to do.
// Rate limiting, scaled by live signals and the operator's controls:
const plan = planMitigation(signals)
const controls = new ProtectionControlStore(controlPlane).current()
const rules = applyControlsToRateLimits(
  defaultRateLimitRules().map(rule => ({ ...rule, limit: applyMitigationFactor(rule.limit, plan) })),
  controls,
)
const limiter = new EdgeRateLimiter(rules)
```

Rate limiting and recursion protection also reduce spend directly — see
[Spend Management](./spend-management.md), where `throttle_requests` uses the
same limiter and a spend cap can drive the mitigation factor.
