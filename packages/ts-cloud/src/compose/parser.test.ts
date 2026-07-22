import { describe, expect, it } from 'bun:test'
import { diffCompose, exportCompose, parseCompose } from './parser'
import { buildComposeRuntimeCommand, buildComposeScaleCommand } from './runtime'
import { listComposeTemplates, parseComposeCatalog, planComposeTemplateUpgrade, renderComposeTemplate } from './templates'

const target = { name: 'Commerce', projectId: 'project-1', environmentId: 'environment-1' }
const representative = `services:\n  web:\n    build: { context: ., dockerfile: Dockerfile }\n    environment:\n      DATABASE_URL: \${DATABASE_URL}\n      APP_ENV: production\n    ports: ["8080:3000"]\n    labels: { ts-cloud.domain: app.example.com }\n    depends_on:\n      postgres: { condition: service_healthy }\n      redis: { condition: service_healthy }\n  worker:\n    image: acme/worker:1.2.3\n    depends_on: [postgres, redis]\n  postgres:\n    image: postgres:17.5\n    environment:\n      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}\n    volumes: [database:/var/lib/postgresql/data]\n    healthcheck: { test: [CMD-SHELL, pg_isready], interval: 10s, timeout: 5s, retries: 5 }\n  redis:\n    image: redis:8.0.3\nvolumes: { database: {} }\n`

describe('Compose subset conversion', () => {
  it('normalizes and round-trips web, worker, Postgres, and Redis without secrets', () => {
    const parsed = parseCompose(representative, target)
    expect(parsed.valid).toBe(true)
    expect(parsed.manifest.spec.dependencyOrder).toEqual(['postgres', 'redis', 'web', 'worker'])
    expect(parsed.manifest.spec.services.web).toMatchObject({ ports: [{ published: 8080, target: 3000 }], environment: { DATABASE_URL: { secretRef: 'DATABASE_URL' } }, domains: ['app.example.com'] })
    expect(parsed.redactedSource).not.toContain('POSTGRES_PASSWORD: plain')
    const roundTrip = parseCompose(exportCompose(parsed.manifest), target)
    expect(roundTrip.manifest).toEqual(parsed.manifest)
  })

  it('blocks dangerous container access and literal secrets before mutation', () => {
    const result = parseCompose(`services:\n  app:\n    image: acme/app:latest\n    privileged: true\n    network_mode: host\n    volumes: [/etc:/host]\n    environment: { API_TOKEN: literal-value }\n`, target)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map(issue => issue.code)).toEqual(expect.arrayContaining(['unsafe.privileged', 'unsafe.network_mode', 'volume.host_mount', 'secret.literal', 'image.floating']))
    expect(result.redactedSource).not.toContain('literal-value')
  })

  it('orders health dependencies, reports cycles, and emits inspectable diffs', () => {
    const cyclic = parseCompose(`services:\n  a: { image: a:1, depends_on: [b] }\n  b: { image: b:1, depends_on: [a] }\n`, target)
    expect(cyclic.diagnostics.map(issue => issue.code)).toContain('dependency.cycle')
    const first = parseCompose(representative, target).manifest; const next = structuredClone(first); next.spec.services.web.replicas = 3
    expect(diffCompose(first, next)).toContainEqual({ path: 'spec.services.web.replicas', before: 1, after: 3 })
  })

  it('builds namespace-safe deploy and destructive-volume commands', () => {
    const manifest = parseCompose(representative, target).manifest
    expect(buildComposeRuntimeCommand(manifest, 'deploy')).toContain('docker compose --project-name')
    expect(buildComposeRuntimeCommand(manifest, 'delete')).not.toContain('--volumes')
    expect(buildComposeRuntimeCommand(manifest, 'delete', { removeVolumes: true })).toContain('--volumes')
    expect(buildComposeScaleCommand(manifest, 'worker', 4)).toContain("'worker=4'")
  })
})

describe('versioned Compose templates', () => {
  it('exposes verified metadata and resolves to a normal editable manifest', () => {
    expect(listComposeTemplates()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'bun-postgres-redis', version: '1.0.0', checksum: expect.stringMatching(/^[a-f0-9]{64}$/), exposedServices: ['web'] })]))
    const rendered = renderComposeTemplate('bun-postgres-redis', { domain: 'preview.example.com' }, target)
    expect(rendered.valid).toBe(true)
    expect(rendered.manifest.spec.services.web.domains).toEqual(['preview.example.com'])
    expect(exportCompose(rendered.manifest)).not.toContain('{{domain}}')
  })

  it('validates checksum-pinned local catalogs and separates upgrade from user changes', () => {
    const compose = `services:\n  app: { image: acme/app:1.0.0 }\n`; const checksum = new Bun.CryptoHasher('sha256').update(compose).digest('hex')
    const catalog = parseComposeCatalog(JSON.stringify({ apiVersion: 'ts-cloud.dev/compose-catalog/v1', source: 'file:./catalog.json', templates: [{ id: 'custom-app', version: '1.0.0', name: 'Custom app', compose, checksum }] }), target)
    expect(catalog).toMatchObject({ valid: true, templates: [{ template: { id: 'custom-app', builtin: false, checksum }, parsed: { valid: true } }] })
    const previous = renderComposeTemplate('wordpress', { domain: 'cms.example.com' }, target, '1.0.0').manifest; const current = structuredClone(previous); current.spec.services.wordpress.replicas = 2
    const plan = planComposeTemplateUpgrade(current, previous, 'wordpress', { domain: 'cms.example.com' }, target, '1.0.0')
    expect(plan.templateChanges).toEqual([]); expect(plan.userChanges).toContainEqual({ path: 'spec.services.wordpress.replicas', before: 1, after: 2 })
  })
})
