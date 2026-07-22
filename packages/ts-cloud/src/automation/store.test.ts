import { describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { AutomationIdentityStore } from './store'

function fixture() {
  let now = new Date('2026-07-21T12:00:00.000Z')
  const controlPlane = new ControlPlaneStore({ path: ':memory:', now: () => now })
  const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
  const project = controlPlane.createProject({ organizationId: organization.id, slug: 'web', name: 'Web' })
  const production = controlPlane.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
  const staging = controlPlane.createEnvironment({ projectId: project.id, slug: 'staging', name: 'Staging', kind: 'staging' })
  const automation = new AutomationIdentityStore(controlPlane, { now: () => now })
  return { controlPlane, organization, project, production, staging, automation, setNow: (value: Date) => { now = value } }
}

describe('AutomationIdentityStore', () => {
  it('creates a least-privilege machine actor and stores only a token hash', () => {
    const { controlPlane, organization, production, automation } = fixture()
    const created = automation.createServiceAccount({
      organizationId: organization.id,
      slug: 'production-ci',
      name: 'Production CI',
      roleTemplate: 'deployer',
      scope: { type: 'environment', id: production.id },
    })
    const issued = automation.createToken({
      serviceAccountId: created.serviceAccount.id,
      name: 'GitHub Actions',
      capabilities: ['project:read', 'deployments:read', 'deployments:create'],
      scope: { type: 'environment', id: production.id },
    })

    expect(controlPlane.getActor(created.serviceAccount.actorId)?.kind).toBe('service_account')
    expect(created.membership).toMatchObject({ roleTemplate: 'deployer', scope: { type: 'environment', id: production.id } })
    expect(issued.secret).toStartWith(`tsc_v1.${issued.token.id}.`)
    expect(JSON.stringify(controlPlane.database.query('SELECT * FROM api_tokens').get())).not.toContain(issued.secret)
    expect(automation.verifyToken(issued.secret, 'network-hash')).toMatchObject({ token: { lastNetworkHint: 'network-hash' }, serviceAccount: { slug: 'production-ci' } })
    expect(() => automation.createToken({ serviceAccountId: created.serviceAccount.id, name: 'Too broad', capabilities: ['secrets:read'], scope: { type: 'environment', id: production.id } })).toThrow('does not grant secrets:read')
    controlPlane.close()
  })

  it('enforces resource boundaries, expiry, rotation overlap, and immediate revocation', () => {
    const { controlPlane, organization, production, staging, automation, setNow } = fixture()
    const account = automation.createServiceAccount({ organizationId: organization.id, slug: 'ci-runner', name: 'CI Runner', roleTemplate: 'deployer', scope: { type: 'environment', id: production.id } }).serviceAccount
    expect(() => automation.createToken({ serviceAccountId: account.id, name: 'Staging escape', capabilities: ['deployments:create'], scope: { type: 'environment', id: staging.id } })).toThrow('does not grant')
    const original = automation.createToken({ serviceAccountId: account.id, name: 'Production deploy', capabilities: ['deployments:create'], scope: { type: 'environment', id: production.id } })
    const rotated = automation.rotateToken(original.token.id)

    expect(automation.verifyToken(original.secret)).toBeDefined()
    expect(automation.verifyToken(rotated.secret)).toBeDefined()
    expect(rotated.token.rotatedFromTokenId).toBe(original.token.id)
    automation.revokeToken(original.token.id)
    expect(automation.verifyToken(original.secret)).toBeUndefined()
    expect(automation.verifyToken(rotated.secret)).toBeDefined()
    setNow(new Date('2026-10-20T12:00:01.000Z'))
    expect(automation.verifyToken(rotated.secret)).toBeUndefined()
    controlPlane.close()
  })

  it('replays identical idempotent responses and rejects key reuse with another body', () => {
    const { controlPlane, organization, automation } = fixture()
    const account = automation.createServiceAccount({ organizationId: organization.id, slug: 'automation', name: 'Automation', roleTemplate: 'admin' }).serviceAccount
    const issued = automation.createToken({ serviceAccountId: account.id, name: 'API', capabilities: ['deployments:create'] })
    const operation = controlPlane.createOperation({ actorId: account.actorId, kind: 'api.deploy' })
    const saved = automation.saveIdempotency({ tokenId: issued.token.id, key: 'deploy-request-123', requestHash: 'body-a', operationId: operation.id, responseStatus: 202, responseBody: { operationId: operation.id } })

    expect(automation.saveIdempotency({ tokenId: issued.token.id, key: 'deploy-request-123', requestHash: 'body-a', operationId: operation.id, responseStatus: 202, responseBody: {} })).toEqual(saved)
    expect(() => automation.saveIdempotency({ tokenId: issued.token.id, key: 'deploy-request-123', requestHash: 'body-b', responseStatus: 202, responseBody: {} })).toThrow('different request')
    controlPlane.close()
  })

  it('revokes every token and membership when the service account is disabled', () => {
    const { controlPlane, organization, automation } = fixture()
    const created = automation.createServiceAccount({ organizationId: organization.id, slug: 'retired-ci', name: 'Retired CI', roleTemplate: 'viewer' })
    const issued = automation.createToken({ serviceAccountId: created.serviceAccount.id, name: 'Read API', capabilities: ['project:read'] })

    expect(automation.disableServiceAccount(created.serviceAccount.id).state).toBe('disabled')
    expect(automation.verifyToken(issued.secret)).toBeUndefined()
    expect(controlPlane.getMembership(created.membership.id)?.status).toBe('revoked')
    controlPlane.close()
  })
})
