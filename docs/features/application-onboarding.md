# Application onboarding

ts-cloud provides one guided, reproducible flow for creating an application from Git, a local directory, a source archive, or a prebuilt OCI image. Open **Applications → Create application** in the dashboard to use the six-stage wizard:

1. choose and inspect the source;
2. review detection evidence and select a build strategy;
3. configure runtime resources;
4. declare plain environment values and write-only secret names;
5. configure the domain and health check;
6. review the normalized manifest, config patch, capabilities, cost drivers, and target before deploying.

Each step can be saved as a resumable draft. Drafts use optimistic versions, so an older browser tab or automation job cannot silently overwrite a newer edit. Production creation requires typing the exact environment slug.

## Sources

| Source | Controls |
|---|---|
| Git connection | Repository and ref, monorepo root, sparse paths, included/excluded watch paths, shallow history, submodules, optional SSH deploy key |
| Local directory | Metadata-only scan of a selected root; dependencies, caches, build output, and symlinks are skipped or rejected |
| ZIP or TAR artifact | 100 MB compressed limit, bounded entry and expansion limits, traversal/link rejection, SHA-256 deduplication |
| OCI image | Image tag or digest and an optional encrypted private-registry connection |

Git inspection uses a temporary blobless, depth-one checkout and applies sparse checkout before project detection. Detection never executes repository code or package lifecycle scripts. The wizard shows every evidence file, confidence score, inferred command, and manual override.

## Build strategies

| Strategy | Typical use | Configurable fields |
|---|---|---|
| Dockerfile | Existing container build | Context, Dockerfile path, target, build arguments, write-only build-secret names |
| Buildpack | Conventional Bun, Node, or PHP project | Runtime/version, install, build, start, and publish commands |
| Static | SPA, documentation, or generated site | Install/build commands and publish directory |
| Server | Long-running Bun, Node, Laravel, or PHP application | Runtime/version, install/build/start commands, port, health check |
| Serverless | Function-style application | Runtime/version, handler, package root |
| Prebuilt image | Existing immutable image | Registry connection, tag/digest, port, health check |

Runtime configuration includes `x86_64` or `arm64`, server/serverless/container target, CPU, memory, minimum/maximum instances, exposed port, and HTTP/HTTPS/TCP health checks. The review page explains recurring cost drivers such as always-on instances, allocated memory, and custom domains before confirmation.

## Secrets and private registries

Drafts and generated manifests contain secret references and supplied secret *names*, never secret values. A value assigned directly to a secret-like environment or build-argument name fails validation. Credential-bearing source URLs are also rejected.

Registry credentials use authenticated encryption at rest. The dashboard, CLI, and API return only safe metadata: whether a credential is configured, its one-way fingerprint, optional expiry, and health. Registry tests can verify both the Docker Registry v2 endpoint and pull access to one image. Bearer challenges are followed only to HTTPS authentication realms with bounded requests.

Before disconnecting a registry, the UI and CLI show how many drafts reference it. Disconnecting erases encrypted credentials. Rotating credentials resets health to pending; expired connections become visibly unusable until rotated.

## CLI workflow

Detection and planning are pure operations, so they can run before anything is persisted:

```bash
cloud app:detect .
cloud app:plan ./application-draft.json --secrets DATABASE_URL,SESSION_SECRET
cloud app:draft:save ./application-draft.json --step review --secrets DATABASE_URL,SESSION_SECRET
cloud app:drafts
cloud app:export <draft-id> --output application.manifest.json
cloud app:deploy <draft-id> --confirm production
```

Import an existing configured site into the same draft format:

```bash
cloud app:import web --env production
cloud app:import web --env production --connection <git-connection-id>
```

Artifacts are inspected before storage:

```bash
cloud app:artifact:add ./release-source.zip
```

Registry secrets come from environment variables instead of command arguments or shell history:

```bash
REGISTRY_USERNAME=robot REGISTRY_PASSWORD='…' \
  cloud app:registry:add ghcr.io --provider ghcr --name production-images

cloud app:registries
cloud app:registry:test <registry-id> --image ghcr.io/acme/web:release

REGISTRY_TOKEN='…' \
  cloud app:registry:rotate <registry-id> --expires 2027-01-01T00:00:00Z

cloud app:registry:disconnect <registry-id>
```

## Manifest format

Planning produces a deterministic `ts-cloud.dev/v1` application manifest plus a configuration patch. The same input produces byte-for-byte stable serialized output, which can be reviewed or committed:

```json
{
  "apiVersion": "ts-cloud.dev/v1",
  "kind": "Application",
  "metadata": {
    "name": "Web",
    "slug": "web",
    "projectId": "project-id",
    "environmentId": "environment-id"
  },
  "spec": {
    "source": { "kind": "local", "root": "." },
    "build": {
      "kind": "server",
      "runtime": "bun",
      "startCommand": "bun run start"
    },
    "runtime": {
      "target": "server",
      "architecture": "arm64",
      "port": 3000,
      "healthCheck": { "protocol": "http", "path": "/health" }
    },
    "environment": {
      "APP_ENV": "production",
      "DATABASE_URL": { "secretRef": "DATABASE_URL" }
    }
  }
}
```

Validation checks source/build compatibility, safe relative paths, ports, health paths, domains, required secret names, and target/runtime combinations before creating desired state.

## Automation API

Service-account tokens use `applications:read` to list drafts and registry metadata and `applications:manage` to detect, plan, save, upload, rotate, disconnect, and deploy. The OpenAPI 3.1 document at `/api/v1/openapi.json` describes:

- `POST /api/v1/application-detections`
- `POST /api/v1/application-plans`
- `GET|POST|PATCH /api/v1/application-drafts`
- `POST /api/v1/applications`
- `POST /api/v1/application-artifacts`
- `GET|POST|PATCH|DELETE /api/v1/registry-connections`

Application creation requires an `Idempotency-Key`. Retrying the same key and JSON body returns the original operation with `Idempotent-Replayed: true`; reusing a key for another request returns `409 idempotency_conflict`.

```bash
curl --fail-with-body -X POST "$TS_CLOUD_API_URL/api/v1/applications" \
  -H "Authorization: Bearer $TS_CLOUD_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: application-release-42' \
  -d '{"draftId":"draft-id","version":1,"confirmEnvironment":"production"}'
```

## Failure behavior

- Detection ambiguity is visible and can be overridden; it never silently chooses an unsupported build.
- Invalid drafts remain resumable but cannot be applied.
- Missing secret names are listed separately from other validation issues.
- No resource or operation is created before target confirmation and plan validation succeed.
- Archive traversal, symbolic/hard links, excessive expansion, and malformed inputs fail before persistence.
- Registry credentials are never included in draft exports, API responses, audit payloads, or application desired state.

## See also

- [Git integrations](/features/git-integrations)
- [API and automation](/features/api-automation)
- [Environments](/features/environments)
- [Security posture](/features/security-posture)
