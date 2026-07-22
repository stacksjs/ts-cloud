export interface ControlPlaneMigration {
  version: number
  name: string
  sql: string
}

export const CONTROL_PLANE_SCHEMA_VERSION: number = 17

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
  {
    version: 5,
    name: 'authorization_provenance',
    sql: `
      ALTER TABLE organization_memberships ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'legacy', 'invitation'));
      ALTER TABLE authorization_grants ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'legacy', 'invitation'));
      CREATE INDEX grants_source_idx ON authorization_grants(membership_id, source);
    `,
  },
  {
    version: 6,
    name: 'durable_authentication',
    sql: `
      CREATE TABLE auth_identities (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id) ON DELETE CASCADE,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        email TEXT COLLATE NOCASE UNIQUE,
        email_verified_at TEXT,
        password_hash TEXT NOT NULL,
        credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
        requires_password_upgrade INTEGER NOT NULL DEFAULT 0 CHECK (requires_password_upgrade IN (0, 1)),
        disabled_at TEXT,
        last_login_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE auth_action_tokens (
        id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL REFERENCES auth_identities(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('activation', 'password_reset', 'email_verification')),
        token_hash TEXT NOT NULL UNIQUE,
        metadata TEXT NOT NULL DEFAULT '{}',
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE auth_sessions (
        id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL REFERENCES auth_identities(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        credential_version INTEGER NOT NULL CHECK (credential_version > 0),
        auth_method TEXT NOT NULL CHECK (auth_method IN ('local', 'oidc')),
        user_agent TEXT,
        network_hint TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        idle_expires_at TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        recent_auth_at TEXT NOT NULL,
        mfa_at TEXT,
        revoked_at TEXT
      ) STRICT;

      CREATE INDEX auth_identities_email_idx ON auth_identities(email);
      CREATE INDEX auth_action_tokens_identity_idx ON auth_action_tokens(identity_id, type, created_at DESC);
      CREATE INDEX auth_action_tokens_expiry_idx ON auth_action_tokens(expires_at, consumed_at);
      CREATE INDEX auth_sessions_identity_idx ON auth_sessions(identity_id, revoked_at, last_used_at DESC);
      CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(idle_expires_at, absolute_expires_at, revoked_at);
    `,
  },
  {
    version: 7,
    name: 'multi_factor_authentication',
    sql: `
      CREATE TABLE auth_mfa_factors (
        id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL UNIQUE REFERENCES auth_identities(id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'totp' CHECK (type = 'totp'),
        label TEXT NOT NULL,
        secret_ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        verified_at TEXT,
        disabled_at TEXT,
        last_used_step INTEGER
      ) STRICT;

      CREATE TABLE auth_recovery_codes (
        id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL REFERENCES auth_identities(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        consumed_at TEXT
      ) STRICT;

      CREATE TABLE auth_mfa_challenges (
        id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL REFERENCES auth_identities(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('login', 'step_up')),
        token_hash TEXT NOT NULL UNIQUE,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX auth_recovery_codes_identity_idx ON auth_recovery_codes(identity_id, consumed_at);
      CREATE INDEX auth_mfa_challenges_identity_idx ON auth_mfa_challenges(identity_id, purpose, expires_at);
      CREATE INDEX auth_mfa_challenges_expiry_idx ON auth_mfa_challenges(expires_at, consumed_at);
    `,
  },
  {
    version: 8,
    name: 'openid_connect_authentication',
    sql: `
      CREATE TABLE auth_oidc_providers (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name TEXT NOT NULL,
        issuer TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        client_secret_ciphertext TEXT,
        scopes TEXT NOT NULL DEFAULT '["openid","email","profile"]',
        allowed_domains TEXT NOT NULL,
        default_role TEXT NOT NULL DEFAULT 'viewer' CHECK (default_role IN ('admin', 'deployer', 'operator', 'viewer', 'auditor')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        enforce_sso INTEGER NOT NULL DEFAULT 0 CHECK (enforce_sso IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE auth_oidc_subjects (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES auth_oidc_providers(id) ON DELETE CASCADE,
        identity_id TEXT NOT NULL REFERENCES auth_identities(id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        email TEXT NOT NULL COLLATE NOCASE,
        linked_at TEXT NOT NULL,
        last_login_at TEXT NOT NULL,
        UNIQUE(provider_id, subject),
        UNIQUE(provider_id, identity_id)
      ) STRICT;

      CREATE TABLE auth_oidc_transactions (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES auth_oidc_providers(id) ON DELETE CASCADE,
        state_hash TEXT NOT NULL UNIQUE,
        nonce_ciphertext TEXT NOT NULL,
        verifier_ciphertext TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        return_path TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX auth_oidc_providers_org_idx ON auth_oidc_providers(organization_id, enabled, name);
      CREATE INDEX auth_oidc_subjects_identity_idx ON auth_oidc_subjects(identity_id, provider_id);
      CREATE INDEX auth_oidc_transactions_expiry_idx ON auth_oidc_transactions(expires_at, consumed_at);
    `,
  },
  {
    version: 9,
    name: 'service_accounts_and_api_tokens',
    sql: `
      CREATE TABLE service_accounts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id) ON DELETE CASCADE,
        slug TEXT NOT NULL COLLATE NOCASE,
        name TEXT NOT NULL,
        description TEXT,
        created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        disabled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(organization_id, slug)
      ) STRICT;

      CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY,
        service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL UNIQUE,
        capabilities TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('organization', 'project', 'environment', 'resource')),
        scope_id TEXT,
        expires_at TEXT NOT NULL,
        last_used_at TEXT,
        last_network_hint TEXT,
        revoked_at TEXT,
        rotated_from_token_id TEXT REFERENCES api_tokens(id) ON DELETE SET NULL,
        created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((scope_type = 'organization' AND scope_id IS NULL) OR (scope_type != 'organization' AND scope_id IS NOT NULL))
      ) STRICT;

      CREATE TABLE api_idempotency_records (
        id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL,
        response_status INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(token_id, idempotency_key)
      ) STRICT;

      CREATE INDEX service_accounts_org_idx ON service_accounts(organization_id, disabled_at, name);
      CREATE INDEX api_tokens_account_idx ON api_tokens(service_account_id, revoked_at, expires_at);
      CREATE INDEX api_tokens_expiry_idx ON api_tokens(expires_at, revoked_at);
      CREATE INDEX api_idempotency_expiry_idx ON api_idempotency_records(expires_at);
    `,
  },
  {
    version: 10,
    name: 'security_posture_and_deploy_policy',
    sql: `
      CREATE TABLE security_scan_runs (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
        resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE,
        release_id TEXT,
        scanner_id TEXT NOT NULL,
        scanner_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'skipped', 'unavailable', 'unsupported', 'stale')),
        error TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        findings_count INTEGER NOT NULL DEFAULT 0 CHECK (findings_count >= 0),
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0)
      ) STRICT;

      CREATE TABLE security_findings (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
        resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE,
        release_id TEXT,
        scan_run_id TEXT NOT NULL REFERENCES security_scan_runs(id) ON DELETE CASCADE,
        scanner_id TEXT NOT NULL,
        scanner_version TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '{}',
        remediation TEXT,
        subject TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved', 'waived')),
        owner_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        recurrence_count INTEGER NOT NULL DEFAULT 0 CHECK (recurrence_count >= 0),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resolved_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE security_policies (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        rules TEXT NOT NULL,
        scanner_fail_mode TEXT NOT NULL CHECK (scanner_fail_mode IN ('open', 'closed')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(organization_id, environment_id, name)
      ) STRICT;

      CREATE TABLE security_waivers (
        id TEXT PRIMARY KEY,
        finding_id TEXT NOT NULL REFERENCES security_findings(id) ON DELETE CASCADE,
        policy_id TEXT REFERENCES security_policies(id) ON DELETE SET NULL,
        reason TEXT NOT NULL,
        reference_url TEXT,
        created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE security_finding_comments (
        id TEXT PRIMARY KEY,
        finding_id TEXT NOT NULL REFERENCES security_findings(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
        body TEXT NOT NULL,
        reference_url TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE release_security_artifacts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
        release_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('sbom', 'vulnerability_summary', 'signature', 'provenance')),
        format TEXT NOT NULL,
        digest TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '{}',
        content TEXT,
        sensitive INTEGER NOT NULL DEFAULT 1 CHECK (sensitive IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE(release_id, kind, digest)
      ) STRICT;

      CREATE TABLE security_deploy_decisions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
        operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL,
        policy_id TEXT NOT NULL REFERENCES security_policies(id) ON DELETE RESTRICT,
        policy_version INTEGER NOT NULL CHECK (policy_version > 0),
        outcome TEXT NOT NULL CHECK (outcome IN ('allow', 'warn', 'block')),
        scanner_versions TEXT NOT NULL,
        finding_ids TEXT NOT NULL,
        waiver_ids TEXT NOT NULL,
        explanation TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX security_scan_scope_idx ON security_scan_runs(organization_id, project_id, environment_id, completed_at DESC);
      CREATE INDEX security_scan_scanner_idx ON security_scan_runs(scanner_id, completed_at DESC);
      CREATE INDEX security_findings_scope_idx ON security_findings(organization_id, project_id, environment_id, status, severity);
      CREATE INDEX security_findings_scanner_idx ON security_findings(scanner_id, rule_id, last_seen_at DESC);
      CREATE INDEX security_waivers_finding_idx ON security_waivers(finding_id, expires_at, revoked_at);
      CREATE INDEX security_comments_finding_idx ON security_finding_comments(finding_id, created_at);
      CREATE INDEX release_security_artifacts_release_idx ON release_security_artifacts(release_id, kind);
      CREATE INDEX security_decisions_environment_idx ON security_deploy_decisions(environment_id, created_at DESC);
    `,
  },
  {
    version: 11,
    name: 'required_security_scanners',
    sql: `
      ALTER TABLE security_policies ADD COLUMN required_scanners TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 12,
    name: 'git_source_connections',
    sql: `
      CREATE TABLE source_connections (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'bitbucket', 'gitea', 'generic_https', 'generic_ssh')),
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        owner TEXT,
        auth_kind TEXT NOT NULL CHECK (auth_kind IN ('app', 'oauth_token', 'access_token', 'deploy_key', 'none')),
        credential_ciphertext TEXT,
        credential_fingerprint TEXT,
        granted_scopes TEXT NOT NULL DEFAULT '[]',
        capabilities TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('pending', 'healthy', 'degraded', 'expired', 'disconnected')),
        health_message TEXT,
        last_tested_at TEXT,
        last_synced_at TEXT,
        credential_expires_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(organization_id, name)
      ) STRICT;

      CREATE TABLE source_repositories (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
        provider_repository_id TEXT NOT NULL,
        full_name TEXT NOT NULL,
        clone_url TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private', 'internal', 'unknown')),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        metadata TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL,
        UNIQUE(connection_id, provider_repository_id),
        UNIQUE(connection_id, full_name)
      ) STRICT;

      CREATE TABLE source_deploy_keys (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        public_key_fingerprint TEXT NOT NULL,
        private_key_ciphertext TEXT NOT NULL,
        host TEXT NOT NULL,
        host_key TEXT NOT NULL,
        host_key_fingerprint TEXT NOT NULL,
        created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(connection_id, name),
        UNIQUE(connection_id, public_key_fingerprint)
      ) STRICT;

      CREATE TABLE source_bindings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
        resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE RESTRICT,
        repository_id TEXT REFERENCES source_repositories(id) ON DELETE SET NULL,
        repository_full_name TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        branch_rule TEXT,
        tag_rule TEXT,
        monorepo_root TEXT NOT NULL DEFAULT '.',
        include_paths TEXT NOT NULL DEFAULT '[]',
        exclude_paths TEXT NOT NULL DEFAULT '[]',
        submodules INTEGER NOT NULL DEFAULT 0 CHECK (submodules IN (0, 1)),
        clone_depth INTEGER CHECK (clone_depth IS NULL OR clone_depth > 0),
        deploy_key_id TEXT REFERENCES source_deploy_keys(id) ON DELETE SET NULL,
        auto_deploy INTEGER NOT NULL DEFAULT 1 CHECK (auto_deploy IN (0, 1)),
        pull_request_previews INTEGER NOT NULL DEFAULT 1 CHECK (pull_request_previews IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        disabled_reason TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, environment_id, resource_id)
      ) STRICT;

      CREATE TABLE source_webhooks (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
        repository_id TEXT REFERENCES source_repositories(id) ON DELETE SET NULL,
        repository_full_name TEXT NOT NULL,
        provider_webhook_id TEXT,
        endpoint_token_hash TEXT NOT NULL UNIQUE,
        secret_ciphertext TEXT NOT NULL,
        events TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'healthy', 'degraded', 'disabled')),
        health_message TEXT,
        last_delivery_at TEXT,
        last_reconciled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(connection_id, repository_full_name)
      ) STRICT;

      CREATE TABLE source_webhook_deliveries (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
        webhook_id TEXT NOT NULL REFERENCES source_webhooks(id) ON DELETE CASCADE,
        provider_delivery_id TEXT NOT NULL,
        event TEXT NOT NULL,
        action TEXT,
        commit_sha TEXT,
        signature_status TEXT NOT NULL CHECK (signature_status IN ('verified', 'invalid', 'missing')),
        status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored', 'rejected', 'duplicate', 'enqueued', 'failed')),
        payload_summary TEXT NOT NULL DEFAULT '{}',
        operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL,
        error TEXT,
        received_at TEXT NOT NULL,
        processed_at TEXT,
        UNIQUE(connection_id, provider_delivery_id)
      ) STRICT;

      CREATE INDEX source_connections_org_idx ON source_connections(organization_id, status, provider, name);
      CREATE INDEX source_repositories_connection_idx ON source_repositories(connection_id, full_name);
      CREATE INDEX source_bindings_connection_idx ON source_bindings(connection_id, status);
      CREATE INDEX source_bindings_repository_idx ON source_bindings(connection_id, repository_full_name, status);
      CREATE INDEX source_webhooks_connection_idx ON source_webhooks(connection_id, status);
      CREATE INDEX source_deliveries_webhook_idx ON source_webhook_deliveries(webhook_id, received_at DESC);
    `,
  },
  {
    version: 13,
    name: 'encrypted_source_webhook_endpoint_tokens',
    sql: `
      ALTER TABLE source_webhooks ADD COLUMN endpoint_token_ciphertext TEXT;
    `,
  },
  {
    version: 14,
    name: 'application_onboarding_drafts',
    sql: `
      CREATE TABLE application_drafts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL,
        name TEXT NOT NULL,
        step TEXT NOT NULL,
        input TEXT NOT NULL,
        supplied_secret_names TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft',
        version INTEGER NOT NULL DEFAULT 1,
        created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX application_drafts_project_idx ON application_drafts(project_id, updated_at DESC);
    `,
  },
  {
    version: 15,
    name: 'encrypted_container_registry_connections',
    sql: `
      CREATE TABLE registry_connections (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        credential_ciphertext TEXT,
        credential_fingerprint TEXT,
        credential_expires_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        health_message TEXT,
        last_tested_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(organization_id, name)
      );
      CREATE INDEX registry_connections_org_idx ON registry_connections(organization_id, status, name);
    `,
  },
  {
    version: 16,
    name: 'inspected_application_artifacts',
    sql: `
      CREATE TABLE application_artifacts (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        format TEXT NOT NULL,
        entry_count INTEGER NOT NULL,
        expanded_bytes INTEGER NOT NULL,
        created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, sha256)
      );
      CREATE INDEX application_artifacts_project_idx ON application_artifacts(project_id, created_at DESC);
    `,
  },
  {
    version: 17,
    name: 'durable_operation_queue',
    sql: `
      CREATE TABLE operation_jobs (
        operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,
        lock_key TEXT,
        provider_key TEXT,
        build_slot INTEGER NOT NULL DEFAULT 0 CHECK (build_slot IN (0, 1)),
        max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts > 0),
        available_at TEXT NOT NULL,
        timeout_seconds INTEGER NOT NULL DEFAULT 1800 CHECK (timeout_seconds > 0),
        heartbeat_at TEXT,
        current_step TEXT,
        blocked_reason TEXT,
        retry_classes TEXT NOT NULL DEFAULT '[]',
        resume_policy TEXT NOT NULL DEFAULT 'fail' CHECK (resume_policy IN ('fail', 'requeue')),
        cancellation_mode TEXT NOT NULL DEFAULT 'cooperative' CHECK (cancellation_mode IN ('cooperative', 'provider_non_cancellable')),
        retention_until TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE operation_logs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
        stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system', 'step')),
        step TEXT,
        message TEXT NOT NULL,
        redacted INTEGER NOT NULL DEFAULT 0 CHECK (redacted IN (0, 1)),
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE operation_locks (
        lock_key TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
        lease_owner TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX operation_jobs_available_idx ON operation_jobs(available_at, operation_id);
      CREATE INDEX operation_jobs_provider_idx ON operation_jobs(provider_key, build_slot, operation_id);
      CREATE INDEX operation_jobs_retention_idx ON operation_jobs(retention_until);
      CREATE INDEX operation_logs_operation_idx ON operation_logs(operation_id, sequence);
      CREATE INDEX operation_locks_expiry_idx ON operation_locks(lease_expires_at);
    `,
  },
]
