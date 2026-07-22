import type { JsonValue } from '../control-plane'
import type { ApplicationDraftInput, ApplicationManifestV1, ApplicationPlan, ApplicationValidationIssue } from './types'

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function inside(path: string): boolean { return !!path && !path.startsWith('/') && !path.split('/').includes('..') && !/[\0\r\n]/.test(path) }
function issue(path: string, code: string, message: string, alternatives?: string[]): ApplicationValidationIssue { return { path, code, message, alternatives } }
function clean(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue }

function configPatch(input: ApplicationDraftInput): JsonValue {
  const env = Object.fromEntries(Object.entries(input.environment ?? {}).map(([key, value]) => [key, typeof value === 'string' ? value : `\${${value.secretRef}}`]))
  if (input.build.kind === 'prebuilt_image' || input.build.kind === 'dockerfile') return clean({ infrastructure: { containers: { [input.slug]: { source: input.source, build: input.build, port: input.runtime.port, cpu: input.runtime.cpu, memory: input.runtime.memoryMb, architecture: input.runtime.architecture, healthCheck: input.runtime.healthCheck, environment: env } } } })
  if (input.runtime.target === 'serverless' || input.build.kind === 'serverless') return clean({ serverless: { apps: { [input.slug]: { source: input.source, build: input.build, architecture: input.runtime.architecture, environment: env, domain: input.domain } } } })
  return clean({ sites: { [input.slug]: { source: input.source, build: input.build, port: input.runtime.port, architecture: input.runtime.architecture, healthCheck: input.runtime.healthCheck, env, domain: input.domain?.hostname } } })
}

export function planApplication(input: ApplicationDraftInput, suppliedSecretNames: string[] = []): ApplicationPlan {
  const issues: ApplicationValidationIssue[] = []
  const sensitiveName = (name: string) => /(?:secret|token|password|passwd|private[_-]?key|api[_-]?key)/i.test(name)
  const normalizedEnvironment = Object.fromEntries(Object.entries(input.environment ?? {}).map(([key, value]) => {
    if (typeof value === 'string' && sensitiveName(key)) {
      issues.push(issue(`environment.${key}`, 'write_only_secret_required', `${key} must be supplied through the write-only secrets boundary.`))
      return [key, { secretRef: key }]
    }
    return [key, value]
  }))
  let normalizedBuild = input.build
  if (input.build.kind === 'dockerfile' && input.build.buildArgs) {
    const buildArgs = Object.fromEntries(Object.entries(input.build.buildArgs).map(([key, value]) => {
      if (sensitiveName(key)) {
        issues.push(issue(`build.buildArgs.${key}`, 'write_only_build_secret_required', `${key} must be declared in secretNames instead of buildArgs.`))
        return [key, '[REDACTED]']
      }
      return [key, value]
    }))
    normalizedBuild = { ...input.build, buildArgs }
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.slug)) issues.push(issue('slug', 'invalid_slug', 'Slug must contain 2-63 lowercase letters, numbers, or hyphens.'))
  if (!inside((input.source.kind === 'git' ? input.source.monorepoRoot : input.source.kind === 'local' ? input.source.root : '.') ?? '.')) issues.push(issue('source', 'unsafe_source_root', 'Source root must stay inside the source tree.'))
  if (input.source.kind === 'git' && input.source.sparsePaths?.some(path => !inside(path))) issues.push(issue('source.sparsePaths', 'unsafe_sparse_path', 'Sparse checkout paths must stay inside the repository.'))
  if (input.build.kind === 'dockerfile' && (!inside(input.build.context) || !inside(input.build.dockerfile))) issues.push(issue('build', 'unsafe_docker_path', 'Docker context and Dockerfile must stay inside the source tree.'))
  if (input.build.kind === 'static' && !inside(input.build.publishDirectory)) issues.push(issue('build.publishDirectory', 'invalid_publish_directory', 'A safe static publish directory is required.'))
  if (input.build.kind === 'server' && !input.build.startCommand.trim()) issues.push(issue('build.startCommand', 'missing_start_command', 'A server start command is required.', ['Use static output', 'Use a Dockerfile']))
  if (input.source.kind === 'image' && input.build.kind !== 'prebuilt_image') issues.push(issue('build.kind', 'image_requires_prebuilt', 'An OCI image source must use the prebuilt-image strategy.', ['Select prebuilt image']))
  if (input.build.kind === 'prebuilt_image' && input.runtime.target !== 'container') issues.push(issue('runtime.target', 'image_requires_container', 'Prebuilt images require the container runtime target.', ['Select container target']))
  if (input.runtime.target === 'serverless' && input.build.kind === 'dockerfile') issues.push(issue('runtime.target', 'unsupported_serverless_dockerfile', 'Dockerfile builds currently target the container service path.', ['Select container target', 'Select serverless package']))
  if (input.runtime.port !== undefined && (!Number.isInteger(input.runtime.port) || input.runtime.port < 1 || input.runtime.port > 65535)) issues.push(issue('runtime.port', 'invalid_port', 'Port must be an integer from 1 to 65535.'))
  const health = input.runtime.healthCheck
  if (health && health.protocol !== 'tcp' && (!health.path || !health.path.startsWith('/') || /[\r\n]/.test(health.path))) issues.push(issue('runtime.healthCheck.path', 'invalid_health_path', 'HTTP health checks require a path beginning with /.'))
  if (input.domain?.hostname && (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(input.domain.hostname) || input.domain.hostname.includes('..'))) issues.push(issue('domain.hostname', 'invalid_domain', 'Domain must be a valid DNS hostname.'))
  const secretRefs = Object.values(normalizedEnvironment).flatMap(value => typeof value === 'object' ? [value.secretRef] : [])
  const required = [...new Set([...(input.requiredSecretNames ?? []), ...(input.build.kind === 'dockerfile' ? input.build.secretNames ?? [] : []), ...secretRefs])].sort()
  const supplied = new Set(suppliedSecretNames)
  const missingSecrets = required.filter(name => !supplied.has(name))
  const manifest: ApplicationManifestV1 = { apiVersion: 'ts-cloud.dev/v1', kind: 'Application', metadata: { name: input.name, slug: input.slug, projectId: input.projectId, environmentId: input.environmentId }, spec: { source: input.source, build: normalizedBuild, runtime: input.runtime, environment: normalizedEnvironment, domain: input.domain } }
  const capabilityRequirements = [...new Set([input.source.kind === 'git' ? 'git:read' : input.source.kind === 'image' ? 'registry:pull' : input.source.kind === 'artifact' ? 'artifact:inspect' : 'filesystem:read', input.runtime.target === 'container' ? 'containers' : input.runtime.target === 'serverless' ? 'serverless' : 'servers', input.domain ? 'dns' : ''])].filter(Boolean).sort()
  const costDrivers = [...new Set([input.runtime.target, input.runtime.cpu ? `${input.runtime.cpu} vCPU` : '', input.runtime.memoryMb ? `${input.runtime.memoryMb} MB memory` : '', (input.runtime.minInstances ?? 0) > 0 ? `${input.runtime.minInstances} minimum instances` : 'scales from zero where supported', input.domain ? 'managed DNS/TLS' : ''])].filter(Boolean)
  return { valid: issues.length === 0 && missingSecrets.length === 0, issues, missingSecrets, manifest, configPatch: configPatch({ ...input, build: normalizedBuild, environment: normalizedEnvironment }), capabilityRequirements, costDrivers, serializedManifest: `${stable(manifest)}\n` }
}

export function parseApplicationManifest(serialized: string): ApplicationManifestV1 {
  const value = JSON.parse(serialized) as ApplicationManifestV1
  if (value.apiVersion !== 'ts-cloud.dev/v1' || value.kind !== 'Application' || !value.metadata?.slug || !value.spec?.build) throw new Error('Unsupported application manifest')
  return value
}
