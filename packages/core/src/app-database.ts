import type { CloudConfig, DatabaseConfig } from './types'

/**
 * Resolve the application's on-box/managed database declaration.
 *
 * `infrastructure.appDatabase` is the ONE canonical key — every ts-cloud code
 * path that creates the database, wires `DB_*` env, backs it up, or restores it
 * resolves through this helper so the surface can never drift again.
 *
 * Backward compatibility: early configs (e.g. bughq) declared the same block as
 * `infrastructure.compute.database`. That alias is still honored when the
 * canonical key is absent; `appDatabase` wins when both are set.
 */
export function resolveAppDatabase(config: Pick<CloudConfig, 'infrastructure'>): DatabaseConfig | undefined {
  return config.infrastructure?.appDatabase ?? config.infrastructure?.compute?.database
}
