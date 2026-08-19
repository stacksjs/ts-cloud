# Durable deployment queue

ts-cloud runs deployments and other long-lived mutations as persistent operations. An API request, signed source webhook, application-onboarding confirmation, or dashboard action can return immediately while a dashboard host worker claims and executes the job. Open **Operations → Deployment queue** at `/operations/queue` to inspect all work you are authorized to see.

## Operation lifecycle

Every operation moves through a deterministic state machine:

```text
queued → running → succeeded
                 → failed
                 → cancelled
                 → timed_out
```

Failed, cancelled, and timed-out work may return to `queued` only through an explicit retry whose error class is allow-listed and whose attempt limit is not exhausted. Each claim increments `attempt`. Priority and creation time determine claim order; the UI reports only a bounded count of jobs ahead instead of promising an exact start time.

The queue persists the operation, execution policy, current checkpoint, lease heartbeat, cancellation request, lock, retry availability, retention deadline, and ordered logs in the control-plane database. A dashboard restart therefore does not lose queued work. On startup, expired running leases are reconciled according to the operation's resume policy:

- `requeue` safely returns eligible work to the queue from its last checkpoint;
- `fail` records a recoverable failure and the last checkpoint so an operator can reconcile provider state before retrying;
- a cancellation already requested becomes a terminal cancellation.

## Concurrency and locking

Transactional claims prevent two workers from owning the same job. A leased resource lock also prevents deploy, rollback, restore, or another mutation from running concurrently against the same target.

Unified `release.activate` and `release.rollback` jobs use the same lock and checkpoints. They additionally persist traffic percentages and health observations in release history, verify the artifact/config identity before calling the provider driver, and bound automatic rollback to one preserved target attempt.

The persisted default limits are:

| Scope | Default | Meaning |
|---|---:|---|
| Project | 2 | Running operations in one project |
| Environment | 1 | Running operations in one environment |
| Provider | 2 | Running operations using one provider |
| Build | 1 | Operations occupying a build slot |

Blocked jobs remain queued and show `resource_lock`, `project_concurrency`, `environment_concurrency`, `provider_concurrency`, or `build_concurrency` as their reason. Limits may be changed from the dashboard, API, or CLI. Changing production limits requires organization-level automation management, an exact confirmation phrase, and emits an audit event.

The dashboard process has eight polling lanes by default. Set `TS_CLOUD_QUEUE_PARALLELISM` to change this process-level ceiling; persisted scope limits still apply within it.

## Logs and progress

Workers record `prepare`, `execute`, and `finalize` checkpoints and stream child-process stdout/stderr in bounded chunks. Each chunk receives a monotonically increasing sequence number. Secret-shaped values and configured secret environment values are redacted before persistence; oversized chunks are marked and truncated before they enter the database.

The deployment drawer provides structured steps and expandable raw logs. Its authenticated Server-Sent Events connection resumes with `Last-Event-ID`; sequence-based deduplication prevents a reconnect from rendering the same chunk twice. Clients that cannot keep an SSE connection open can poll the logs endpoint with `after=<last-sequence>`.

Log authorization is evaluated against the operation's resource, environment, project, or organization target. A connected API stream periodically rechecks token validity and closes after revocation.

## Cancellation, timeouts, and retries

- Cancelling `queued` work records a terminal cancellation before any provider call begins.
- Cancelling `running` work records the request and signals cooperative code. The built-in deployment worker terminates its child process.
- Provider steps declared non-cancellable are never reported as safely interrupted. Completion after a cancellation request records that reconciliation is required.
- A timeout aborts cooperative work and records `timed_out`; non-cancellable provider work is marked for reconciliation.
- Automatic and manual retries require an operation-specific allow-list such as `network`, `provider_throttled`, or `provider_unavailable`. Automatic retries use bounded exponential backoff and never exceed `maxAttempts`.

Do not retry an unknown destructive failure until provider state has been checked. The detail drawer shows the attempt limit, last checkpoint, terminal error, and reconciliation metadata needed for that decision.

## CLI

```bash
# Inspect the queue and one operation's sanitized logs
cloud ops:list --state running
cloud ops:show <operation-id> --after 0

# Cancel or retry within the operation's recorded policy
cloud ops:cancel <operation-id>
cloud ops:retry <operation-id> --class provider_unavailable --delay 5000

# Inspect and explicitly update persisted concurrency
cloud ops:concurrency
cloud ops:concurrency:set --project 4 --environment 2 --provider 3 --builds 2 \
  --confirm "update queue limits"

# Delete only terminal history whose retention deadline has elapsed
cloud ops:history:clear --before 2026-07-01T00:00:00Z
```

History cleanup cannot bypass retention. The optional `--before` value adds a stricter completion-time cutoff; it does not make newer records eligible.

## Automation API

The OpenAPI document at `/api/v1/openapi.json` describes the typed queue client and these endpoints:

| Endpoint | Capability | Purpose |
|---|---|---|
| `GET /api/v1/queue` | `deployments:read` at each target | List visible jobs, policy, blocking reason, and bounded position |
| `GET /api/v1/queue/settings` | `deployments:read` | Read effective concurrency |
| `PATCH /api/v1/queue/settings` | organization `automation:manage` | Change concurrency with `confirm: "update queue limits"` |
| `DELETE /api/v1/queue/history` | organization `automation:manage` | Clear retention-eligible history with `confirm: "clear completed"` |
| `GET /api/v1/operations/{id}/logs` | target `deployments:read` | Poll ordered logs after a numeric cursor |
| `GET /api/v1/operations/{id}/logs/stream` | target `deployments:read` | Resume SSE logs with `Last-Event-ID` |
| `POST /api/v1/operations/{id}/cancel` | target `deployments:cancel` | Cancel queued work or request running cancellation |
| `POST /api/v1/operations/{id}/retry` | target `deployments:create` | Retry an allowed error class with an optional delay |

Example resumable log polling:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $TS_CLOUD_API_TOKEN" \
  "$TS_CLOUD_API_URL/api/v1/operations/$OPERATION_ID/logs?after=$LAST_SEQUENCE"
```

## Retention and operator checklist

Normal deployment and onboarding jobs retain history for 90 days, pull-request preview jobs for 14 days, and generic queue jobs for 30 days unless their producer selects another policy. Before clearing history or manually retrying, confirm:

1. the operation is terminal and its retention deadline has elapsed;
2. the provider does not still have a change in progress;
3. the target lock and concurrency reason are understood;
4. the proposed retry class appears in the job's allow-list;
5. any `reconciliationRequired` result has been resolved.

See also [API and automation](/features/api-automation), [Git integrations](/features/git-integrations), and [Application onboarding](/features/application-onboarding).
