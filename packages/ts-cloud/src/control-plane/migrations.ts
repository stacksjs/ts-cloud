export interface ControlPlaneMigration {
  version: number
  name: string
  sql: string
}

export const CONTROL_PLANE_SCHEMA_VERSION: number = 34

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
  {
    version: 18,
    name: 'preview_environments',
    sql: `
      CREATE TABLE preview_definitions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        base_environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        branch_rule TEXT,
        domain_pattern TEXT NOT NULL,
        ttl_hours INTEGER NOT NULL DEFAULT 24 CHECK (ttl_hours BETWEEN 1 AND 720),
        keep_count INTEGER NOT NULL DEFAULT 10 CHECK (keep_count BETWEEN 1 AND 100),
        public_access INTEGER NOT NULL DEFAULT 0 CHECK (public_access IN (0, 1)),
        authentication_required INTEGER NOT NULL DEFAULT 1 CHECK (authentication_required IN (0, 1)),
        allow_forks INTEGER NOT NULL DEFAULT 0 CHECK (allow_forks IN (0, 1)),
        inherited_secrets TEXT NOT NULL DEFAULT '[]',
        resource_overrides TEXT NOT NULL DEFAULT '{}',
        database_strategy TEXT NOT NULL DEFAULT 'disabled' CHECK (database_strategy IN ('disabled', 'isolated', 'snapshot', 'shared_read_only')),
        max_monthly_cost REAL NOT NULL DEFAULT 25 CHECK (max_monthly_cost >= 0),
        max_cpu REAL NOT NULL DEFAULT 1 CHECK (max_cpu > 0),
        max_memory_mb INTEGER NOT NULL DEFAULT 1024 CHECK (max_memory_mb > 0),
        cleanup_on_close INTEGER NOT NULL DEFAULT 1 CHECK (cleanup_on_close IN (0, 1)),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, resource_id)
      ) STRICT;

      CREATE TABLE preview_instances (
        id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL REFERENCES preview_definitions(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        base_environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
        identity_key TEXT NOT NULL,
        source_provider TEXT,
        repository TEXT,
        branch TEXT NOT NULL,
        pull_request_number INTEGER,
        fork INTEGER NOT NULL DEFAULT 0 CHECK (fork IN (0, 1)),
        commit_sha TEXT NOT NULL,
        name TEXT NOT NULL,
        stack_name TEXT NOT NULL,
        url TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'deploying', 'active', 'updating', 'destroying', 'destroyed', 'failed', 'cleanup_failed')),
        expires_at TEXT NOT NULL,
        latest_operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL,
        created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        cost_estimate REAL,
        desired_state TEXT NOT NULL DEFAULT '{}',
        observed_state TEXT NOT NULL DEFAULT '{}',
        teardown_error TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        destroyed_at TEXT,
        UNIQUE(definition_id, identity_key),
        UNIQUE(project_id, name),
        UNIQUE(project_id, stack_name)
      ) STRICT;

      CREATE TABLE preview_resources (
        id TEXT PRIMARY KEY,
        preview_id TEXT NOT NULL REFERENCES preview_instances(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_resource_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        tags TEXT NOT NULL,
        observed_state TEXT NOT NULL DEFAULT '{}',
        discovered_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE(preview_id, provider, provider_resource_id)
      ) STRICT;

      CREATE INDEX preview_definitions_project_idx ON preview_definitions(project_id, enabled, resource_id);
      CREATE INDEX preview_instances_project_idx ON preview_instances(project_id, status, expires_at);
      CREATE INDEX preview_instances_pr_idx ON preview_instances(repository, pull_request_number, status);
      CREATE INDEX preview_instances_expiry_idx ON preview_instances(expires_at, status);
      CREATE INDEX preview_resources_preview_idx ON preview_resources(preview_id, deleted_at);
      CREATE INDEX preview_resources_provider_idx ON preview_resources(provider, provider_resource_id);
    `,
  },
  {
    version: 19,
    name: 'compose_applications',
    sql: `
      CREATE TABLE compose_applications (
        id TEXT PRIMARY KEY,
        resource_id TEXT NOT NULL UNIQUE REFERENCES resources(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'deploying', 'running', 'stopped', 'degraded', 'failed', 'deleting', 'deleted')),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('compose', 'template')),
        source_hash TEXT NOT NULL,
        redacted_source TEXT NOT NULL,
        manifest TEXT NOT NULL,
        diagnostics TEXT NOT NULL DEFAULT '[]',
        template_id TEXT,
        template_version TEXT,
        latest_operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL,
        created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE(project_id, environment_id, slug)
      ) STRICT;

      CREATE TABLE compose_service_states (
        application_id TEXT NOT NULL REFERENCES compose_applications(id) ON DELETE CASCADE,
        service_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'starting', 'running', 'stopped', 'unhealthy', 'failed', 'unknown')),
        replicas INTEGER NOT NULL DEFAULT 0 CHECK (replicas >= 0),
        healthy_replicas INTEGER NOT NULL DEFAULT 0 CHECK (healthy_replicas >= 0),
        latest_operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL,
        observed_state TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(application_id, service_name)
      ) STRICT;

      CREATE INDEX compose_applications_scope_idx ON compose_applications(project_id, environment_id, status, updated_at);
      CREATE INDEX compose_service_states_status_idx ON compose_service_states(application_id, status, service_name);
    `,
  },
  {
    version: 20,
    name: 'unified_releases',
    sql: `
      CREATE TABLE release_artifacts (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, digest TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('static','compute','serverless_zip','serverless_image','container','compose')), uri TEXT NOT NULL, size INTEGER NOT NULL CHECK (size >= 0), media_type TEXT NOT NULL, provenance TEXT NOT NULL DEFAULT '{}', attestation TEXT NOT NULL DEFAULT '{}', verified_at TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(organization_id, digest));
      CREATE TABLE releases (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE, artifact_id TEXT NOT NULL REFERENCES release_artifacts(id) ON DELETE RESTRICT, kind TEXT NOT NULL CHECK (kind IN ('static','compute','serverless_zip','serverless_image','container','compose')), source_sha TEXT, config_hash TEXT NOT NULL, manifest TEXT NOT NULL, provenance TEXT NOT NULL DEFAULT '{}', strategy TEXT NOT NULL CHECK (strategy IN ('atomic','rolling','blue_green','canary')), status TEXT NOT NULL CHECK (status IN ('built','awaiting_approval','activating','active','failed','rolled_back','superseded')), health_gate TEXT, hooks TEXT NOT NULL DEFAULT '{}', drain_seconds INTEGER NOT NULL DEFAULT 30, grace_seconds INTEGER NOT NULL DEFAULT 30, automatic_rollback INTEGER NOT NULL DEFAULT 1 CHECK (automatic_rollback IN (0,1)), rollback_attempts INTEGER NOT NULL DEFAULT 0, previous_release_id TEXT REFERENCES releases(id) ON DELETE SET NULL, promoted_from_release_id TEXT REFERENCES releases(id) ON DELETE SET NULL, actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL, trigger TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)), pin_reason TEXT, activated_at TEXT, failed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE release_transitions (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE, from_status TEXT, to_status TEXT NOT NULL, traffic_percent REAL, health TEXT NOT NULL DEFAULT '{}', message TEXT NOT NULL, operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL, created_at TEXT NOT NULL);
      CREATE TABLE release_approvals (id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE, environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE, decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')), actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT, comment TEXT, created_at TEXT NOT NULL);
      CREATE INDEX releases_scope_idx ON releases(project_id, environment_id, resource_id, created_at DESC);
      CREATE INDEX releases_active_idx ON releases(resource_id, status, activated_at DESC);
      CREATE INDEX releases_artifact_idx ON releases(artifact_id, status);
      CREATE INDEX release_transitions_release_idx ON release_transitions(release_id, sequence);
    `,
  },
  {
    version: 21,
    name: 'normalized_telemetry',
    sql: `
      CREATE TABLE telemetry_records (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
        resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('metric','log','trace','request','event')),
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        value REAL,
        unit TEXT,
        level TEXT,
        message TEXT,
        duration_ms REAL,
        status_code INTEGER,
        method TEXT,
        host TEXT,
        path_template TEXT,
        bytes_in INTEGER,
        bytes_out INTEGER,
        region TEXT,
        cache_result TEXT,
        upstream TEXT,
        trace_id TEXT,
        request_id TEXT,
        deployment_id TEXT,
        release_id TEXT,
        workload_id TEXT,
        sampled INTEGER NOT NULL DEFAULT 1 CHECK (sampled IN (0,1)),
        attributes TEXT NOT NULL DEFAULT '{}',
        ingested_bytes INTEGER NOT NULL DEFAULT 0 CHECK (ingested_bytes >= 0)
      ) STRICT;
      CREATE INDEX telemetry_scope_time_idx ON telemetry_records(project_id, environment_id, timestamp DESC, id DESC);
      CREATE INDEX telemetry_resource_time_idx ON telemetry_records(resource_id, timestamp DESC, id DESC);
      CREATE INDEX telemetry_kind_name_time_idx ON telemetry_records(kind, name, timestamp DESC);
      CREATE INDEX telemetry_trace_idx ON telemetry_records(trace_id, timestamp ASC);
      CREATE INDEX telemetry_request_idx ON telemetry_records(request_id, timestamp ASC);
      CREATE INDEX telemetry_release_idx ON telemetry_records(release_id, timestamp DESC);

      CREATE TABLE telemetry_saved_queries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES actors(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        query TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, actor_id, name)
      ) STRICT;
      CREATE INDEX telemetry_saved_queries_actor_idx ON telemetry_saved_queries(project_id, actor_id, updated_at DESC);
    `,
  },
  {
    version: 22,
    name: 'health_alerting_notifications',
    sql: `
      CREATE TABLE health_checks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE, resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE,
        name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('http','tcp','command')), target TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 10 AND 86400), timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 1 AND 300),
        failure_threshold INTEGER NOT NULL CHECK (failure_threshold BETWEEN 1 AND 100), recovery_threshold INTEGER NOT NULL CHECK (recovery_threshold BETWEEN 1 AND 100), regions TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX health_checks_scope_idx ON health_checks(project_id, environment_id, resource_id, enabled, updated_at DESC);
      CREATE TABLE health_results (
        id TEXT PRIMARY KEY, check_id TEXT NOT NULL REFERENCES health_checks(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK (status IN ('healthy','unhealthy','no_data')), agent TEXT NOT NULL, region TEXT, status_code INTEGER, message TEXT, timings TEXT NOT NULL DEFAULT '{}', checked_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX health_results_check_idx ON health_results(check_id, checked_at DESC);

      CREATE TABLE alert_rules (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE, resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE, health_check_id TEXT REFERENCES health_checks(id) ON DELETE CASCADE,
        name TEXT NOT NULL, signal TEXT NOT NULL, operator TEXT NOT NULL CHECK (operator IN ('gt','gte','lt','lte','eq','unhealthy')), threshold REAL, recovery_threshold REAL, window_ms INTEGER NOT NULL, consecutive INTEGER NOT NULL CHECK (consecutive BETWEEN 1 AND 100), recovery_consecutive INTEGER NOT NULL CHECK (recovery_consecutive BETWEEN 1 AND 100), no_data_policy TEXT NOT NULL CHECK (no_data_policy IN ('ignore','pending','firing')),
        severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')), group_by TEXT NOT NULL DEFAULT '[]', labels TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX alert_rules_scope_idx ON alert_rules(project_id, environment_id, resource_id, enabled, updated_at DESC);
      CREATE TABLE alerts (
        id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE, resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE,
        dedup_key TEXT NOT NULL UNIQUE, group_key TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','firing','resolved','silenced')), severity TEXT NOT NULL, title TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '{}', failure_count INTEGER NOT NULL DEFAULT 0, recovery_count INTEGER NOT NULL DEFAULT 0, occurrence_count INTEGER NOT NULL DEFAULT 1,
        owner_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL, acknowledged_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL, acknowledged_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, firing_at TEXT, resolved_at TEXT, silenced_until TEXT, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX alerts_scope_state_idx ON alerts(project_id, environment_id, resource_id, state, severity, updated_at DESC);
      CREATE TABLE alert_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE, type TEXT NOT NULL, actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX alert_events_alert_idx ON alert_events(alert_id, sequence);
      CREATE TABLE alert_silences (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE, resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE, matcher TEXT NOT NULL DEFAULT '{}', reason TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, timezone TEXT NOT NULL, created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX alert_silences_scope_idx ON alert_silences(project_id, starts_at, ends_at);

      CREATE TABLE notification_channels (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('slack','discord','teams','telegram','email','webhook')), config TEXT NOT NULL DEFAULT '{}', credential_ciphertext TEXT, credential_fingerprint TEXT, status TEXT NOT NULL CHECK (status IN ('active','paused','failing','disabled')), version INTEGER NOT NULL DEFAULT 1, last_tested_at TEXT, last_error TEXT, created_by_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(organization_id, name)
      ) STRICT;
      CREATE TABLE notification_routes (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, name TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, matcher TEXT NOT NULL DEFAULT '{}', channel_ids TEXT NOT NULL DEFAULT '[]', quiet_hours TEXT, group_wait_seconds INTEGER NOT NULL DEFAULT 30, reminder_seconds INTEGER, escalation TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX notification_routes_org_idx ON notification_routes(organization_id, enabled, priority DESC);
      CREATE TABLE notification_deliveries (
        id TEXT PRIMARY KEY, alert_id TEXT REFERENCES alerts(id) ON DELETE CASCADE, channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE, route_id TEXT REFERENCES notification_routes(id) ON DELETE SET NULL, event_type TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK (state IN ('pending','delivered','retrying','failed','dead')), attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, next_attempt_at TEXT, response_status INTEGER, error TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT
      ) STRICT;
      CREATE INDEX notification_deliveries_state_idx ON notification_deliveries(state, next_attempt_at, updated_at);
    `,
  },
  {
    version: 23,
    name: 'notification_templates_and_rate_limits',
    sql: `
      ALTER TABLE notification_routes ADD COLUMN template TEXT;
      ALTER TABLE notification_routes ADD COLUMN rate_limit_per_minute INTEGER NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 10000);
      CREATE INDEX notification_deliveries_route_created_idx ON notification_deliveries(route_id, created_at DESC);
    `,
  },
  {
    version: 24,
    name: 'scheduled_jobs_and_workers',
    sql: `
      CREATE TABLE scheduled_jobs (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE, resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE,
        name TEXT NOT NULL, provider TEXT NOT NULL CHECK (provider IN ('server','eventbridge','lambda','platform')), expression TEXT NOT NULL, normalized_expression TEXT NOT NULL, timezone TEXT NOT NULL, starts_at TEXT, ends_at TEXT, flexible_minutes INTEGER NOT NULL DEFAULT 0,
        target TEXT NOT NULL, payload_refs TEXT NOT NULL DEFAULT '{}', missed_run_policy TEXT NOT NULL CHECK (missed_run_policy IN ('skip','catch_up')), overlap_policy TEXT NOT NULL CHECK (overlap_policy IN ('allow','forbid','replace')), retry_policy TEXT NOT NULL, timeout_seconds INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), origin TEXT NOT NULL CHECK (origin IN ('managed','config','external')), source_key TEXT, owner_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL, observed_state TEXT NOT NULL DEFAULT '{}', reconciliation_status TEXT NOT NULL CHECK (reconciliation_status IN ('pending','in_sync','drifted','unsupported','unavailable')),
        next_run_at TEXT, last_scheduled_for TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, environment_id, source_key)
      ) STRICT;
      CREATE INDEX scheduled_jobs_due_idx ON scheduled_jobs(enabled, next_run_at, project_id, environment_id);
      CREATE TABLE job_executions (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE, operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL, trigger TEXT NOT NULL CHECK (trigger IN ('scheduled','manual','catch_up','external','retry')), scheduled_for TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','skipped','dead')), attempt INTEGER NOT NULL DEFAULT 0, started_at TEXT, finished_at TEXT, output TEXT NOT NULL DEFAULT '{}', error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX job_executions_job_idx ON job_executions(job_id, scheduled_for DESC, created_at DESC);
      CREATE TABLE worker_definitions (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE, resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE,
        name TEXT NOT NULL, provider TEXT NOT NULL CHECK (provider IN ('systemd','ecs','lambda')), queue TEXT NOT NULL, processes INTEGER NOT NULL, timeout_seconds INTEGER NOT NULL, restart_policy TEXT NOT NULL CHECK (restart_policy IN ('always','on_failure','never')), target TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), origin TEXT NOT NULL CHECK (origin IN ('managed','config','external')), source_key TEXT,
        owner_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL, observed_state TEXT NOT NULL DEFAULT '{}', reconciliation_status TEXT NOT NULL CHECK (reconciliation_status IN ('pending','in_sync','drifted','unsupported','unavailable')), version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, environment_id, source_key)
      ) STRICT;
      CREATE INDEX worker_definitions_scope_idx ON worker_definitions(project_id, environment_id, resource_id, enabled);
    `,
  },
  {
    version: 25,
    name: 'data_service_lifecycle',
    sql: `
      CREATE TABLE data_services (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE, resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
        name TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine IN ('postgres','mysql','mariadb','redis','mongodb','libsql')), provider TEXT NOT NULL CHECK (provider IN ('aws_rds','aws_aurora','aws_elasticache','server','container','external')), placement TEXT NOT NULL, engine_version TEXT, plan TEXT NOT NULL, storage_gb INTEGER, high_availability INTEGER NOT NULL DEFAULT 0 CHECK (high_availability IN (0,1)), public_exposure INTEGER NOT NULL DEFAULT 0 CHECK (public_exposure IN (0,1)), allowed_cidrs TEXT NOT NULL DEFAULT '[]',
        desired_state TEXT NOT NULL DEFAULT '{}', observed_state TEXT NOT NULL DEFAULT '{}', capabilities TEXT NOT NULL DEFAULT '{}', credential_ref TEXT, status TEXT NOT NULL CHECK (status IN ('draft','planning','provisioning','available','modifying','degraded','failed','deleting','retained','adopted')), origin TEXT NOT NULL CHECK (origin IN ('managed','config','adopted')), management_enabled INTEGER NOT NULL DEFAULT 1 CHECK (management_enabled IN (0,1)), owner_actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL,
        version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, environment_id, name)
      ) STRICT;
      CREATE INDEX data_services_scope_idx ON data_services(project_id, environment_id, status, engine);
      CREATE TABLE data_service_credentials (
        id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES data_services(id) ON DELETE CASCADE, username TEXT NOT NULL, secret_ref TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, rotated_at TEXT, UNIQUE(service_id, username)
      ) STRICT;
      CREATE TABLE data_service_dependencies (
        service_id TEXT NOT NULL REFERENCES data_services(id) ON DELETE CASCADE, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE, secret_ref TEXT NOT NULL, requires_redeploy INTEGER NOT NULL DEFAULT 1 CHECK (requires_redeploy IN (0,1)), created_at TEXT NOT NULL, PRIMARY KEY(service_id, resource_id)
      ) STRICT;
    `,
  },
  {
    version: 26,
    name: 'encrypted_data_service_secrets',
    sql: `
      CREATE TABLE data_service_secrets (
        reference TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 27,
    name: 'backup_recovery_control_plane',
    sql: `
      CREATE TABLE backup_destinations (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, provider TEXT NOT NULL CHECK (provider IN ('aws_s3','s3_compatible','aws_backup')), endpoint TEXT, endpoint_policy TEXT NOT NULL CHECK (endpoint_policy IN ('public_https','allow_private')), bucket TEXT, prefix TEXT NOT NULL DEFAULT '', region TEXT, force_path_style INTEGER NOT NULL DEFAULT 0 CHECK (force_path_style IN (0,1)), credential_ref TEXT,
        encryption TEXT NOT NULL CHECK (encryption IN ('provider','client_side','both')), encryption_key_ref TEXT, immutability TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL CHECK (status IN ('untested','healthy','failing','disabled')), last_tested_at TEXT, last_success_at TEXT, last_failure_at TEXT, last_error TEXT,
        version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,name)
      ) STRICT;
      CREATE INDEX backup_destinations_health_idx ON backup_destinations(project_id,status,last_tested_at);
      CREATE TABLE backup_policies (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE, resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE, data_service_id TEXT REFERENCES data_services(id) ON DELETE CASCADE, destination_id TEXT NOT NULL REFERENCES backup_destinations(id) ON DELETE RESTRICT,
        name TEXT NOT NULL, resource_kind TEXT NOT NULL CHECK (resource_kind IN ('managed_database','logical_database','volume','files','control_plane','infrastructure')), schedule TEXT NOT NULL, timezone TEXT NOT NULL, retention TEXT NOT NULL, compression TEXT NOT NULL CHECK (compression IN ('none','gzip','zstd')), encryption TEXT NOT NULL CHECK (encryption IN ('destination','client_side','both')), include_patterns TEXT NOT NULL DEFAULT '[]', exclude_patterns TEXT NOT NULL DEFAULT '[]', expected_rpo_minutes INTEGER NOT NULL CHECK (expected_rpo_minutes BETWEEN 1 AND 525600), expected_rto_minutes INTEGER NOT NULL CHECK (expected_rto_minutes BETWEEN 1 AND 525600), health_check_id TEXT REFERENCES health_checks(id) ON DELETE SET NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), next_run_at TEXT, last_run_at TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,environment_id,name)
      ) STRICT;
      CREATE INDEX backup_policies_due_idx ON backup_policies(enabled,next_run_at,project_id,environment_id);
      CREATE TABLE backup_jobs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, policy_id TEXT REFERENCES backup_policies(id) ON DELETE SET NULL, recovery_point_id TEXT, operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('backup','restore','verify','drill','cleanup')), status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','cleanup_required')), idempotency_key TEXT NOT NULL UNIQUE, target TEXT NOT NULL DEFAULT '{}', restore_mode TEXT CHECK (restore_mode IN ('isolated','in_place')), cancellability TEXT NOT NULL CHECK (cancellability IN ('safe','checkpoint_only','provider_uncancellable')), safety_backup_id TEXT, health_result TEXT, progress TEXT NOT NULL DEFAULT '{}', error TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX backup_jobs_scope_idx ON backup_jobs(project_id,status,kind,created_at DESC);
      CREATE TABLE recovery_points (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, policy_id TEXT REFERENCES backup_policies(id) ON DELETE SET NULL, destination_id TEXT NOT NULL REFERENCES backup_destinations(id) ON DELETE RESTRICT, resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL, data_service_id TEXT REFERENCES data_services(id) ON DELETE SET NULL, backup_job_id TEXT REFERENCES backup_jobs(id) ON DELETE SET NULL,
        kind TEXT NOT NULL, point_in_time TEXT NOT NULL, uri TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0), checksum TEXT NOT NULL, manifest TEXT NOT NULL DEFAULT '{}', tool_version TEXT, engine_version TEXT, expires_at TEXT, locked_until TEXT, held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0,1)), pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)), status TEXT NOT NULL CHECK (status IN ('pending','available','failed','deleting','deleted')), verification_state TEXT NOT NULL CHECK (verification_state IN ('unverified','verifying','verified','corrupt','failed')), verified_at TEXT, duration_ms INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX recovery_points_inventory_idx ON recovery_points(project_id,policy_id,point_in_time DESC);
      CREATE INDEX recovery_points_retention_idx ON recovery_points(status,expires_at,held,pinned);
      CREATE TRIGGER backup_jobs_recovery_point_fk_insert BEFORE INSERT ON backup_jobs WHEN NEW.recovery_point_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM recovery_points WHERE id=NEW.recovery_point_id) BEGIN SELECT RAISE(ABORT,'backup recovery point not found'); END;
      CREATE TRIGGER backup_jobs_recovery_point_fk_update BEFORE UPDATE OF recovery_point_id ON backup_jobs WHEN NEW.recovery_point_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM recovery_points WHERE id=NEW.recovery_point_id) BEGIN SELECT RAISE(ABORT,'backup recovery point not found'); END;
    `,
  },
  {
    version: 28,
    name: 'scoped_configuration',
    sql: `
      CREATE TABLE configuration_entries (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('project','environment','service','preview')), scope_id TEXT NOT NULL, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE, resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE, preview_id TEXT,
        key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('variable','secret')), value TEXT, value_fingerprint TEXT NOT NULL, secret_ref TEXT, backend TEXT NOT NULL CHECK (backend IN ('plaintext','local_encrypted','aws_secrets_manager','aws_ssm','external')), backend_version TEXT,
        origin TEXT NOT NULL CHECK (origin IN ('managed','config','migrated')), required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)), metadata TEXT NOT NULL DEFAULT '{}', last_used_at TEXT, rotated_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project_id,scope_type,scope_id,key),
        CHECK ((kind='variable' AND value IS NOT NULL AND secret_ref IS NULL AND backend='plaintext') OR (kind='secret' AND value IS NULL AND secret_ref IS NOT NULL AND backend<>'plaintext'))
      ) STRICT;
      CREATE INDEX configuration_entries_scope_idx ON configuration_entries(project_id,environment_id,resource_id,preview_id,kind,key);
      CREATE TABLE configuration_dependencies (
        entry_id TEXT NOT NULL REFERENCES configuration_entries(id) ON DELETE CASCADE, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE, injection_target TEXT NOT NULL CHECK (injection_target IN ('environment','native_reference','file')), required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)), requires_redeploy INTEGER NOT NULL DEFAULT 1 CHECK (requires_redeploy IN (0,1)), last_deployed_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(entry_id,resource_id)
      ) STRICT;
      CREATE INDEX configuration_dependencies_resource_idx ON configuration_dependencies(resource_id,requires_redeploy);
      CREATE TABLE configuration_mutations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, result TEXT NOT NULL DEFAULT '{}', actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL, created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 29,
    name: 'encrypted_configuration_values',
    sql: `
      CREATE TABLE configuration_secret_values (
        reference TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 30,
    name: 'function_configuration_scope',
    sql: `
      ALTER TABLE configuration_entries RENAME TO configuration_entries_old;
      ALTER TABLE configuration_dependencies RENAME TO configuration_dependencies_old;
      DROP INDEX configuration_entries_scope_idx;
      DROP INDEX configuration_dependencies_resource_idx;
      CREATE TABLE configuration_entries (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('project','environment','service','function','preview')), scope_id TEXT NOT NULL, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE, resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE, preview_id TEXT,
        key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('variable','secret')), value TEXT, value_fingerprint TEXT NOT NULL, secret_ref TEXT, backend TEXT NOT NULL CHECK (backend IN ('plaintext','local_encrypted','aws_secrets_manager','aws_ssm','external')), backend_version TEXT,
        origin TEXT NOT NULL CHECK (origin IN ('managed','config','migrated')), required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)), metadata TEXT NOT NULL DEFAULT '{}', last_used_at TEXT, rotated_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(project_id,scope_type,scope_id,key),
        CHECK ((kind='variable' AND value IS NOT NULL AND secret_ref IS NULL AND backend='plaintext') OR (kind='secret' AND value IS NULL AND secret_ref IS NOT NULL AND backend<>'plaintext'))
      ) STRICT;
      INSERT INTO configuration_entries SELECT * FROM configuration_entries_old;
      CREATE INDEX configuration_entries_scope_idx ON configuration_entries(project_id,environment_id,resource_id,preview_id,kind,key);
      CREATE TABLE configuration_dependencies (
        entry_id TEXT NOT NULL REFERENCES configuration_entries(id) ON DELETE CASCADE, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE, injection_target TEXT NOT NULL CHECK (injection_target IN ('environment','native_reference','file')), required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)), requires_redeploy INTEGER NOT NULL DEFAULT 1 CHECK (requires_redeploy IN (0,1)), last_deployed_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(entry_id,resource_id)
      ) STRICT;
      INSERT INTO configuration_dependencies SELECT * FROM configuration_dependencies_old;
      CREATE INDEX configuration_dependencies_resource_idx ON configuration_dependencies(resource_id,requires_redeploy);
      DROP TABLE configuration_dependencies_old;
      DROP TABLE configuration_entries_old;
    `,
  },
  {
    version: 31,
    name: 'persistent_volume_lifecycle',
    sql: `
      CREATE TABLE persistent_volumes (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
        resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL, name TEXT NOT NULL, provider TEXT NOT NULL, provider_id TEXT, type TEXT NOT NULL CHECK (type IN ('server_path','docker','ebs','efs','provider')),
        status TEXT NOT NULL CHECK (status IN ('pending','available','attaching','attached','detaching','resizing','snapshotting','orphaned','deleting','deleted','error')), capacity_bytes INTEGER CHECK (capacity_bytes IS NULL OR capacity_bytes >= 0), used_bytes INTEGER CHECK (used_bytes IS NULL OR used_bytes >= 0), filesystem TEXT, encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0,1)),
        capabilities TEXT NOT NULL DEFAULT '{}', desired_state TEXT NOT NULL DEFAULT '{}', observed_state TEXT NOT NULL DEFAULT '{}', backup_policy_id TEXT REFERENCES backup_policies(id) ON DELETE SET NULL, last_backup_at TEXT, orphaned_at TEXT, adopted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, UNIQUE(project_id,environment_id,name)
      ) STRICT;
      CREATE INDEX persistent_volumes_inventory_idx ON persistent_volumes(project_id,environment_id,status,type,updated_at DESC);
      CREATE UNIQUE INDEX persistent_volumes_provider_idx ON persistent_volumes(provider,provider_id) WHERE provider_id IS NOT NULL AND deleted_at IS NULL;
      CREATE TABLE volume_attachments (
        id TEXT PRIMARY KEY, volume_id TEXT NOT NULL REFERENCES persistent_volumes(id) ON DELETE RESTRICT, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        target_path TEXT NOT NULL, read_only INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0,1)), uid INTEGER CHECK (uid IS NULL OR uid >= 0), gid INTEGER CHECK (gid IS NULL OR gid >= 0), mode TEXT, propagation TEXT NOT NULL DEFAULT 'private' CHECK (propagation IN ('private','rprivate','shared','rshared','slave','rslave')), driver_options TEXT NOT NULL DEFAULT '{}',
        desired_state TEXT NOT NULL CHECK (desired_state IN ('attached','detached')), observed_state TEXT NOT NULL CHECK (observed_state IN ('pending','attached','detached','error')), operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL, last_error TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(volume_id,resource_id,target_path)
      ) STRICT;
      CREATE INDEX volume_attachments_resource_idx ON volume_attachments(resource_id,desired_state,observed_state);
      CREATE TABLE volume_snapshots (
        id TEXT PRIMARY KEY, volume_id TEXT NOT NULL REFERENCES persistent_volumes(id) ON DELETE CASCADE, recovery_point_id TEXT REFERENCES recovery_points(id) ON DELETE SET NULL, provider_id TEXT,
        name TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','available','restoring','deleting','deleted','error')), size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0), encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0,1)), checksum TEXT, metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      ) STRICT;
      CREATE INDEX volume_snapshots_inventory_idx ON volume_snapshots(volume_id,status,created_at DESC);
    `,
  },
  { version: 32, name: 'provider_neutral_fleet', sql: `
    CREATE TABLE fleet_servers (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      name TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('aws','hetzner','ssh')), provider_id TEXT, region TEXT, zone TEXT, endpoint TEXT NOT NULL, ssh_user TEXT NOT NULL, ssh_port INTEGER NOT NULL CHECK(ssh_port BETWEEN 1 AND 65535), credential_ref TEXT NOT NULL,
      host_key_algorithm TEXT, host_key_fingerprint TEXT, pending_host_key TEXT, roles TEXT NOT NULL, labels TEXT NOT NULL DEFAULT '{}', taints TEXT NOT NULL DEFAULT '[]', capacity TEXT NOT NULL DEFAULT '{}', usage TEXT NOT NULL DEFAULT '{}', capabilities TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK(status IN ('pending','validating','ready','degraded','unreachable','draining','drained','archived')), trust_state TEXT NOT NULL CHECK(trust_state IN ('unverified','pinned','rotation_pending','blocked')), validation TEXT NOT NULL DEFAULT '{}', bootstrap_version TEXT, heartbeat_at TEXT, last_seen_at TEXT, archived_at TEXT,
      version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,name)
    ) STRICT;
    CREATE UNIQUE INDEX fleet_servers_provider_identity ON fleet_servers(organization_id,provider,provider_id) WHERE provider_id IS NOT NULL AND archived_at IS NULL;
    CREATE INDEX fleet_servers_status ON fleet_servers(project_id,status,heartbeat_at);
    CREATE TABLE fleet_bootstrap_plans (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES fleet_servers(id) ON DELETE CASCADE, plan_version TEXT NOT NULL, facts_hash TEXT NOT NULL, steps TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('preview','queued','running','succeeded','failed')), operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  ` },
  { version: 33, name: 'capacity_pools_and_placement', sql: `
    CREATE TABLE capacity_pools (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('application','build','worker','monitoring','backup')), backend TEXT NOT NULL CHECK(backend IN ('server','ecs','asg')),
      region TEXT, architecture TEXT, labels TEXT NOT NULL DEFAULT '{}', required_server_labels TEXT NOT NULL DEFAULT '{}', tolerated_taints TEXT NOT NULL DEFAULT '[]',
      capacity TEXT NOT NULL, reserved TEXT NOT NULL DEFAULT '{}', max_workloads INTEGER NOT NULL CHECK(max_workloads > 0), cost_weight REAL NOT NULL DEFAULT 1 CHECK(cost_weight >= 0), spread_key TEXT,
      concurrency INTEGER NOT NULL DEFAULT 1 CHECK(concurrency > 0), ephemeral_workspaces INTEGER NOT NULL DEFAULT 1 CHECK(ephemeral_workspaces IN (0,1)), allow_production_secrets INTEGER NOT NULL DEFAULT 0 CHECK(allow_production_secrets IN (0,1)),
      status TEXT NOT NULL CHECK(status IN ('active','draining','disabled')), version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,name)
    ) STRICT;
    CREATE INDEX capacity_pools_scope ON capacity_pools(project_id,purpose,status,region,architecture);
    CREATE TABLE capacity_pool_members (
      pool_id TEXT NOT NULL REFERENCES capacity_pools(id) ON DELETE CASCADE, server_id TEXT NOT NULL REFERENCES fleet_servers(id) ON DELETE CASCADE,
      capacity_override TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL CHECK(status IN ('active','draining','offline')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(pool_id,server_id)
    ) STRICT;
    CREATE TABLE workload_placements (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      release_id TEXT REFERENCES releases(id) ON DELETE SET NULL, pool_id TEXT NOT NULL REFERENCES capacity_pools(id) ON DELETE RESTRICT, server_id TEXT REFERENCES fleet_servers(id) ON DELETE SET NULL,
      purpose TEXT NOT NULL, requirements TEXT NOT NULL, decision TEXT NOT NULL, stateful INTEGER NOT NULL DEFAULT 0 CHECK(stateful IN (0,1)), auto_reschedule INTEGER NOT NULL DEFAULT 0 CHECK(auto_reschedule IN (0,1)),
      status TEXT NOT NULL CHECK(status IN ('reserved','active','moving','blocked','released','failed')), version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX workload_placements_target ON workload_placements(project_id,resource_id,status,pool_id);
    CREATE TABLE capacity_leases (
      id TEXT PRIMARY KEY, placement_id TEXT NOT NULL REFERENCES workload_placements(id) ON DELETE CASCADE, pool_id TEXT NOT NULL REFERENCES capacity_pools(id) ON DELETE CASCADE, server_id TEXT REFERENCES fleet_servers(id) ON DELETE SET NULL,
      resources TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','released','expired')), expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX capacity_leases_active ON capacity_leases(placement_id) WHERE state='active';
    CREATE INDEX capacity_leases_pool ON capacity_leases(pool_id,state,expires_at);
    CREATE TABLE remote_builds (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL, pool_id TEXT NOT NULL REFERENCES capacity_pools(id) ON DELETE RESTRICT,
      placement_id TEXT REFERENCES workload_placements(id) ON DELETE SET NULL, operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL, source_sha TEXT NOT NULL, build_spec TEXT NOT NULL, credential_policy TEXT NOT NULL,
      workspace TEXT, cache_key TEXT, artifact_uri TEXT, artifact_digest TEXT, status TEXT NOT NULL CHECK(status IN ('queued','running','uploading','succeeded','failed','cancelled','cleanup_required')),
      cleanup_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX remote_builds_pool ON remote_builds(pool_id,status,created_at);
  ` },
  { version: 34, name: 'multi_region_orchestration', sql: `
    CREATE TABLE regional_topologies (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, environment_id TEXT REFERENCES environments(id) ON DELETE CASCADE,
      name TEXT NOT NULL, hostname TEXT NOT NULL, home_region TEXT NOT NULL, regions TEXT NOT NULL, traffic_policy TEXT NOT NULL CHECK(traffic_policy IN ('active_passive','weighted','latency')),
      data_policy TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','provisioning','ready','degraded','failing_over','failed_over','failing_back','destroying','destroyed','failed')),
      active_region TEXT NOT NULL, revision TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,environment_id,name), UNIQUE(project_id,hostname)
    ) STRICT;
    CREATE TABLE regional_targets (
      id TEXT PRIMARY KEY, topology_id TEXT NOT NULL REFERENCES regional_topologies(id) ON DELETE CASCADE, region TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('primary','secondary')), provider TEXT NOT NULL,
      stack_id TEXT, stack_revision TEXT, status TEXT NOT NULL CHECK(status IN ('pending','provisioning','ready','degraded','failed','deleting','deleted')), health TEXT NOT NULL DEFAULT '{}', last_healthy_at TEXT,
      version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(topology_id,region)
    ) STRICT;
    CREATE TABLE regional_replication_channels (
      id TEXT PRIMARY KEY, topology_id TEXT NOT NULL REFERENCES regional_topologies(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('s3','dynamodb','secrets')), source_region TEXT NOT NULL, target_region TEXT NOT NULL,
      config TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','configuring','in_sync','lagging','failed','disabled')), checkpoint TEXT, lag_seconds INTEGER, last_verified_at TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(topology_id,kind,source_region,target_region)
    ) STRICT;
    CREATE TABLE regional_traffic_routes (
      id TEXT PRIMARY KEY, topology_id TEXT NOT NULL REFERENCES regional_topologies(id) ON DELETE CASCADE, hostname TEXT NOT NULL, dns_provider TEXT NOT NULL, cdn_enabled INTEGER NOT NULL DEFAULT 0 CHECK(cdn_enabled IN (0,1)), waf_enabled INTEGER NOT NULL DEFAULT 0 CHECK(waf_enabled IN (0,1)),
      weights TEXT NOT NULL, desired_weights TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','applying','in_sync','failed','drained')), provider_state TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(topology_id,hostname)
    ) STRICT;
    CREATE TABLE regional_executions (
      id TEXT PRIMARY KEY, topology_id TEXT NOT NULL REFERENCES regional_topologies(id) ON DELETE CASCADE, operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL, kind TEXT NOT NULL CHECK(kind IN ('rollout','failover','failback','destroy','reconcile')),
      requested_region TEXT, revision TEXT, plan TEXT NOT NULL, current_step TEXT, completed_steps TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')), error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX regional_executions_active ON regional_executions(topology_id,status,created_at DESC);
  ` },
]
