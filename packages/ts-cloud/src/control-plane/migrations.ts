export interface ControlPlaneMigration {
  version: number
  name: string
  sql: string
}

export const CONTROL_PLANE_SCHEMA_VERSION: number = 4

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
  {
    version: 3,
    name: 'resource_discovery_preferences',
    sql: `
      CREATE TABLE tags (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, normalized_name)
      ) STRICT;

      CREATE TABLE resource_tags (
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(resource_id, tag_id)
      ) STRICT;

      CREATE TABLE saved_filters (
        id TEXT PRIMARY KEY,
        actor_key TEXT NOT NULL,
        name TEXT NOT NULL,
        route_id TEXT NOT NULL,
        query TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(actor_key, name)
      ) STRICT;

      CREATE TABLE navigation_items (
        actor_key TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
        last_visited_at TEXT NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 1 CHECK (visit_count > 0),
        PRIMARY KEY(actor_key, entity_type, entity_id)
      ) STRICT;

      CREATE INDEX tags_project_idx ON tags(project_id, normalized_name);
      CREATE INDEX resource_tags_tag_idx ON resource_tags(tag_id, resource_id);
      CREATE INDEX saved_filters_actor_idx ON saved_filters(actor_key, updated_at DESC);
      CREATE INDEX navigation_actor_idx ON navigation_items(actor_key, favorite DESC, last_visited_at DESC);
    `,
  },
  {
    version: 4,
    name: 'organizations_and_scoped_authorization',
    sql: `
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      ALTER TABLE events ADD COLUMN organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL;

      CREATE TABLE organization_memberships (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
        role_template TEXT NOT NULL CHECK (role_template IN ('owner', 'admin', 'deployer', 'operator', 'viewer', 'auditor')),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'project', 'environment', 'resource')),
        scope_id TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version > 0),
        last_active_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(organization_id, actor_id),
        CHECK ((scope_type = 'organization' AND scope_id IS NULL) OR (scope_type != 'organization' AND scope_id IS NOT NULL))
      ) STRICT;

      CREATE TABLE organization_invitations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        role_template TEXT NOT NULL CHECK (role_template IN ('owner', 'admin', 'deployer', 'operator', 'viewer', 'auditor')),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'project', 'environment', 'resource')),
        scope_id TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        invited_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        accepted_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        expires_at TEXT NOT NULL,
        accepted_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((scope_type = 'organization' AND scope_id IS NULL) OR (scope_type != 'organization' AND scope_id IS NOT NULL))
      ) STRICT;

      CREATE TABLE authorization_grants (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        membership_id TEXT NOT NULL REFERENCES organization_memberships(id) ON DELETE CASCADE,
        effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
        capability TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'project', 'environment', 'resource')),
        scope_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(membership_id, effect, capability, scope_type, scope_id),
        CHECK ((scope_type = 'organization' AND scope_id IS NULL) OR (scope_type != 'organization' AND scope_id IS NOT NULL))
      ) STRICT;

      CREATE INDEX memberships_org_idx ON organization_memberships(organization_id, status, role_template);
      CREATE INDEX memberships_actor_idx ON organization_memberships(actor_id, status);
      CREATE INDEX invitations_org_idx ON organization_invitations(organization_id, accepted_at, revoked_at, expires_at);
      CREATE INDEX grants_membership_idx ON authorization_grants(membership_id, capability, effect);
      CREATE UNIQUE INDEX grants_unique_idx ON authorization_grants(membership_id, effect, capability, scope_type, COALESCE(scope_id, ''));
      CREATE INDEX projects_organization_idx ON projects(organization_id, slug);
      CREATE INDEX events_organization_idx ON events(organization_id, sequence DESC);
    `,
  },
]
