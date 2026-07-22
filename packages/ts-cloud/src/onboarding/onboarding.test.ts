import type { ApplicationDraftInput } from './types'
import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlPlaneStore } from '../control-plane'
import { inspectApplicationArchive } from './archive'
import { ApplicationArtifactStore } from './artifact-store'
import { detectApplication, scanApplicationDirectory } from './detection'
import { migrateApplicationDraft } from './migrations'
import { parseApplicationManifest, planApplication } from './plan'
import { RegistryConnectionStore } from './registry'
import { applyApplicationDraft } from './service'
import { ApplicationDraftStore } from './store'

function base(build: ApplicationDraftInput['build'], runtime: ApplicationDraftInput['runtime']): ApplicationDraftInput {
  return { schemaVersion: 1, name: 'Web', slug: 'web', projectId: 'project', environmentId: 'production', source: { kind: 'local', root: '.' }, build, runtime }
}

function storedZip(path: string, content = 'hello'): Uint8Array {
  const name = new TextEncoder().encode(path); const body = new TextEncoder().encode(content); const bytes = new Uint8Array(30 + name.length + body.length); const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(8, 0, true); view.setUint32(18, body.length, true); view.setUint32(22, body.length, true); view.setUint16(26, name.length, true)
  bytes.set(name, 30); bytes.set(body, 30 + name.length); return bytes
}

function tar(path: string, kind = '0'): Uint8Array {
  const bytes = new Uint8Array(1024); const encoder = new TextEncoder(); bytes.set(encoder.encode(path), 0); bytes.set(encoder.encode('00000000000\0'), 124); bytes[156] = kind.charCodeAt(0); return bytes
}

describe('application detection', () => {
  it('detects Dockerfile, Bun/Node, Laravel, PHP, and static projects from explicit evidence', () => {
    expect(detectApplication([{ path: 'Dockerfile', content: 'FROM oven/bun' }, { path: 'package.json', content: '{"scripts":{"start":"bun index.ts"}}' }, { path: 'bun.lock' }]).map(item => item.framework)).toEqual(['dockerfile', 'bun'])
    expect(detectApplication([{ path: 'package.json', content: '{"scripts":{"start":"node server.js"}}' }, { path: 'package-lock.json' }])[0]).toMatchObject({ framework: 'node', strategy: 'server' })
    expect(detectApplication([{ path: 'artisan' }, { path: 'composer.json', content: '{"require":{"laravel/framework":"^12"}}' }])[0]).toMatchObject({ framework: 'laravel', confidence: .98 })
    expect(detectApplication([{ path: 'composer.json', content: '{"require":{}}' }])[0]).toMatchObject({ framework: 'php' })
    expect(detectApplication([{ path: 'index.html' }])[0]).toMatchObject({ framework: 'static', strategy: 'static' })
  })

  it('scans metadata without executing code and rejects symlink traversal', () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-cloud-detection-'))
    try {
      writeFileSync(join(root, 'package.json'), '{"scripts":{"start":"bun index.ts"}}')
      writeFileSync(join(root, 'bun.lock'), '')
      mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules', 'ignored'), 'ignored')
      expect(scanApplicationDirectory(root).map(file => file.path)).toEqual(['bun.lock', 'package.json'])
      symlinkSync('/tmp', join(root, 'escape'))
      expect(() => scanApplicationDirectory(root)).toThrow('refuses symbolic links')
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('keeps ambiguous evidence ranked and unsupported projects manually configurable', () => {
    const ambiguous = detectApplication([{ path: 'Dockerfile' }, { path: 'package.json', content: '{}' }, { path: 'bun.lock' }])
    expect(ambiguous).toHaveLength(2)
    expect(ambiguous[0]).toMatchObject({ framework: 'dockerfile', confidence: .99 })
    expect(detectApplication([{ path: 'README.md' }])[0]).toMatchObject({ framework: 'unknown', strategy: 'buildpack', confidence: .2 })
  })
})

describe('application planning', () => {
  it('round-trips deterministic manifests for four build strategies', () => {
    const drafts = [
      base({ kind: 'server', runtime: 'bun', startCommand: 'bun run start' }, { target: 'server', architecture: 'arm64', port: 3000, healthCheck: { protocol: 'http', path: '/health' } }),
      base({ kind: 'static', publishDirectory: 'dist', buildCommand: 'bun run build' }, { target: 'serverless', architecture: 'x86_64' }),
      base({ kind: 'dockerfile', context: '.', dockerfile: 'Dockerfile', target: 'release' }, { target: 'container', architecture: 'x86_64', port: 8080, healthCheck: { protocol: 'tcp' } }),
      { ...base({ kind: 'prebuilt_image', image: 'registry.example/acme/web@sha256:abc' }, { target: 'container', architecture: 'arm64', port: 8080, healthCheck: { protocol: 'http', path: '/ready' } }), source: { kind: 'image', image: 'registry.example/acme/web@sha256:abc' } as const },
    ]
    for (const draft of drafts) {
      const first = planApplication(draft)
      const second = planApplication(draft)
      expect(first.valid).toBe(true)
      expect(first.serializedManifest).toBe(second.serializedManifest)
      expect(parseApplicationManifest(first.serializedManifest)).toEqual(first.manifest)
    }
  })

  it('fails invalid combinations before mutation and redacts misplaced secrets', () => {
    const draft = base({ kind: 'dockerfile', context: '../escape', dockerfile: '/Dockerfile', buildArgs: { API_TOKEN: 'do-not-leak' }, secretNames: ['REGISTRY_PASSWORD'] }, { target: 'serverless', architecture: 'x86_64', port: 70000, healthCheck: { protocol: 'http', path: 'health' } })
    draft.environment = { DATABASE_PASSWORD: 'do-not-leak-either' }
    draft.domain = { hostname: 'not a domain' }
    const plan = planApplication(draft)
    expect(plan.valid).toBe(false)
    expect(plan.issues.map(item => item.code)).toEqual(expect.arrayContaining(['write_only_secret_required', 'write_only_build_secret_required', 'unsafe_docker_path', 'unsupported_serverless_dockerfile', 'invalid_port', 'invalid_health_path', 'invalid_domain']))
    expect(plan.missingSecrets).toEqual(['DATABASE_PASSWORD', 'REGISTRY_PASSWORD'])
    expect(JSON.stringify(plan)).not.toContain('do-not-leak')
  })
})

describe('application archive inspection', () => {
  it('accepts bounded safe ZIP and TAR entries without extracting them', () => {
    expect(inspectApplicationArchive(storedZip('dist/index.html'), 'site.zip')).toMatchObject({ format: 'zip', entries: 1, expandedBytes: 5, paths: ['dist/index.html'] })
    expect(inspectApplicationArchive(tar('public/index.html'), 'site.tar')).toMatchObject({ format: 'tar', entries: 1, paths: ['public/index.html'] })
  })

  it('stores inspected artifacts with restrictive permissions and deduplicates content', () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-cloud-artifact-'))
    try {
      const controlPlane = new ControlPlaneStore({ path: ':memory:' }); const organization = controlPlane.createOrganization({ slug: 'artifacts', name: 'Artifacts' }); const project = controlPlane.createProject({ organizationId: organization.id, slug: 'app', name: 'App' }); const artifacts = new ApplicationArtifactStore(controlPlane, { cwd: root, id: () => 'artifact-1' })
      const created = artifacts.create({ organizationId: organization.id, projectId: project.id, filename: 'site.zip', bytes: storedZip('dist/index.html') })
      expect(created).toMatchObject({ filename: 'site.zip', format: 'zip', entryCount: 1 })
      expect(artifacts.create({ organizationId: organization.id, projectId: project.id, filename: 'site.zip', bytes: storedZip('dist/index.html') }).id).toBe(created.id)
      const raw = controlPlane.database.query<Record<string, string>, [string]>('SELECT storage_path FROM application_artifacts WHERE id=?').get(created.id)!
      expect(statSync(raw.storage_path).mode & 0o777).toBe(0o600)
      expect(() => artifacts.create({ organizationId: organization.id, projectId: project.id, filename: '../site.zip', bytes: storedZip('index.html') })).toThrow('must not contain a path')
      controlPlane.close()
    }
    finally { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }) }
  })

  it('rejects traversal, links, malformed formats, and expansion limits', () => {
    expect(() => inspectApplicationArchive(storedZip('../secret'), 'bad.zip')).toThrow('Unsafe archive path')
    expect(() => inspectApplicationArchive(tar('link', '2'), 'bad.tar')).toThrow('links are not accepted')
    expect(() => inspectApplicationArchive(storedZip('large', '123456'), 'large.zip', { maxExpandedBytes: 5 })).toThrow('expansion limit')
    expect(() => inspectApplicationArchive(new Uint8Array([1, 2, 3]), 'bad.exe')).toThrow('Only ZIP')
  })
})

describe('resumable application drafts', () => {
  it('persists only non-secret inputs, resumes optimistically, and marks a confirmed plan applied', () => {
    let sequence = 0
    const controlPlane = new ControlPlaneStore({ path: ':memory:', id: () => `control-${++sequence}` })
    const organization = controlPlane.createOrganization({ slug: 'drafts', name: 'Drafts' })
    const project = controlPlane.createProject({ organizationId: organization.id, slug: 'web', name: 'Web' })
    const environment = controlPlane.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
    const drafts = new ApplicationDraftStore(controlPlane, { id: () => `draft-${++sequence}` })
    const input = base({ kind: 'server', runtime: 'bun', startCommand: 'bun run start' }, { target: 'server', architecture: 'arm64', port: 3000, healthCheck: { protocol: 'http', path: '/health' } })
    input.projectId = project.id; input.environmentId = environment.id; input.environment = { APP_ENV: 'production', DATABASE_PASSWORD: { secretRef: 'DATABASE_PASSWORD' } }; input.requiredSecretNames = ['DATABASE_PASSWORD']
    const created = drafts.create({ organizationId: organization.id, projectId: project.id, name: 'Web import', draft: input, step: 'environment' })
    expect(created).toMatchObject({ status: 'draft', step: 'environment', version: 1, suppliedSecretNames: [] })
    expect(planApplication(created.input, created.suppliedSecretNames).missingSecrets).toEqual(['DATABASE_PASSWORD'])
    expect(JSON.stringify(created)).not.toContain('database-runtime-value')
    const ready = drafts.update(created.id, 1, { draft: input, step: 'review', suppliedSecretNames: ['DATABASE_PASSWORD'] })
    expect(ready).toMatchObject({ status: 'ready', step: 'review', version: 2 })
    expect(() => drafts.update(created.id, 1, { draft: input, step: 'review' })).toThrow('changed since version')
    expect(drafts.markApplied(created.id, 2)).toMatchObject({ status: 'applied', version: 3 })
    expect(controlPlane.listEvents({ projectId: project.id }).map(event => event.type)).toEqual(['application.draft.created', 'application.draft.updated', 'application.draft.applied'])
    controlPlane.close()
  })

  it('requires explicit target confirmation before creating desired state', () => {
    const controlPlane = new ControlPlaneStore({ path: ':memory:' }); const organization = controlPlane.createOrganization({ slug: 'apply', name: 'Apply' }); const project = controlPlane.createProject({ organizationId: organization.id, slug: 'app', name: 'App' }); const environment = controlPlane.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' }); const drafts = new ApplicationDraftStore(controlPlane)
    const input = base({ kind: 'static', publishDirectory: 'dist', buildCommand: 'bun run build' }, { target: 'serverless', architecture: 'arm64' }); input.projectId = project.id; input.environmentId = environment.id
    const draft = drafts.create({ organizationId: organization.id, projectId: project.id, name: 'Static web', draft: input, step: 'review' })
    expect(() => applyApplicationDraft({ controlPlane, drafts, draftId: draft.id, expectedVersion: draft.version, confirmEnvironment: 'staging' })).toThrow('Type production')
    expect(controlPlane.listResources(project.id)).toHaveLength(0)
    const applied = applyApplicationDraft({ controlPlane, drafts, draftId: draft.id, expectedVersion: draft.version, confirmEnvironment: 'production' })
    expect(applied).toMatchObject({ resource: { slug: 'web', kind: 'application' }, operation: { state: 'queued', kind: 'application.create' }, plan: { valid: true } })
    expect(() => applyApplicationDraft({ controlPlane, drafts, draftId: draft.id, expectedVersion: draft.version + 1, confirmEnvironment: 'production' })).toThrow('already applied')
    controlPlane.close()
  })

  it('queues reproducible create flows for Bun, Laravel, static, Dockerfile, and prebuilt images', () => {
    const controlPlane = new ControlPlaneStore({ path: ':memory:' })
    const organization = controlPlane.createOrganization({ slug: 'strategies', name: 'Strategies' })
    const project = controlPlane.createProject({ organizationId: organization.id, slug: 'matrix', name: 'Matrix' })
    const environment = controlPlane.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
    const drafts = new ApplicationDraftStore(controlPlane)
    const strategies: Array<{ slug: string, build: ApplicationDraftInput['build'], runtime: ApplicationDraftInput['runtime'], source?: ApplicationDraftInput['source'] }> = [
      { slug: 'bun-api', build: { kind: 'server', runtime: 'bun', installCommand: 'bun install --frozen-lockfile', startCommand: 'bun run start' }, runtime: { target: 'server', architecture: 'arm64', port: 3000 } },
      { slug: 'laravel-api', build: { kind: 'server', runtime: 'php', installCommand: 'composer install --no-dev', startCommand: 'php artisan serve --host=0.0.0.0 --port=8080' }, runtime: { target: 'server', architecture: 'x86_64', port: 8080 } },
      { slug: 'static-site', build: { kind: 'static', publishDirectory: 'dist', buildCommand: 'bun run build' }, runtime: { target: 'serverless', architecture: 'arm64' } },
      { slug: 'docker-app', build: { kind: 'dockerfile', context: '.', dockerfile: 'Dockerfile', target: 'release' }, runtime: { target: 'container', architecture: 'x86_64', port: 8080 } },
      { slug: 'oci-app', build: { kind: 'prebuilt_image', image: 'registry.example/acme/web@sha256:abc' }, runtime: { target: 'container', architecture: 'arm64', port: 8080 }, source: { kind: 'image', image: 'registry.example/acme/web@sha256:abc' } },
    ]
    for (const strategy of strategies) {
      const input = base(strategy.build, strategy.runtime)
      input.name = strategy.slug
      input.slug = strategy.slug
      input.projectId = project.id
      input.environmentId = environment.id
      if (strategy.source) input.source = strategy.source
      const draft = drafts.create({ organizationId: organization.id, projectId: project.id, name: `${strategy.slug} import`, draft: input, step: 'review' })
      const applied = applyApplicationDraft({ controlPlane, drafts, draftId: draft.id, expectedVersion: draft.version, confirmEnvironment: 'production' })
      expect(applied.plan.manifest.spec.build.kind).toBe(strategy.build.kind)
      expect(applied.resource.desiredState).toMatchObject({ manifest: { spec: { build: { kind: strategy.build.kind } } } })
      expect(applied.operation).toMatchObject({ kind: 'application.create', state: 'queued', resourceId: applied.resource.id })
      expect(controlPlane.database.query<Record<string, number>, [string]>('SELECT build_slot FROM operation_jobs WHERE operation_id=?').get(applied.operation.id)?.build_slot).toBe(strategy.build.kind === 'prebuilt_image' ? 0 : 1)
    }
    expect(controlPlane.listOperations({ projectId: project.id }).map(operation => operation.kind)).toEqual(Array(5).fill('application.create'))
    expect(controlPlane.listResources(project.id, environment.id).map(resource => resource.slug).sort()).toEqual(strategies.map(strategy => strategy.slug).sort())
    controlPlane.close()
  })

  it('migrates prototype drafts and refuses embedded secret values', () => {
    const migrated = migrateApplicationDraft({ schemaVersion: 0, appName: 'Legacy', applicationSlug: 'legacy', projectId: 'project', environmentId: 'prod', strategy: 'static', publishDirectory: 'public', secretNames: ['API_TOKEN'] })
    expect(migrated).toMatchObject({ schemaVersion: 1, name: 'Legacy', slug: 'legacy', build: { kind: 'static', publishDirectory: 'public' }, requiredSecretNames: ['API_TOKEN'] })
    const controlPlane = new ControlPlaneStore({ path: ':memory:' }); const organization = controlPlane.createOrganization({ slug: 'secrets', name: 'Secrets' }); const project = controlPlane.createProject({ organizationId: organization.id, slug: 'app', name: 'App' })
    const draft = base({ kind: 'dockerfile', context: '.', dockerfile: 'Dockerfile', buildArgs: { API_TOKEN: 'runtime-secret' } }, { target: 'container', architecture: 'x86_64' }); draft.projectId = project.id
    expect(() => new ApplicationDraftStore(controlPlane).create({ organizationId: organization.id, projectId: project.id, name: 'Unsafe', draft })).toThrow('build secret name')
    controlPlane.close()
  })
})

describe('private registry connections', () => {
  it('encrypts, tests, rotates, expires, and disconnects image-pull credentials', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z'); let sequence = 0
    const controlPlane = new ControlPlaneStore({ path: ':memory:' }); const organization = controlPlane.createOrganization({ slug: 'registry', name: 'Registry' })
    const registries = new RegistryConnectionStore(controlPlane, { encryptionKey: 'registry-fixture', now: () => now, id: () => `registry-${++sequence}` })
    const created = registries.create({ organizationId: organization.id, provider: 'generic', name: 'Production OCI', host: 'https://registry.example', credential: { username: 'robot', password: 'runtime-password' }, credentialExpiresAt: '2026-02-01T00:00:00.000Z' })
    expect(created).toMatchObject({ credentialConfigured: true, status: 'pending' })
    const raw = controlPlane.database.query<Record<string, string>, [string]>('SELECT credential_ciphertext FROM registry_connections WHERE id=?').get(created.id)!
    expect(raw.credential_ciphertext).not.toContain('runtime-password')
    const calls: Array<{ url: string, authorization?: string }> = []
    const fetch = (async (value: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(value), authorization: new Headers(init?.headers).get('authorization') ?? undefined }); return new Response(null, { status: 200 }) }) as typeof globalThis.fetch
    expect(await registries.test(created.id, { image: 'registry.example/acme/web:release', fetch })).toMatchObject({ status: 'healthy', healthMessage: 'Registry image is readable.' })
    expect(calls.map(call => call.url)).toEqual(['https://registry.example/v2/', 'https://registry.example/v2/acme/web/manifests/release'])
    expect(calls.every(call => call.authorization?.startsWith('Basic '))).toBe(true)
    expect(registries.rotate(created.id, { token: 'replacement' }, { expiresAt: '2026-03-01T00:00:00.000Z' })).toMatchObject({ status: 'pending', version: 3 })
    now = new Date('2026-04-01T00:00:00.000Z')
    expect(registries.get(created.id)?.status).toBe('expired')
    expect(registries.disconnect(created.id)).toMatchObject({ status: 'disconnected', credentialConfigured: false })
    expect(registries.credential(created.id)).toBeUndefined()
    controlPlane.close()
  })

  it('follows bounded HTTPS bearer challenges without returning credentials', async () => {
    const controlPlane = new ControlPlaneStore({ path: ':memory:' }); const organization = controlPlane.createOrganization({ slug: 'bearer', name: 'Bearer' }); const registries = new RegistryConnectionStore(controlPlane, { encryptionKey: 'registry-fixture' })
    const connection = registries.create({ organizationId: organization.id, provider: 'docker_hub', name: 'Docker Hub', host: 'https://registry-1.docker.io', credential: { username: 'robot', password: 'password' } })
    const fetch = (async (value: string | URL | Request) => {
      const url = String(value)
      if (url === 'https://registry-1.docker.io/v2/') return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' } })
      if (url.startsWith('https://auth.docker.io/token')) return Response.json({ token: 'short-lived' })
      return new Response(null, { status: 200 })
    }) as typeof globalThis.fetch
    expect(await registries.test(connection.id, { image: 'registry-1.docker.io/library/bun:latest', fetch })).toMatchObject({ status: 'healthy' })
    controlPlane.close()
  })
})
