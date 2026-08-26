import { describe, expect, it } from 'bun:test'
import { buildDatabaseSetupScript, pgConnectionCapacityWarning } from '../../src/drivers/shared/db-provision'

const postgres = { engine: 'postgres', name: 'training', username: 'training', password: 'secret' } as any

/**
 * A shared box fills up quietly. Every co-located app holds a pool, the pools
 * idle rather than close, and one day a deploy's migration cannot get a slot —
 * at which point Postgres reports `remaining connection slots are reserved for
 * roles with the SUPERUSER attribute`, which reads like a permissions fault in
 * whichever app deployed last and names none of the ones actually holding the
 * connections.
 */
describe('postgres connection capacity warning', () => {
  it('is emitted as part of database setup', () => {
    const script = buildDatabaseSetupScript(postgres).join('\n')
    expect(script).toContain('TS_CLOUD_PG_CAP_EOF')
  })

  it('reports the count against the limit', () => {
    const sql = pgConnectionCapacityWarning(postgres).join('\n')
    expect(sql).toContain('pg_stat_activity')
    expect(sql).toContain("name = 'max_connections'")
    expect(sql).toContain('[ts-cloud] postgres is at')
  })

  it('names the databases holding the connections, and how long they have idled', () => {
    const sql = pgConnectionCapacityWarning(postgres).join('\n')
    expect(sql).toContain('GROUP BY datname')
    expect(sql).toContain('state_change')
  })

  it('says only at 80% or above, so a healthy deploy stays quiet', () => {
    const sql = pgConnectionCapacityWarning(postgres).join('\n')
    expect(sql).toContain('>= 0.8')
  })

  /**
   * A warning, never a gate. A deploy that would have worked must not start
   * failing because a neighbouring app is noisy.
   */
  it('cannot fail the deploy', () => {
    const lines = pgConnectionCapacityWarning(postgres)
    expect(lines[0]).toContain('|| true')
  })
})
