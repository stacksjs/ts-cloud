# Remote Run: Site Inventory, Kubernetes and Host Keys

Three library APIs for a tool that opens a session in something already
deployed and runs code there: a REPL, a log tail, a one-off script. They are
read-only towards your infrastructure, write nothing on the target, and shell
out to the system `ssh` and `kubectl` with a fixed argument vector.

| Need | API |
| --- | --- |
| Where is each site, and how do I get a shell in it? | [`listDeployedSites`](#site-inventory) |
| Pods, `exec` and `logs` on a cluster | [`KubectlClient`](#kubernetes) |
| A checked SSH host key for a person at a keyboard | [`resolveSshHostKey`](#host-key-policy) |
| The process as a live stream, locally or over SSH | [`streamSshCommand`](#streams) |

```ts
import {
  deployedSiteSshVia,
  KubectlClient,
  listDeployedSites,
  streamSshCommand,
} from '@stacksjs/ts-cloud'
```

## Site inventory

`listDeployedSites` returns every server-deployed site of a project and
environment with the full address a session needs.

```ts
const inventory = await listDeployedSites({ config, environment: 'production' })

for (const site of inventory.sites) {
  site.name          // 'api' (the key in cloud.config.ts)
  site.hosts         // [{ ipv4, ipv6, address, name, status, source }]
  site.ssh           // { user, port, identityFile, hostKey }
  site.appPath       // '/var/www/acme-api/current'
  site.envFile       // '/var/www/acme-api/shared/.env'
  site.runtime       // { kind: 'systemd', unit: 'acme-api.service', instancePattern: 'acme-api@*.service' }
  site.hostnames     // ['api.acme.com', 'api2.acme.com']
}
```

### Nothing is guessed

Every field comes from the function the deploy uses to produce it, so the
inventory cannot drift from what is on the box:

| Field | Derived from |
| --- | --- |
| Stack and state file | `resolveProjectStackName`, then `storage/cloud/state/<stack>.json` (or `<stateDir>/state/`) |
| Host | The state file's pinned server ids, then the `ts-cloud/project`, `environment` and `role` labels: the order a deploy resolves its targets in |
| SSH user | The user the state file recorded at the last deploy, then `hetzner.sshUser` / `ssh.hosts[].user`, then the environment, then the default |
| SSH key | `hetzner.sshPrivateKeyPath` / `ssh.hosts[].privateKeyPath`, expanded to an absolute path. The path only: the key is never read |
| `installBase`, `appPath`, `envFile` | `siteInstallBase(slug, site)` and the release layout (`current`, `shared/.env`) |
| `runtime` | `<slug>-<site>.service`, the unit the deploy script writes; `instancePattern` when the site cuts over with one instance per release |
| `hostnames` | The rpx registry fragment the deploy writes for that site: its domain and aliases |

### One list call, or none

The inventory reads the pinned state file and makes at most one provider
listing. With no API token it answers from the state file alone, which is the
normal case for a project attached to someone else's box (`cloud.attachTo`):
the tenant's own state file pins the owner's server, and that pin is what
resolves the host, not the labels (those name the owner).

```ts
// Never call a provider.
await listDeployedSites({ config, environment: 'production', listServers: false })

// Bring your own listing.
await listDeployedSites({ config, environment: 'production', listServers: () => myServers() })
```

`host.source` says how each host was identified: `state-pin` (matched in a
live listing by the pinned id), `state-file` (the address recorded at the last
deploy; status `unknown`) or `labels`.

A listing that fails degrades to the state file. A pin that is stale is not
used, and `inventory.warnings` says why: the server was deleted, turned off,
or is now named something other than what the pin recorded. A site with no
resolvable host is still returned, with `hosts: []`, because its paths and
unit are still true.

### Shared boxes and the app path

On a shared box each project's sites live under its own slug, so two projects
with a `main` site do not collide:

```
/var/www/acme-main/current      # the owner
/var/www/tenant-main/current    # an attached tenant
```

`appPath` is always this slug-prefixed form. `legacyAppPath`
(`/var/www/<site>/current`) is where a deploy from before directories were
namespaced put a site, and where a hand-built one may still be. It is offered
as a candidate, never as the answer. To settle it, run the probe on the box:

```ts
import { buildAppPathProbeScript, parseAppPathProbe } from '@stacksjs/ts-cloud'

const via = deployedSiteSshVia(site)
const probe = await streamSshCommand(via, ['sh', '-s'], { stdin: buildAppPathProbeScript(site) }).collect()
const appPath = parseAppPathProbe(probe.stdout) // undefined when neither exists
```

### What is not listed

Bucket, redirect and proxy sites have no directory on a server. They are
returned in `inventory.skipped` with the reason, not silently dropped.

### Runtime kinds

| `runtime.kind` | Site | Notes |
| --- | --- | --- |
| `systemd` | An app with `start` | `unit` is stable across releases. `journalctl -u` accepts `instancePattern` |
| `php-fpm` | Laravel / PHP | nginx and php-fpm; the site has no unit of its own |
| `static` | Files served by the gateway | No process, but `appPath` is real |
| `docker` | Never derived | ts-cloud does not run sites as containers. Pass `runtimes: { worker: { kind: 'docker', container } }` when you discovered one yourself |

### What the box actually routes

`hostnames` is what the deploy would write. To compare against what the box
serves, read its fragments with the existing `probeHostRoutes` and pass them
in; each site then carries `routedHostnames`.

## Kubernetes

`KubectlClient` drives the system `kubectl`. There is no Kubernetes client
library and no API call of ts-cloud's own: kubectl already handles
kubeconfigs, credential plugins and API versions.

```ts
const kubectl = new KubectlClient({
  kubeconfig: '/Users/me/.kube/config', // optional; kubectl's own lookup otherwise
  context: 'prod-eu',                   // optional; the current context otherwise
})

await kubectl.listContexts()               // [{ name, current }]
await kubectl.listNamespaces()             // [{ name, phase, createdAt }]
await kubectl.listPods({ namespace: 'shop' }) // pods with their containers
```

A pod's `status` is the one `kubectl get pods` prints: `CrashLoopBackOff`,
not the `Running` phase that hides it. `defaultContainer` follows kubectl's
rule (the `kubectl.kubernetes.io/default-container` annotation, else the first
container).

### exec with stdin

The script travels over stdin. It is never part of the command line, on your
machine or in the pod.

```ts
const run = kubectl.exec({
  namespace: 'shop',
  pod: 'web-5d4f7c9b8-x2k4p',
  container: 'app',
  command: ['bun', 'run', '-'],
  stdin: 'console.log(await User.count())',
})

for await (const chunk of run) {
  // chunk.stream is 'stdout' or 'stderr'; chunk.data is text
}
const { code } = await run.exited
```

`stdin` takes a string, bytes, a `ReadableStream`, or `'pipe'` to write
incrementally through `run.stdin`. Omit it and `--stdin` is not passed. A
non-zero exit is reported by `exited`, not thrown: the output up to that point
is what you wanted.

### logs

```ts
const controller = new AbortController()
const tail = kubectl.logs({
  namespace: 'shop',
  pod: 'web-5d4f7c9b8-x2k4p',
  follow: true,
  tail: 200,
  since: '10m',        // or a Date
  timestamps: true,
  signal: controller.signal,
})
for await (const chunk of tail) render(chunk.data)
```

A followed log stays open until you abort it, call `tail.kill()`, or leave the
loop (which kills the process so nothing fills a pipe nobody reads).

### Fixed argv

Every call is an argument array. Names are whole arguments and are rejected if
they start with `-`, so a pod cannot be named into a flag. The command an
`exec` runs sits after `--`. `kubectl.command(args)` returns the exact argv a
call would run.

### Through SSH

Set `via` to run the same commands on another machine: a cluster reachable
only from a bastion, or k3s on the box itself. `kubeconfig` is then a path on
that host.

```ts
const k3s = new KubectlClient({
  via: deployedSiteSshVia(site),
  kubeconfig: '/etc/rancher/k3s/k3s.yaml',
})
```

The argv is quoted argument by argument for the remote shell and sent with
`ssh -T` over the deploy transport's options, so what the remote kubectl
receives is byte for byte what a local one would.

### In the runtime inventory

`KubernetesDiscoveryAdapter` and `kubernetesWorkloads` map pods onto
`RuntimeWorkload` (`provider: 'kubernetes'`, `kind: 'pod'`), beside the
systemd and docker adapters:

```ts
new KubernetesDiscoveryAdapter(() => kubectl.podsJson({ allNamespaces: true }), 'kubernetes:prod-eu')
```

## Streams

`exec`, `logs` and `streamSshCommand` return a `ProcessStream`:

| Member | |
| --- | --- |
| `for await (const chunk of stream)` | `{ stream: 'stdout' \| 'stderr', data }` as it arrives |
| `exited` | `{ code, signal }` once the process is gone and both pipes are drained |
| `collect()` | Drain it and return `{ code, signal, stdout, stderr }` |
| `kill()` | Stop it |
| `stdin` | `write()` / `end()`, when opened with `stdin: 'pipe'` |
| `command` | The exact argv that was spawned |

Run a script in a deployed site:

```ts
const site = inventory.sites.find(s => s.name === 'api')!
const run = streamSshCommand(deployedSiteSshVia(site), ['bun', 'run', '-'], {
  cwd: site.appPath,
  stdin: code,
})
```

Chunks have the shape of `RuntimeStreamChunk`, so a stream drops into a
`RuntimeStreamRegistry` when you want a bounded, reconnectable buffer.
Cancelling the entry kills the process:

```ts
const entry = registry.create('exec', workloadId)
await pumpProcessStream(registry, entry.id, run) // closes 'complete' or 'failed'
```

## Host-key policy

A deploy reaches a box the provider API just identified, so it does not check
the host key. An interactive session has no such voucher at the moment it
connects, and it is about to pipe code into a production machine. The
inventory and the SSH-backed paths above therefore check the key by default.

| Policy | ssh option | Behaviour |
| --- | --- | --- |
| `accept-new` (interactive default) | `StrictHostKeyChecking=accept-new` | Trust on first contact, refuse a changed key after |
| `pin` | `StrictHostKeyChecking=yes` | Refuse any host not already recorded. Call `ensureHostKey` first to scan and record it |
| `insecure` | `StrictHostKeyChecking=no` | Never check. What deploys do. Available only by name |

Keys are recorded in `<stateDir>/ssh/known_hosts`, not in your
`~/.ssh/known_hosts`.

```ts
import { interactiveSshOptions, resolveSshHostKey, SystemSshTransport } from '@stacksjs/ts-cloud'

// Per inventory
await listDeployedSites({ config, environment: 'production', hostKeyPolicy: 'pin' })

// Per transport
const options = interactiveSshOptions({ user: 'deploy', identityFile, hostKeyPolicy: 'pin' })
const { fingerprint, pinnedNow } = await new SystemSshTransport(options).ensureHostKey(host)

// Just the hostKey value
resolveSshHostKey('accept-new', { knownHostsFile: '/custom/known_hosts' })
```

If a box is rebuilt its key changes and a checked connection is refused. That
is the policy working. Remove the old line from the known_hosts file above
once you have confirmed the rebuild.

Deploy behaviour is unchanged: the cloud drivers still connect
without checking, and the `ssh` driver still follows `ssh.hostKey` (default
`pin`).
