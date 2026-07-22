import { describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { SourceConnectionStore } from './store'

function fixture() {
  let sequence = 0
  const controlPlane = new ControlPlaneStore({ path: ':memory:', id: () => `control-${++sequence}` })
  const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
  const actor = controlPlane.createActor({ kind: 'user', externalId: 'dashboard:chris', displayName: 'Chris' })
  const project = controlPlane.createProject({ organizationId: organization.id, slug: 'web', name: 'Web' })
  const environment = controlPlane.createEnvironment({
    projectId: project.id,
    slug: 'production',
    name: 'Production',
    kind: 'production',
  })
  const resource = controlPlane.createResource({
    projectId: project.id,
    environmentId: environment.id,
    kind: 'application',
    slug: 'site',
    name: 'Site',
  })
  const sources = new SourceConnectionStore(controlPlane, {
    encryptionKey: 'fixture-key',
    id: () => `source-${++sequence}`,
  })
  return { controlPlane, sources, organization, actor, project, environment, resource }
}

describe('SourceConnectionStore', () => {
  it('fails closed after credential expiry and allows explicit rotation', () => {
    let now = new Date('2026-01-01T00:00:00.000Z')
    const controlPlane = new ControlPlaneStore({ path: ':memory:' })
    const organization = controlPlane.createOrganization({ slug: 'expiry', name: 'Expiry' })
    const sources = new SourceConnectionStore(controlPlane, { encryptionKey: 'fixture-key', now: () => now })
    const connection = sources.createConnection({
      organizationId: organization.id,
      provider: 'github',
      name: 'Expiring GitHub',
      host: 'https://github.com',
      authKind: 'access_token',
      credential: { token: 'old' },
      credentialExpiresAt: '2026-01-02T00:00:00.000Z',
    })
    expect(sources.getConnection(connection.id)?.status).toBe('pending')
    now = new Date('2026-01-03T00:00:00.000Z')
    expect(sources.getConnection(connection.id)).toMatchObject({
      status: 'expired',
      healthMessage: expect.stringContaining('rotate'),
    })
    expect(() =>
      sources.upsertRepository({
        connectionId: connection.id,
        providerRepositoryId: '1',
        fullName: 'acme/web',
        cloneUrl: 'https://github.com/acme/web.git',
        defaultBranch: 'main',
        visibility: 'private',
        archived: false,
        metadata: {},
      }),
    ).toThrow('Active source connection')
    expect(
      sources.rotateCredential(connection.id, { token: 'new' }, { expiresAt: '2027-01-01T00:00:00.000Z' }),
    ).toMatchObject({ status: 'pending' })
    controlPlane.close()
  })

  it('encrypts credentials and exposes only metadata and a one-way fingerprint', () => {
    const f = fixture()
    const connection = f.sources.createConnection({
      organizationId: f.organization.id,
      provider: 'github',
      name: 'GitHub production',
      host: 'https://github.com/',
      owner: 'acme',
      authKind: 'app',
      credential: { appId: '42', installationId: '9001', privateKey: 'private-material' },
      grantedScopes: ['contents:read', 'metadata:read'],
      createdByActorId: f.actor.id,
    })
    expect(connection).toMatchObject({
      provider: 'github',
      host: 'https://github.com',
      owner: 'acme',
      credentialConfigured: true,
      status: 'pending',
    })
    expect(JSON.stringify(connection)).not.toContain('private-material')
    expect(f.sources.getCredential(connection.id)).toEqual({
      appId: '42',
      installationId: '9001',
      privateKey: 'private-material',
    })

    const raw = f.controlPlane.database
      .query<Record<string, string>, [string]>('SELECT credential_ciphertext FROM source_connections WHERE id = ?')
      .get(connection.id)!
    expect(raw.credential_ciphertext).not.toContain('private-material')
    expect(raw.credential_ciphertext).toStartWith('v1.')

    const rotated = f.sources.rotateCredential(
      connection.id,
      { token: 'replacement-token' },
      { actorId: f.actor.id, expiresAt: '2027-01-01T00:00:00.000Z' },
    )
    expect(rotated.version).toBe(2)
    expect(f.sources.getCredential(connection.id)).toEqual({ token: 'replacement-token' })
    expect(
      f.sources.updateHealth(connection.id, {
        status: 'healthy',
        tested: true,
        grantedScopes: ['metadata:read', 'contents:read', 'webhooks:write'],
      }).grantedScopes,
    ).toEqual(['contents:read', 'metadata:read', 'webhooks:write'])
    expect(f.controlPlane.listEvents({ organizationId: f.organization.id }).map((event) => event.type)).toEqual([
      'source.connection.created',
      'source.credential.rotated',
      'source.connection.scopes_updated',
    ])
  })

  it('stores safe repository metadata and disables every dependent binding on disconnect', () => {
    const f = fixture()
    const connection = f.sources.createConnection({
      organizationId: f.organization.id,
      provider: 'gitlab',
      name: 'GitLab',
      host: 'gitlab.example.test',
      authKind: 'access_token',
      credential: { token: 'token' },
    })
    const repository = f.sources.upsertRepository({
      connectionId: connection.id,
      providerRepositoryId: '88',
      fullName: 'acme/web',
      cloneUrl: 'https://gitlab.example.test/acme/web.git',
      defaultBranch: 'main',
      visibility: 'private',
      archived: false,
      metadata: { namespace: 'acme' },
    })
    expect(f.sources.listRepositories(connection.id, 'WEB')).toMatchObject([
      { id: repository.id, fullName: 'acme/web' },
    ])
    expect(() =>
      f.sources.upsertRepository({
        ...repository,
        providerRepositoryId: '89',
        cloneUrl: 'https://user:token@gitlab.example.test/acme/web.git',
      }),
    ).toThrow('credentials')

    const binding = f.sources.createBinding({
      projectId: f.project.id,
      environmentId: f.environment.id,
      resourceId: f.resource.id,
      connectionId: connection.id,
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      defaultBranch: 'main',
      branchRule: 'main',
      monorepoRoot: 'apps/web',
      includePaths: ['apps/web/**'],
      excludePaths: ['**/*.md'],
      cloneDepth: 10,
    })
    const result = f.sources.disconnectConnection(connection.id, f.actor.id)
    expect(result.affectedBindings.map((item) => item.id)).toEqual([binding.id])
    expect(result.connection).toMatchObject({ status: 'disconnected', credentialConfigured: false })
    expect(f.sources.getBinding(binding.id)).toMatchObject({
      status: 'disabled',
      autoDeploy: false,
      disabledReason: 'Source connection was disconnected',
    })
    expect(f.sources.getCredential(connection.id)).toBeUndefined()
  })

  it('requires encrypted deploy keys and pinned host keys from the same connection', () => {
    const f = fixture()
    const connection = f.sources.createConnection({
      organizationId: f.organization.id,
      provider: 'generic_ssh',
      name: 'Private Git',
      host: 'https://git.example.test',
      authKind: 'deploy_key',
    })
    const key = f.sources.createDeployKey({
      connectionId: connection.id,
      name: 'Readonly production',
      publicKey: `ssh-ed25519 ${Buffer.from('public').toString('base64')} release@test`,
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----',
      host: 'git.example.test',
      hostKey: `ssh-ed25519 ${Buffer.from('host').toString('base64')}`,
      actorId: f.actor.id,
    })
    expect(key).toMatchObject({ connectionId: connection.id, host: 'git.example.test' })
    expect(JSON.stringify(key)).not.toContain('OPENSSH PRIVATE KEY')
    expect(f.sources.listDeployKeys(connection.id)).toEqual([key])
    expect(f.sources.getDeployPrivateKey(key.id)).toContain('OPENSSH PRIVATE KEY')
    expect(() =>
      f.sources.createBinding({
        projectId: f.project.id,
        connectionId: connection.id,
        repositoryFullName: 'acme/web',
        deployKeyId: 'another-key',
      }),
    ).toThrow('does not belong')
    const binding = f.sources.createBinding({
      projectId: f.project.id,
      connectionId: connection.id,
      repositoryFullName: 'acme/web',
      deployKeyId: key.id,
    })
    expect(f.sources.revokeDeployKey(key.id, f.actor.id).affectedBindings).toHaveLength(1)
    expect(f.sources.getDeployKey(key.id)).toBeUndefined()
    expect(f.sources.getBinding(binding.id)).toMatchObject({
      deployKeyId: undefined,
      status: 'disabled',
      autoDeploy: false,
    })
  })
})
