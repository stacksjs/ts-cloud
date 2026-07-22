import type { ApplicationDraftInput } from './types'

/** Upgrade the original prototype draft shape without inventing secret values. */
export function migrateApplicationDraft(value: unknown): ApplicationDraftInput {
  const input = value as Record<string, any>
  if (input?.schemaVersion === 1) return input as ApplicationDraftInput
  if (input?.schemaVersion === 0 || input?.appName || input?.applicationSlug) {
    const runtime = ['bun', 'node', 'php'].includes(input.runtime) ? input.runtime : 'node'
    const strategy = input.strategy === 'static'
      ? { kind: 'static' as const, publishDirectory: input.publishDirectory ?? 'dist', buildCommand: input.buildCommand }
      : { kind: 'server' as const, runtime, startCommand: input.startCommand ?? (runtime === 'php' ? 'php -S 0.0.0.0:$PORT -t public' : `${runtime} run start`), buildCommand: input.buildCommand }
    return { schemaVersion: 1, name: String(input.appName ?? input.name ?? 'Application'), slug: String(input.applicationSlug ?? input.slug ?? 'app'), projectId: String(input.projectId ?? ''), environmentId: String(input.environmentId ?? ''), source: { kind: 'local', root: String(input.root ?? '.') }, build: strategy, runtime: { target: strategy.kind === 'static' ? 'serverless' : 'server', architecture: input.architecture === 'arm64' ? 'arm64' : 'x86_64', port: strategy.kind === 'server' ? Number(input.port ?? 3000) : undefined }, environment: Object.fromEntries((Array.isArray(input.environmentNames) ? input.environmentNames : []).map((name: unknown) => [String(name), ''])), requiredSecretNames: (Array.isArray(input.secretNames) ? input.secretNames : []).map(String) }
  }
  throw new Error('Unsupported application draft schema')
}
