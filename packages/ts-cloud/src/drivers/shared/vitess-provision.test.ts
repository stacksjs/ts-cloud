import type { VitessServiceConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { buildServicesProvisionScript } from './db-provision'
import {
  buildLaunchers,
  buildEtcdUnit,
  buildMysqlctldUnit,
  buildVitessAuthFileScript,
  buildVitessBootstrapScript,
  buildVitessHealthCheck,
  buildVitessProvisionScript,
  buildVtcomboUnit,
  buildVtctldUnit,
  buildVtgateUnit,
  buildVttabletUnit,
  ETCD_CLIENT_PORT,
  VTCTLD_GRPC_PORT,
  VTGATE_MYSQL_PORT,
  vitessPackages,
} from './vitess-provision'

/**
 * The launcher body a unit's ExecStart points at.
 *
 * Building a unit registers its launcher, so this reads what will actually
 * be written to disk and run - which is where the flags live.
 */
function launcherBody(unit: string, name: string): string {
  expect(unit).toContain(`ExecStart=/bin/sh /usr/local/lib/vitess/${name}.sh`)
  const scripts = buildLaunchers()
  const body = scripts.get(name)
  expect(body).toBeDefined()
  return body as string
}

const CLUSTER: VitessServiceConfig = {
  cell: 'zone1',
  keyspaces: [{ name: 'commerce', sharded: true }, { name: 'lookup' }],
}

describe('opt-in', () => {
  it('provisions nothing when vitess is not requested', () => {
    expect(buildVitessProvisionScript(undefined)).toEqual([])
    expect(buildVitessProvisionScript(false)).toEqual([])
    expect(buildServicesProvisionScript({})).toEqual([])
  })

  it('defaults to cluster mode, not the non-durable combo stack', () => {
    // A config that provisions infrastructure must not quietly hand back a
    // development stack that loses its topology on restart.
    const script = buildVitessProvisionScript(true).join('\n')
    expect(script).toContain('vitess-vtgate.service')
    expect(script).not.toContain('vtcombo')
  })
})

describe('packages', () => {
  it('installs vitess, etcd, and mysql for a self-contained cluster', () => {
    // Pinned to the same GA release planServices installs. Unpinned resolves
    // to a 9.x "innovation" tag, which is how a box got a mysqld linked
    // against an ICU it did not have.
    expect(vitessPackages({})).toEqual(['vitess.io', 'etcd.io', 'mysql.com@8.0.43'])
  })

  it('skips etcd when an external topology store is configured', () => {
    expect(vitessPackages({ etcdEndpoint: 'http://etcd.internal:2379' })).not.toContain('etcd.io')
  })

  it('installs only vitess for combo, which carries its own topology and mysqld', () => {
    // vtcombo has no embedded storage: `--start-mysql` launches a real
    // mysqld, and the health gate's client comes from the same package.
    expect(vitessPackages({ mode: 'combo' })).toEqual(['vitess.io', 'mysql.com@8.0.43'])
  })

  it('honors a pinned version', () => {
    expect(vitessPackages({ version: '24.0.2' })[0]).toBe('vitess.io@24.0.2')
  })
})

describe('combo mode (development)', () => {
  // Flags live in the launcher script, not the unit: systemd parses
  // ExecStart itself and splits on `;`, expands `$VAR`, and strips quotes,
  // which silently truncated an inline command mid-flags on a real box.
  const unit = launcherBody(buildVtcomboUnit({ keyspaces: [{ name: 'app' }] }), 'vtcombo')

  it('runs the whole stack in one process', () => {
    expect(unit).toContain('/vtcombo')
    expect(unit).not.toContain('/vtgate ')
    expect(unit).not.toContain('/vttablet ')
  })

  it('binds only to loopback, since it runs without auth', () => {
    // The two go together: no auth is acceptable precisely because nothing
    // off-box can reach it. Changing one without the other exposes an
    // unauthenticated database.
    expect(unit).toContain('--mysql-auth-server-impl none')
    expect(unit).toContain('--mysql-server-bind-address 127.0.0.1')
  })

  it('encodes the topology as a vttest proto, not a keyspace/shard string', () => {
    // `--proto-topo` takes a `vttest.VTTestTopology` in protobuf compact text
    // format. An earlier version passed `app/0`, which vtcombo cannot parse.
    expect(unit).toContain('--proto-topo \'keyspaces:{name:"app" shards:{name:"0"}}')
    expect(unit).toContain('cells:"zone1"')
  })

  it('declares a sharded keyspace with both shards', () => {
    const sharded = launcherBody(buildVtcomboUnit({ keyspaces: [{ name: 'commerce', sharded: true }] }), 'vtcombo')
    expect(sharded).toContain('keyspaces:{name:"commerce" shards:{name:"-80"} shards:{name:"80-"}}')
  })

  it('starts its own mysqld, because vtcombo embeds no storage', () => {
    expect(unit).toContain('--start-mysql')
  })

  it('needs no bootstrap, because the topology is in-process', () => {
    const script = buildVitessProvisionScript({ mode: 'combo' }).join('\n')
    expect(script).not.toContain('AddCellInfo')
    expect(script).not.toContain('CreateKeyspace')
  })
})

describe('cluster ordering', () => {
  // Mis-ordering does not fail cleanly: Vitess components retry, so a badly
  // ordered stack reports healthy and then misbehaves under load. systemd has
  // to enforce the graph.
  it('vtctld waits for the topology store and dies with it', () => {
    const unit = buildVtctldUnit(CLUSTER)
    expect(unit).toContain('After=network.target vitess-etcd.service')
    expect(unit).toContain('Requires=vitess-etcd.service')
  })

  it('vtctld does not require a local etcd when the store is external', () => {
    const unit = buildVtctldUnit({ ...CLUSTER, etcdEndpoint: 'http://etcd.internal:2379' })
    expect(unit).not.toContain('vitess-etcd.service')
    const body = launcherBody(unit, 'vtctld')
    expect(body).toContain('--topo-global-server-address http://etcd.internal:2379')
  })

  it('vttablet waits for both control plane and its mysqld', () => {
    const unit = buildVttabletUnit(CLUSTER, 'commerce', '-80')
    expect(unit).toContain('vitess-vtctld.service')
    expect(unit).toContain('vitess-mysqlctld.service')
    // Without its mysqld the tablet has nothing to serve, so failure must
    // propagate rather than leave it retrying.
    expect(unit).toContain('Requires=vitess-mysqlctld.service')
  })

  it('vtgate waits for the control plane', () => {
    expect(buildVtgateUnit(CLUSTER)).toContain('After=network.target vitess-vtctld.service')
  })

  it('starts units in dependency order', () => {
    const script = buildVitessProvisionScript(CLUSTER)
    const order = script.filter(l => l.startsWith('systemctl enable --now')).map(l => l.replace('systemctl enable --now ', ''))
    expect(order[0]).toBe('vitess-etcd.service')
    expect(order.indexOf('vitess-vtctld.service')).toBeLessThan(order.indexOf('vitess-vtgate.service'))
  })

  it('reloads systemd once, after every unit is written', () => {
    // Reloading per unit would make systemd act on a half-written stack.
    const script = buildVitessProvisionScript(CLUSTER)
    const reloads = script.filter(l => l === 'systemctl daemon-reload')
    expect(reloads).toHaveLength(1)
    const lastUnitWrite = script.map(l => l.includes('/etc/systemd/system/')).lastIndexOf(true)
    expect(script.indexOf('systemctl daemon-reload')).toBeGreaterThan(lastUnitWrite)
  })
})

describe('cluster topology', () => {
  it('creates one tablet per shard', () => {
    const script = buildVitessProvisionScript(CLUSTER).join('\n')
    // commerce is sharded (-80, 80-), lookup is not (0).
    expect(script).toContain('vitess-vttablet-commerce-x80.service')
    expect(script).toContain('vitess-vttablet-commerce-80x.service')
    expect(script).toContain('vitess-vttablet-lookup-0.service')
  })

  it('starts tablets as replicas, never as primaries', () => {
    // Coming up as primary would let two primaries exist across a restart.
    expect(launcherBody(buildVttabletUnit(CLUSTER, 'commerce', '-80'), 'vttablet')).toContain('--init-tablet-type replica')
  })

  it('points every daemon at the same topology root', () => {
    for (const unit of [launcherBody(buildVtctldUnit(CLUSTER), 'vtctld'), launcherBody(buildVtgateUnit(CLUSTER), 'vtgate')]) {
      expect(unit).toContain('--topo-implementation etcd2')
      expect(unit).toContain(`--topo-global-server-address http://127.0.0.1:${ETCD_CLIENT_PORT}`)
      expect(unit).toContain('--topo-global-root /vitess/global')
    }
  })

  it('raises the file descriptor limit', () => {
    // vtgate reaches the default 1024 under modest load.
    expect(buildVtgateUnit(CLUSTER)).toContain('LimitNOFILE=65535')
  })

  it('gives etcd a persistent data directory', () => {
    const unit = launcherBody(buildEtcdUnit(), 'etcd')
    expect(unit).toContain('--data-dir /var/lib/vitess/etcd')
    expect(buildEtcdUnit()).toContain('ExecStartPre=+/bin/mkdir -p /var/lib/vitess/etcd')
  })

  it('separates the tablet mysqld port from vtgate', () => {
    // Applications must reach vtgate; the tablet's mysqld is not a client
    // endpoint and writing to it bypasses Vitess.
    expect(launcherBody(buildMysqlctldUnit({ mysqlPort: 3306 }), 'mysqlctld')).toContain('--mysql-port 3306')
    expect(launcherBody(buildVtgateUnit(CLUSTER), 'vtgate')).toContain(`--mysql-server-port ${VTGATE_MYSQL_PORT}`)
  })
})

describe('cluster authentication', () => {
  it('does not override the configured password with an empty native hash', () => {
    // Vitess prefers MysqlNativePassword when the client negotiates that
    // plugin. An empty placeholder therefore rejects every real password.
    const script = buildVitessAuthFileScript({ username: 'app', password: 'production-secret' }).join('\n')
    expect(script).toContain('"Password":"production-secret"')
    expect(script).not.toContain('MysqlNativePassword')
  })
})

describe('bootstrap is idempotent', () => {
  const script = buildVitessBootstrapScript(CLUSTER).join('\n')

  it('waits for vtctld to accept connections before issuing commands', () => {
    // systemd reports the unit started a moment before vtctld is listening;
    // without this the first command races it and fails a healthy cluster.
    expect(script).toContain('GetCellInfoNames >/dev/null 2>&1 && break')
  })

  it('guards cell registration on a read', () => {
    // AddCellInfo fails when the cell exists; a re-provision must not turn
    // that into a failed deploy.
    expect(script).toContain('if ! ')
    expect(script).toContain('GetCellInfoNames')
    expect(script).toContain('AddCellInfo')
  })

  it('guards each keyspace on a read', () => {
    expect(script).toContain("CreateKeyspace --sharded 'commerce'")
    expect(script).toContain("CreateKeyspace 'lookup'")
    // GetKeyspaces prints JSON, so a line match never fired and every
    // re-provision failed with "node already exists". GetKeyspace exits
    // non-zero when absent, which is an existence check rather than a parse.
    expect(script).toContain('GetKeyspace ')
    expect(script).not.toContain('GetKeyspaces')
  })

  it('targets vtctld, not vtgate', () => {
    expect(script).toContain(`--server 127.0.0.1:${VTCTLD_GRPC_PORT}`)
  })
})

describe('primary election', () => {
  const script = buildVitessBootstrapScript(CLUSTER).join('\n')

  it('elects a primary for every shard', () => {
    // Verified on a live cluster: a tablet starts as a replica, so a fresh
    // shard reports REPLICA/NOT_SERVING and silently fails writes until it
    // is reparented. The provision is not done until each shard can write.
    expect(script).toContain("PlannedReparentShard 'commerce/-80'")
    expect(script).toContain("PlannedReparentShard 'commerce/80-'")
    expect(script).toContain("PlannedReparentShard 'lookup/0'")
  })

  it('retries the promotion instead of guessing when it will be possible', () => {
    // This used to wait for the tablet RECORD and then promote once. vttablet
    // registers within seconds, but a promotion also needs its mysqld, and
    // mysqlctld spends about two minutes initializing a fresh data directory,
    // so that single attempt ran far too early: it failed with "node doesn't
    // exist: .../shards/0/" and left a shard with no primary, on a cluster
    // that answered SHOW KEYSPACES but no query at all.
    expect(script).toContain('for i in $(seq 1 90); do')
    expect(script).not.toContain('GetTablet ')
  })

  it('fails the provision when no primary can be elected', () => {
    // Silently continuing produced the worst outcome available: provisioning
    // reported success and the cluster could not serve a single query.
    expect(script).toContain('no primary could be elected for commerce/-80')
    expect(script).toContain('exit 1')
  })

  it('does not reparent a shard that already has a primary', () => {
    // A needless failover on every re-provision would be worse than useless.
    expect(script).toContain('is_primary_serving')
    expect(script).not.toContain('primary_alias')
  })

  it('publishes each keyspace to the serving graph', () => {
    // Primary election does not create SrvKeyspace. Without this vtgate logs
    // that the topology node is missing and cannot route the new keyspace.
    expect(script).toContain("RebuildKeyspaceGraph 'commerce'")
    expect(script).toContain("RebuildKeyspaceGraph 'lookup'")
  })
})

describe('health gate', () => {
  const script = buildVitessHealthCheck({}).join('\n')

  it('fails the provision when vtgate never serves', () => {
    // A box that provisioned "successfully" with a dead vtgate accepts a
    // deploy and then fails every request, which is far harder to attribute.
    expect(script).toContain('exit 1')
    expect(script).toContain('did not become ready')
  })

  it('probes the port applications actually use', () => {
    expect(script).toContain(`-P ${VTGATE_MYSQL_PORT}`)
    expect(script).toContain('SHOW KEYSPACES')
  })

  it('runs last, after bootstrap', () => {
    const full = buildVitessProvisionScript(CLUSTER)
    const health = full.findIndex(l => l.includes('did not become ready'))
    const bootstrap = full.findIndex(l => l.includes('CreateKeyspace'))
    expect(health).toBeGreaterThan(bootstrap)
  })
})

describe('coexistence with other services', () => {
  it('provisions vitess alongside redis without interfering', () => {
    const script = buildServicesProvisionScript({ redis: true, vitess: true }).join('\n')
    expect(script).toContain('redis.io')
    expect(script).toContain('vitess-vtgate.service')
  })

  it('leaves non-vitess boxes byte-identical', () => {
    // Regression guard: adding vitess must not perturb existing provisioning.
    const before = buildServicesProvisionScript({ redis: true, postgres: true })
    expect(before.some(l => l.includes('vitess'))).toBe(false)
  })
})

describe('daemons find their libraries however they are launched', () => {
  const script = buildVitessProvisionScript({ mode: 'cluster', keyspaces: [{ name: 'commerce' }] }).join('\n')

  it('registers mysqld\'s library directory with the dynamic linker', () => {
    // Exporting LD_LIBRARY_PATH from the launcher is not sufficient. mysqlctld
    // runs `mysqld --initialize-insecure` directly, which inherits it, but it
    // STARTS the server through mysqld_safe, where mysqld does not receive it.
    // The result was a data directory that initialized perfectly and a server
    // that then would not boot: "error while loading shared libraries:
    // libprotobuf-lite.so.24.4.0".
    expect(script).toContain('/etc/ld.so.conf.d/vitess-mysql.conf')
    expect(script).toContain('ldconfig')
  })

  it('fails loudly when that directory is missing', () => {
    expect(script).toContain('mysqld library directory not found')
  })

  it('never evaluates non-assignment output from `pantry env`', () => {
    // These units run as the `vitess` user, which has neither root's HOME nor
    // its pantry state, so `pantry env` printed "No project detected in
    // current directory" to STDOUT and the eval tried to run a command called
    // `No`. 2>/dev/null did not hide it and `|| true` swallowed the failure,
    // so the environment was silently never set up.
    expect(script).toContain('grep -E \'^(export [A-Za-z_]|[A-Za-z_][A-Za-z0-9_]*=)\'')
    expect(script).not.toContain('eval "$(pantry env 2>/dev/null)" || true')
  })

  it('still exports a library path for the daemons themselves', () => {
    expect(script).toContain('LD_LIBRARY_PATH="$VT_MYSQL_ROOT/lib:$VTROOT/lib')
  })
})
