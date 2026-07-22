import type { ComposeApplicationManifest, ComposeCatalogResult, ComposeDiagnostic, ComposeParseResult, ComposeTemplate, ComposeTemplateUpgradePlan } from './types'
import { createHash } from 'node:crypto'
import { diffCompose, parseCompose } from './parser'

const verified = '2026-07-21T00:00:00.000Z'
const definitions = [
  {
    id: 'bun-postgres-redis',
    name: 'Bun + Postgres + Redis',
    description: 'Web and worker services with durable Postgres and Redis dependencies.',
    category: 'application',
    version: '1.0.0',
    sourceVersion: 'oven/bun:1.2.21,postgres:17.5,redis:8.0.3',
    architecture: 'web → Postgres + Redis; worker → Postgres + Redis',
    minimumResources: { cpu: 2, memoryMb: 3072 },
    exposedServices: ['web'],
    maintenanceNotes: 'Back up the Postgres volume before major upgrades.',
    inputs: [{ name: 'domain', label: 'Web domain', required: true, secret: false }],
    source: `services:\n  web:\n    image: oven/bun:1.2.21\n    command: [bun, run, start]\n    environment:\n      DATABASE_URL: \${DATABASE_URL}\n      REDIS_URL: redis://redis:6379\n    ports: [3000]\n    labels:\n      ts-cloud.domain: {{domain}}\n    depends_on:\n      postgres: { condition: service_healthy }\n      redis: { condition: service_healthy }\n  worker:\n    image: oven/bun:1.2.21\n    command: [bun, run, worker]\n    environment:\n      DATABASE_URL: \${DATABASE_URL}\n      REDIS_URL: redis://redis:6379\n    depends_on:\n      postgres: { condition: service_healthy }\n      redis: { condition: service_healthy }\n  postgres:\n    image: postgres:17.5\n    environment:\n      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}\n    volumes: [postgres-data:/var/lib/postgresql/data]\n    healthcheck: { test: [CMD-SHELL, pg_isready -U postgres], interval: 10s, timeout: 5s, retries: 5 }\n  redis:\n    image: redis:8.0.3\n    volumes: [redis-data:/data]\n    healthcheck: { test: [CMD, redis-cli, ping], interval: 10s, timeout: 5s, retries: 5 }\nvolumes:\n  postgres-data: {}\n  redis-data: {}\n`,
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    description: 'Pinned WordPress and MariaDB with persistent content and database volumes.',
    category: 'cms',
    version: '1.0.0',
    sourceVersion: 'wordpress:6.8.2-php8.3-apache,mariadb:11.8.2',
    architecture: 'WordPress → MariaDB',
    minimumResources: { cpu: 2, memoryMb: 2048 },
    exposedServices: ['wordpress'],
    maintenanceNotes: 'Back up both named volumes before image upgrades.',
    inputs: [{ name: 'domain', label: 'Site domain', required: true, secret: false }],
    source: `services:\n  wordpress:\n    image: wordpress:6.8.2-php8.3-apache\n    environment:\n      WORDPRESS_DB_HOST: db\n      WORDPRESS_DB_PASSWORD: \${WORDPRESS_DB_PASSWORD}\n    ports: [80]\n    labels: { ts-cloud.domain: "{{domain}}" }\n    volumes: [wordpress-data:/var/www/html]\n    depends_on:\n      db: { condition: service_healthy }\n  db:\n    image: mariadb:11.8.2\n    environment:\n      MARIADB_ROOT_PASSWORD: \${MARIADB_ROOT_PASSWORD}\n      MARIADB_DATABASE: wordpress\n    volumes: [database-data:/var/lib/mysql]\n    healthcheck: { test: [CMD, healthcheck.sh, --connect, --innodb_initialized], interval: 10s, timeout: 5s, retries: 8 }\nvolumes:\n  wordpress-data: {}\n  database-data: {}\n`,
  },
] as const

export function listComposeTemplates(): ComposeTemplate[] {
  return definitions.map(({ source: manifestSource, ...template }) => ({
    ...template,
    source: `builtin:${template.id}`,
    lastVerifiedAt: verified,
    builtin: true,
    checksum: createHash('sha256').update(manifestSource).digest('hex'),
    exposedServices: [...template.exposedServices],
    inputs: template.inputs.map((value) => ({ ...value })),
  }))
}
export function getComposeTemplate(id: string, version?: string): ComposeTemplate | undefined {
  return listComposeTemplates().find((template) => template.id === id && (!version || template.version === version))
}
export function renderComposeTemplate(
  id: string,
  inputs: Record<string, string>,
  target: { name: string; projectId: string; environmentId: string },
  version?: string,
): ComposeParseResult {
  const definition = definitions.find((template) => template.id === id && (!version || template.version === version))
  if (!definition) throw new Error(`Compose template ${id}${version ? `@${version}` : ''} was not found`)
  let source: string = definition.source
  for (const input of definition.inputs) {
    const value = inputs[input.name] ?? ('default' in input ? input.default : undefined)
    if (input.required && !value) throw new Error(`Template input ${input.name} is required`)
    if (value && !/^[A-Za-z0-9._:/@+-]{1,255}$/.test(value))
      throw new Error(`Template input ${input.name} contains unsupported characters`)
    source = source.replaceAll(`{{${input.name}}}`, value ?? '')
  }
  return parseCompose(source, target)
}

export function parseComposeCatalog(
  source: string,
  target: { projectId: string; environmentId: string },
): ComposeCatalogResult {
  if (Buffer.byteLength(source) > 1024 * 1024) throw new Error('Compose catalog exceeds the 1 MiB limit')
  let document: Record<string, any>
  try {
    document = JSON.parse(source) as Record<string, any>
  } catch {
    throw new Error('Compose catalog must be valid JSON')
  }
  if (document.apiVersion !== 'ts-cloud.dev/compose-catalog/v1' || !Array.isArray(document.templates))
    throw new Error('Compose catalog must use ts-cloud.dev/compose-catalog/v1 and contain templates')
  const catalogSource = String(document.source ?? '').trim()
  if (!/^https:\/\//.test(catalogSource) && !catalogSource.startsWith('file:'))
    throw new Error('Compose catalog source must be HTTPS or an explicit file: source')
  const diagnostics: ComposeDiagnostic[] = []
  const templates: ComposeCatalogResult['templates'] = []
  for (const [index, entryValue] of document.templates.slice(0, 100).entries()) {
    const entry =
      entryValue && typeof entryValue === 'object' && !Array.isArray(entryValue)
        ? (entryValue as Record<string, any>)
        : {}
    const path = `templates[${index}]`
    const manifestSource = String(entry.compose ?? '')
    const checksum = createHash('sha256').update(manifestSource).digest('hex')
    if (
      !/^[a-z0-9][a-z0-9-]{1,62}$/.test(String(entry.id ?? '')) ||
      !/^\d+\.\d+\.\d+$/.test(String(entry.version ?? ''))
    ) {
      diagnostics.push({
        severity: 'error',
        path,
        code: 'template.identity',
        message: 'Template id and semantic version are required.',
      })
      continue
    }
    if (String(entry.checksum ?? '') !== checksum) {
      diagnostics.push({
        severity: 'error',
        path: `${path}.checksum`,
        code: 'template.checksum',
        message: 'Template checksum does not match its Compose source.',
      })
      continue
    }
    const parsed = parseCompose(manifestSource, {
      name: String(entry.name ?? entry.id),
      projectId: target.projectId,
      environmentId: target.environmentId,
    })
    diagnostics.push(...parsed.diagnostics.map((issue) => ({ ...issue, path: `${path}.compose.${issue.path}` })))
    const template: ComposeTemplate = {
      id: String(entry.id),
      name: String(entry.name ?? entry.id),
      description: String(entry.description ?? ''),
      category: String(entry.category ?? 'custom'),
      version: String(entry.version),
      source: catalogSource,
      sourceVersion: String(entry.sourceVersion ?? entry.version),
      architecture: String(entry.architecture ?? Object.keys(parsed.manifest.spec.services).join(' + ')),
      minimumResources: {
        cpu: Math.max(0.1, Number(entry.minimumResources?.cpu) || 1),
        memoryMb: Math.max(128, Number(entry.minimumResources?.memoryMb) || 512),
      },
      exposedServices: Array.isArray(entry.exposedServices) ? entry.exposedServices.map(String) : [],
      maintenanceNotes: String(entry.maintenanceNotes ?? ''),
      lastVerifiedAt: String(entry.lastVerifiedAt ?? ''),
      inputs: [],
      checksum,
      builtin: false,
    }
    templates.push({ template, parsed })
  }
  return {
    valid: !diagnostics.some((issue) => issue.severity === 'error'),
    source: catalogSource,
    templates,
    diagnostics,
  }
}

export function planComposeTemplateUpgrade(
  current: ComposeApplicationManifest,
  previousTemplate: ComposeApplicationManifest,
  id: string,
  inputs: Record<string, string>,
  target: { name: string; projectId: string; environmentId: string },
  version: string,
): ComposeTemplateUpgradePlan {
  const template = getComposeTemplate(id, version)
  if (!template) throw new Error(`Compose template ${id}@${version} was not found`)
  const parsed = renderComposeTemplate(id, inputs, target, version)
  return {
    template,
    parsed,
    templateChanges: diffCompose(previousTemplate, parsed.manifest),
    userChanges: diffCompose(previousTemplate, current),
  }
}
