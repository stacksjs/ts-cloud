# Full-stack container backend for an existing static site

ts-cloud can add a long-running Bun/Node application to an existing S3 and CloudFront frontend without recreating the frontend. The backend is a separate CloudFormation stack containing ECS Fargate, an Application Load Balancer, PostgreSQL, Redis, SQS with a dead-letter queue, Secrets Manager credentials, and the permissions required to send mail through SES. Only after that stack is healthy does ts-cloud add an isolated `/api/*` behavior to the existing distribution.

Use this path for an application that needs stable database connection pools, long-running jobs, in-process workers, WebSockets, or predictable request latency. Use the [private Lambda API origin](/features/static-site-api-origin) for small, bursty, stateless APIs that benefit from scaling to zero.

## Architecture and ownership

```text
existing domain ──> existing CloudFront distribution
                       ├── /* ──> existing S3 bucket (untouched)
                       └── /api/* ──> origin-api.example.com
                                            │ HTTPS + secret origin header
                                            ▼
                                     public ALB, default 403
                                            │ matching-header rule
                                            ▼
                                  private-subnet ECS Fargate task(s)
                                     ├── RDS PostgreSQL
                                     ├── ElastiCache Redis
                                     ├── SQS jobs + retained DLQ
                                     └── SES send permission
```

The frontend stack continues to own S3, CloudFront, the viewer certificate, aliases, and static content. The new `<slug>-backend` stack owns the VPC, private tasks, ALB, target group, execution roles, log group, autoscaling, database, cache, and queue. CloudFront is changed through an ETag-protected patch after the backend stack and its origin health endpoint succeed.

This boundary avoids importing an existing production distribution into a second stack and prevents a failed backend create from replacing or rolling back the static site.

## Application contract

Provide a production Dockerfile whose container:

- listens on `0.0.0.0:3000`;
- returns `200-399` from `GET /api/health` only when it can serve traffic;
- handles graceful `SIGTERM` shutdown;
- reads non-sensitive runtime configuration from environment variables;
- reads `DB_USERNAME` and `DB_PASSWORD` injected from Secrets Manager;
- constructs the database connection from `DB_HOST`, `DB_PORT`, and the secret values;
- uses TLS for `REDIS_HOST` and `REDIS_PORT` when `REDIS_TLS=true`;
- consumes or publishes through `QUEUE_URL` and uses the default task role;
- uses the AWS SDK/default credential chain for SES rather than static keys.

Example Bun image:

```dockerfile
FROM oven/bun:1.3.14-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
```

Keep `.env`, credentials, local state, tests, and build caches out of the context with `.dockerignore`. The pre-deployment security policy should scan the context before artifact publication.

## Publish an immutable artifact

```bash
cloud container:artifact example-api \
  --context . \
  --dockerfile ./Dockerfile \
  --platform linux/amd64 \
  --region us-east-1 \
  --profile production
```

The command hashes the filtered context, creates a scan-on-push immutable ECR repository if needed, installs a 25-image lifecycle policy, builds without a mutable `latest` tag, authenticates through an isolated temporary Docker configuration, pushes, and resolves the registry-assigned digest. Use the returned URI ending in `@sha256:<digest>` for deployment. Mutable tag-only URIs are rejected.

Docker/buildx must be available locally. Registry authentication uses direct ECR API calls; the AWS CLI is not required. The selected AWS credential profile applies to ECR, CloudFormation, STS, and CloudFront.

## Plan and deploy

The plan is read-only. It verifies the AWS account, enabled distribution, expected alias, existing stack state, immutable image identity, resource counts, service choices, routing path, and rollback order:

```bash
cloud deploy:fullstack E123456789AB example.com \
  --name Example \
  --slug example \
  --image '923076644019.dkr.ecr.us-east-1.amazonaws.com/example-api@sha256:…' \
  --origin-domain origin-api.example.com \
  --certificate-arn 'arn:aws:acm:us-east-1:923076644019:certificate/…' \
  --dns-provider porkbun \
  --profile production
```

The origin-domain certificate belongs in the backend region and must match the DNS name CloudFront uses for the ALB origin. This is separate from the viewer certificate, which CloudFront requires in `us-east-1`.

For apply, create a stable random origin secret outside version control and provide the exact confirmation token printed by the plan:

```bash
export TS_CLOUD_ORIGIN_SECRET='<at-least-24-random-characters>'

cloud deploy:fullstack E123456789AB example.com \
  --name Example \
  --slug example \
  --image '923076644019.dkr.ecr.us-east-1.amazonaws.com/example-api@sha256:…' \
  --origin-domain origin-api.example.com \
  --certificate-arn 'arn:aws:acm:us-east-1:923076644019:certificate/…' \
  --dns-provider porkbun \
  --profile production \
  --apply \
  --confirm 'E123456789AB:/api/*:example-backend'
```

The external DNS adapter upserts the origin CNAME. The ALB default action returns `403`; a higher-priority rule forwards only requests containing the secret header that CloudFront adds. The orchestrator checks `https://origin-api.example.com/api/health` with that header before submitting the CloudFront patch. Keep the header value secret and rotate it with an overlap procedure.

## Deployment behavior

Fargate tasks run in two private subnets without public IPs. The ALB is public so the existing distribution can use it as a custom origin. Tasks accept traffic only from the ALB security group; PostgreSQL and Redis accept traffic only from the task security group.

The ECS rolling deployment uses 100% minimum and 200% maximum healthy capacity, a 60-second health grace period, target-group health checks, 30-second deregistration, and the ECS deployment circuit breaker with automatic rollback to the last completed revision. Target tracking scales from the configured baseline to six tasks at 70% average CPU by default.

Database credentials are generated by Secrets Manager. Only their references enter the task definition; the task execution role receives the narrow secret-read permission needed for injection. Application code receives no long-lived AWS access keys. The task role is limited to the stack queue family and SES send actions.

## Data and rollback

The CloudFront rollback command printed in every plan removes only the exact `/api/*` behavior and its unreferenced origin. Run that first and wait for CloudFront to reach `Deployed`; the static default behavior is never removed.

Stateful resource policy is deliberately conservative:

| Resource | Stack delete/replace behavior |
|---|---|
| PostgreSQL | Snapshot on delete and replacement |
| Redis | Snapshot on delete and replacement |
| DB credential secret | Retain |
| SQS jobs and dead-letter queue | Retain |
| ECR release images | Keep newest 25 according to repository lifecycle policy |
| ALB, ECS service, networking | Delete after routing has been removed |

Retained named resources can block recreating a stack with the same names. Import, rename, or explicitly remove them only after a data-retention decision. Infrastructure rollback does not undo schema migrations; use backward-compatible migrations and the immutable release promotion/rollback workflow.

## Cost baseline

```bash
cloud deploy:fullstack:cost --desired-count 1
```

The July 2026 US East baseline is approximately `$93.33/month` before usage, storage, transfer, public IPv4, and taxes: one 0.25-vCPU/0.5-GB Fargate task, one ALB, one NAT gateway, one single-AZ `db.t4g.micro`, and two `cache.t4g.micro` nodes. NAT and Redis dominate this minimal shape. Production can choose two tasks and Multi-AZ PostgreSQL for availability; cost increases accordingly. Development environments can omit database, cache, or queue with `--no-database`, `--no-cache`, or `--no-queue` and should be isolated from production data.

Verify current rates with the official [Fargate pricing](https://aws.amazon.com/fargate/pricing/), [load balancer pricing](https://aws.amazon.com/elasticloadbalancing/pricing/), [RDS pricing](https://aws.amazon.com/rds/postgresql/pricing/), [ElastiCache pricing](https://aws.amazon.com/elasticache/pricing/), and [VPC pricing](https://aws.amazon.com/vpc/pricing/) pages. See AWS guidance for [restricting ALB access to CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/restrict-access-to-load-balancer.html), [ECS Secrets Manager injection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data-tutorial.html), and [deployment circuit-breaker rollback](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html).
