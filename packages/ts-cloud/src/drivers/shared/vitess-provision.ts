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
  packages.push('mysql.com')
  return packages as PantrySpec[]
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
    execStart: [
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
    ].join(' '),
  })
}

/** etcd, the topology store every real Vitess component reads. */
export function buildEtcdUnit(): string {
  return systemdUnit({
    description: 'etcd (Vitess topology store)',
    execStart: [
      `${PANTRY_BIN}/etcd`,
      `--data-dir ${VITESS_ROOT}/etcd`,
      `--listen-client-urls http://127.0.0.1:${ETCD_CLIENT_PORT}`,
      `--advertise-client-urls http://127.0.0.1:${ETCD_CLIENT_PORT}`,
    ].join(' '),
    execStartPre: [`/bin/mkdir -p ${VITESS_ROOT}/etcd`],
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
    execStart: [
      `${PANTRY_BIN}/vtctld`,
      ...topoFlags(config),
      `--cell ${config.cell ?? 'zone1'}`,
      `--service-map grpc-vtctl,grpc-vtctld`,
      `--grpc-port ${VTCTLD_GRPC_PORT}`,
      `--port ${VTCTLD_GRPC_PORT + 1}`,
    ].join(' '),
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
    execStart: [
      `${PANTRY_BIN}/vttablet`,
      ...topoFlags(config),
      `--tablet-path ${cell}-0000000100`,
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
    ].join(' '),
  })
}

/** mysqlctld: the managed mysqld a tablet owns. */
export function buildMysqlctldUnit(config: VitessServiceConfig): string {
  return systemdUnit({
    description: 'Vitess mysqlctld (managed mysqld)',
    execStart: [
      `${PANTRY_BIN}/mysqlctld`,
      `--tablet-dir ${VITESS_ROOT}/vt_0000000100`,
      `--mysql-port ${config.mysqlPort ?? 3306}`,
      '--wait-time 2m',
    ].join(' '),
    execStartPre: [`/bin/mkdir -p ${VITESS_ROOT}`],
  })
}

/** vtgate: the query router applications connect to. */
export function buildVtgateUnit(config: VitessServiceConfig): string {
  const cell = config.cell ?? 'zone1'
  return systemdUnit({
    description: 'Vitess vtgate (query router)',
    after: ['vitess-vtctld.service'],
    execStart: [
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
      '--mysql-server-bind-address 0.0.0.0',
      `--port ${VTGATE_GRPC_PORT}`,
      `--grpc-port ${VTGATE_GRPC_PORT + 1}`,
    ].join(' '),
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
      `if ! ${client} GetKeyspaces 2>/dev/null | grep -qx ${sh(keyspace.name)}; then`,
      `  ${client} CreateKeyspace${sharded} ${sh(keyspace.name)}`,
      'fi',
    )
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
    `  if ${PANTRY_BIN}/mysql -h 127.0.0.1 -P ${port} -u root --connect-timeout=2 -e 'SHOW KEYSPACES' >/dev/null 2>&1; then`,
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

  const out: string[] = [...buildPantryInstallScript(vitessPackages(config))]

  if (combo) {
    out.push(
      ...writeUnit('vitess-vtcombo', buildVtcomboUnit(config)),
      'systemctl daemon-reload',
      'systemctl enable --now vitess-vtcombo.service',
      ...buildVitessHealthCheck(config),
    )
    return out
  }

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

  out.push('systemctl daemon-reload')
  // Started in dependency order. systemd would resolve this from the unit
  // relationships anyway; doing it explicitly means the provisioning log
  // reads in the order things actually came up, which is what an operator
  // debugging a failed provision needs.
  for (const [name] of units) out.push(`systemctl enable --now ${name}.service`)

  out.push(...buildVitessBootstrapScript(config), ...buildVitessHealthCheck(config))
  return out
}
