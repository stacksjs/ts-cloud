import type { CloudConfig } from '@ts-cloud/core'
import type { DashboardUser } from './dashboard-auth'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDashboardControlPlane, synchronizeDashboardUsers } from './dashboard-control-plane'
import { createDashboardGuard, dashboardMembershipVersions } from './dashboard-guard'
import { createSessionToken, serializeSessionCookie } from './dashboard-session'
import { saveUsers } from './dashboard-users'

const secret = 'guard-test-secret'
let root: string | undefined

afterEach(() => {
  if (root)
    rmSync(root, { recursive: true, force: true })
  root = undefined
})

function setup() {
  root = mkdtempSync(join(tmpdir(), 'ts-cloud-guard-'))
  const config = {
    project: { name: 'Acme', slug: 'acme', region: 'us-west-2' },
    environments: { production: { type: 'production' } },
    sites: {
      blog: { domain: 'blog.test', root: '.', start: 'bun blog.ts', port: 3000 },
      private: { domain: 'private.test', root: '.', start: 'bun private.ts', port: 3001 },
    },
  } as CloudConfig
  const users: DashboardUser[] = [
    { username: 'owner', passwordHash: 'test', role: 'admin', sites: {} },
    { username: 'dev', passwordHash: 'test', role: 'member', sites: { blog: 'collaborator' } },
  ]
  saveUsers(root, users)
  const controlPlane = initializeDashboardControlPlane(root, config)
  synchronizeDashboardUsers(controlPlane, users)
  const guard = createDashboardGuard({
    cwd: root,
    enabled: true,
    secret,
    authorization: {
      store: controlPlane.store,
      organizationId: controlPlane.organization.id,
      projectId: controlPlane.project.id,
      defaultEnvironment: 'production',
    },
  })
  const request = (user: DashboardUser, path: string, method = 'GET', body?: Record<string, unknown>) => {
    const token = createSessionToken(user.username, secret, undefined, dashboardMembershipVersions(controlPlane.store, controlPlane.organization.id, user))
    return new Request(`http://localhost${path}`, {
      method,
      headers: { cookie: serializeSessionCookie(token, { secure: false }), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  }
  return { controlPlane, guard, users, request }
}

describe('dashboard organization guard', () => {
  it('allows a legacy collaborator to deploy only an assigned site', () => {
    const { controlPlane, guard, users, request } = setup()
    const allowedRequest = request(users[1], '/api/sites/deploy?env=production', 'POST', { name: 'blog' })
    const user = guard.resolveUser(allowedRequest)
    expect(user?.username).toBe('dev')
    expect(guard.check(allowedRequest, '/api/sites/deploy', user, 'blog')).toMatchObject({ ok: true })

    const guessedRequest = request(users[1], '/api/sites/deploy?env=production', 'POST', { name: 'private' })
    const guessedUser = guard.resolveUser(guessedRequest)
    expect(guard.check(guessedRequest, '/api/sites/deploy', guessedUser, 'private')).toMatchObject({ ok: false, status: 403, error: 'You do not have access to this.' })
    controlPlane.store.close()
  })

  it('keeps viewers out of terminal, data mutations, and project-wide writes', () => {
    const { controlPlane, guard, users, request } = setup()
    for (const [method, path] of [['GET', '/api/terminal'], ['POST', '/api/databases'], ['POST', '/api/sites']] as const) {
      const req = request(users[1], path, method)
      expect(guard.check(req, path, guard.resolveUser(req))).toMatchObject({ ok: false, status: 403 })
    }
    controlPlane.store.close()
  })

  it('invalidates an active session as soon as membership changes', () => {
    const { controlPlane, guard, users, request } = setup()
    const req = request(users[1], '/api/me')
    expect(guard.resolveUser(req)?.username).toBe('dev')
    const actor = controlPlane.store.getActorByExternalId('user', 'dashboard:dev')!
    const membership = controlPlane.store.getMembershipForActor(controlPlane.organization.id, actor.id)!
    controlPlane.store.updateMembership({ id: membership.id, roleTemplate: membership.roleTemplate, scope: membership.scope })
    expect(guard.resolveUser(req)).toBeNull()
    controlPlane.store.close()
  })

  it('invalidates an active session when a scoped grant is revoked', () => {
    const { controlPlane, guard, users, request } = setup()
    const req = request(users[1], '/api/me')
    expect(guard.resolveUser(req)?.username).toBe('dev')
    const actor = controlPlane.store.getActorByExternalId('user', 'dashboard:dev')!
    const membership = controlPlane.store.getMembershipForActor(controlPlane.organization.id, actor.id)!
    const grant = controlPlane.store.listGrants(membership.id).find(item => item.capability === 'deployments:create')!
    controlPlane.store.removeGrant(grant.id)
    expect(guard.resolveUser(req)).toBeNull()
    controlPlane.store.close()
  })

  it('lets the migrated owner use owner-only organization capabilities', () => {
    const { controlPlane, guard, users, request } = setup()
    const req = request(users[0], '/api/users')
    expect(guard.check(req, '/api/users', guard.resolveUser(req))).toMatchObject({ ok: true })
    controlPlane.store.close()
  })
})
