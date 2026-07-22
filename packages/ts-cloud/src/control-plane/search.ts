import type { ControlPlaneStore } from './store'

export type ControlPlaneSearchResultType =
  'project' | 'environment' | 'service' | 'server' | 'database' | 'deployment' | 'operation'

export interface ControlPlaneSearchResult {
  type: ControlPlaneSearchResultType
  id: string
  title: string
  subtitle: string
  href: string
  environment?: string
  status?: string
  provider?: string
  tags: Array<{ id: string; name: string; color: string }>
  score: number
}

export interface ControlPlaneSearchOptions {
  projectId: string
  query: string
  allowedResourceSlugs?: ReadonlySet<string>
  limit?: number
}

const SAFE_METADATA_KEYS: ReadonlySet<string> = new Set([
  'domain',
  'domains',
  'hostname',
  'hostnames',
  'url',
  'repository',
  'repo',
  'image',
  'label',
  'labels',
])
const SAFE_RELEASE_KEYS: ReadonlySet<string> = new Set(['sha', 'commit', 'commitsha', 'release', 'releaseid'])

function searchableValues(value: unknown, allowedKeys: ReadonlySet<string>): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const values: string[] = []
  for (const [key, child] of Object.entries(value)) {
    if (!allowedKeys.has(key.toLowerCase())) continue
    if (typeof child === 'string') values.push(child)
    else if (Array.isArray(child)) values.push(...(child.filter((item) => typeof item === 'string') as string[]))
  }
  return values
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._:/@-]+/g, ' ')
}

function rank(query: string, title: string, text: string): number {
  const wanted = normalize(query)
  const normalizedTitle = normalize(title)
  const normalizedText = normalize(text)
  if (!wanted) return 0
  if (normalizedTitle === wanted) return 1_000
  if (normalizedTitle.startsWith(wanted)) return 800 - Math.min(100, normalizedTitle.length - wanted.length)
  if (normalizedTitle.includes(wanted)) return 650 - Math.min(100, normalizedTitle.indexOf(wanted))
  const tokens = wanted.split(/\s+/).filter(Boolean)
  if (tokens.every((token) => normalizedText.includes(token))) return 400 + tokens.length * 10
  let position = 0
  for (const character of wanted) {
    position = normalizedText.indexOf(character, position)
    if (position < 0) return 0
    position++
  }
  return Math.max(1, 180 - Math.floor(normalizedText.length / 20))
}

function resourceResult(
  resource: { kind: string; slug: string },
  environment: string,
): Pick<ControlPlaneSearchResult, 'type' | 'href'> {
  const kind = resource.kind.toLowerCase()
  if (kind === 'server' || kind === 'compute')
    return { type: 'server', href: `/server/metrics?env=${encodeURIComponent(environment)}` }
  if (kind.includes('database') || ['mysql', 'postgres', 'postgresql', 'sqlite', 'redis'].includes(kind))
    return {
      type: 'database',
      href: `/server/database?env=${encodeURIComponent(environment)}&database=${encodeURIComponent(resource.slug)}`,
    }
  return {
    type: 'service',
    href: `/server/sites?env=${encodeURIComponent(environment)}&service=${encodeURIComponent(resource.slug)}`,
  }
}

export function searchControlPlane(
  store: ControlPlaneStore,
  options: ControlPlaneSearchOptions,
): ControlPlaneSearchResult[] {
  const project = store.getProject(options.projectId)
  if (!project) return []
  const environments = store.listEnvironments(project.id)
  const environmentById = new Map(environments.map((environment) => [environment.id, environment]))
  const tagLinks = store.listResourceTags(project.id)
  const tagsByResource = new Map<string, Array<{ id: string; name: string; color: string }>>()
  for (const link of tagLinks) {
    const tags = tagsByResource.get(link.resourceId) ?? []
    tags.push({ id: link.tag.id, name: link.tag.name, color: link.tag.color })
    tagsByResource.set(link.resourceId, tags)
  }

  const results: ControlPlaneSearchResult[] = []
  const restricted = options.allowedResourceSlugs !== undefined
  if (!restricted) {
    results.push({
      type: 'project',
      id: project.id,
      title: project.name,
      subtitle: project.slug,
      href: `/?project=${encodeURIComponent(project.slug)}`,
      tags: [],
      score: 0,
    })
    for (const environment of environments) {
      results.push({
        type: 'environment',
        id: environment.id,
        title: environment.name,
        subtitle: `${project.name} · ${environment.kind}`,
        href: `/?env=${encodeURIComponent(environment.slug)}`,
        environment: environment.slug,
        tags: [],
        score: 0,
      })
    }
  }

  const resources = store
    .listResources(project.id)
    .filter((resource) => !options.allowedResourceSlugs || options.allowedResourceSlugs.has(resource.slug))
  for (const resource of resources) {
    const environment = resource.environmentId ? environmentById.get(resource.environmentId) : undefined
    const tags = tagsByResource.get(resource.id) ?? []
    const metadata = searchableValues(resource.desiredState, SAFE_METADATA_KEYS)
    const text = [
      resource.name,
      resource.slug,
      resource.kind,
      resource.provider,
      resource.providerId,
      environment?.slug,
      ...metadata,
      ...tags.map((tag) => tag.name),
    ]
      .filter(Boolean)
      .join(' ')
    const destination = resourceResult(resource, environment?.slug ?? environments[0]?.slug ?? '')
    results.push({
      type: destination.type,
      id: resource.id,
      title: resource.name,
      subtitle: [resource.kind, ...metadata.slice(0, 2)].join(' · '),
      href: destination.href,
      environment: environment?.slug,
      provider: resource.provider,
      tags,
      score: rank(options.query, resource.name, text),
    })
  }

  if (!restricted) {
    for (const operation of store.listOperations({ projectId: project.id, limit: 500 })) {
      const environment = operation.environmentId ? environmentById.get(operation.environmentId) : undefined
      const releaseValues = searchableValues(operation.input, SAFE_RELEASE_KEYS)
      const deployment = operation.kind.includes('deploy')
      const title = releaseValues[0] ?? operation.kind
      const text = [operation.kind, operation.id, operation.correlationId, operation.state, ...releaseValues].join(' ')
      results.push({
        type: deployment ? 'deployment' : 'operation',
        id: operation.id,
        title,
        subtitle: `${operation.kind} · ${operation.state}`,
        href: `/server/activity?env=${encodeURIComponent(environment?.slug ?? environments[0]?.slug ?? '')}&operation=${encodeURIComponent(operation.id)}`,
        environment: environment?.slug,
        status: operation.state,
        tags: [],
        score: rank(options.query, title, text),
      })
    }
  }

  for (const result of results) {
    if (result.score === 0)
      result.score = rank(
        options.query,
        result.title,
        `${result.title} ${result.subtitle} ${result.environment ?? ''} ${result.provider ?? ''}`,
      )
  }
  const typeOrder: Record<ControlPlaneSearchResultType, number> = {
    service: 0,
    server: 1,
    database: 2,
    deployment: 3,
    environment: 4,
    project: 5,
    operation: 6,
  }
  return results
    .filter((result) => result.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        typeOrder[left.type] - typeOrder[right.type] ||
        left.title.localeCompare(right.title) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, Math.min(50, Math.max(1, options.limit ?? 20)))
}
