# Git integrations

ts-cloud can connect a Git provider once, discover the repositories that credential is allowed to read, and bind individual repositories to applications. Verified pushes queue production deployments and pull-request events queue previews. Branch, tag, monorepo, watched-path, clone-depth, submodule, and SSH deploy-key rules live on the binding rather than in the provider credential.

Open **Delivery → Git integrations** in the dashboard to manage the complete workflow. The page shows connection health, granted repositories, application bindings, webhook health, recent signed deliveries, and the impact of disconnecting a credential.

## Supported providers

| Provider | Authentication | Repository discovery | Branches/tags | Managed webhooks |
|---|---|---:|---:|---:|
| GitHub / GitHub Enterprise | GitHub App or access token | Yes | Yes | Yes |
| GitLab / self-managed GitLab | Access token | Yes | Yes | Yes |
| Bitbucket Cloud | Access token | Yes | Yes | Yes |
| Gitea / compatible hosts | Access token | Yes | Yes | Yes |
| Generic HTTPS Git | Optional username/token | Manual repository | Yes | Manual |
| Generic SSH Git | Encrypted deploy key + pinned host key | Manual repository | Yes | Manual |

Use the narrowest provider permission set that can read repository metadata and contents and manage hooks. The dashboard reports the scopes returned by providers where available.

## Connect and bind a repository

In the dashboard:

1. Select **Add connection**, choose a provider, and enter its host and credential. Credentials are write-only; after submission the browser receives only encrypted-credential metadata and a one-way fingerprint.
2. Select **Sync repositories** for a hosted provider. Generic connections accept one credential-free HTTPS or SSH clone URL directly.
3. Select **Bind application** on a repository. Choose the application, deployment branch or tag rule, monorepo root, included/excluded paths, clone depth, submodule behavior, and whether pushes and pull requests deploy.
4. Select **Configure webhook**. Hosted providers are reconciled automatically when the dashboard has a public base URL. For a generic host, copy the reveal-once endpoint into its webhook settings.

Set the public URL before starting the dashboard:

```bash
export TS_CLOUD_WEBHOOK_BASE_URL=https://dashboard.example.com
cloud dashboard:serve
```

Public webhook URLs must use HTTPS, except for loopback development. The endpoint token identifies a hook but does not authenticate an event; every accepted body must also pass the provider signature check.

## Binding rules

Bindings are evaluated independently, so one monorepo can deploy several applications from one push.

- `defaultBranch` selects the normal deploy branch.
- `branchRule` accepts an exact branch or a glob such as `release/**`.
- `tagRule` accepts tags such as `v*`. A tag binding does not deploy unrelated branch pushes.
- `monorepoRoot` must remain inside the checkout. Absolute paths and `..` traversal are rejected.
- `includePaths` requires at least one changed path to match. An empty list watches the whole repository.
- `excludePaths` suppresses matching files after include matching.
- `cloneDepth` selects shallow history; omit it for full history.
- `submodules` opts into submodule initialization.
- `deployKeyId` pins an SSH binding to one encrypted key and one recorded host key.

Each provider delivery ID is persisted before work is queued. Replays return the original outcome and do not create a second deployment operation.

Pull-request and selected branch events can instead reconcile one persistent preview environment. The provider receives deployment status for the exact commit, and close/merge/delete events queue isolated cleanup. Configure URL, TTL, fork, secret, database, and resource policies under **Operations → Preview environments**. See [Preview environments](/features/preview-environments).

Repositories containing Compose definitions can be checked out through the same credential-safe exact-source path and imported into the [Compose applications](/features/compose-applications) model. The resulting stack uses normal source authorization, durable operations, and per-service observability rather than executing an unreviewed file directly from a webhook.

## SSH deploy keys

Generic SSH connections require all of the following:

- a public key, shown in safe metadata so it can be installed read-only at the Git host;
- its private key, encrypted at rest and never returned;
- the exact SSH clone host;
- a pinned OpenSSH host-key line such as `ssh-ed25519 AAAA…`.

Clones run with strict host-key checking, a temporary `0600` private-key file, no interactive prompts, bounded execution time, and argument arrays rather than a shell. Revoking a deploy key disables every binding that used it; there is no fallback to another key.

## CLI

Tokens are read from environment variables, never command arguments. Defaults are `GITHUB_TOKEN`, `GITLAB_TOKEN`, `BITBUCKET_TOKEN`, `GITEA_TOKEN`, and `GIT_TOKEN`; use `--token-env` to choose another variable.

```bash
# Connect GitHub and bind it to the web application
GITHUB_TOKEN=… cloud git:add acme/web --site web --branch main --root apps/web --yes

# See stored safe metadata and granted repositories
cloud git:connections
cloud git:repositories --connection <connection-id>

# Browse refs and queue an idempotent source deployment
cloud git:branches acme/web --connection <connection-id>
cloud git:deploy main --repo acme/web --env production

# Reconcile or remove a signed provider hook
cloud git:webhook:add acme/web --connection <connection-id> --base-url https://dashboard.example.com
cloud git:webhook:remove <webhook-id>

# Preview affected bindings, then disconnect
cloud git:disconnect <connection-id>
```

For SSH, pass paths to the public/private key files and the pinned public host-key value:

```bash
cloud git:add git@git.example:acme/web.git \
  --provider generic_ssh \
  --public-key ./deploy.pub \
  --private-key ./deploy \
  --host-key 'ssh-ed25519 AAAA…' \
  --site web
```

Existing Forge-style `site.repository` configuration can be imported without editing the config:

```bash
GITHUB_TOKEN=… cloud git:import --yes
```

The importer preserves each site's branch or tag strategy and binds it to the matching application resource.

## Automation API

Organization-scoped service-account tokens with `sources:read` can list source metadata. `sources:manage` creates connections/bindings/hooks, synchronizes repositories, and disconnects credentials. The OpenAPI 3.1 contract is available at `/api/v1/openapi.json`.

```bash
curl https://dashboard.example.com/api/v1/source/connections \
  -H "authorization: Bearer $TS_CLOUD_TOKEN"

curl -X POST https://dashboard.example.com/api/v1/source/connections \
  -H "authorization: Bearer $TS_CLOUD_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "provider":"generic_https",
    "name":"Private Git",
    "host":"https://git.example",
    "authKind":"access_token",
    "token":"write-only-value",
    "repositoryFullName":"acme/web",
    "repositoryUrl":"https://git.example/acme/web.git"
  }'
```

The response never echoes `token`, application private keys, deploy private keys, or webhook signing secrets. Connection deletion accepts `{"id":"…","preview":true}` to return affected bindings before making the change.

## Security and failure behavior

- Provider credentials, deploy private keys, webhook secrets, and webhook endpoint tokens use authenticated encryption in the control-plane database.
- Clone URLs containing embedded credentials are rejected. HTTPS credentials are injected only into the child Git process environment.
- Raw request bytes are verified before webhook JSON is parsed. Provider delivery IDs provide replay protection.
- Provider requests use bounded timeouts, reject pagination that leaves the configured origin, and return sanitized errors.
- Disconnecting a connection erases its encrypted provider credential and disables its bindings and hooks in one transaction.
- An expired, degraded, or disconnected connection is visible as unhealthy and never silently falls back to another credential.

If repository discovery returns nothing, verify that the repository was granted to the app/token and then synchronize again. If a manual webhook remains pending, set `TS_CLOUD_WEBHOOK_BASE_URL` and reconcile it. If SSH reference discovery fails, compare the recorded clone host and pinned host key with the Git server before rotating anything.

## See also

- [API & automation](/features/api-automation)
- [Preview environments](/features/preview-environments)
- [Laravel deployments](/features/laravel)
- [Security posture](/features/security-posture)
