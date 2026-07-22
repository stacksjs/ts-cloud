import type { CLI } from '@stacksjs/clapp'
import type { ConfigurationBackend, ConfigurationEntry, ConfigurationMetadata, ConfigurationScope } from '../../src/configuration'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveAuthEncryptionKey } from '../../src/auth'
import { SecretsManagerClient } from '../../src/aws/secrets-manager'
import { SSMClient } from '../../src/aws/ssm'
import { AwsSecretsManagerConfigurationBackend, AwsSsmConfigurationBackend, ConfigurationService, ConfigurationStore, ExternalConfigurationBackend, LocalEncryptedConfigurationBackend, synchronizeConfiguredConfiguration } from '../../src/configuration'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { PreviewEnvironmentStore } from '../../src/preview'
import * as output from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

interface ScopeOptions { env?: string; scope?: string; target?: string }
interface SetOptions extends ScopeOptions { value?: string; fromEnv?: string; secret?: boolean; backend?: string; reference?: string; required?: boolean; confirm?: string; json?: boolean }

async function context(environment?: string) {
  const config = await loadValidatedConfig(), controlPlane = initializeDashboardControlPlane(process.cwd(), config), env = environment ?? Object.keys(config.environments ?? {})[0] ?? 'production', environmentRecord = controlPlane.environments.get(env as any)
  if (!environmentRecord) { controlPlane.store.close(); throw new Error(`Environment ${env} was not found.`) }
  const region = config.project?.region ?? 'us-east-1', encryptionKey = resolveAuthEncryptionKey(process.cwd()), store = new ConfigurationStore(controlPlane.store)
  const service = new ConfigurationService(store, { encryptionKey, backends: [new LocalEncryptedConfigurationBackend(controlPlane.store, encryptionKey), new AwsSecretsManagerConfigurationBackend(new SecretsManagerClient(region), region), new AwsSsmConfigurationBackend(new SSMClient(region), region), new ExternalConfigurationBackend()] })
  const actor = controlPlane.store.getActorByExternalId('system', 'cli') ?? controlPlane.store.createActor({ kind: 'system', externalId: 'cli', displayName: 'ts-cloud CLI' })
  await synchronizeConfiguredConfiguration(service, controlPlane, config, actor.id)
  return { config, controlPlane, env, environmentRecord, store, service, actor }
}
type ConfigurationContext = Awaited<ReturnType<typeof context>>
async function withContext<T>(environment: string | undefined, callback: (value: ConfigurationContext) => Promise<T>): Promise<T> { const value = await context(environment); try { return await callback(value) } finally { value.controlPlane.store.close() } }
async function run(callback: () => Promise<void>): Promise<void> { try { await callback() } catch (error) { output.error(error instanceof Error ? error.message : String(error)) } }

export function configurationRows(entries: ConfigurationMetadata[]): string[][] {
  return entries.map(item => [item.key, item.kind, item.scope.type, item.inherited ? 'inherited' : item.overridden ? 'override' : 'direct', item.kind === 'secret' ? item.backend ?? 'restricted' : item.value ?? '', item.backendVersion ?? '—', item.required ? 'required' : 'optional', item.updatedAt])
}

export function secretValueFromOptions(options: { value?: string; fromEnv?: string }, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (options.value != null) throw new Error('Secret values are not accepted in command arguments; use --from-env or the interactive prompt.')
  if (!options.fromEnv) return undefined
  const value = env[options.fromEnv]
  if (!value) throw new Error(`${options.fromEnv} is empty or unavailable.`)
  return value
}

function scope(value: ConfigurationContext, options: ScopeOptions): ConfigurationScope {
  const type = options.scope ?? 'environment'
  if (type === 'project') return { type, id: value.controlPlane.project.id }
  if (type === 'environment') {
    const item = options.target ? value.controlPlane.store.listEnvironments(value.controlPlane.project.id).find(candidate => candidate.id === options.target || candidate.slug === options.target) : value.environmentRecord
    if (!item) throw new Error(`Environment ${options.target} was not found.`)
    return { type, id: item.id, environmentId: item.id }
  }
  if (type === 'service') {
    const resources = value.controlPlane.store.listResources(value.controlPlane.project.id), item = resources.find(candidate => candidate.id === options.target || candidate.slug === options.target)
    if (!item) throw new Error('Service scope requires --target with a resource ID or slug.')
    return { type, id: item.id, environmentId: item.environmentId, resourceId: item.id }
  }
  if (type === 'function') {
    const resources = value.controlPlane.store.listResources(value.controlPlane.project.id), item = resources.find(candidate => candidate.kind === 'function' && (candidate.id === options.target || candidate.slug === options.target))
    if (!item) throw new Error('Function scope requires --target with a function resource ID or slug.')
    return { type, id: item.id, environmentId: item.environmentId, resourceId: item.id }
  }
  if (type === 'preview') {
    const item = new PreviewEnvironmentStore(value.controlPlane.store).listInstances({ projectId: value.controlPlane.project.id }).find(candidate => candidate.id === options.target || candidate.name === options.target)
    if (!item) throw new Error('Preview scope requires --target with a preview ID or name.')
    return { type, id: item.id, environmentId: item.baseEnvironmentId, resourceId: item.resourceId, previewId: item.id }
  }
  throw new Error('--scope must be project, environment, service, function, or preview.')
}

function backend(value: string | undefined): Exclude<ConfigurationBackend, 'plaintext'> {
  const kind = value ?? 'local_encrypted'
  if (!['local_encrypted', 'aws_secrets_manager', 'aws_ssm', 'external'].includes(kind)) throw new Error('--backend must be local_encrypted, aws_secrets_manager, aws_ssm, or external.')
  return kind as Exclude<ConfigurationBackend, 'plaintext'>
}
function entry(value: ConfigurationContext, key: string, selectedScope: ConfigurationScope): ConfigurationEntry {
  const item = value.store.find(value.controlPlane.project.id, selectedScope, key)
  if (!item) throw new Error(`${key} was not found in the selected scope.`)
  return item
}
async function inputValue(kind: 'variable' | 'secret', options: SetOptions): Promise<string | undefined> {
  if (kind === 'secret') return secretValueFromOptions(options) ?? await output.prompt('Enter secret value (input is write-only)', '')
  if (options.fromEnv) { const value = process.env[options.fromEnv]; if (value == null) throw new Error(`${options.fromEnv} is unavailable.`); return value }
  if (options.value != null) return options.value
  return await output.prompt('Enter variable value', '')
}
function common(command: ReturnType<CLI['command']>): ReturnType<CLI['command']> {
  return command.option('--env <environment>', 'Dashboard environment').option('--scope <scope>', 'project, environment, service, function, or preview', { default: 'environment' }).option('--target <id>', 'Environment, resource, function, or preview ID/name')
}

export function registerConfigCommands(app: CLI): void {
  app.command('config', 'Show validated file configuration').action(async () => run(async () => { const config = await loadValidatedConfig(); console.log(JSON.stringify(config, null, 2)) }))
  app.command('config:validate', 'Validate configuration file').action(async () => run(async () => { const config = await loadValidatedConfig(); if (!config.project?.name || !config.project?.slug || !config.mode) throw new Error('project.name, project.slug, and mode are required.'); output.success(`Configuration is valid: ${config.project.name} · ${config.mode} · ${config.project.region || 'us-east-1'}`) }))

  common(app.command('config:list', 'List scoped variables and write-only secret metadata')).option('--kind <kind>', 'variable or secret').option('--search <text>', 'Filter key names').option('--json', 'Print structured JSON')
    .action(async (options: ScopeOptions & { kind?: string; search?: string; json?: boolean }) => run(async () => withContext(options.env, async value => { const selected = scope(value, options), kind = ['variable', 'secret'].includes(options.kind ?? '') ? options.kind as 'variable' | 'secret' : undefined, items = value.service.list({ projectId: value.controlPlane.project.id, scope: selected, kind, search: options.search, canReadSecretMetadata: true }); if (options.json) console.log(JSON.stringify(items, null, 2)); else output.table(['Key', 'Kind', 'Scope', 'Precedence', 'Value/backend', 'Backend version', 'Requirement', 'Updated'], configurationRows(items)) })))

  common(app.command('config:set <key>', 'Create or replace a scoped variable or secret')).option('--value <value>', 'Plaintext variable value only').option('--from-env <name>', 'Read the value from an environment variable').option('--secret', 'Store a write-only secret').option('--backend <backend>', 'local_encrypted, aws_secrets_manager, aws_ssm, or external').option('--reference <uri>', 'External provider reference').option('--required', 'Fail deployments when unavailable').option('--confirm <key>', 'Exact key confirmation for production replacements').option('--json', 'Print structured JSON')
    .action(async (key: string, options: SetOptions) => run(async () => withContext(options.env, async value => { const selected = scope(value, options), kind = options.secret ? 'secret' as const : 'variable' as const, secretBackend = kind === 'secret' ? backend(options.backend) : undefined, input = secretBackend === 'external' ? undefined : await inputValue(kind, options); const result = await value.service.set({ organizationId: value.controlPlane.organization.id, projectId: value.controlPlane.project.id, scope: selected, key, kind, value: input, reference: options.reference, backend: secretBackend, required: !!options.required, confirmed: options.confirm === key, actorId: value.actor.id, idempotencyKey: `cli:${crypto.randomUUID()}` }); if (options.json) console.log(JSON.stringify({ entry: value.service.list({ projectId: value.controlPlane.project.id, scope: selected, canReadSecretMetadata: true }).find(item => item.id === result.entry.id), mutation: result.mutation, warnings: result.warnings }, null, 2)); else output.success(`${key}: ${result.mutation.added.length ? 'created' : result.mutation.changed.length ? 'updated' : 'unchanged'}; ${result.mutation.affectedResourceIds.length} affected service(s).`) })))

  common(app.command('config:delete <key>', 'Delete a scoped variable or secret')).option('--confirm <key>', 'Exact key confirmation').action(async (key: string, options: ScopeOptions & { confirm?: string }) => run(async () => withContext(options.env, async value => { const item = entry(value, key, scope(value, options)); await value.service.remove({ entryId: item.id, expectedVersion: item.version, confirmed: options.confirm === key, actorId: value.actor.id }); output.success(`Deleted ${key}.`) })))

  common(app.command('config:import <file>', 'Validate and import a dotenv file')).option('--secret-keys <keys>', 'Comma-separated secret keys').option('--backend <backend>', 'Secret backend').option('--confirm <word>', 'Use import for production replacement confirmation').option('--json', 'Print structured JSON')
    .action(async (file: string, options: ScopeOptions & { secretKeys?: string; backend?: string; confirm?: string; json?: boolean }) => run(async () => withContext(options.env, async value => { const result = await value.service.importDotenv({ organizationId: value.controlPlane.organization.id, projectId: value.controlPlane.project.id, scope: scope(value, options), source: await readFile(resolve(file), 'utf8'), secretKeys: options.secretKeys?.split(',').map(item => item.trim()).filter(Boolean), backend: backend(options.backend), confirmed: options.confirm === 'import', actorId: value.actor.id, idempotencyKey: `cli-import:${crypto.randomUUID()}` }); if (!result.document.valid) throw new Error(result.document.diagnostics.map(item => `line ${item.line}: ${item.message}`).join('\n')); if (options.json) console.log(JSON.stringify({ mutation: result.mutation, diagnostics: result.document.diagnostics, warnings: result.warnings }, null, 2)); else output.success(`Imported ${result.mutation?.added.length ?? 0} new, ${result.mutation?.changed.length ?? 0} changed, and ${result.mutation?.unchanged.length ?? 0} unchanged entries.`) })))

  common(app.command('config:plan <file>', 'Preview dotenv drift using key names only')).option('--remove-missing', 'Include managed keys absent from the file').option('--json', 'Print structured JSON')
    .action(async (file: string, options: ScopeOptions & { removeMissing?: boolean; json?: boolean }) => run(async () => withContext(options.env, async value => { const { parseDotenv } = await import('../../src/configuration'); const document = parseDotenv(await readFile(resolve(file), 'utf8')); if (!document.valid) throw new Error(document.diagnostics.map(item => `line ${item.line}: ${item.message}`).join('\n')); const plan = value.service.plan({ projectId: value.controlPlane.project.id, scope: scope(value, options), values: document.values, removeMissing: !!options.removeMissing }); if (options.json) console.log(JSON.stringify(plan, null, 2)); else { output.table(['Action', 'Keys'], [['Add', plan.added.join(', ') || '—'], ['Change', plan.changed.join(', ') || '—'], ['Remove', plan.removed.join(', ') || '—'], ['Unchanged', plan.unchanged.join(', ') || '—']]); output.info(`${plan.affectedResourceIds.length} affected service(s); no secret values were printed.`) } })))

  common(app.command('config:export [file]', 'Export plaintext variables only as dotenv')).action(async (file: string | undefined, options: ScopeOptions) => run(async () => withContext(options.env, async value => { const content = value.service.exportVariables({ projectId: value.controlPlane.project.id, scope: scope(value, options) }); if (file) { await writeFile(resolve(file), content, { mode: 0o600 }); output.success(`Exported variables to ${resolve(file)}; secrets were excluded.`) } else process.stdout.write(content) })))

  common(app.command('config:transfer <key>', 'Copy or move an entry between scopes')).option('--to-scope <scope>', 'Destination scope').option('--to-target <id>', 'Destination ID or slug').option('--move', 'Remove the source after copying').option('--confirm <key>', 'Exact key confirmation').action(async (key: string, options: ScopeOptions & { toScope?: string; toTarget?: string; move?: boolean; confirm?: string }) => run(async () => withContext(options.env, async value => { const selected = scope(value, options), item = entry(value, key, selected), target = scope(value, { env: options.env, scope: options.toScope, target: options.toTarget }); const result = await value.service.transfer({ entryId: item.id, targetScope: target, mode: options.move ? 'move' : 'copy', confirmed: options.confirm === key, actorId: value.actor.id, idempotencyKey: `cli-transfer:${crypto.randomUUID()}` }); output.success(`${key} ${options.move ? 'moved' : 'copied'}; ${result.mutation.affectedResourceIds.length} affected service(s).`) })))

  common(app.command('config:reveal <key>', 'Reveal a secret after exact confirmation')).option('--confirm <key>', 'Exact key confirmation').action(async (key: string, options: ScopeOptions & { confirm?: string }) => run(async () => withContext(options.env, async value => { if (options.confirm !== key) throw new Error(`Use --confirm ${key} to reveal this secret.`); const item = entry(value, key, scope(value, options)); console.log(await value.service.reveal({ entryId: item.id, canRevealSecrets: true, recentlyAuthenticated: true, actorId: value.actor.id })) })))

  common(app.command('config:env', 'Backward-compatible variable management')).option('--list', 'List variables').option('--set <key=value>', 'Set a variable').option('--unset <key>', 'Delete a variable').option('--environment <environment>', 'Target environment')
    .action(async (options: { list?: boolean; set?: string; unset?: string; environment?: string; env?: string; scope?: string; target?: string }) => run(async () => withContext(options.environment ?? options.env, async value => { const selected = scope(value, { env: options.environment, scope: 'environment', target: options.environment }); if (options.list) output.table(['Key', 'Value', 'Updated'], value.service.list({ projectId: value.controlPlane.project.id, scope: selected, kind: 'variable' }).map(item => [item.key, item.value ?? '', item.updatedAt])); else if (options.set) { const separator = options.set.indexOf('='); if (separator < 1) throw new Error('Use --set KEY=VALUE.'); const key = options.set.slice(0, separator), input = options.set.slice(separator + 1); await value.service.set({ organizationId: value.controlPlane.organization.id, projectId: value.controlPlane.project.id, scope: selected, key, kind: 'variable', value: input, confirmed: false, actorId: value.actor.id }); output.success(`Set ${key}.`) } else if (options.unset) { const item = entry(value, options.unset, selected); await value.service.remove({ entryId: item.id, expectedVersion: item.version, confirmed: await output.confirm(`Delete ${item.key}?`, false), actorId: value.actor.id }); output.success(`Deleted ${item.key}.`) } else output.info('Use --list, --set KEY=VALUE, or --unset KEY.') })))

  common(app.command('config:secrets', 'Backward-compatible write-only secret management')).option('--list', 'List secret metadata').option('--create <key>', 'Create a secret').option('--update <key>', 'Rotate a secret').option('--get <key>', 'Reveal a secret').option('--delete <key>', 'Delete a secret').option('--from-env <name>', 'Read new value from an environment variable').option('--backend <backend>', 'Secret backend').option('--confirm <key>', 'Exact key confirmation')
    .action(async (options: ScopeOptions & { list?: boolean; create?: string; update?: string; get?: string; delete?: string; fromEnv?: string; backend?: string; confirm?: string }) => run(async () => withContext(options.env, async value => { const selected = scope(value, options); if (options.list) output.table(['Key', 'Backend', 'Version', 'Rotated'], value.service.list({ projectId: value.controlPlane.project.id, scope: selected, kind: 'secret', canReadSecretMetadata: true }).map(item => [item.key, item.backend ?? 'restricted', item.backendVersion ?? '—', item.rotatedAt ?? 'never'])); else if (options.create || options.update) { const key = options.create ?? options.update!, input = secretValueFromOptions(options) ?? await output.prompt('Enter secret value (write-only)', ''); await value.service.set({ organizationId: value.controlPlane.organization.id, projectId: value.controlPlane.project.id, scope: selected, key, kind: 'secret', value: input, backend: backend(options.backend), confirmed: options.confirm === key, actorId: value.actor.id }); output.success(`${key} ${options.update ? 'rotated' : 'created'}.`) } else if (options.get) { if (options.confirm !== options.get) throw new Error(`Use --confirm ${options.get} to reveal.`); const item = entry(value, options.get, selected); console.log(await value.service.reveal({ entryId: item.id, canRevealSecrets: true, recentlyAuthenticated: true, actorId: value.actor.id })) } else if (options.delete) { const item = entry(value, options.delete, selected); await value.service.remove({ entryId: item.id, expectedVersion: item.version, confirmed: options.confirm === item.key, actorId: value.actor.id }); output.success(`Deleted ${item.key}.`) } else output.info('Use --list, --create, --update, --get, or --delete.') })))
}
