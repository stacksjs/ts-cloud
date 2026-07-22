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

## Current month projection

`cloud cost` queries each billed service from the first day of the current UTC month through today. It projects the total with `month-to-date spend / elapsed calendar days × days in month` and compares that projection with the previous full month.

```sh
cloud cost
cloud cost --profile stacks
cloud cost --no-cache
```

The projection is deliberately naive: it is useful for spotting trajectory changes, but it does not model reservations, one-time charges, seasonality, or future usage changes.

## Rolling service breakdown

`cost:breakdown` compares adjacent windows of equal length and calculates the trend independently for every service.

```sh
cloud cost:breakdown                 # last 30 days vs the preceding 30
cloud cost:breakdown --days 7
cloud cost:breakdown --days 90 --profile stacks
```

The accepted range is 1–366 days. A service with no spend in the previous window is labeled `new` instead of showing a misleading infinite percentage.

## Egress usage types

`cost:egress` groups real Cost Explorer data by `USAGE_TYPE` and ranks billed NAT Gateway, internet, inter-AZ, inter-region, and other data-transfer line items.

```sh
cloud cost:egress
cloud cost:egress --days 7 --profile stacks
```

Cost Explorer usage types identify the transfer category, not the workload or destination that caused it. Correlating a line item to destination IP, port, or instance requires VPC Flow Logs; the command states this boundary explicitly instead of inventing attribution.

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
| Key | `(profile, start, end, granularity, metrics, groupBy, filter)` — anything that affects response shape |
| TTL — open period | 1 hour (the current month is still moving) |
| TTL — closed period | 30 days (closed months are immutable in Cost Explorer) |
| Skip cache | `--no-cache` on any cost query command |

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

## Status of resource commands

The cost reporting commands above use real Cost Explorer data. Resource discovery and recommendation commands remain guarded until their provider inventory and CloudWatch signal paths are complete:

| Command | Tracking |
|---|---|
| `resources` (Resource Groups Tagging API) | [#110](https://github.com/stacksjs/ts-cloud/issues/110) |
| `resources:unused` (CloudWatch idle detection) | [#111](https://github.com/stacksjs/ts-cloud/issues/111) |
| `optimize` (RI/savings recommendations) | [#112](https://github.com/stacksjs/ts-cloud/issues/112) |

## See also

- [AWS Resources](/features/aws) — typed CloudFormation builders for everything in your stack
- [Security](/features/security) — pre-deployment secret scanning
