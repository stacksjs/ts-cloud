# Releases, promotion, and rollback

ts-cloud records every deployable version as an immutable release. Static sites, compute applications, serverless ZIPs and images, containers, and Compose applications share the same artifact identity, provenance, approval, activation, health, comparison, retention, and rollback model.

Open **Operations → Releases & promotion** at `/operations/releases`. The page is scoped by normal `deployments:read` and `deployments:create` grants and shows:

- the exact source commit, SHA-256 artifact digest and immutable URI;
- the sanitized config hash, manifest changes, build provenance, attestation, actor, trigger, and duration;
- environment, resource, provider, strategy, approval state, health observations, traffic steps, and provider resource versions;
- supported and unavailable strategies with capacity, temporary cost, health requirements, and rollback behavior;
- guarded promotion, approval, activation, pinning, and rollback controls.

Secret values are never part of release history. Configuration is sanitized before hashing and persistence. Use secret references in manifests and provide values through the normal secret store at activation time.

## Immutable artifact identity

A release references one content-addressed artifact. Registering the same organization and digest returns the existing identity instead of creating a mutable copy. The artifact kind must match the release kind, and its URI must identify a supported immutable location (`s3:`, `https:`, `oci:`, or `file:`).

```bash
cloud release:artifact 'oci:registry.example/acme/web@sha256:abc...' \
  --digest 'sha256:abc...' --kind container --size 4815162342 \
  --media-type application/vnd.oci.image.manifest.v1+json

cloud release:create web <artifact-id> --env staging --kind container \
  --source-sha "$GIT_COMMIT" --manifest release.json --config staging.json \
  --strategy blue_green --health-path /health
```

`release:create` does not build or copy the artifact. It binds the already verified identity to an exact target, sanitized configuration hash, immutable manifest, activation strategy, health gate, hook compatibility, actor, and trigger.

## Strategy availability

Run the capability check before creating a release:

```bash
cloud release:capabilities container --health --replicas 3
```

| Strategy | Typical targets | Requirements | Capacity and rollback |
|---|---|---|---|
| Atomic | Static, compute, serverless ZIP/image | Compute and serverless require readiness; static pointer switches do not | 1× capacity; restore the prior pointer or alias |
| Rolling | Container and Compose | At least two replicas plus a health gate | Up to 1.5× temporary capacity; stop replacement and restore the prior service definition |
| Blue-green | Container and serverless | Health gate and two traffic-addressable revisions | 2× temporary capacity; return all traffic to blue |
| Canary | Container and serverless | Health gate plus weighted traffic | About 1.25× temporary capacity; set canary traffic to zero |

Unsupported strategies are returned with `supported: false` and an explanation. The CLI, API, and dashboard do not silently downgrade the requested strategy.

## Promotion without rebuilding

Only an active or superseded release can be promoted. Promotion creates a new release record in the target environment while preserving the artifact ID, digest, source SHA, manifest, provenance, and hook contract. Target configuration, strategy, health gate, and approval policy may differ.

```bash
cloud release:promote <staging-release-id> web --env production \
  --config production.json --approval
cloud release:approve <production-release-id> --actor <actor-id> \
  --comment 'Change reviewed; staging health held for 30m'
cloud release:activate <production-release-id>
```

The dashboard confirmation names the exact target environment and displays the digest being reused. This prevents a promotion control from accidentally becoming a rebuild.

## Durable activation and health

Activation and rollback are resource-locked durable queue jobs. A provider release driver receives the immutable release, artifact, preserved prior release, and an explicit traffic plan:

- atomic: one 100% pointer switch;
- rolling: 50%, then 100%;
- blue-green: validate green at 0%, then switch to 100%;
- canary: 5%, 25%, 50%, then 100%.

Every traffic observation becomes a release transition and an operation log entry. The provider result records the provider version and per-resource versions. Health failure marks the candidate failed and queues at most one automatic rollback when a prior release is preserved. Resource locking prevents another deploy, promotion activation, or rollback from racing the same target.

Embedding applications configure a `ReleaseDriverResolver` on `startLocalDashboardServer`. A dashboard process without an immutable provider driver fails activation explicitly and preserves the prior release; it never reports a control-plane-only status change as a successful provider activation.

## Rollback and data caveats

```bash
cloud release:compare <current-release-id> <prior-release-id>
cloud release:rollback <current-release-id>
cloud release:rollback <current-release-id> --to <prior-release-id>
```

Manual rollback is accepted only for the active release and a preserved prior release on the same resource. The dashboard preview shows current and target identity, config hashes, and the migration caveat before requiring the resource slug. A successful driver rollback marks the current release `rolled_back` and restores the prior release to `active`.

Traffic rollback does not reverse database changes. Hooks declare migrations as `none`, `backward_compatible`, `forward_only`, or `irreversible`; forward-only and irreversible changes must have an application/data recovery plan. Failed rollback remains visible as a failed durable operation and does not erase either release.

## History and retention

```bash
cloud release:list --env production
cloud release:show <release-id>
cloud release:compare <left-id> <right-id>
cloud release:pin <release-id> --reason 'incident baseline'
cloud release:pin <release-id> --remove
```

Retention candidates never include active, activating, awaiting-approval, pinned, or currently referenced rollback releases. The store keeps a configurable minimum per resource and exposes candidates rather than deleting provider artifacts implicitly.

## Automation API

The versioned OpenAPI document and TypeScript client expose:

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/releases/capabilities` | Explain supported strategies for a kind, health gate, and replica count |
| `POST /api/v1/release-artifacts` | Register a verified content-addressed artifact |
| `GET\|POST /api/v1/releases` | List authorized history or create a release from an existing artifact |
| `GET /api/v1/releases/{releaseId}` | Read artifact, transitions, approvals, health, and provenance |
| `POST /api/v1/releases/{releaseId}/{action}` | Promote, approve, activate, roll back, report health, or pin |

Read operations require `deployments:read` at the release resource. Creation, activation, rollback, promotion, and gate decisions require the corresponding resource-scoped deployment/application capability. Artifact registration is organization scoped so an environment token cannot introduce an unreviewed organization-wide identity.

See also [Durable deployment queue](/features/deployment-queue), [API and automation](/features/api-automation), and [Deployment guide](/guide/deployment).
