# Preview environments

ts-cloud creates persistent, isolated preview environments for pull requests, selected branches, or an exact commit requested from the CLI/API. Each preview has a collision-safe stack name, stable HTTPS URL, immutable source SHA, expiry, desired and observed state, cost estimate, and a durable operation history.

Open **Operations → Preview environments** at `/operations/previews` to configure policy, inspect live previews, open their URLs, extend expiry, rebuild the recorded commit, or queue tagged teardown. Preview state survives dashboard and worker restarts.

## Configure a policy

A policy belongs to one application and its base environment. Re-saving a policy updates that application's existing definition rather than creating duplicates.

| Setting | Behavior |
|---|---|
| Domain pattern | Must be HTTPS and contain `{name}`. `{project}`, `{branch}`, and `{pr}` are also expanded. |
| Branch rule | Optional glob such as `preview/**`; it is independent of the production deploy branch. |
| TTL / keep count | Bounds automatic cleanup by age and by newest previews retained per application. |
| Authentication | Public previews require authentication. Anonymous public previews are rejected. |
| Forks | Disabled by default. When enabled, fork previews never inherit base-environment secrets. |
| Inherited secrets | Explicit uppercase allow-list only; production credentials are never inherited implicitly. |
| Database strategy | `disabled`, `isolated`, `snapshot`, or `shared_read_only`. |
| Resource limits | Per-preview CPU, memory, and monthly-cost caps plus provider-specific resource overrides. |
| Cleanup on close | Queues teardown when a pull request closes/merges or a matching branch is deleted. |

Serverless and static applications are the first supported deployment targets. Application-only validation prevents a preview policy from being attached to an unrelated infrastructure resource.

## Source lifecycle

After a signed webhook passes replay protection and binding rules:

1. A pull-request open or matching branch push creates one preview identity and queues `preview.create`.
2. Later commits update that same identity and queue `preview.update` for the exact 40–64 character SHA.
3. The worker checks out and verifies the immutable SHA before deployment. Moving branch heads are never used as the artifact identity.
4. Hosted providers receive a pending status followed by success or failure, linked to the stable preview URL.
5. Pull-request close/merge and branch deletion queue `preview.destroy` when cleanup-on-close is enabled.

Webhook retries are idempotent. Updates lock on the preview identity, so two deliveries cannot mutate the same stack concurrently.

## CLI workflow

The first create configures a policy when needed. Pass an HTTPS wildcard-compatible domain pattern and an exact commit:

```bash
cloud env:preview feature/search \
  --site web \
  --sha 7cafe0123456789abcdef0123456789abcdef012 \
  --domain 'https://{name}.preview.example.com' \
  --ttl 24

cloud env:previews --site web
cloud env:preview feature/search --site web --get-url
cloud env:preview feature/search --site web --extend 12
cloud env:preview feature/search --site web --rebuild
cloud env:preview feature/search --site web --destroy

# Always inspect candidates first when changing cleanup policy.
cloud env:cleanup --dry-run --max-age 72 --keep 10
cloud env:cleanup --max-age 72 --keep 10
```

Use `--pr <number>` to address a pull-request preview. Rebuild always deploys the already recorded SHA; provide a new `--sha` to update it.

## Automation API

The OpenAPI document at `/api/v1/openapi.json` describes the complete preview surface:

- `GET|POST /api/v1/preview-definitions`
- `GET|POST /api/v1/previews`
- `POST /api/v1/previews/{previewId}/extend`
- `POST /api/v1/previews/{previewId}/rebuild`
- `POST /api/v1/previews/{previewId}/destroy`
- `POST /api/v1/previews/cleanup`

Policy writes require `config:write`; reads and lifecycle actions are authorized against the application resource. Teardown requires the exact preview name as confirmation. Cleanup defaults can be dry-run and returns each candidate with its reasons.

```bash
curl -X POST https://dashboard.example.com/api/v1/previews \
  -H "authorization: Bearer $TS_CLOUD_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "definitionId":"preview-policy-id",
    "repository":"acme/web",
    "branch":"feature/search",
    "commitSha":"7cafe0123456789abcdef0123456789abcdef012"
  }'
```

## Cleanup and reconciliation

An hourly dashboard sweep evaluates policy TTL and keep-count limits. Manual cleanup can add a maximum age or override keep count. Every candidate remains visible while teardown is queued, running, failed, or retrying.

Deletion is tag-gated. Provider resources must match all immutable tags—preview ID, project ID, and expiry—before they are associated with a preview. Untagged resources are ignored, mismatched resources are reported as unknown leaks, and teardown never broadens its target to an environment, account, or provider-wide query. Failed cleanup records the error and observed leak information so an operator can retry it.

Before enabling previews in production, provision wildcard DNS/TLS for the domain pattern, use a low-privilege base environment, keep write-capable endpoints out of preview configuration, and verify cost caps with a cleanup dry run.

## See also

- [Git integrations](/features/git-integrations)
- [Durable deployment queue](/features/deployment-queue)
- [API & automation](/features/api-automation)
- [Security posture](/features/security-posture)
