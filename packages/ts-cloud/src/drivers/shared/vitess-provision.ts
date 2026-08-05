/**
 * Vitess provisioning.
 *
 * Two modes, because "run Vitess" means two very different things depending on
 * why you are doing it:
 *
 * - **`combo`** runs the entire stack inside a single `vtcombo` process with
 *   an in-memory topology. It is the right answer for development and CI: one
 *   unit, one port, nothing to bootstrap, and it goes away cleanly. It is not
 *   durable and must never be used for real data.
 * - **`cluster`** runs the real daemons (etcd, vtctld, vttablet beside a
 *   managed mysqld, vtgate) as separate systemd units on the box, with the
 *   ordering and topology bootstrap they require.
 *
 * ## What cluster mode is and is not
 *
 * This provisions a **single-box** Vitess: every component on one machine.
 * That is a genuine deployment for staging, small production, and any case
 * where you want Vitess's online DDL and query routing without yet needing
 * horizontal scale. It is deliberately NOT a multi-box sharded cluster:
 * spreading tablets across machines means per-shard placement, cross-box
 * topology, and reparent policy, which are decisions an operator has to make
 * rather than defaults a provisioner should invent.
 *
 * So a sharded keyspace here has its shards' tablets on one host. That gives
 * you the routing and DDL semantics of Vitess and none of the fault
 * tolerance, which is the honest trade and is stated in the config docs.
 *
 * ## Ordering is the whole problem
 *
 * Vitess daemons are not independent. vtctld and vttablet both need the
 * topology store; vttablet also needs its mysqld; vtgate needs topology to
 * route. Starting them in the wrong order does not fail cleanly - components
 * retry, so a mis-ordered stack comes up "green" and then behaves oddly under
 * load. The units below encode the dependency graph in `After=`/`Requires=`
 * so systemd enforces it rather than relying on retry luck.
 */

import type { VitessKeyspaceConfig, VitessServiceConfig } from '@ts-cloud/core'
import type { PantrySpec } from './package-manager'
import { buildPantryInstallScript, PANTRY_PROJECT_DIR } from './package-manager'

/** Where pantry exposes installed binaries. */
export const PANTRY_BIN: string = `${PANTRY_PROJECT_DIR}/pantry/.bin`

/** vtgate's MySQL-protocol port. Applications connect here. */
export const VTGATE_MYSQL_PORT = 15306
/** vtgate's gRPC port. */
export const VTGATE_GRPC_PORT = 15991
/** vtctld's gRPC port. `vtctldclient --server` targets this. */
export const VTCTLD_GRPC_PORT = 15999
/** vttablet's gRPC port. */
export const VTTABLET_GRPC_PORT = 16101
/** Where etcd listens for the topology store. */
export const ETCD_CLIENT_PORT = 2379

/** Root directory for Vitess state on the box. */
export const VITESS_ROOT = '/var/lib/vitess'

/**
 * Tablet UID for the single-box tablet.
 *
 * Shared by mysqlctld and vttablet on purpose: they must agree, because
 * Vitess derives the tablet's working directory (and therefore its mysqld
 * socket) from `$VTDATAROOT/vt_<uid>`. Two different values silently give
 * the tablet a mysqld it cannot find.
 */
export const VITESS_TABLET_UID = 100

/** Re-exported so callers of the provisioner need only one import. */
export type { VitessKeyspaceConfig, VitessServiceConfig }

export function enabled(value: boolean | VitessServiceConfig | undefined): value is true | VitessServiceConfig {
  return value === true || (typeof value === 'object' && value !== null)
}

function settings(value: boolean | VitessServiceConfig | undefined): VitessServiceConfig {
  return typeof value === 'object' && value !== null ? value : {}
}

/** Single-quote a value for safe embedding in generated shell. */
function sh(value: string | number): string {
  return `'${String(value).split("'").join("'\\''")}'`
}

/** Packages a Vitess box needs, given the mode and whether etcd is external. */
export function vitessPackages(config: VitessServiceConfig): PantrySpec[] {
  const version = config.version ? `vitess.io@${config.version}` : 'vitess.io'
  const packages: string[] = [version]
  // combo carries its own in-memory topology, and an external endpoint means
  // somebody else runs the store. Only a self-contained cluster needs etcd.
  if (config.mode !== 'combo' && !config.etcdEndpoint)
    packages.push('etcd.io')
  // Both modes need a real mysqld, which Vitess does not ship: a cluster's
  // vttablet manages one, and vtcombo starts its own via `--start-mysql`.
  // Omitting it from combo also broke the health gate, which invokes the
  // `mysql` client from this package.
  //
  // Pinned to the same GA release the rest of ts-cloud installs (see
  // `planServices`). Unpinned resolves to the newest tag, which is a 9.x
  // "innovation" release; that is how a box ended up with a mysqld linked
  // against an ICU it did not have, failing to start at all.
  packages.push('mysql.com@8.0.43')
  return packages as PantrySpec[]
}

/**
 * The unprivileged account every Vitess daemon runs as.
 *
 * Not a hardening nicety: Vitess refuses to start as root outright
 * ("running this as root makes no sense" from servenv.Init), so a unit with
 * no `User=` crash-loops immediately on every daemon.
 */
export const VITESS_USER = 'vitess'

/**
 * PATH for the units.
 *
 * systemd gives a service a minimal PATH that does not include pantry's bin
 * directory. `mysqlctld` shells out to find `mysqld` and panics with
 * "VT_MYSQL_ROOT is not set and no mysqld could be found in your PATH"
 * without this, and `vttablet` needs the same to manage its mysqld.
 */
const UNIT_PATH = `${PANTRY_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`

/** Directory holding the generated launcher scripts. */
export const VITESS_LIB = '/usr/local/lib/vitess'

/**
 * Wrap a command so `VT_MYSQL_ROOT` is resolved when the unit starts.
 *
 * mysqlctld and vttablet locate mysqld under
 * `$VT_MYSQL_ROOT/{sbin,bin,libexec,scripts}`. Pantry exposes binaries from a
 * `.bin` symlink directory, so deriving the root from PATH lands on
 * `/opt/pantry/pantry` and the lookup fails with "mysqld not found in any
 * of ...". The real root is the versioned package directory
 * (`.../mysql.com/v9.6.0`), which changes on every mysql upgrade, so it is
 * resolved from the symlink at start rather than baked into the unit and
 * left to rot.
 */
/**
 * The body of a daemon launcher script.
 *
 * Every daemon runs through a script on disk rather than an inline
 * `ExecStart=/bin/sh -c '...'`. That is not stylistic: systemd parses
 * ExecStart itself, and it splits on `;`, expands `$VAR` before the shell
 * ever sees it, and strips quotes. An inline command was silently truncated
 * at its first semicolon, so the daemon launched with none of its flags and
 * printed usage instead of starting. A script file has none of those
 * hazards and can also be run by hand when debugging a box.
 *
 * Two things have to be resolved at start rather than baked in, because
 * pantry's paths are version-pinned and change on upgrade:
 *   - pantry's own environment, chiefly `LD_LIBRARY_PATH`; its binaries are
 *     dynamically linked inside its package tree and fail to load without it
 *   - `VT_MYSQL_ROOT` and `VTROOT`, which locate mysqld and
 *     `config/init_db.sql` respectively
 */
/**
 * Scripts to write, keyed by daemon name. Collected as units are built so
 * the provisioner can emit them before anything starts.
 */
const launchers = new Map<string, string>()

function launcherPath(name: string): string {
  return `${VITESS_LIB}/${name}.sh`
}

/** Record a launcher and return the ExecStart that runs it. */
function launcherFor(name: string, command: string[]): string {
  launchers.set(name, launcherScript(command))
  return `/bin/sh ${launcherPath(name)}`
}

/** The launcher scripts recorded so far, for inspection and testing. */
export function buildLaunchers(): Map<string, string> {
  return new Map(launchers)
}

/** The launcher scripts recorded so far, as shell that writes them. */
function buildLauncherScripts(): string[] {
  const out: string[] = [`mkdir -p ${VITESS_LIB}`]
  for (const [name, body] of launchers) {
    out.push(
      `cat > ${launcherPath(name)} <<'TS_CLOUD_VITESS_LAUNCHER_EOF'`,
      body,
      'TS_CLOUD_VITESS_LAUNCHER_EOF',
      `chmod 0755 ${launcherPath(name)}`,
    )
  }
  return out
}

function launcherScript(command: string[]): string {
  return [
    '#!/bin/sh',
    'set -e',
    `cd ${PANTRY_PROJECT_DIR}`,
    // `pantry env` prints a human sentence to STDOUT when it cannot detect a
    // project, and these units run as the `vitess` user, which has neither
    // root's HOME nor its pantry state - so it printed "No project detected in
    // current directory" and the eval tried to run a command called `No`.
    // `2>/dev/null` did not hide it (the message is on stdout) and `|| true`
    // swallowed the failure, so the environment was silently never set up.
    //
    // Take only lines that are actually assignments, so nothing else can ever
    // be executed by this eval.
    'PANTRY_ENV="$(pantry env 2>/dev/null | grep -E \'^(export [A-Za-z_]|[A-Za-z_][A-Za-z0-9_]*=)\' || true)"',
    'if [ -n "$PANTRY_ENV" ]; then eval "$PANTRY_ENV"; fi',
    `VT_MYSQL_ROOT="$(dirname "$(dirname "$(readlink -f ${PANTRY_BIN}/mysqld 2>/dev/null)")")"`,
    `VTROOT="$(dirname "$(dirname "$(readlink -f ${PANTRY_BIN}/mysqlctld 2>/dev/null)")")"`,
    'export VT_MYSQL_ROOT VTROOT',
    // Derived from the roots resolved above rather than from `pantry env`,
    // which is exactly the thing that turned out not to be dependable here.
    // mysqld links bundled libraries out of its own lib directory
    // (libprotobuf-lite among them); without this it exits 127 with
    // "error while loading shared libraries", and mysqlctld reports that as
    // "could not auto-detect MySQL version" - a message that says nothing
    // about the actual cause.
    'LD_LIBRARY_PATH="$VT_MYSQL_ROOT/lib:$VTROOT/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"',
    'export LD_LIBRARY_PATH',
    `exec ${command.join(' ')}`,
  ].join('\n')
}

interface UnitOptions {
  description: string
  execStart: string
  after?: string[]
  requires?: string[]
  environment?: Record<string, string>
  execStartPre?: string[]
}

function systemdUnit(opts: UnitOptions): string {
  const lines = [
    '[Unit]',
    `Description=${opts.description}`,
    `After=network.target${opts.after?.length ? ` ${opts.after.join(' ')}` : ''}`,
  ]
  // `Requires` propagates failure: if the topology store dies, the daemons
  // that cannot work without it stop too, rather than sitting in a retry loop
  // and reporting healthy.
  if (opts.requires?.length) lines.push(`Requires=${opts.requires.join(' ')}`)
  lines.push(
    '',
    '[Service]',
    'Type=simple',
    `User=${VITESS_USER}`,
    `Group=${VITESS_USER}`,
    `Environment="PATH=${UNIT_PATH}"`,
    // Vitess derives every per-tablet working directory from VTDATAROOT,
    // which defaults to `/vt`. The daemons run unprivileged and cannot
    // create a directory at the filesystem root, so mysqlctld dies with
    // "mkdir /vt: permission denied" without this.
    `Environment="VTDATAROOT=${VITESS_ROOT}"`,
    ...Object.entries(opts.environment ?? {}).map(([k, v]) => `Environment="${k}=${v}"`),
    ...(opts.execStartPre ?? []).map(c => `ExecStartPre=${c}`),
    `ExecStart=${opts.execStart}`,
    'Restart=always',
    'RestartSec=5',
    // Vitess daemons open many connections and files; the default 1024 is
    // reached quickly by vtgate under even modest load.
    'LimitNOFILE=65535',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  )
  return lines.join('\n')
}

function writeUnit(name: string, body: string): string[] {
  return [
    `cat > /etc/systemd/system/${name}.service <<'TS_CLOUD_VITESS_UNIT_EOF'`,
    body,
    'TS_CLOUD_VITESS_UNIT_EOF',
  ]
}

/**
 * The single-process development stack.
 *
 * `vtcombo` runs vtgate, vttablet, and vtctld together against an in-memory
 * topology, so there is nothing to order and nothing to bootstrap. The
 * keyspaces are declared on the command line and exist from the first start.
 */
export function buildVtcomboUnit(config: VitessServiceConfig): string {
  const cell = config.cell ?? 'zone1'
  const port = config.vtgatePort ?? VTGATE_MYSQL_PORT
  // `--proto-topo` takes a `vttest.VTTestTopology` in protobuf COMPACT TEXT
  // format, not a `keyspace/shard` string. The proto is
  // `repeated Keyspace keyspaces` where each `Keyspace` has a name and
  // `repeated Shard shards`, each with a name. An unsharded keyspace has the
  // single shard `0`; a sharded one is split at the midpoint of the keyrange.
  const keyspaces = (config.keyspaces?.length ? config.keyspaces : [{ name: 'app' }])
    .map((k) => {
      const shards = (k.sharded ? ['-80', '80-'] : ['0'])
        .map(s => `shards:{name:"${s}"}`)
        .join(' ')
      return `keyspaces:{name:"${k.name}" ${shards}}`
    })
    .join(' ')
  const topology = `${keyspaces} cells:"${cell}"`

  return systemdUnit({
    description: 'Vitess (vtcombo, single-process development stack)',
    execStart: launcherFor('vtcombo', [
      `${PANTRY_BIN}/vtcombo`,
      `--cell ${cell}`,
      `--proto-topo ${sh(topology)}`,
      `--mysql-server-port ${port}`,
      '--mysql-server-bind-address 127.0.0.1',
      // No auth in combo mode, and bound to loopback above so that is
      // contained. A combo stack must never be exposed.
      '--mysql-auth-server-impl none',
      // vtcombo does not embed storage: without this there is no mysqld
      // behind the tablet it runs, and every query fails.
      '--start-mysql',
      `--port ${VTGATE_GRPC_PORT}`,
      `--grpc-port ${VTCTLD_GRPC_PORT}`,
    ]),
  })
}

/** etcd, the topology store every real Vitess component reads. */
export function buildEtcdUnit(): string {
  return systemdUnit({
    description: 'etcd (Vitess topology store)',
    execStart: launcherFor('etcd', [
      `${PANTRY_BIN}/etcd`,
      `--data-dir ${VITESS_ROOT}/etcd`,
      `--listen-client-urls http://127.0.0.1:${ETCD_CLIENT_PORT}`,
      `--advertise-client-urls http://127.0.0.1:${ETCD_CLIENT_PORT}`,
    ]),
    execStartPre: [`+/bin/mkdir -p ${VITESS_ROOT}/etcd`, `+/bin/chown ${VITESS_USER}:${VITESS_USER} ${VITESS_ROOT}/etcd`],
  })
}

function topoFlags(config: VitessServiceConfig): string[] {
  const endpoint = config.etcdEndpoint ?? `http://127.0.0.1:${ETCD_CLIENT_PORT}`
  return [
    '--topo-implementation etcd2',
    `--topo-global-server-address ${endpoint}`,
    '--topo-global-root /vitess/global',
  ]
}

/** vtctld: the control plane `vtctldclient` talks to. */
export function buildVtctldUnit(config: VitessServiceConfig): string {
  const requiresEtcd = !config.etcdEndpoint
  return systemdUnit({
    description: 'Vitess vtctld (control plane)',
    after: requiresEtcd ? ['vitess-etcd.service'] : [],
    requires: requiresEtcd ? ['vitess-etcd.service'] : [],
    execStart: launcherFor('vtctld', [
      `${PANTRY_BIN}/vtctld`,
      ...topoFlags(config),
      `--cell ${config.cell ?? 'zone1'}`,
      `--service-map grpc-vtctl,grpc-vtctld`,
      `--grpc-port ${VTCTLD_GRPC_PORT}`,
      `--port ${VTCTLD_GRPC_PORT + 1}`,
    ]),
  })
}

/** vttablet: manages one mysqld and serves its shard. */
export function buildVttabletUnit(config: VitessServiceConfig, keyspace: string, shard: string): string {
  const cell = config.cell ?? 'zone1'
  return systemdUnit({
    description: `Vitess vttablet (${keyspace}/${shard})`,
    // Both dependencies are real: no topology means it cannot register, no
    // mysqld means it has nothing to serve.
    after: ['vitess-vtctld.service', 'vitess-mysqlctld.service'],
    requires: ['vitess-mysqlctld.service'],
    execStart: launcherFor('vttablet', [
      `${PANTRY_BIN}/vttablet`,
      ...topoFlags(config),
      `--tablet-path ${cell}-${String(VITESS_TABLET_UID).padStart(10, '0')}`,
      `--init-keyspace ${keyspace}`,
      `--init-shard ${shard}`,
      // Starts as a replica and is promoted by reparenting. Coming up as a
      // primary would let two primaries exist during a restart.
      '--init-tablet-type replica',
      `--service-map ${sh('grpc-queryservice,grpc-tabletmanager,grpc-updatestream')}`,
      `--port ${VTTABLET_GRPC_PORT}`,
      `--grpc-port ${VTTABLET_GRPC_PORT + 1}`,
      `--db-port ${config.mysqlPort ?? 3306}`,
      `--mycnf-mysql-port ${config.mysqlPort ?? 3306}`,
    ]),
  })
}

/** mysqlctld: the managed mysqld a tablet owns. */
export function buildMysqlctldUnit(config: VitessServiceConfig): string {
  return systemdUnit({
    description: 'Vitess mysqlctld (managed mysqld)',
    execStart: launcherFor('mysqlctld', [
      `${PANTRY_BIN}/mysqlctld`,
      // NOT --tablet-dir: that value is resolved relative to VTDATAROOT, so
      // an absolute path produces `/var/lib/vitess/var/lib/vitess/...` and
      // mysqld's socket never appears where the tablet looks for it. The uid
      // lets Vitess derive the directory itself, which is what upstream's
      // own example does.
      `--tablet-uid ${VITESS_TABLET_UID}`,
      `--mysql-port ${config.mysqlPort ?? 3306}`,
      // Creates the vt_dba/vt_app/vt_repl accounts vttablet needs. Without
      // it the tablet times out on "waiting for the dba user to have the
      // required permissions" and the shard never gets a primary.
      '--init-db-sql-file "$VTROOT/config/init_db.sql"',
      '--wait-time 2m',
    ]),
    execStartPre: [`+/bin/mkdir -p ${VITESS_ROOT}`, `+/bin/chown ${VITESS_USER}:${VITESS_USER} ${VITESS_ROOT}`],
  })
}

/** Where the generated vtgate credentials live. */
export const VITESS_AUTH_FILE = '/etc/vitess/auth.json'

/**
 * vtgate's static credentials file.
 *
 * vtgate defaults to `--mysql-auth-server-impl static` and exits with "no
 * AuthServer name static registered" when no credentials are supplied, so
 * this is required, not optional. The alternative Vitess offers is
 * `none`, which would leave an unauthenticated MySQL endpoint - acceptable
 * only for the loopback-bound combo stack, never for a cluster.
 */
export function buildVitessAuthFileScript(config: VitessServiceConfig): string[] {
  const user = config.username ?? 'vitess'
  const password = config.password ?? ''
  const auth = JSON.stringify({ [user]: [{ MysqlNativePassword: '', Password: password, UserData: user }] })
  return [
    'mkdir -p /etc/vitess',
    `cat > ${VITESS_AUTH_FILE} <<'TS_CLOUD_VITESS_AUTH_EOF'`,
    auth,
    'TS_CLOUD_VITESS_AUTH_EOF',
    // Contains a password: readable by the daemon, nobody else.
    `chown ${VITESS_USER}:${VITESS_USER} ${VITESS_AUTH_FILE}`,
    `chmod 0600 ${VITESS_AUTH_FILE}`,
  ]
}

/** vtgate: the query router applications connect to. */
export function buildVtgateUnit(config: VitessServiceConfig): string {
  const cell = config.cell ?? 'zone1'
  return systemdUnit({
    description: 'Vitess vtgate (query router)',
    after: ['vitess-vtctld.service'],
    execStart: launcherFor('vtgate', [
      `${PANTRY_BIN}/vtgate`,
      ...topoFlags(config),
      `--cell ${cell}`,
      `--cells-to-watch ${cell}`,
      // PRIMARY first so writes work; the replica types let read routing use
      // them once the app opts in.
      '--tablet-types-to-wait PRIMARY,REPLICA',
      // A daemon only serves the gRPC APIs its service map names; omitting
      // this leaves the port open and every RPC unimplemented.
      `--service-map ${sh('grpc-vtgateservice')}`,
      `--mysql-server-port ${config.vtgatePort ?? VTGATE_MYSQL_PORT}`,
      // Loopback by default: on the single-box model the application shares
      // this host, so exposing the database to the network buys nothing and
      // widens the blast radius. `bindAddress` opts into wider exposure.
      `--mysql-server-bind-address ${config.bindAddress ?? '127.0.0.1'}`,
      '--mysql-auth-server-impl static',
      `--mysql-auth-server-static-file ${VITESS_AUTH_FILE}`,
      `--port ${VTGATE_GRPC_PORT}`,
      `--grpc-port ${VTGATE_GRPC_PORT + 1}`,
    ]),
  })
}

/**
 * Bootstrap the topology: register the cell, then create each keyspace.
 *
 * Idempotent. `AddCellInfo` and `CreateKeyspace` both fail when the object
 * already exists, and a re-provision must not turn that into a failed deploy,
 * so each is guarded on the corresponding read.
 */
export function buildVitessBootstrapScript(config: VitessServiceConfig): string[] {
  const cell = config.cell ?? 'zone1'
  const endpoint = config.etcdEndpoint ?? `http://127.0.0.1:${ETCD_CLIENT_PORT}`
  const client = `${PANTRY_BIN}/vtctldclient --server 127.0.0.1:${VTCTLD_GRPC_PORT}`
  const out: string[] = [
    // vtctld accepts connections a moment after systemd reports the unit
    // started; without this the first command races it and the whole
    // bootstrap fails on a cluster that is actually fine.
    `for i in $(seq 1 30); do ${client} GetCellInfoNames >/dev/null 2>&1 && break; sleep 2; done`,
    `if ! ${client} GetCellInfoNames 2>/dev/null | grep -qx ${sh(cell)}; then`,
    `  ${client} AddCellInfo --root ${sh(`/vitess/${cell}`)} --server-address ${sh(endpoint)} ${sh(cell)}`,
    'fi',
  ]

  for (const keyspace of config.keyspaces ?? []) {
    const sharded = keyspace.sharded ? ' --sharded' : ''
    out.push(
      // `GetKeyspaces` prints JSON, so a line-match against it never fired
      // and CreateKeyspace ran on every re-provision, failing with "node
      // already exists". `GetKeyspace <name>` exits non-zero when absent,
      // which is an existence check rather than a parse.
      `if ! ${client} GetKeyspace ${sh(keyspace.name)} >/dev/null 2>&1; then`,
      `  ${client} CreateKeyspace${sharded} ${sh(keyspace.name)}`,
      'fi',
    )

    // Elect a primary for every shard.
    //
    // A tablet starts as a replica (see buildVttabletUnit), so a freshly
    // created shard has none. Vitess routes writes to the primary, and a
    // shard without one answers reads and silently fails writes - which does
    // not look like a broken cluster, just a broken application. The
    // provision is not finished until each shard can take a write.
    //
    // Guarded on the current state so a re-provision does not reparent a
    // healthy shard, which would be a needless failover.
    const alias = `${cell}-${String(VITESS_TABLET_UID).padStart(10, '0')}`
    for (const shard of keyspace.sharded ? ['-80', '80-'] : ['0']) {
      const target = `${keyspace.name}/${shard}`
      out.push(
        // Waiting for the tablet RECORD is not enough, and that is what this
        // used to do. vttablet registers within seconds of systemd starting
        // it, but a promotion also needs its mysqld, and mysqlctld spends
        // about two minutes initializing a fresh data directory on first boot.
        // The single attempt that followed therefore ran far too early and
        // failed with "node doesn't exist: .../shards/0/", leaving a shard
        // with no primary and a cluster that answered SHOW KEYSPACES but no
        // query: "no healthy tablet available for ... PRIMARY".
        //
        // Retry the promotion itself instead of trying to predict when its
        // preconditions are met. It is idempotent, and succeeding is the only
        // evidence that everything underneath it is actually up.
        `for i in $(seq 1 90); do`,
        `  if ${client} GetShard ${sh(target)} 2>/dev/null | grep -q '"primary_alias": *"[^"]'; then break; fi`,
        `  ${client} PlannedReparentShard ${sh(target)} --new-primary ${sh(alias)} >/dev/null 2>&1 && break`,
        `  ${client} InitShardPrimary --force ${sh(target)} ${sh(alias)} >/dev/null 2>&1 && break`,
        '  sleep 2',
        'done',
        `if ! ${client} GetShard ${sh(target)} 2>/dev/null | grep -q '"primary_alias": *"[^"]'; then`,
        `  echo "no primary could be elected for ${target}" >&2; exit 1`,
        'fi',
      )
    }
  }

  return out
}

/**
 * Wait until vtgate actually answers on its MySQL port.
 *
 * The deploy should fail here rather than later: a box that finished
 * provisioning with a vtgate that never came up will accept a deploy and then
 * fail every request, which is much harder to attribute.
 */
export function buildVitessHealthCheck(config: VitessServiceConfig): string[] {
  const port = config.vtgatePort ?? VTGATE_MYSQL_PORT
  return [
    `for i in $(seq 1 60); do`,
    `  if (cd ${PANTRY_PROJECT_DIR} && eval "$(pantry env 2>/dev/null)"; MYSQL_PWD=${sh(config.password ?? '')} ${PANTRY_BIN}/mysql -h 127.0.0.1 -P ${port} -u ${sh(config.username ?? 'vitess')} --connect-timeout=2 -e 'SHOW KEYSPACES') >/dev/null 2>&1; then`,
    `    echo "vtgate is serving on ${port}"; exit 0`,
    '  fi',
    '  sleep 2',
    'done',
    `echo "vtgate did not become ready on port ${port}" >&2`,
    'exit 1',
  ]
}

/**
 * Full provisioning script for a Vitess box.
 *
 * Order matters and is deliberate: install, write every unit, reload systemd
 * ONCE, then start in dependency order, then bootstrap, then health-gate.
 * Reloading per-unit would make systemd act on a half-written stack.
 */
export function buildVitessProvisionScript(value: boolean | VitessServiceConfig | undefined): string[] {
  if (!enabled(value)) return []
  const config = settings(value)
  const combo = config.mode === 'combo'

  // Launchers accumulate as units are built, and the registry is module
  // scoped, so a previous call in the same process would otherwise leak its
  // scripts into this one - a cluster provision emitting a vtcombo launcher,
  // for instance. Each provision starts from empty.
  launchers.clear()

  const out: string[] = [
    ...buildPantryInstallScript(vitessPackages(config)),
    // Register mysqld's own library directory with the dynamic linker.
    //
    // Exporting LD_LIBRARY_PATH from the unit launcher is not enough. mysqlctld
    // runs `mysqld --initialize-insecure` directly, which inherits it and
    // works, but it STARTS the server through `mysqld_safe`, and mysqld does
    // not receive it there. The result was a data directory that initialized
    // perfectly and a server that then would not boot:
    //
    //   mysqld: error while loading shared libraries: libprotobuf-lite.so.24.4.0
    //
    // which mysqlctld reports as "could not auto-detect MySQL version" and then
    // "deadline exceeded waiting for mysqld socket file to appear" - neither of
    // which mentions a missing library. Registering the directory makes the
    // library resolvable however mysqld is launched, including under an empty
    // environment. Written at provision time because the path carries the
    // package version and is only known once pantry has installed it.
    `VT_MYSQL_LIB="$(dirname "$(dirname "$(readlink -f ${PANTRY_BIN}/mysqld)")")/lib"`,
    'if [ -d "$VT_MYSQL_LIB" ]; then',
    '  printf \'%s\\n\' "$VT_MYSQL_LIB" > /etc/ld.so.conf.d/vitess-mysql.conf',
    '  ldconfig',
    'else',
    '  echo "mysqld library directory not found under $VT_MYSQL_LIB" >&2; exit 1',
    'fi',
    // Created before any unit is written: the daemons refuse to run as root,
    // and they need to own their state directory to start at all.
    `id -u ${VITESS_USER} >/dev/null 2>&1 || useradd --system --home-dir ${VITESS_ROOT} --shell /usr/sbin/nologin ${VITESS_USER}`,
    `mkdir -p ${VITESS_ROOT}`,
    `chown -R ${VITESS_USER}:${VITESS_USER} ${VITESS_ROOT}`,
  ]

  if (combo) {
    out.push(
      ...writeUnit('vitess-vtcombo', buildVtcomboUnit(config)),
      ...buildLauncherScripts(),
      'systemctl daemon-reload',
      'systemctl enable --now vitess-vtcombo.service',
      ...buildVitessHealthCheck(config),
    )
    return out
  }

  out.push(...buildVitessAuthFileScript(config))

  const units: Array<[string, string]> = []
  if (!config.etcdEndpoint) units.push(['vitess-etcd', buildEtcdUnit()])
  units.push(
    ['vitess-vtctld', buildVtctldUnit(config)],
    ['vitess-mysqlctld', buildMysqlctldUnit(config)],
    ['vitess-vtgate', buildVtgateUnit(config)],
  )

  // One tablet per keyspace/shard. Single-box, so they share a host; see the
  // module header for why that is a deliberate limit rather than an oversight.
  for (const keyspace of config.keyspaces ?? []) {
    for (const shard of keyspace.sharded ? ['-80', '80-'] : ['0'])
      units.push([`vitess-vttablet-${keyspace.name}-${shard.replace(/-/g, 'x')}`, buildVttabletUnit(config, keyspace.name, shard)])
  }

  for (const [name, body] of units) out.push(...writeUnit(name, body))

  // Written after the units, because building the units is what registers
  // the launchers, and before daemon-reload so nothing can start without one.
  out.push(...buildLauncherScripts())

  out.push('systemctl daemon-reload')
  // Started in dependency order. systemd would resolve this from the unit
  // relationships anyway; doing it explicitly means the provisioning log
  // reads in the order things actually came up, which is what an operator
  // debugging a failed provision needs.
  for (const [name] of units) out.push(`systemctl enable --now ${name}.service`)

  out.push(...buildVitessBootstrapScript(config), ...buildVitessHealthCheck(config))
  return out
}
