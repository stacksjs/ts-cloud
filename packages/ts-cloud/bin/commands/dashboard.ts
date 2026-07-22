import type { CLI } from '@stacksjs/clapp'
import type { AuthorizationCapability, AuthorizationEffect, AuthorizationScope, ControlPlaneSnapshot, OrganizationRoleTemplate } from '../../src/control-plane'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { AUTHORIZATION_CAPABILITIES, ControlPlaneStore } from '../../src/control-plane'
import { AuthenticationStore } from '../../src/auth'
import * as cli from '../../src/utils/cli'
import { startLocalDashboardServer } from '../../src/deploy/local-dashboard-server'

function openControlPlane(path?: string): ControlPlaneStore {
  return new ControlPlaneStore(path ? { path: resolve(path) } : {})
}

function printControlPlaneHealth(store: ControlPlaneStore): void {
  const health = store.health()
  cli.header('Control-plane diagnostics')
  cli.info(`Database: ${health.path}`)
  cli.info(`Schema: ${health.schemaVersion}/${health.supportedSchemaVersion}`)
  cli.info(`Integrity: ${health.integrity}`)
  cli.info(`Journal: ${health.journalMode}`)
  cli.info(`Size: ${health.databaseBytes.toLocaleString()} bytes`)
  cli.info(`Last backup: ${health.lastBackupAt ?? 'never'}`)
  cli.info(`Operations: ${Object.entries(health.operations).map(([state, count]) => `${state}=${count}`).join(', ')}`)
  cli.info(`Pending/retryable: ${health.pendingRetryableOperations}`)
}

function resolveOrganization(store: ControlPlaneStore, value: string) {
  const organization = store.getOrganization(value) ?? store.getOrganizationBySlug(value)
  if (!organization)
    throw new Error(`Organization '${value}' was not found.`)
  return organization
}

function commandScope(type?: string, id?: string): AuthorizationScope {
  const scopeType = type ?? 'organization'
  if (scopeType === 'organization')
    return { type: 'organization' }
  if (!['project', 'environment', 'resource'].includes(scopeType) || !id)
    throw new Error('Scoped access requires --scope project|environment|resource and --scope-id <id>.')
  return { type: scopeType as 'project' | 'environment' | 'resource', id }
}

function resolveAuthIdentity(authentication: AuthenticationStore, value: string) {
  const identity = value.includes('@')
    ? authentication.getIdentityByEmail(value)
    : authentication.getIdentityByUsername(value)
  if (!identity)
    throw new Error(`Authentication identity '${value}' was not found.`)
  return identity
}

export function registerDashboardCommands(app: CLI): void {
  app
    .command('dashboard:serve', 'Run the local Forge-style cloud management UI')
    .option('--host <host>', 'Host to bind', { default: '127.0.0.1' })
    .option('--port <port>', 'Port to bind', { default: '7676' })
    .option('--env <environment>', 'Environment to manage')
    .option('--box', 'Box mode: run on the provisioned server (operate on localhost)')
    .option('--open', 'Print the URL for opening in a browser')
    .option('--verbose', 'Print server errors')
    .action(async (options?: { host?: string, port?: string, env?: string, box?: boolean, open?: boolean, verbose?: boolean }) => {
      const server = await startLocalDashboardServer({
        host: options?.host,
        port: Number(options?.port ?? 7676),
        environment: options?.env as any,
        box: options?.box,
        verbose: options?.verbose,
      })

      cli.header('ts-cloud Local Dashboard')
      cli.success(`Serving ${server.url}`)
      cli.info('Use Ctrl+C to stop.')

      await new Promise<void>((resolve) => {
        const stop = (): void => {
          server.server.stop(true)
          resolve()
        }
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
      })
    })

  app
    .command('control-plane:status', 'Inspect local control-plane storage health')
    .option('--path <path>', 'Use a non-default control-plane database')
    .action((options?: { path?: string }) => {
      const store = openControlPlane(options?.path)
      try {
        printControlPlaneHealth(store)
      }
      finally {
        store.close()
      }
    })

  app
    .command('control-plane:backup', 'Create a consistent local control-plane backup')
    .option('--path <path>', 'Use a non-default control-plane database')
    .action((options?: { path?: string }) => {
      const store = openControlPlane(options?.path)
      try {
        const backup = store.createBackup('cli')
        cli.success(`Backup written to ${backup}`)
      }
      finally {
        store.close()
      }
    })

  app
    .command('control-plane:export <file>', 'Export portable control-plane metadata and history')
    .option('--path <path>', 'Use a non-default control-plane database')
    .action((file: string, options?: { path?: string }) => {
      const output = resolve(file)
      const store = openControlPlane(options?.path)
      try {
        mkdirSync(dirname(output), { recursive: true })
        writeFileSync(output, `${JSON.stringify(store.exportSnapshot(), null, 2)}\n`, { mode: 0o600 })
        chmodSync(output, 0o600)
        cli.success(`Control-plane snapshot exported to ${output}`)
      }
      finally {
        store.close()
      }
    })

  app
    .command('control-plane:import <file>', 'Import a portable control-plane snapshot')
    .option('--path <path>', 'Use a non-default control-plane database')
    .option('--replace', 'Replace existing control-plane records')
    .action((file: string, options?: { path?: string, replace?: boolean }) => {
      const input = resolve(file)
      const snapshot = JSON.parse(readFileSync(input, 'utf8')) as ControlPlaneSnapshot
      const store = openControlPlane(options?.path)
      try {
        const backup = options?.replace ? store.createBackup('pre-import') : undefined
        store.importSnapshot(snapshot, { replace: options?.replace })
        cli.success(`Imported control-plane snapshot from ${input}`)
        if (backup)
          cli.info(`Previous state backed up to ${backup}`)
      }
      finally {
        store.close()
      }
    })

  app
    .command('control-plane:compact', 'Apply history retention and compact control-plane storage')
    .option('--path <path>', 'Use a non-default control-plane database')
    .option('--event-days <days>', 'Retain event history for this many days', { default: '90' })
    .option('--operation-days <days>', 'Retain terminal operations for this many days', { default: '365' })
    .option('--no-vacuum', 'Delete expired records without reclaiming file space')
    .action((options?: { path?: string, eventDays?: string, operationDays?: string, vacuum?: boolean }) => {
      const store = openControlPlane(options?.path)
      try {
        const result = store.compact({
          eventRetentionDays: Number(options?.eventDays ?? 90),
          operationRetentionDays: Number(options?.operationDays ?? 365),
          vacuum: options?.vacuum !== false,
        })
        cli.success(`Removed ${result.deletedEvents} event(s) and ${result.deletedOperations} terminal operation(s).`)
        if (result.vacuumed)
          cli.info('Database file compacted.')
      }
      finally {
        store.close()
      }
    })

  app
    .command('organization:list', 'List organizations in the local control plane')
    .option('--path <path>', 'Use a non-default control-plane database')
    .action((options?: { path?: string }) => {
      const store = openControlPlane(options?.path)
      try {
        cli.header('Organizations')
        for (const organization of store.listOrganizations())
          cli.info(`${organization.slug}  ${organization.name}  ${organization.id}`)
      }
      finally { store.close() }
    })

  app
    .command('organization:members <organization>', 'List memberships and scoped grants')
    .option('--path <path>', 'Use a non-default control-plane database')
    .option('--all', 'Include revoked memberships')
    .action((organizationValue: string, options?: { path?: string, all?: boolean }) => {
      const store = openControlPlane(options?.path)
      try {
        const organization = resolveOrganization(store, organizationValue)
        cli.header(`${organization.name} members`)
        for (const membership of store.listMemberships(organization.id, { includeRevoked: options?.all })) {
          const actor = store.getActor(membership.actorId)
          cli.info(`${actor?.displayName ?? membership.actorId}  ${membership.roleTemplate}  ${membership.scope.type}:${membership.scope.id ?? organization.slug}  ${membership.status}  ${membership.id}`)
          for (const grant of store.listGrants(membership.id))
            cli.info(`  ${grant.effect} ${grant.capability} @ ${grant.scope.type}:${grant.scope.id ?? organization.slug}`)
        }
      }
      finally { store.close() }
    })

  app
    .command('organization:invite <organization> <email>', 'Create a hashed, expiring organization invitation')
    .option('--path <path>', 'Use a non-default control-plane database')
    .option('--role <role>', 'owner|admin|deployer|operator|viewer|auditor', { default: 'viewer' })
    .option('--scope <scope>', 'organization|project|environment|resource', { default: 'organization' })
    .option('--scope-id <id>', 'Project, environment, or resource ID')
    .option('--days <days>', 'Invitation lifetime in days', { default: '7' })
    .option('--base-url <url>', 'Dashboard URL used to print the acceptance link', { default: 'http://127.0.0.1:7676' })
    .action((organizationValue: string, email: string, options?: { path?: string, role?: string, scope?: string, scopeId?: string, days?: string, baseUrl?: string }) => {
      const store = openControlPlane(options?.path)
      try {
        const organization = resolveOrganization(store, organizationValue)
        if (!['owner', 'admin', 'deployer', 'operator', 'viewer', 'auditor'].includes(options?.role ?? 'viewer'))
          throw new Error('Unknown role template.')
        const created = store.createInvitation({
          organizationId: organization.id,
          email,
          roleTemplate: (options?.role ?? 'viewer') as OrganizationRoleTemplate,
          scope: commandScope(options?.scope, options?.scopeId),
          expiresInMs: Number(options?.days ?? 7) * 86_400_000,
        })
        cli.success(`Invitation created for ${created.invitation.email}; expires ${created.invitation.expiresAt}`)
        cli.info(`${String(options?.baseUrl ?? 'http://127.0.0.1:7676').replace(/\/$/, '')}/accept-invitation?token=${encodeURIComponent(created.token)}`)
        cli.info('This token is shown once. Resending revokes it and creates a new token.')
      }
      finally { store.close() }
    })

  app
    .command('organization:invitations <organization>', 'List invitation states without exposing tokens')
    .option('--path <path>', 'Use a non-default control-plane database')
    .action((organizationValue: string, options?: { path?: string }) => {
      const store = openControlPlane(options?.path)
      try {
        const organization = resolveOrganization(store, organizationValue)
        cli.header(`${organization.name} invitations`)
        for (const invitation of store.listInvitations(organization.id))
          cli.info(`${invitation.email}  ${invitation.roleTemplate}  ${invitation.scope.type}:${invitation.scope.id ?? organization.slug}  ${invitation.state}  ${invitation.id}`)
      }
      finally { store.close() }
    })

  app
    .command('organization:revoke-invitation <id>', 'Revoke a pending organization invitation')
    .option('--path <path>', 'Use a non-default control-plane database')
    .action((id: string, options?: { path?: string }) => {
      const store = openControlPlane(options?.path)
      try {
        const invitation = store.revokeInvitation(id)
        cli.success(`Invitation ${invitation.id} is ${invitation.state}.`)
      }
      finally { store.close() }
    })

  app
    .command('organization:grant <organization> <membership> <capability>', 'Add an explicit scoped allow or deny')
    .option('--path <path>', 'Use a non-default control-plane database')
    .option('--effect <effect>', 'allow|deny', { default: 'allow' })
    .option('--scope <scope>', 'organization|project|environment|resource', { default: 'organization' })
    .option('--scope-id <id>', 'Project, environment, or resource ID')
    .action((organizationValue: string, membership: string, capabilityValue: string, options?: { path?: string, effect?: string, scope?: string, scopeId?: string }) => {
      const store = openControlPlane(options?.path)
      try {
        const organization = resolveOrganization(store, organizationValue)
        if (!AUTHORIZATION_CAPABILITIES.includes(capabilityValue as AuthorizationCapability))
          throw new Error(`Unknown capability '${capabilityValue}'.`)
        if (options?.effect !== undefined && !['allow', 'deny'].includes(options.effect))
          throw new Error('Effect must be allow or deny.')
        const grant = store.upsertGrant({
          organizationId: organization.id,
          membershipId: membership,
          effect: (options?.effect ?? 'allow') as AuthorizationEffect,
          capability: capabilityValue as AuthorizationCapability,
          scope: commandScope(options?.scope, options?.scopeId),
        })
        cli.success(`${grant.effect} ${grant.capability} added at ${grant.scope.type}:${grant.scope.id ?? organization.slug}.`)
      }
      finally { store.close() }
    })

  app
    .command('organization:revoke-member <membership>', 'Revoke a membership and invalidate its sessions')
    .option('--path <path>', 'Use a non-default control-plane database')
    .option('--confirm <id>', 'Type the membership ID to confirm')
    .action((membership: string, options?: { path?: string, confirm?: string }) => {
      if (options?.confirm !== membership)
        throw new Error(`Pass --confirm ${membership} to revoke this membership.`)
      const store = openControlPlane(options?.path)
      try {
        const revoked = store.revokeMembership(membership)
        cli.success(`Membership ${revoked.id} revoked; session version is now ${revoked.sessionVersion}.`)
      }
      finally { store.close() }
    })

  app
    .command('auth:identities', 'List local authentication identities without credential material')
    .option('--path <path>', 'Use a non-default control-plane database')
    .action((options?: { path?: string }) => {
      const store = openControlPlane(options?.path)
      try {
        const authentication = new AuthenticationStore(store)
        cli.header('Authentication identities')
        for (const identity of authentication.listIdentities())
          cli.info(`${identity.username}  ${identity.email ?? 'no-email'}  ${identity.disabledAt ? 'disabled' : 'active'}  ${identity.id}`)
      }
      finally { store.close() }
    })

  app
    .command('auth:reset-link <identity>', 'Create a one-time password reset link for offline recovery')
    .option('--path <path>', 'Use a non-default control-plane database')
    .option('--base-url <url>', 'Dashboard URL used to print the reset link', { default: 'http://127.0.0.1:7676' })
    .action((identityValue: string, options?: { path?: string, baseUrl?: string }) => {
      const store = openControlPlane(options?.path)
      try {
        const authentication = new AuthenticationStore(store)
        const identity = resolveAuthIdentity(authentication, identityValue)
        authentication.revokeActionTokens(identity.id, 'password_reset')
        const created = authentication.createActionToken(identity.id, 'password_reset')
        cli.success(`Created a one-time reset link for ${identity.username}; it expires ${created.actionToken.expiresAt}.`)
        cli.info(`${String(options?.baseUrl ?? 'http://127.0.0.1:7676').replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(created.token)}`)
      }
      finally { store.close() }
    })

  app
    .command('auth:sessions <identity>', 'List active and expired sessions for an identity')
    .option('--path <path>', 'Use a non-default control-plane database')
    .action((identityValue: string, options?: { path?: string }) => {
      const store = openControlPlane(options?.path)
      try {
        const authentication = new AuthenticationStore(store)
        const identity = resolveAuthIdentity(authentication, identityValue)
        cli.header(`${identity.username} sessions`)
        for (const session of authentication.listSessions(identity.id, { includeInactive: true }))
          cli.info(`${session.state}  ${session.authMethod}  ${session.userAgent ?? 'unknown-device'}  ${session.lastUsedAt}  ${session.id}`)
      }
      finally { store.close() }
    })

  app
    .command('auth:revoke-sessions <identity>', 'Revoke every dashboard session for an identity')
    .option('--path <path>', 'Use a non-default control-plane database')
    .option('--confirm <identity>', 'Type the username or email to confirm')
    .action((identityValue: string, options?: { path?: string, confirm?: string }) => {
      if (options?.confirm !== identityValue)
        throw new Error(`Pass --confirm ${identityValue} to revoke these sessions.`)
      const store = openControlPlane(options?.path)
      try {
        const authentication = new AuthenticationStore(store)
        const identity = resolveAuthIdentity(authentication, identityValue)
        const sessions = authentication.listSessions(identity.id)
        for (const session of sessions)
          authentication.revokeSession(identity.id, session.id)
        cli.success(`Revoked ${sessions.length} session(s) for ${identity.username}.`)
      }
      finally { store.close() }
    })

  app
    .command('auth:disable-mfa <identity>', 'Disable MFA through the offline administrative recovery path')
    .option('--path <path>', 'Use a non-default control-plane database')
    .option('--confirm <identity>', 'Type the username or email to confirm')
    .action((identityValue: string, options?: { path?: string, confirm?: string }) => {
      if (options?.confirm !== identityValue)
        throw new Error(`Pass --confirm ${identityValue} to disable MFA.`)
      const store = openControlPlane(options?.path)
      try {
        const authentication = new AuthenticationStore(store)
        const identity = resolveAuthIdentity(authentication, identityValue)
        authentication.disableMfa(identity.id)
        for (const session of authentication.listSessions(identity.id))
          authentication.revokeSession(identity.id, session.id)
        cli.success(`Disabled MFA and revoked active sessions for ${identity.username}.`)
      }
      finally { store.close() }
    })
}
