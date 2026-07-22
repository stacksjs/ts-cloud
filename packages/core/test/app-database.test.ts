import { describe, expect, it } from 'bun:test'
import type { CloudConfig } from '../src/types'
import { resolveAppDatabase } from '../src/app-database'

function cfg(infrastructure: CloudConfig['infrastructure']): Pick<CloudConfig, 'infrastructure'> {
  return { infrastructure }
}

describe('resolveAppDatabase', () => {
  it('prefers the canonical infrastructure.appDatabase key', () => {
    const db = resolveAppDatabase(
      cfg({
        appDatabase: { engine: 'postgres', name: 'training', username: 'training', password: 'pw' },
        compute: { database: { engine: 'postgres', name: 'legacy' } },
      }),
    )
    expect(db?.name).toBe('training')
  })

  it('falls back to the deprecated infrastructure.compute.database alias', () => {
    // The bughq shape: managedServices + compute.database, no appDatabase.
    const db = resolveAppDatabase(
      cfg({
        compute: {
          managedServices: { postgres: true },
          database: { engine: 'postgres', name: 'bughq', username: 'bughq', password: 'pw' },
        },
      }),
    )
    expect(db?.name).toBe('bughq')
    expect(db?.engine).toBe('postgres')
  })

  it('returns undefined when neither key is set', () => {
    expect(resolveAppDatabase(cfg({}))).toBeUndefined()
    expect(resolveAppDatabase(cfg({ compute: {} }))).toBeUndefined()
    expect(resolveAppDatabase({})).toBeUndefined()
  })
})
