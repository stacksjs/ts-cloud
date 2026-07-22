# API and automation

ts-cloud exposes a versioned HTTP API at `/api/v1` for CI systems and external automation. The dashboard's **API & automation** page creates service accounts and one-time-revealed bearer tokens. Raw token values are never stored or shown again.

## Safety model

Every request must pass three independent checks:

1. the service-account organization membership and maximum role/scope;
2. the token's explicit capability list and equal-or-narrower resource scope;
3. the route's required capability for the requested resource.

Service accounts cannot be organization owners or create browser sessions. Disabling an account revokes its membership and all tokens. Revoked and expired tokens stop new requests and authenticated event streams immediately.

Use short expiries. During rotation, deploy the newly revealed token while the prior token remains active, verify the new client, then revoke the prior token. Audit events record creation, first/hourly use, rotation, revocation, and account disable without recording credentials.

## Contract and compatibility

The OpenAPI 3.1 document is available at `/api/v1/openapi.json`. Additive fields and endpoints may be added within v1. Breaking request or response changes require a new URL version. Internal dashboard endpoints are intentionally outside this compatibility promise.

Every JSON response includes `X-Request-Id`. Errors use:

```json
{
  "error": {
    "code": "forbidden",
    "message": "The token does not grant access to this resource.",
    "requestId": "..."
  }
}
```

List endpoints return opaque cursors. Send `page.nextCursor` as `cursor`; do not parse or manufacture cursor values.

## CI deployment

```sh
export TS_CLOUD_API_URL=https://dashboard.example.com
export TS_CLOUD_API_TOKEN='tsc_v1...'

cloud api:projects
cloud api:deploy project-id environment-id \
  --service service-id \
  --revision "$GITHUB_SHA" \
  --idempotency-key "github-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
```

Direct HTTP clients must send `Idempotency-Key` for deployment mutations. Retrying the same key and JSON body returns the original operation with `Idempotent-Replayed: true`. Reusing a key with a different body returns `409 idempotency_conflict`.

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $TS_CLOUD_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: github-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" \
  -d '{"projectId":"project-id","environmentId":"environment-id","serviceId":"service-id"}' \
  "$TS_CLOUD_API_URL/api/v1/deployments"
```

The same replay-safe contract is available for guided application creation, including detection, normalized plans, resumable secret-free drafts, bounded artifact uploads, and encrypted registry connections. See [Application onboarding](/features/application-onboarding) for the endpoint map and examples.

Release automation uses content-addressed artifact registration, immutable release creation, environment promotion without rebuild, approvals, durable activation/rollback, health reporting, and retention pinning. See [Releases, promotion, and rollback](/features/releases) for the endpoint map and target-scoped authorization rules.

## Progress and event delivery

Use `GET /api/v1/events/stream?projectId=...&after=...` for authenticated server-sent events. The stream sends event sequence IDs, heartbeats while idle, and rechecks token validity while connected. Reconnect with the last observed sequence in `after`.

Long-running mutations also expose a durable queue. `GET /api/v1/queue` lists only jobs for targets where the token has `deployments:read`. Poll `GET /api/v1/operations/{id}/logs?after=<sequence>` or resume `GET /api/v1/operations/{id}/logs/stream` with `Last-Event-ID`. Cancellation requires `deployments:cancel`, while allow-listed retries require `deployments:create` at the operation target; concurrency and history changes require organization-scoped `automation:manage` plus their exact confirmation phrases.

See [Durable deployment queue](/features/deployment-queue) for the complete state, retry, locking, retention, and endpoint contract.

For webhook delivery, run a subscriber that consumes this stream and signs outbound webhook payloads with a separate destination secret. Store the last delivered sequence, retry destinations with exponential backoff, and dead-letter repeated failures. Do not reuse a ts-cloud API token as a webhook signing secret or place it in destination URLs.
