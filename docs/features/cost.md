# Cost Analysis

ts-cloud includes a small CLI for inspecting your AWS spend without logging into the console. It calls the **Cost Explorer** API directly using SigV4 — no AWS SDK or CLI dependency — and caches responses on disk so you aren't billed every time you run it.

## `cost:analyze`

Rank AWS services by cost for the **last full calendar month**.

```sh
cloud cost:analyze
cloud cost:analyze --profile stacks
cloud cost:analyze --profile stacks --output            # also writes ./aws.md
cloud cost:analyze --no-cache                           # always hit AWS
```

### Sample output

```
Cost Analysis — April 2026 (profile: stacks)

Service                                                        Resources    Cost     % of Total
─────────────────────────────────────────────────────────────────────────────────────────────
Amazon Simple Storage Service                                  50 buckets   $191.91  62.4%
Amazon Elastic Compute Cloud - Compute                         -            $41.78   13.6%
Amazon Virtual Private Cloud                                   -            $18.00    5.9%
AWS WAF                                                        -            $15.00    4.9%
…

Total: $307.63 across 19 services
```

### What it does

- Calls `ce:GetCostAndUsage` for the last fully-closed month, grouping by `SERVICE` with `UnblendedCost`.
- Sorts services descending and filters out zero-spend rows.
- For S3, also calls `s3:ListAllMyBuckets` and shows the bucket count next to the spend line.
- Prints a one-line cache notice on a hit so you know when the data isn't fresh.

### IAM permissions

| Permission | Required for |
|---|---|
| `ce:GetCostAndUsage` | The cost data itself (mandatory) |
| `s3:ListAllMyBuckets` | Bucket count next to the S3 row (optional — falls back to `unknown`) |

If `ce:GetCostAndUsage` is missing the command exits with a clear error. If `s3:ListAllMyBuckets` is missing it just hides the bucket count.

### Profile precedence

`--profile <name>` is **strict**: if the profile doesn't exist in `~/.aws/credentials` the command errors out, matching the AWS CLI's behavior. Without `--profile` the standard precedence applies: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env vars > `AWS_PROFILE` > `default`.

### Multi-account / Organizations

If you see significant S3 spend but `0 buckets`, the calling identity is most likely in your AWS Organization's payer/management account. Cost Explorer rolls up consolidated billing from member accounts, but `ListBuckets` only returns buckets owned by the calling account. The command warns when it detects this combination.

## Response cache

Cost Explorer charges **$0.01 per request**. ts-cloud caches every successful `getCostByService` response on disk so re-running `cost:analyze` is free until the data is stale.

| Where | `~/.cache/ts-cloud/cost-explorer/<profile>/<sha>.json` (honors `XDG_CACHE_HOME`) |
|---|---|
| Key | `(profile, start, end, granularity, metrics, groupBy)` — anything that affects response shape |
| TTL — open period | 1 hour (the current month is still moving) |
| TTL — closed period | 30 days (closed months are immutable in Cost Explorer) |
| Skip cache | `--no-cache` on `cost:analyze` |

When a cached response is used, you'll see a one-line notice:

```
(cached, 24s old — pass --no-cache to refresh)
```

### `cost:cache:clear`

Wipe cached responses without making a request:

```sh
cloud cost:cache:clear --profile stacks    # one profile (default if no flag)
cloud cost:cache:clear --all               # everything under the cache root
```

## Markdown report (`--output`)

Pass `--output` to also write `./aws.md` next to the table on stdout. Useful for pasting into a GitHub issue or a recurring report:

```md
# AWS Cost Analysis — April 2026

_Profile: `stacks`_

| Service | Resources | Cost | % of Total |
|---|---|---|---|
| Amazon Simple Storage Service | 50 buckets | $191.91 | 62.4% |
| Amazon Elastic Compute Cloud - Compute | - | $41.78 | 13.6% |
…

**Total: $307.63 across 19 services**
```

## Status of related commands

A handful of stub commands ship with hardcoded output and are guarded with a "not implemented" warning until they're wired against real AWS APIs:

| Command | Tracking |
|---|---|
| `cost` (current MTD + naive projection) | [#108](https://github.com/stacksjs/ts-cloud/issues/108) |
| `cost:breakdown` (N-day window with trend) | [#109](https://github.com/stacksjs/ts-cloud/issues/109) |
| `resources` (Resource Groups Tagging API) | [#110](https://github.com/stacksjs/ts-cloud/issues/110) |
| `resources:unused` (CloudWatch idle detection) | [#111](https://github.com/stacksjs/ts-cloud/issues/111) |
| `optimize` (RI/savings recommendations) | [#112](https://github.com/stacksjs/ts-cloud/issues/112) |

Use `cost:analyze` for real numbers in the meantime.

## See also

- [AWS Resources](/features/aws) — typed CloudFormation builders for everything in your stack
- [Security](/features/security) — pre-deployment secret scanning
