# Add a private API to an existing static site

ts-cloud can attach a small Lambda-backed API to an existing CloudFront and S3 site without replacing its distribution, bucket, certificate, aliases, or default cache behavior. Requests matching `/api/*` go to a private Lambda function URL; all other requests continue to use the existing static origin.

This workflow is intended for a low-volume API, webhook receiver, health endpoint, or incremental full-stack migration. For long-running work, stable high throughput, databases, queues, cache, and mail, use the container application workflow instead.

## Architecture

```text
viewer ──> existing CloudFront distribution
             ├── default behavior ──> existing S3 origin
             └── /api/* behavior ──> private Lambda function URL
                                          └── CloudWatch Logs (14-day default)
```

The Lambda URL uses `AWS_IAM`, not public access. CloudFront signs origin requests with a Lambda origin access control. The function resource policy grants `cloudfront.amazonaws.com` both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`, scoped to the exact distribution ARN. AWS requires both permissions for new function URLs created from October 2025 onward.

The managed `CachingDisabled` cache policy prevents API responses from being cached. `AllViewerExceptHostHeader` forwards viewer request data while replacing the viewer `Host` header with the Lambda URL origin host.

## Guarded deployment

Planning is the default and never creates or updates a resource:

```bash
cloud cdn:api:deploy E123456789AB example.com \
  --function example-static-api \
  --profile production
```

Before showing the plan, ts-cloud verifies:

- the active AWS identity returned an account ID;
- the distribution is enabled;
- the expected custom-domain alias belongs to that exact distribution;
- whether the role, function, function URL, origin access control, origin, and path behavior already exist;
- that the requested path is a non-default wildcard and therefore cannot replace the static default behavior.

Apply only with the exact token printed by the plan:

```bash
cloud cdn:api:deploy E123456789AB example.com \
  --function example-static-api \
  --profile production \
  --apply \
  --confirm 'E123456789AB:/api/*'
```

The deployment creates or reconciles a least-privilege execution role, explicit log group and retention, Node.js 22 Lambda function, private function URL, Lambda origin access control, dual scoped permissions, and ETag-protected CloudFront patch. Existing origins and behaviors are preserved. A path or origin collision fails unless it is separately inspected and handled through the low-level origin command.

The built-in handler exposes `GET /api/health` and reports whether the process was cold. Pass `code` through the TypeScript API to deploy a different single-file handler. Use the normal serverless application pipeline for multi-file builds, native dependencies, layers, aliases, and application lifecycle management.

## Verification

Capture the frontend response digest before applying:

```bash
curl -fsSL https://example.com/ | shasum -a 256
```

After CloudFront reports `Deployed`, verify the original static response, API health, end-to-end latency, and the latest Lambda `Init Duration` observation:

```bash
cloud cdn:api:verify example.com \
  --function example-static-api \
  --profile production \
  --frontend-sha256 '<digest-before-change>'
```

Verification fails if the API is unhealthy or the supplied frontend digest changed. The result is structured JSON suitable for attaching to a change record.

## Rollback

Every deployment plan records whether the role, function, and URL existed beforehand and prints the exact CloudFront rollback command. Remove the new behavior first:

```bash
cloud cdn:origin:remove E123456789AB abc.lambda-url.us-east-1.on.aws \
  --id example-static-api-url \
  --path '/api/*' \
  --profile production \
  --apply \
  --confirm 'remove:E123456789AB:/api/*'
```

This removes only the exact `/api/*` behavior and removes its origin only when no other behavior references it. It does not touch the default behavior. If the deployment created a dedicated Lambda, function URL, log group, or role, remove those only after CloudFront finishes deploying the rollback and the plan confirms they were not pre-existing.

## Method and payload constraint

CloudFront origin access control signs Lambda URL requests. AWS documents an additional `x-amz-content-sha256` viewer header requirement for `POST` and `PUT` requests to this origin type. The built-in transport check is deliberately a `GET`. Browser APIs that need arbitrary writes should either calculate and send this header, use an origin that supports the intended request flow, or move to the ALB-backed container architecture.

## Cost boundary

```bash
cloud cdn:api:cost 100000 --duration 100 --memory 256
```

The estimate uses the current US East public Lambda request and GB-second rates, including the monthly free tier by default. The comparison uses one continuously running Linux/x86 Fargate task at 0.25 vCPU and 0.5 GB plus one Application Load Balancer before LCU usage. It excludes CloudFront, data transfer, logs, public IPv4, taxes, and application data services. Use `--no-free-tier` for a conservative Lambda estimate and AWS Pricing Calculator before production approval.

See the official [Lambda pricing](https://aws.amazon.com/lambda/pricing/), [Fargate pricing](https://aws.amazon.com/fargate/pricing/), [load balancer pricing](https://aws.amazon.com/elasticloadbalancing/pricing/), [Lambda URL access control](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html), and [private Lambda URL origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html) references.
