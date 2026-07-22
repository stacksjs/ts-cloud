export interface ControlPlaneMigration {
  version: number
  name: string
  sql: string
}

export const CONTROL_PLANE_SCHEMA_VERSION: number = 2

export const controlPlaneMigrations: readonly ControlPlaneMigration[] = [
  {
    version: 1,
    name: 'core_control_plane',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        organization_id TEXT,
        desired_config_hash TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE environments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        region TEXT,
        desired_state TEXT NOT NULL DEFAULT '{}',
        discovered_state TEXT NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, slug)
      ) STRICT;

      CREATE TABLE resources (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        provider TEXT,
        provider_id TEXT,
        desired_state TEXT NOT NULL DEFAULT '{}',
        discovered_state TEXT NOT NULL DEFAULT '{}',
        metadata TEXT NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, environment_id, kind, slug)
      ) STRICT;

      CREATE TABLE actors (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('user', 'service_account', 'system')),
        external_id TEXT,
        display_name TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        disabled_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(kind, external_id)
      ) STRICT;

      CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
        resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
        actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
        correlation_id TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        input TEXT NOT NULL DEFAULT '{}',
        output TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        priority INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        cancel_requested_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL,
        resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
        actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        correlation_id TEXT NOT NULL,
        type TEXT NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warning', 'error')),
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: 'operations_and_event_indexes',
    sql: `
      CREATE INDEX operations_queue_idx ON operations(state, priority DESC, created_at ASC);
      CREATE INDEX operations_project_idx ON operations(project_id, created_at DESC);
      CREATE INDEX operations_lease_idx ON operations(state, lease_expires_at);
      CREATE INDEX operations_correlation_idx ON operations(correlation_id);
      CREATE INDEX events_project_idx ON events(project_id, sequence DESC);
      CREATE INDEX events_operation_idx ON events(operation_id, sequence ASC);
      CREATE INDEX events_resource_idx ON events(resource_id, sequence DESC);
      CREATE INDEX events_correlation_idx ON events(correlation_id, sequence ASC);
      CREATE INDEX resources_environment_idx ON resources(environment_id, kind, slug);
    `,
  },
]
