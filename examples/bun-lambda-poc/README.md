# Bun-on-Lambda PoC (issue #117)

Proves the plumbing for deploying a Stacks-style API to AWS Lambda using **Bun's
own runtime** — not `nodejs20.x`. The handler is a plain `Bun.serve`-shaped
`fetch` function, so swapping in the real Stacks router later is a one-line change.

## How it works

Lambda has no native Bun runtime, so Bun runs as a **custom runtime via a layer**
(`provided.al2023`):

```text
paweldregan.com  → existing CloudFront → S3        (untouched)
api  (this PoC)   → Lambda Function URL → Bun runtime layer → handler/index.ts
```

- `layer/bootstrap` + `layer/runtime.ts` — the layer. The runtime loop polls the
  Lambda Runtime API, converts each event (Function URL / API Gateway payload
  format 2.0) into a `Request`, calls your `fetch`, and serializes the `Response`.
- `handler/index.ts` — the API. `export default { fetch(req) }` — identical to the
  Stacks HTTP server.
- `build-layer.ts` — downloads a pinned Bun release and assembles the layer zip.
- `deploy.ts` — publishes the layer, creates the role + function + Function URL.

## Run it

```sh
# 1. Build the runtime layer (arm64 = Graviton, ~20% cheaper).
bun build-layer.ts --arch arm64

# 2. Deploy. Target account = your AWS_PROFILE / env creds.
# paweldregan lives in the `stacks` account (923076644019):
AWS_PROFILE=stacks bun deploy.ts --arch arm64

# 3. Verify (deploy.ts prints the exact URL + command):
curl https://<id>.lambda-url.us-east-1.on.aws/health
# → {"ok":true,"message":"hello from bun on lambda","runtime":"bun 1.3.13",...}
```

> ⚠️ `deploy.ts` makes real AWS calls and creates resources (Lambda, layer, IAM
> role, S3 deploy bucket). `build-layer.ts` only touches local files + downloads Bun.

### Env overrides

| Var | Default | Notes |
|---|---|---|
| `AWS_REGION` | `us-east-1` | |
| `AWS_PROFILE` | (default creds) | **Set to `stacks` for paweldregan** |
| `FN_NAME` | `bun-poc-api` | function + role + URL base name |
| `DEPLOY_BUCKET` | `bun-poc-api-deploy-<account>` | layer upload bucket |
| `ARCH` / `--arch` | `arm64` | `arm64` \| `x86_64` (must match the layer) |

## What the issue's open questions resolve to

- **Bundle size**: Bun aarch64 binary ≈ 90 MB; the 250 MB unzipped limit is not a
  concern.
- **Runtime**: `provided.al2023` + Bun layer. The function code is just
  `handler/index.ts` (Bun runs TS directly) — a few KB.
- **Cold start**: measure from the first invoke's CloudWatch `Init Duration`
  (Bun custom-runtime init is typically ~150–300 ms).

## Cleanup

```sh
AWS_PROFILE=stacks bun -e "import {LambdaClient} from '../../packages/ts-cloud/src/aws/lambda'; await new LambdaClient().deleteFunction('bun-poc-api')"
# plus the IAM role, layer versions, and deploy bucket if you want a full teardown
```
