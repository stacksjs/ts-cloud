# Dashboard & Collaborators

The management dashboard is the cockpit for a server: sites, deployments, logs, metrics, databases, firewall and a web terminal. It is deployed automatically with every server deploy, at `dashboard.<your-domain>`.

One box often hosts sites for more than one party. You own the server; other people own individual sites on it. The dashboard is built around that: you can invite someone to a single site, and they see that site and nothing else.

## The access model

There are two levels.

**Box role** — what someone is on the server as a whole:

| Role | Reach |
|---|---|
| `admin` | The box owner. Everything: every site, plus the shell, SSH keys, firewall, databases and cloud config. |
| `member` | Only the sites they have been granted, and never the box itself. |

**Site grants** — a member holds one role per site:

| Site role | Can |
|---|---|
| `owner` | View the site, deploy it, and change its settings (domain, TLS, env, aliases, redirects). |
| `collaborator` | View the site and deploy it. |

A member with a grant on `blog` sees `blog`: its deployments, its log lines, its TLS certificate. They do not see other sites on the box, and they do not see the box's own metrics, services, open ports, SSH keys or backups.

### What members can never do

Box-level capabilities are **admin-only and not grantable per site**:

- the web terminal and arbitrary remote commands
- SSH keys
- the host firewall
- databases and database users
- editing the cloud config, or switching the active environment
- creating or deleting sites
- managing collaborators
- the serverless surface (it is account-wide, not per-site)

This is deliberate, and it is not a matter of taste. Each of those is root on a server that hosts other people's sites: a shell on the box reads every tenant's files, so handing one site's collaborator a terminal would hand them every other site. There is no grant that unlocks them.

## Inviting someone

Open **Team** in the dashboard, enter a username, set a role per site, and send the invite. A password is generated and shown **once** — copy it and send it over a channel you trust. Only its scrypt hash is stored.

To change what someone can reach, invite them again with different grants; to revoke access entirely, remove them. Both take effect on their next request, not when their session expires.

The same thing over the API (admin session required):

```bash
# Invite dana as the owner of the blog site
curl -X POST https://dashboard.example.com/api/users \
  -H 'content-type: application/json' \
  -d '{"username":"dana","name":"Dana","sites":{"blog":"owner"}}'

# Revoke
curl -X DELETE https://dashboard.example.com/api/users \
  -H 'content-type: application/json' \
  -d '{"username":"dana"}'
```

## The first admin

On first start the dashboard creates one admin and prints its password once:

```
ts-cloud dashboard: created the first admin.
  username: admin
  password: 7xClHv0FROAQ086cKWExUQnu
```

Set `TS_CLOUD_UI_PASSWORD` before the first start to choose it yourself, and `TS_CLOUD_UI_USERNAME` to change the name from `admin`.

Lost it? Delete `.ts-cloud/dashboard-users.json` on the deploy host and restart — a new admin is minted. This removes every invited collaborator too, since the file is the store.

## Where state lives

Both files are written `0600`, and neither belongs in git:

| File | Holds |
|---|---|
| `.ts-cloud/dashboard-users.json` | Users, scrypt password hashes, site grants |
| `.ts-cloud/dashboard-secret` | The session signing key. Rotating it signs everyone out. |

Sessions are stateless signed cookies (`HttpOnly`, `SameSite=Lax`, `Secure` off loopback) and last 8 hours. The user is re-read from the store on every request, so a revoked grant applies immediately.

## Environment variables

| Variable | Effect |
|---|---|
| `TS_CLOUD_UI_PASSWORD` | The first admin's password (otherwise generated). |
| `TS_CLOUD_UI_USERNAME` | The first admin's username. Default `admin`. |
| `TS_CLOUD_UI_DOMAIN` | Dashboard host. Default `dashboard.<apex>`. |
| `TS_CLOUD_UI_DISABLE` | Skip deploying the dashboard. |
| `TS_CLOUD_DASHBOARD_SECRET` | Session signing key. Generated and persisted if unset. |
| `TS_CLOUD_DASHBOARD_TERMINAL` | `0` disables the web terminal. |
| `TS_CLOUD_DASHBOARD_AUTH` | `0` disables authentication. Local development only — **refused in box mode**, where the dashboard is internet-facing and this would expose a root shell. |

## Running it locally

```bash
cloud dashboard:serve --port 7788
```

It serves `<http://127.0.0.1:7788>` against your `cloud.config.ts`, resolving live data from the box when it can reach one and falling back to config-derived data when it cannot.

## How enforcement works

Worth knowing if you are reviewing or extending this:

- **One table.** Every API route maps to a capability in `dashboard-policy.ts`. A route with no entry resolves to the most privileged capability, so adding a route and forgetting its policy locks members out rather than exposing it. A test scans the server for the routes it implements and asserts each one was given an entry.
- **One decision point.** `authorize()` in `dashboard-auth.ts` answers every question, and denies anything it does not recognize.
- **Data is withheld, not hidden.** A member's `/api/dashboard-data` payload is filtered server-side before it is serialized. The dashboard's pages render their data at build time, so the UI is built once per distinct access scope and cached — a member's HTML contains only their own sites. Filtering in the browser would leave the rest one devtools tab away.
- **The UI only reflects this.** Members are not offered box-level pages or buttons, but that is presentation. Access is checked on every request regardless of what was rendered.

## See also

- [Security](/features/security) — pre-deployment secret scanning
- [Laravel (Forge replacement)](/features/laravel) — server deployments
