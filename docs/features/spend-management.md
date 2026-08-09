# Spend Management

Cloud bills are a trailing indicator. By the time a provider invoice shows a
runaway function loop, the money is gone; AWS Cost Explorer lags roughly a day,
and Hetzner and a local box have no billing API at all. So ts-cloud does not
wait for the bill. It meters usage as it happens, prices it locally, and can
stop work before spend continues.

Everything here works the same on AWS, Hetzner, and a local box.

## What it does

| Capability | Where |
|---|---|
| Soft and hard caps with a configurable enforcement ladder | `spend/evaluator.ts`, `spend/enforcement.ts` |
| Forecasting with an explicit confidence score | `spend/projection.ts` |
| Statistical anomaly detection on hourly spend | `spend/anomaly.ts` |
| A billing/usage API your agents can query | `GET /api/v1/usage` |
| Provider-neutral metering and pricing | `spend/meter.ts`, `spend/pricing.ts` |

For DDoS mitigation, rate limiting, WAF, and recursion protection, see
[Edge Protection](./edge-protection.md).

## Quick start

```sh
# See what a project is spending and how much headroom is left.
cloud usage

# Create a cap. It starts in dry run: it evaluates and reports, enforces nothing.
cloud budget:create --name 'Production monthly' --hard 500 --soft 400

# Watch it for a period, then let it enforce.
cloud budget:update <budgetId> --enforce
```

A budget created through the API or the dashboard also starts in dry run.
A budget created from the CLI enforces unless you pass `--dry-run`, because an
operator at a terminal has read the flags they typed.

## How costs are calculated

Three steps, and it matters that they are separate.

**1. Meter.** Telemetry the platform already collects — request counts, bytes
out, function durations, build durations, the on-box egress collector — is
mapped onto provider-neutral meters. `edge.egress_gb` is a gigabyte leaving the
edge whether that edge is CloudFront, a Hetzner NIC, or nginx on a laptop.

Signals reported as running totals (the on-box collector reports egress for the
month) are differenced before they are billed, so a scrape does not re-bill the
month. Counter resets from a reboot are treated as a fresh total rather than a
negative delta.

**2. Price.** A local price book turns quantity into cents. It supports free
allowances, graduated tiers, and per-provider and per-region rates. Rates are
stored in micro-cents because a CloudFront request costs about 0.0000075 cents,
which rounds to zero in any coarser unit — and a request meter that rounds to
zero makes request floods free.

Shipped rates are list prices, deliberately rounded up. They exist for
forecasting and capping, not invoicing: a cap that trips at 101% is a surprised
user, and not surprising people is the whole point.

**3. Roll up.** Usage is stored as hourly buckets per scope, meter, provider,
and region. Every applied delta leaves a receipt keyed by a deterministic id, so
replaying a telemetry batch — a retried collector POST, a resumed backfill —
adds nothing the second time.

::: tip Override the price book
Pass your own to `SpendStore`, or merge over the defaults with
`mergePriceBooks(DEFAULT_PRICE_BOOK, yourBook)`. An entry matching on exactly
`(meter, provider, region)` replaces the shipped one.
:::

### Meters

| Meter | Unit |
|---|---|
| `edge.requests` | requests |
| `edge.egress_gb` | GB |
| `function.invocations` | invocations |
| `function.gb_seconds` | GB-seconds |
| `build.minutes` | minutes |
| `compute.instance_hours` | hours |
| `storage.gb_hours` | GB-hours |
| `object.egress_gb` / `object.requests` | GB / requests |
| `database.gb_hours` / `database.io_requests` | GB-hours / requests |
| `telemetry.ingest_gb` | GB |
| `image.transformations` | count |

A meter with no matching price entry is still metered and reported as
`unpricedMeters`. It counts as zero against a budget, and the runner warns —
usage silently counting as free is exactly the failure a cap must not have.

## Budgets

A budget names a scope, a period, one or two limits, and a ladder.

```ts
import { SpendStore } from 'ts-cloud'

const budget = store.createBudget({
  organizationId,
  projectId,                  // omit for an organization-wide cap
  name: 'Production monthly',
  period: 'monthly',          // 'daily' | 'weekly' | 'monthly'
  timezone: 'America/Los_Angeles',
  softLimitCents: 40_000,     // warn only
  hardLimitCents: 50_000,     // enforces
  graceSeconds: 300,
  meters: ['edge.egress_gb'], // optional: cap one meter, not the whole project
  dryRun: true,
})
```

**Periods are timezone-aware.** A monthly cap that resets at UTC midnight
resets in the middle of a Californian afternoon and does not match the month on
the invoice. DST is handled: a spring-forward day is measured as 23 hours.
Weeks start Monday, so a working week is not split across two budgets.

**Money is integer cents throughout.** Floating-point dollars accumulate
rounding error across millions of records, and a cap off by a cent in the wrong
direction is a cap that does not fire.

**Overlapping budgets take the strictest outcome.** An organization cap cannot
be loosened by a permissive project budget, and an environment budget can
tighten it. An action is only lifted when no governing budget still wants it.

## The enforcement ladder

Thresholds map a percentage to actions. Percentages are measured against the
hard limit when one exists, so a ladder reads the same however the budget is
configured.

```ts
thresholds: [
  { atPercent: 50,  actions: ['notify'] },
  { atPercent: 80,  actions: ['notify'] },
  { atPercent: 100, actions: ['notify'], onProjection: true },
  { atPercent: 100, actions: ['notify', 'block_builds', 'block_deployments'] },
  { atPercent: 115, actions: ['notify', 'block_builds', 'block_deployments', 'throttle_requests'] },
]
```

That is the default. It warns early and twice, acts only at the limit, and puts
the forecast rung before the actual one — a project on track to blow its cap in
three days is far cheaper to fix than one that already has.

Actions, least to most disruptive:

| Action | Effect |
|---|---|
| `notify` | Send the configured spend notifications. |
| `block_builds` | Refuse new builds. Running builds finish. |
| `block_deployments` | Refuse new deployments. The running release keeps serving. |
| `throttle_requests` | Rate-limit inbound requests at the edge. |
| `suspend_functions` | Stop invoking functions; static and cached responses still serve. |
| `serve_static` | Serve the last built static output only. |
| `suspend_project` | Park inbound traffic behind a 503. |

**No action deletes anything.** The strongest rung parks traffic; it does not
drop a database, discard a build, or remove a resource. Every applied action
records what it needs to undo itself, because a cap that cannot be lifted is an
outage.

### Three things that make a cap usable

**Hysteresis.** A scope sitting exactly on the line would otherwise enforce and
release on every cycle, paging someone each time. An action is only lifted once
spend falls a configured margin (`hysteresisPercent`, 5% by default) below the
threshold that armed it.

**Grace.** A single spiky minute should not suspend production. A breach must
persist for `graceSeconds` before enforcement runs. Notifications still fire
immediately — a warning has no blast radius.

**Confidence.** Ten minutes into a month, a burn rate extrapolates to a number
that is arithmetically correct and meaningless. Every projection carries a
confidence from 0 to 1, built from elapsed time and the number of buckets that
actually carried spend. Below 0.35, a projection rung may notify but never
enforces.

### Approval on production

User-visible actions (`throttle_requests`, `suspend_functions`, `serve_static`,
`suspend_project`) are **withheld** on a production environment rather than
applied automatically. They appear in the cycle result as `withheld` with a
warning. Silently taking a customer's site off the air to save $20 is worse than
the bill.

```ts
planEnforcement(decision, { environmentKind: 'production' })
// or cap automatic disruption anywhere:
planEnforcement(decision, { maxAutomaticAction: 'block_builds' })
```

Lifting an action never requires approval. Restoring service is always safe.

## What "capped" means: the spend gate

Enforcement writes one durable record — the **gate** — into the control plane,
and the subsystems that spend money read it before acting.

```ts
import { assertSpendAllows, SpendGate } from 'ts-cloud'

const gate = new SpendGate(controlPlane)
assertSpendAllows(gate, 'deploy', { organizationId, projectId })  // throws SpendCapError (402)
```

This is deliberate. Applying a cap by mutating in-memory state quietly lifts
itself on the next restart, which is exactly when a runaway workload is least
supervised. Coupling each action to a driver means `block_builds` needs SSH to
mean anything, so a driver outage reads as "not capped". And state spread across
five subsystems gives "is this project capped?" five answers that drift.

The gate is the source of truth; a driver call is an additional, best-effort
effect on top of it. Applying always writes the gate **first**, so a transport
that times out still leaves the cap in force. Releasing restores the traffic
path first and opens the gate second, so nothing is admitted to an edge still
serving a 503.

`POST /api/v1/deployments` consults the gate and returns **402** with the
blocking action and budget id.

### Ghost entries

A gate entry whose budget was deleted or disabled would keep refusing
operations forever with nothing left in the UI to explain why. Every cycle
reconciles the gate against live budgets and drops orphans. `cloud
budget:delete` and the dashboard's delete both lift the gate before removing
the record.

## Anomaly detection

Mean plus three standard deviations does not survive real infrastructure data.
One genuine incident poisons the baseline for as long as it stays in the window,
so the detector goes quiet exactly when it matters; and a flat baseline fires
every weekday morning until everyone ignores it.

So the detector uses:

- **Median and MAD** (median absolute deviation) rather than mean and standard
  deviation. Unmoved by up to half the sample being garbage.
- **A per-phase seasonal baseline.** An hour is compared against the same hour
  on previous days, so a normal daily peak is not an anomaly. Use
  `seasonLength: 168` for signals with a weekday/weekend shape.
- **A warmup.** No history, no verdict.
- **An absolute floor.** A jump from $0.01 to $0.09 is 800% and worth nobody's
  pager. The cost preset ignores changes under 25 cents.

### The signals it runs on

Detection is not cost-only. Nine signals ship, sourced from usage rollups and
request telemetry:

| Signal | Source | An empty hour is | Min samples |
|---|---|---|---|
| `cost` | usage | zero | — |
| `edge.requests`, `edge.egress_gb`, `function.invocations` | usage | zero | — |
| `http.requests`, `http.errors` | telemetry | zero | — |
| `http.error_rate`, `http.client_error_rate` | telemetry | **ignored** | 20 |
| `http.latency_p95` | telemetry | **ignored** | 20 |

`cloud anomaly:config --signals` prints this table, `GET /api/v1/spend/signals`
returns it, and `DETECTABLE_SIGNALS` is the catalog behind both. `SignalSource`
builds each series if you need one directly.

`lookbackHoursForSignal` reports how far back a signal needs to look.

### Three rules that decide whether the data is any good

**A gap is not a zero, and which one it is depends on the signal.** For a count,
an hour with no data means "we served nothing" — zero is the truth. For a
*ratio*, an hour with no traffic has no error rate at all; filling it with 0%
drags the baseline toward zero, and the first ordinary hour then reads as a
spike. Ratios carry gaps through to the detector, which skips them.

**A ratio needs a denominator floor.** One failed request out of two is a 50%
error rate and means nothing. Below `minSamples` the point becomes a gap, and
the count of suppressed buckets is recorded on the anomaly — so "why did this
not fire" has an answer.

**A percentile needs enough samples to be a percentile.** A p95 over four
requests is the maximum wearing a hat.

Gaps are carried as non-finite values rather than omitted, because omitting them
would shift every later point into the wrong seasonal phase. A single one in the
history would otherwise make the median non-finite and silently disable
detection for that phase forever — a detector reporting nothing while looking
perfectly healthy.

### Lookback follows the season

Each signal looks back as far as its own seasonality needs:
`seasonLength × (minHistory + 1)`, floored at 14 days. A weekly signal needs
three weeks of history for three same-phase observations; a fixed 14-day window
would starve every one of them, and they would report nothing forever.

Only complete hours are judged — a partial hour always reads low.

### Per-route detection

Pass `routes: true` and detection also runs per route template, bounded to the
busiest few (at least 500 requests in the window). Only route-aware signals
take part: usage rollups are priced per meter, not per path, so narrowing one
to a route would produce the project-wide series recorded under that route's
name. A long tail of one-hit routes
produces noise rather than insight. Route anomalies are recorded as
`http.error_rate@/checkout`, so one route's spike cannot dedupe against
another's in the same hour.

```ts
detectLatestAnomaly(series, anomalyOptionsForSignal('cost'))
```

Each anomaly is recorded once per signal per hour bucket and notified once.

### Configuring it

Detection works with no configuration; configuring it is a refinement, not a
prerequisite. Per-scope configs tune what is watched and how sensitively, and
the most specific scope wins (environment, then project, then organization):

```sh
cloud anomaly:config --signal cost --sensitivity high --severity critical
cloud anomaly:config --signal edge.requests --season 168 --min-delta 5000
cloud anomaly:config --list
```

Sensitivity is `low` / `medium` / `high` rather than a raw z-score. Nobody
tuning an alert at 2am wants to reason about median absolute deviations, and a
number that means nothing to the person setting it gets set wrong.

### Silencing

A silence skips detection entirely — not "detect and hide". A known-noisy
pattern then costs nothing and never reaches the dashboard:

```sh
cloud anomaly:silence --route '/webhooks/**' --reason 'Provider retries in bursts'
cloud anomaly:silence --status 404 --reason 'Scanner noise' --until 2026-08-01T00:00:00Z
cloud anomaly:silence --list
```

A reason is required, because someone will later ask why this stopped alerting.
A matcher that would silence everything is refused: that is what disabling the
config is for, and a catch-all silence is indistinguishable from a broken
detector. An unbounded silence warns, since it will outlive the reason for it.

## The usage API

The interesting question is not what last month cost — a dashboard answers
that — but *"if I start this deploy, does it fit in what's left?"*

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.example.com/api/v1/usage?projectId=$PROJECT"
```

```json
{
  "window": { "start": "2026-07-01T00:00:00.000Z", "label": "July 2026" },
  "currency": "USD",
  "totalCents": 41500,
  "byMeter": [{ "meter": "edge.egress_gb", "provider": "aws", "quantity": 4882, "costCents": 41500 }],
  "budgets": [{
    "name": "Production monthly",
    "limitCents": 50000,
    "spentCents": 41500,
    "remainingCents": 8500,
    "usedPercent": 83,
    "projectedCents": 61000,
    "projectionConfidence": 0.87,
    "timeToCap": "2d 4h",
    "level": "warning"
  }],
  "enforcement": { "strongestAction": null, "active": [] }
}
```

Every budget carries `remainingCents`, `projectedCents`, `projectionConfidence`
and `timeToCap` — a caller deciding whether to proceed needs the forecast and
how much to trust it, not an invoice.

For a yes/no answer, ask directly:

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.example.com/api/v1/spend/allowance?operation=deploy&projectId=$PROJECT"
# { "operation": "deploy", "allowed": false, "blockedBy": "block_deployments", "reason": "..." }
```

### FOCUS export

For FinOps tools, the same data in the interchange format they already read:

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.example.com/api/v1/usage/focus?from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z"
```

FOCUS v1.3, newline-delimited JSON, daily grain by default (`granularity=hourly`
for our native one). Without this, every team wanting cost observability writes
a bespoke transformer against our column names, and that transformer breaks the
first time we add a meter.

Costs are reported in the currency's major unit, not cents. `BilledCost`,
`EffectiveCost`, and `ListCost` are the same number: no commitments are
modelled, and reporting a different effective cost would be a fabricated
discount. Ranges are capped at one year.

### Endpoints

| Method | Path | Capability |
|---|---|---|
| GET | `/api/v1/usage` | `billing:read` |
| GET | `/api/v1/usage/rollups` | `billing:read` |
| GET | `/api/v1/usage/focus` | `billing:read` |
| GET | `/api/v1/spend/budgets` | `billing:read` |
| POST | `/api/v1/spend/budgets` | `billing:manage` |
| PATCH / DELETE | `/api/v1/spend/budgets/{id}` | `billing:manage` |
| GET | `/api/v1/spend/anomalies` | `billing:read` |
| POST | `/api/v1/spend/anomalies/{id}/acknowledge` | `billing:manage` |
| GET | `/api/v1/spend/enforcement` | `billing:read` |
| GET | `/api/v1/spend/allowance` | `billing:read` |
| GET | `/api/v1/spend/signals` | `billing:read` |
| GET / POST | `/api/v1/spend/anomaly-configs` | `billing:read` / `billing:manage` |
| GET / POST | `/api/v1/spend/anomaly-silences` | `billing:read` / `billing:manage` |

`billing:read` and `billing:manage` are separate from every project capability:
someone who can deploy a service is not automatically someone who may see, or
raise, the cap that constrains them. `billing:read` is included in the viewer
role; `billing:manage` is not.

A project-scoped token asking for organization-wide usage sees only its own
project. `PATCH` accepts `expectedVersion` for optimistic concurrency and
returns 409 on a stale write.

## SDK

```ts
import { TsCloudClient } from 'ts-cloud'

const api = new TsCloudClient({ baseUrl, token })
const verdict = await api.allowance('deploy', { projectId })
if (!verdict.allowed) throw new Error(verdict.reason ?? 'A spend cap is blocking this deploy.')

await api.usage({ projectId })
await api.usageRollups({ from, to, meters: ['edge.egress_gb'] })
await api.budgets({ projectId })
await api.anomalies({ unacknowledged: true })
```

## Running the loop

`SpendService` is the composable layer — ingest, evaluate one budget, produce a
usage report — and `SpendRunner` is the scheduled composition around it. Use the
runner unless you need to drive the steps yourself.

```ts
import { SpendRunner, startSpendLoop } from 'ts-cloud'

const runner = new SpendRunner({
  controlPlane,
  store: spendStore,
  alerts: alertStore,        // reuses your existing channels and routes
  transport: myTransport,    // optional; needed only for traffic-affecting actions
})

const stop = startSpendLoop(runner, { intervalSeconds: 60 })
```

One cycle is: **ingest → evaluate → enforce → notify → detect anomalies →
prune**. Ingest is first because a decision made against last cycle's usage is a
decision made a minute late, and a minute is a lot of invocations. Prune is last
because it is the only step safe to skip if the process dies partway through.

Sixty seconds is the intended cadence: usage rolls up hourly, so a faster cycle
re-reads the same numbers, and a slower one widens the window in which a runaway
bills unchecked.

Every step is wrapped. A broken Slack webhook must not disable a spend cap, so a
notification failure is a warning on the result, not an aborted cycle. Cycles
never overlap — a slow cycle delays the next rather than double-applying.

### Where the loop runs

The dashboard server starts it automatically (disable with `spendLoop: false`,
and it is off under `NODE_ENV=test`). For a deployment with no dashboard, or to
run it as its own unit:

```sh
cloud spend:work                    # runs until stopped
cloud spend:work --interval 120
cloud spend:work --once             # a single cycle, then exit
```

### Running it in more than one process

Pass a `SpendLoopLease`. Both the dashboard and a `spend:work` worker on the
same box is the ordinary case, and without a lease each would evaluate every
budget every minute:

```ts
startSpendLoop(runner, { lease: new SpendLoopLease(controlPlane, { owner: `worker:${process.pid}` }) })
```

Most of the damage is already prevented downstream — the gate is idempotent on
(budget, action), live enforcement rows have a unique index, and notification
deliveries dedupe on their key. What the lease avoids is the duplicated *work*:
double the database traffic and double the provider calls enforcement makes, and
provider calls are rate-limited and sometimes billed.

It is an advisory lease with a TTL (120 seconds by default), not a distributed
lock. A process that dies holding one blocks the loop for at most that long,
which is the right trade: a stalled cap for a minute beats a lock nobody can
clear. Stopping the loop releases it immediately rather than waiting out the TTL.

### Enforcement transports

Actions that only need the gate (`notify`, `block_builds`, `block_deployments`)
work with no transport at all. The traffic-affecting ones need a driver, and two
ship:

```ts
import { AwsSpendTransport, ComputeSpendTransport, compositeSpendTransport } from 'ts-cloud'

const transport = compositeSpendTransport([
  new AwsSpendTransport({ lambda, functions: () => ['app-http', 'app-queue'] }),
  new ComputeSpendTransport({ host, exec: sshExec, units: () => ['acme-web'], ddos, renderDdos: renderDdosInstallScript }),
])
```

| Action | AWS | Compute box |
|---|---|---|
| `throttle_requests` | not supported | nftables limits re-rendered at a lower rate |
| `suspend_functions` | reserved concurrency set to 0 | `systemctl stop` the app units |
| `serve_static` | same lever; CloudFront and S3 keep serving | app units stop, the gateway keeps serving built files |
| `suspend_project` | `MAINTENANCE_MODE=1` (503 with a bypass header) | app units stop |

**Reserved concurrency, not deletion.** Setting a Lambda's reserved concurrency
to zero means triggers still fire, Lambda rejects the invocation, nothing runs,
and one call reverses it. Deleting the function loses its triggers; detaching
event source mappings is a multi-step change that is easy to half-restore.

**Every method returns what it takes to undo itself.** The AWS transport reads
the current reserved concurrency before overwriting it, because restoring to
"no limit" when there had been a limit of 50 quietly raises the account's
exposure after the cap lifts.

**The compute transport never stops `rpx-gateway.service`.** On a shared box
that gateway fronts every tenant, and taking it down to cap one project's spend
would be an outage for everyone else. It stops the project's own units and
records exactly which release instances it stopped, so the right code restarts.

**Request throttling is absent on AWS on purpose.** Rate limiting in front of
CloudFront needs AWS WAF, which ts-cloud does not provision. Reporting the
action as applied when nothing changed would be worse than not supporting it,
so the applier marks it `unsupported: true` instead.

`compositeSpendTransport` fans one action out to several legs. Every leg runs
even if an earlier one throws, and the first error is rethrown once all have
been attempted — stopping at the first failure would leave the others uncapped
with no record of it. A leg that failed to apply is skipped on release rather
than undone.

Without any transport, traffic-affecting actions still record in the gate and
are marked `unsupported: true` — visible and reversible, but honest that no
traffic changed. `RecordingSpendTransport` records calls instead of making them,
which is also what a dry-run preview uses.

## Notifications

Spend reuses the alert channels, routes, quiet hours, escalation, per-route rate
limits, and retrying delivery worker you already configured. Building a second
notification system for billing would mean configuring Slack twice.

Event types: `spend.threshold`, `spend.enforced`, `spend.released`,
`spend.anomaly`. Route them like any other event.

Channels are Slack, Discord, Teams, Telegram, email, webhook, and **SMS**. SMS
exists for the rung where enforcement starts: that is the one worth reaching a
phone for. Only the summary line is sent — an SMS is 160 characters and the
recipient is holding a phone, so the full payload stays in the other channels.

Messages lead with the money and the budget name, not the percentage — "83% of
Production" means nothing without the limit:

```
[CAP] Production monthly: $415.00 of $500.00 (83%). Enforcing block_builds, block_deployments.
```

Quiet hours suppress a threshold but never a release. Waking someone to say a
cap lifted is unnecessary; leaving them to believe a cap is still on is worse.

The idempotency key includes the window and the crossed threshold, so a budget
re-evaluated every minute produces one delivery per threshold per window.

::: info Organization-wide budgets
`alerts.project_id` is NOT NULL, so an organization-wide budget cannot own an
alert row. Spend notifications therefore create deliveries directly
(`notification_deliveries.alert_id` is nullable) rather than synthesizing an
alert. Otherwise the broadest and most important caps would silently never
notify.
:::

## CLI

```sh
cloud usage [--period monthly] [--timezone UTC] [--json]
cloud budget:list [--json]
cloud budget:create --name <name> [--soft 400] [--hard 500] [--period monthly]
                    [--scope project|environment|organization] [--actions notify,block_builds]
                    [--grace 300] [--timezone UTC] [--dry-run]
cloud budget:update <budgetId> [--soft|--hard <amount>] [--enforce|--dry-run] [--enable|--disable]
cloud budget:delete <budgetId>
cloud spend:check [--apply] [--json]
cloud spend:work [--interval 60] [--once]
cloud spend:status [--json]
cloud spend:release <budgetId> <action>
cloud spend:anomalies [--unacknowledged] [--json]
cloud anomaly:config [--signal cost] [--sensitivity low|medium|high] [--season 24]
                     [--min-delta 25] [--severity warning] [--enable|--disable] [--list] [--signals]
cloud anomaly:silence [--signal <signal>] [--route <glob>] [--status <code>]
                      --reason <reason> [--until <iso>] [--list] [--remove <id>]
```

Amounts are dollars (`--hard 500`, `--hard '$1,250.50'`). Use a `c` suffix for
exact cents (`--hard 49999c`).

`spend:check` previews by default and only enforces behind `--apply`.
`spend:release` warns that the next cycle re-applies the action unless the
underlying spend falls back — a manual release is a stopgap, not a resolution.

## Dashboard

**Operations → Spend & budgets**, visible to anyone with `billing:read`.
Four tabs: current usage and headroom, budget management, enforcement in force,
and anomalies. Mutations are gated on `billing:manage` server-side rather than
by hiding controls.

Budgets created here start in dry run, and the form says why.

## Retention

Hourly rollups are kept for 400 days by default, so year-over-year comparison
works. Ingest receipts are kept for 7 days — long enough to outlive any
plausible replay, and far shorter than the reporting retention the rollups
serve.

```ts
store.pruneUsage(400)   // { rollups, receipts }
```

## Known limits

- **Estimated, not billed.** Local prices are list prices. They will not match
  an invoice with reserved instances, savings plans, committed-use discounts, or
  negotiated rates. Override the price book to close the gap.
- **Hourly resolution.** A cap is evaluated against hourly rollups, so the
  worst-case window in which a runaway bills unchecked is about one hour of
  usage plus one cycle.
- **A cap cannot un-spend.** Enforcement stops future work. Money already spent
  in the window stays spent.
- **Traffic-affecting actions need a transport.** `AwsSpendTransport` and
  `ComputeSpendTransport` ship; without one configured, `block_builds` and
  `block_deployments` are still fully effective and the rest are recorded but
  inert.
- **No request throttling on AWS.** That needs AWS WAF, which ts-cloud does not
  provision. On a compute box the nftables path covers it.
- **Traffic signals need request telemetry.** `http.*` signals are sourced from
  request records; a deployment that does not emit them gets the usage-backed
  signals only, and says so by reporting an empty series rather than zeros.
