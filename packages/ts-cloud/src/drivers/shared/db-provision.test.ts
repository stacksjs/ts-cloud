import { describe, expect, it } from 'bun:test'
import { buildManagedDbEnv } from './db-provision'

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
