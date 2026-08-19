import { describe, expect, it } from 'bun:test'
import { buildDatabaseSetupScript, buildManagedDbEnv, isLocalDatabase } from './db-provision'

describe('buildManagedDbEnv — SingleStore', () => {
  it('wires DB_CONNECTION=singlestore over the MySQL port with TLS on', () => {
    const env = buildManagedDbEnv({
      engine: 'singlestore',
      name: 'ghostanalytics',
      host: 'svc-abc.svc.singlestore.com',
      username: 'admin',
      password: 'secret',
    } as any)
    expect(env.DB_CONNECTION).toBe('singlestore')
    expect(env.DB_PORT).toBe('3306')
    expect(env.DB_HOST).toBe('svc-abc.svc.singlestore.com')
    expect(env.DB_DATABASE).toBe('ghostanalytics')
    expect(env.DB_SSL).toBe('true')
  })

  it('lets ssl:false opt out of TLS', () => {
    const env = buildManagedDbEnv({ engine: 'singlestore', name: 'a', host: 'h', ssl: false } as any)
    expect(env.DB_SSL).toBeUndefined()
  })

  it('leaves mysql/postgres untouched', () => {
    expect(buildManagedDbEnv({ engine: 'mysql', name: 'a', host: 'h' } as any).DB_CONNECTION).toBe('mysql')
    const pg = buildManagedDbEnv({ engine: 'postgres', name: 'a', host: 'h' } as any)
    expect(pg.DB_CONNECTION).toBe('pgsql')
    expect(pg.DB_PORT).toBe('5432')
    expect(pg.DB_SSL).toBeUndefined()
  })
})

describe('buildManagedDbEnv — Vitess', () => {
  it('wires DB_CONNECTION=vitess over vtgate 15306 with TLS on', () => {
    const env = buildManagedDbEnv({
      engine: 'vitess',
      name: 'commerce',
      host: 'vtgate.example.com',
      username: 'app',
      password: 'secret',
    } as any)
    expect(env.DB_CONNECTION).toBe('vitess')
    // 3306 would reach a vttablet's underlying mysqld and silently bypass
    // sharding — a working connection that does the wrong thing.
    expect(env.DB_PORT).toBe('15306')
    expect(env.DB_HOST).toBe('vtgate.example.com')
    // The keyspace occupies the database slot.
    expect(env.DB_DATABASE).toBe('commerce')
    expect(env.DB_SSL).toBe('true')
  })

  it('keeps DB_CONNECTION distinct from mysql', () => {
    // Collapsing vitess to 'mysql' would make the app emit foreign keys and
    // AUTO_INCREMENT, both of which a sharded keyspace rejects.
    expect(buildManagedDbEnv({ engine: 'vitess', name: 'k', host: 'h' } as any).DB_CONNECTION)
      .not.toBe('mysql')
  })

  it('honors an explicit port', () => {
    expect(buildManagedDbEnv({ engine: 'vitess', name: 'k', host: 'h', port: 15307 } as any).DB_PORT)
      .toBe('15307')
  })

  it('honors ssl: false', () => {
    expect(buildManagedDbEnv({ engine: 'vitess', name: 'k', host: 'h', ssl: false } as any).DB_SSL)
      .toBeUndefined()
  })
})

describe('always-external engines are never provisioned on-box', () => {
  // isLocalDatabase decides "on-box or not" from the HOST, and host is
  // optional. Before the engine check, declaring singlestore or vitess with
  // no host read as local and fell through to the MySQL branch of
  // buildDatabaseSetupScript, which shells out to
  // `mysql --socket=/var/lib/pantry/mysql/mysqld.sock` — a socket that cannot
  // exist because nothing ever installed MySQL.
  for (const engine of ['singlestore', 'vitess'] as const) {
    it(`treats ${engine} as external even with no host`, () => {
      expect(isLocalDatabase({ engine, name: 'app' } as any)).toBe(false)
    })

    it(`treats ${engine} as external even pointed at loopback`, () => {
      // A loopback address here means a tunnel or local proxy, not an engine
      // this box installed and can administer over a unix socket.
      expect(isLocalDatabase({ engine, name: 'app', host: '127.0.0.1' } as any)).toBe(false)
    })

    it(`emits no on-box setup script for ${engine}`, () => {
      expect(buildDatabaseSetupScript({ engine, name: 'app', username: 'u', password: 'p' } as any))
        .toEqual([])
    })
  }

  it('still provisions a genuinely on-box mysql database', () => {
    const script = buildDatabaseSetupScript(
      { engine: 'mysql', name: 'app', username: 'u', password: 'p' } as any,
      { mysql: true } as any,
    )
    expect(script.length).toBeGreaterThan(0)
    expect(script.join('\n')).toContain('CREATE DATABASE IF NOT EXISTS')
  })

  it('still treats a hostless mysql database as local', () => {
    expect(isLocalDatabase({ engine: 'mysql', name: 'app' } as any)).toBe(true)
  })
})
