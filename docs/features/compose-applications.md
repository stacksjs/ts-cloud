# Compose applications and templates

ts-cloud imports a security-focused subset of the Compose Specification into a persistent, editable multi-service manifest. It keeps the normalized model, a secret-redacted export of the original definition, actionable conversion diagnostics, durable operations, and per-service observed state in the control plane.

Open **Applications → Compose applications** at `/applications/compose` for a topology-oriented view of every stack. The page shows dependency order, service health/replicas, domains, source/template version, logs, shell access when permitted, scale/start/stop/redeploy controls, and separate confirmations for stateless teardown versus persistent data deletion.

## Supported Compose subset

| Area | Supported behavior |
|---|---|
| Service source | `image` or repository-local `build` context/Dockerfile/target/args. |
| Process | Array commands/entrypoints, or string commands normalized to `sh -c`. |
| Environment | Plain non-sensitive values and `${SECRET_NAME}` references. Secret-like literal values are rejected and redacted. |
| Networking | Named networks and TCP/UDP target/published ports. Per-service domains use `ts-cloud.domain` or `ts-cloud.domains` labels. |
| Storage | Named volumes with absolute container targets and optional read-only mode. Volume identity is stable across redeploys. |
| Dependencies | Short or long `depends_on`, including started, healthy, and completed-successfully conditions. Cycles/missing services block deployment. |
| Health | Test, interval, timeout, retries, and start period. Deployment uses `docker compose up --wait`; dependency order never substitutes for readiness. |
| Resources | CPU, memory, replicas, and restart policy. Scale is bounded to 0–100 replicas and capability-dependent. |

Unknown non-dangerous service fields are warnings and are omitted from the normalized export. Unsupported security-sensitive fields are blocking errors.

## Import and inspect

Preview conversion before persistence or provider mutation:

```bash
cloud compose:preview compose.yaml --name Commerce --env production
cloud compose:import compose.yaml --name Commerce --env production
cloud compose:list
cloud compose:export <application-id>
cloud compose:diff <application-id> compose.next.yaml
```

The parser accepts at most 512 KiB and 64 services. Names, paths, ports, dependencies, domains, duration/resource values, and environment references are validated before a control-plane resource is created. Re-importing the same project/environment/slug updates the existing application, reconciles service records, and preserves its identity.

The same file can come from a checked-out connected repository, an uploaded/pasted file in the dashboard, or a local CI workspace. Source-triggered work still uses the signed webhook, exact-checkout, and durable queue boundaries described in [Git integrations](/features/git-integrations).

## Deploy and operate

```bash
cloud compose:deploy <application-id>
cloud compose:redeploy <application-id>
cloud compose:start <application-id>
cloud compose:stop <application-id>
cloud compose:scale <application-id> worker 4
cloud compose:logs <application-id> web --lines 500
cloud compose:shell <application-id> web sh
cloud compose:delete <application-id> --confirm commerce
cloud compose:delete <application-id> --remove-volumes \
  --confirm 'commerce delete volumes'
```

Mutations become `compose.*` durable jobs and lock the application identity. Server/fleet targets use the installed Docker Compose plugin with a deterministic project name and `/opt/ts-cloud/compose/<project>/compose.yaml`. A deploy validates the generated file, starts in dependency order, removes orphaned stateless containers, and waits for health. Redeploy force-recreates services while preserving named volumes.

Default deletion runs `down --remove-orphans` and keeps named volumes. Data deletion adds `--volumes` only after the longer `<slug> delete volumes` confirmation. A failure remains visible as `failed` or `degraded`, with the operation's retry/log history.

Shell access uses the `runtime:terminal` capability and an exact service-name confirmation in the dashboard. Logs use `runtime:logs`; deploy/scale and stop/delete use their corresponding deployment capabilities. Service names and command arguments are validated/quoted before a remote command is assembled.

## Templates

Built-in cards are versioned and checksum-pinned. Each shows source/version, category, architecture, minimum CPU/memory, exposed services, maintenance notes, verification date, and required inputs. Selecting one resolves to the same ordinary editable manifest as a manual import; it does not bypass validation, authorization, the queue, or audit events.

```bash
cloud compose:templates
cloud compose:template wordpress \
  --version 1.0.0 \
  --name CMS \
  --domain cms.example.com
```

Custom/local catalogs use JSON and must identify an HTTPS or explicit `file:` source. Every entry includes the exact SHA-256 checksum of its Compose text. Catalog validation parses every template through the same safety model and runs without deployment:

```json
{
  "apiVersion": "ts-cloud.dev/compose-catalog/v1",
  "source": "file:./catalog.json",
  "templates": [{
    "id": "internal-api",
    "name": "Internal API",
    "version": "1.0.0",
    "category": "internal",
    "checksum": "<sha256-of-compose-field>",
    "compose": "services:\n  api: { image: registry.example/api:1.0.0 }\n"
  }]
}
```

```bash
cloud compose:catalog ./catalog.json
```

Upgrade planning separates upstream template changes from user changes with field-level manifest diffs. Nothing silently overwrites user customization; pin the next version, inspect both change sets, then re-import the chosen merged manifest.

## Safety model

The importer blocks privileged containers, host networking/PID/IPC, host or bind mounts, device access, added capabilities, unsafe security options, repository path traversal, malformed ports/domains, dependency cycles, and literal secret-like environment/build values. Floating or `latest` image references are warnings so they are visible before deployment; production catalogs should pin explicit versions or digests.

Secret references export as required `${NAME:?…}` expressions and are resolved only at runtime. Values never enter Compose records, diffs, template metadata, diagnostics, or logs. Ensure every required secret is provisioned at the target's secret boundary before deployment; missing values fail Compose validation rather than silently becoming empty strings.

Current provider execution targets capable server/fleet drivers. The normalized model intentionally stays provider-neutral so supported service/image/resource portions can map to managed container orchestration without changing the authoring contract. Kubernetes semantics and unrestricted Compose compatibility are not goals.

## Automation API

API v1.5 and its generated client expose:

- `GET /api/v1/compose-templates`
- `GET|POST /api/v1/compose-applications`
- `POST /api/v1/compose-applications/preview`
- `GET /api/v1/compose-applications/{applicationId}/services`
- `POST /api/v1/compose-applications/{applicationId}/{action}`

The dashboard adds resource-scoped logs and confirmed shell operations. See `/api/v1/openapi.json` and [API & automation](/features/api-automation).

## See also

- [Application onboarding](/features/application-onboarding)
- [Durable deployment queue](/features/deployment-queue)
- [Git integrations](/features/git-integrations)
- [Security posture](/features/security-posture)
