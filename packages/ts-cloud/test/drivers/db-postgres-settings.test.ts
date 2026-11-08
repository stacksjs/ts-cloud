import { describe, expect, it } from 'bun:test'
import { buildDatabaseSetupScript, buildPostgresSettingsScript } from '../../src/drivers/shared/db-provision'

const postgres = { engine: 'postgres', name: 'training', username: 'training', password: 'secret' } as any

/**
 * A box's engine converges on the parameters its config declares. The one
 * that matters most is idle_session_timeout: a release whose pools never close
 * fills max_connections until the next deploy cannot get a slot to migrate.
 */
describe('postgres server settings', () => {
  it('writes nothing when none are declared', () => {
    expect(buildPostgresSettingsScript(postgres, { postgres: true })).toEqual([])
    expect(buildPostgresSettingsScript(postgres, { postgres: { settings: {} } })).toEqual([])
    expect(buildDatabaseSetupScript(postgres, { postgres: true }).join('\n')).not.toContain('TS_CLOUD_PG_SETTINGS_EOF')
  })

  it('writes each setting with ALTER SYSTEM and reloads', () => {
    const sql = buildPostgresSettingsScript(postgres, { postgres: { settings: { idle_session_timeout: '15min', log_min_duration_statement: 500, log_connections: true } } }).join('\n')
    expect(sql).toContain(`ALTER SYSTEM SET idle_session_timeout = '15min';`)
    expect(sql).toContain(`ALTER SYSTEM SET log_min_duration_statement = '500';`)
    expect(sql).toContain(`ALTER SYSTEM SET log_connections = 'on';`)
    expect(sql).toContain('SELECT pg_reload_conf();')
    expect(sql).toContain('-v ON_ERROR_STOP=1')
  })

  it('ends sessions already idle past a new idle_session_timeout, so the deploy that sets it gets a slot', () => {
    const sql = buildPostgresSettingsScript(postgres, { postgres: { settings: { idle_session_timeout: '15min' } } }).join('\n')
    expect(sql).toContain('pg_terminate_backend(pid)')
    expect(sql).toContain(`state = 'idle'`)
    expect(sql).toContain(`backend_type = 'client backend'`)
    expect(sql).toContain(`now() - state_change > '15min'::interval`)
    const ms = buildPostgresSettingsScript(postgres, { postgres: { settings: { idle_session_timeout: 600000 } } }).join('\n')
    expect(ms).toContain(`'600000 milliseconds'::interval`)
    const off = buildPostgresSettingsScript(postgres, { postgres: { settings: { idle_session_timeout: 0 } } }).join('\n')
    expect(off).not.toContain('pg_terminate_backend')
  })

  it('reports restart-only parameters as pending rather than restarting the engine', () => {
    const script = buildPostgresSettingsScript(postgres, { postgres: { settings: { max_connections: 200 } } }).join('\n')
    expect(script).toContain('pending_restart')
    expect(script).not.toMatch(/\b(restart|stop) postgres/)
  })

  it('runs as part of database setup, before the capacity warning and the migration', () => {
    const script = buildDatabaseSetupScript(postgres, { postgres: { settings: { idle_session_timeout: '15min' } } }).join('\n')
    expect(script.indexOf('TS_CLOUD_PG_SETTINGS_EOF')).toBeGreaterThan(script.indexOf('TS_CLOUD_PG_EOF'))
    expect(script.indexOf('TS_CLOUD_PG_SETTINGS_EOF')).toBeLessThan(script.indexOf('TS_CLOUD_PG_CAP_EOF'))
  })

  it('refuses names and values that are not parameters', () => {
    expect(() => buildPostgresSettingsScript(postgres, { postgres: { settings: { 'x; DROP DATABASE training': '1' } } })).toThrow('Invalid PostgreSQL setting name')
    const quoted = buildPostgresSettingsScript(postgres, { postgres: { settings: { application_name: `it's` } } }).join('\n')
    expect(quoted).toContain(`'it''s'`)
    expect(() => buildPostgresSettingsScript(postgres, { postgres: { settings: { work_mem: Number.NaN } } })).toThrow('Invalid PostgreSQL setting value')
  })

  it('refuses settings for a managed or external database', () => {
    const managed = { ...postgres, host: 'db.example.com' }
    expect(() => buildPostgresSettingsScript(managed, { postgres: { settings: { idle_session_timeout: '15min' } } })).toThrow('box\'s own engine')
  })
})
