import type { CLI } from '@stacksjs/clapp'
import type { SourceConnection, SourceProvider, SourceRepository } from '../../src/source'
import { readFileSync } from 'node:fs'
import { resolveAuthEncryptionKey } from '../../src/auth'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { listSourceReferences, reconcileSourceWebhook, removeSourceWebhook, SourceConnectionStore, syncSourceRepositories, testSourceConnection, webhookEndpoint } from '../../src/source'
import * as cli from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

interface GitAddOptions {
  branch?: string
  connection?: string
  provider?: SourceProvider
  host?: string
  name?: string
  tokenEnv?: string
  url?: string
  site?: string
  root?: string
  include?: string
  exclude?: string
  tag?: string
  fullClone?: boolean
  submodules?: boolean
  deployKey?: string
  publicKey?: string
  privateKey?: string
  hostKey?: string
  sshHost?: string
  yes?: boolean
}

interface SourceContext {
  config: Awaited<ReturnType<typeof loadValidatedConfig>>
  controlPlane: ReturnType<typeof initializeDashboardControlPlane>
  sources: SourceConnectionStore
}

const PROVIDER_TOKEN_ENV: Partial<Record<SourceProvider, string>> = {
  github: 'GITHUB_TOKEN',
  gitlab: 'GITLAB_TOKEN',
  bitbucket: 'BITBUCKET_TOKEN',
  gitea: 'GITEA_TOKEN',
  generic_https: 'GIT_TOKEN',
}

const PROVIDER_HOST: Partial<Record<SourceProvider, string>> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
  bitbucket: 'https://bitbucket.org',
  gitea: 'https://gitea.com',
}

export function inferSourceRepository(value: string, input: { provider?: SourceProvider, host?: string, cloneUrl?: string } = {}): { provider: SourceProvider, host: string, fullName: string, cloneUrl?: string } {
  if (input.provider && !['github', 'gitlab', 'bitbucket', 'gitea', 'generic_https', 'generic_ssh'].includes(input.provider)) throw new Error(`Unsupported Git provider: ${input.provider}`)
  const cloneUrl = input.cloneUrl ?? (/^(?:https?:\/\/|ssh:\/\/|git@)/.test(value) ? value : undefined)
  let hostname = ''
  let fullName = cloneUrl ?? value
  if (cloneUrl?.startsWith('git@')) {
    const matched = /^git@([^:]+):(.+)$/.exec(cloneUrl)
    if (!matched) throw new Error('SSH repository URL must use git@host:owner/name.git')
    hostname = matched[1]!
    fullName = matched[2]!
  }
  else if (cloneUrl) {
    const parsed = new URL(cloneUrl)
    hostname = parsed.hostname
    fullName = parsed.pathname
  }
  fullName = fullName.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new Error('Repository must use owner/name or a supported clone URL')
  const provider = input.provider ?? (hostname.includes('github') ? 'github' : hostname.includes('gitlab') ? 'gitlab' : hostname.includes('bitbucket') ? 'bitbucket' : hostname.includes('gitea') ? 'gitea' : cloneUrl?.startsWith('git@') || cloneUrl?.startsWith('ssh://') ? 'generic_ssh' : cloneUrl ? 'generic_https' : 'github')
  const host = input.host ?? PROVIDER_HOST[provider] ?? (hostname ? `https://${hostname}` : '')
  if (!host) throw new Error('A provider host is required')
  return { provider, host, fullName, cloneUrl }
}

async function sourceContext(): Promise<SourceContext> {
  const config = await loadValidatedConfig()
  const controlPlane = initializeDashboardControlPlane(process.cwd(), config)
  return { config, controlPlane, sources: new SourceConnectionStore(controlPlane.store, { encryptionKey: resolveAuthEncryptionKey(process.cwd()) }) }
}

async function withSources<T>(callback: (context: SourceContext) => Promise<T>): Promise<T> {
  const context = await sourceContext()
  try { return await callback(context) }
  finally { context.controlPlane.store.close() }
}

function findConnection(sources: SourceConnectionStore, organizationId: string, reference?: string): SourceConnection | undefined {
  const connections = sources.listConnections(organizationId)
  if (!reference) return connections.length === 1 ? connections[0] : undefined
  return connections.find(item => item.id === reference || item.name.toLowerCase() === reference.toLowerCase())
}

function readSecretFile(path: string | undefined, label: string): string {
  if (!path) throw new Error(`${label} file is required`)
  return readFileSync(path, 'utf8')
}

async function resolveRepository(sources: SourceConnectionStore, connection: SourceConnection, inferred: ReturnType<typeof inferSourceRepository>, options: GitAddOptions): Promise<SourceRepository> {
  if (['github', 'gitlab', 'bitbucket', 'gitea'].includes(connection.provider)) {
    const existing = sources.listRepositories(connection.id).find(item => item.fullName.toLowerCase() === inferred.fullName.toLowerCase())
    if (existing) return existing
    const synchronized = await syncSourceRepositories(sources, connection.id, { search: inferred.fullName, maxPages: 20 })
    const repository = synchronized.find(item => item.fullName.toLowerCase() === inferred.fullName.toLowerCase())
    if (!repository) throw new Error(`Repository ${inferred.fullName} is not granted to this connection`)
    return repository
  }
  const cloneUrl = options.url ?? inferred.cloneUrl
  if (!cloneUrl) throw new Error('Generic Git connections require --url <clone-url>')
  return sources.upsertRepository({ connectionId: connection.id, providerRepositoryId: `manual:${inferred.fullName}`, fullName: inferred.fullName, cloneUrl, defaultBranch: options.branch ?? 'main', visibility: 'unknown', archived: false, metadata: { source: 'cli' } })
}

async function connectRepository(context: SourceContext, value: string, options: GitAddOptions): Promise<{ connection: SourceConnection, repository: SourceRepository }> {
  const inferred = inferSourceRepository(value, { provider: options.provider, host: options.host, cloneUrl: options.url })
  let connection = findConnection(context.sources, context.controlPlane.organization.id, options.connection)
  if (!connection) {
    if (options.connection) throw new Error(`Source connection ${options.connection} was not found`)
    const tokenEnv = options.tokenEnv ?? PROVIDER_TOKEN_ENV[inferred.provider]
    const token = tokenEnv ? process.env[tokenEnv] : undefined
    if (['github', 'gitlab', 'bitbucket', 'gitea'].includes(inferred.provider) && !token) throw new Error(`Set ${tokenEnv} or pass --token-env <name>; secrets are never accepted as command arguments`)
    const sshKey = inferred.provider === 'generic_ssh'
      ? { publicKey: readSecretFile(options.publicKey, 'Public key'), privateKey: readSecretFile(options.privateKey, 'Private key'), hostKey: options.hostKey ?? '' }
      : undefined
    context.controlPlane.store.database.transaction(() => {
      connection = context.sources.createConnection({ organizationId: context.controlPlane.organization.id, provider: inferred.provider, name: options.name ?? `${inferred.provider.replace('_', ' ')} · ${new URL(inferred.host).host}`, host: inferred.host, owner: inferred.fullName.split('/')[0], authKind: inferred.provider === 'generic_ssh' ? 'deploy_key' : token ? 'access_token' : 'none', credential: token ? { token } : undefined })
      if (sshKey) context.sources.createDeployKey({ connectionId: connection!.id, name: options.deployKey ?? `${inferred.fullName} deploy key`, ...sshKey, host: options.sshHost ?? new URL(inferred.host).hostname, actorId: undefined })
    })()
  }
  if (!connection) throw new Error('Source connection could not be created')
  if (connection.status === 'disconnected') throw new Error('The selected source connection is disconnected')
  const repository = await resolveRepository(context.sources, connection, inferred, options)
  if (options.site) {
    const environment = context.controlPlane.environments.get('production') ?? [...context.controlPlane.environments.values()][0]
    const resource = context.controlPlane.store.listResources(context.controlPlane.project.id, environment?.id).find(item => item.kind === 'application' && item.slug === options.site)
    if (!resource) throw new Error(`Application ${options.site} was not found`)
    const deployKey = connection.provider === 'generic_ssh' ? context.sources.listDeployKeys(connection.id)[0] : undefined
    context.sources.createBinding({ projectId: context.controlPlane.project.id, environmentId: environment?.id, resourceId: resource.id, connectionId: connection.id, repositoryId: repository.id, repositoryFullName: repository.fullName, defaultBranch: options.branch ?? repository.defaultBranch, branchRule: options.tag ? undefined : options.branch ?? repository.defaultBranch, tagRule: options.tag, monorepoRoot: options.root ?? '.', includePaths: options.include?.split(',').map(item => item.trim()).filter(Boolean), excludePaths: options.exclude?.split(',').map(item => item.trim()).filter(Boolean), submodules: options.submodules, cloneDepth: options.fullClone ? undefined : 20, deployKeyId: deployKey?.id })
  }
  return { connection, repository }
}

function printError(error: unknown): void {
  cli.error(error instanceof Error ? error.message : 'Git integration command failed')
}

export function registerGitCommands(app: CLI): void {
  app.command('git:connections', 'List encrypted Git provider connections').action(async () => {
    try {
      await withSources(async ({ sources, controlPlane }) => {
        const values = sources.listConnections(controlPlane.organization.id)
        cli.table(['ID', 'Name', 'Provider', 'Status', 'Credential', 'Last sync'], values.map(item => [item.id, item.name, item.provider, item.status, item.credentialConfigured ? 'encrypted' : 'none', item.lastSyncedAt ?? '-']))
      })
    }
    catch (error) { printError(error) }
  })

  app.command('git:repositories', 'List repositories granted to a connection').option('--connection <id>', 'Connection ID or name').action(async (options: { connection?: string }) => {
    try {
      await withSources(async ({ sources, controlPlane }) => {
        const connection = findConnection(sources, controlPlane.organization.id, options.connection)
        if (!connection) throw new Error('Choose a connection with --connection <id>')
        const values = sources.listRepositories(connection.id)
        cli.table(['ID', 'Repository', 'Default branch', 'Visibility', 'Archived'], values.map(item => [item.id, item.fullName, item.defaultBranch, item.visibility, item.archived ? 'yes' : 'no']))
      })
    }
    catch (error) { printError(error) }
  })

  app.command('git:add <repo>', 'Connect and optionally bind a Git repository')
    .option('--branch <branch>', 'Default branch to deploy', { default: 'main' }).option('--connection <id>', 'Reuse a connection ID or name').option('--provider <provider>', 'github, gitlab, bitbucket, gitea, generic_https, or generic_ssh').option('--host <url>', 'Provider API host').option('--name <name>', 'Connection name').option('--token-env <name>', 'Environment variable containing the access token').option('--url <clone-url>', 'Credential-free clone URL').option('--site <slug>', 'Bind the repository to an application').option('--root <path>', 'Monorepo root', { default: '.' }).option('--include <globs>', 'Comma-separated watched paths').option('--exclude <globs>', 'Comma-separated ignored paths').option('--tag <glob>', 'Deploy matching tags instead of branch pushes').option('--full-clone', 'Use full history instead of a shallow clone').option('--submodules', 'Initialize repository submodules').option('--deploy-key <name>', 'Deploy-key display name').option('--public-key <path>', 'SSH public-key file').option('--private-key <path>', 'SSH private-key file').option('--host-key <key>', 'Pinned SSH host key').option('--ssh-host <host>', 'SSH clone host').option('--yes', 'Skip confirmation')
    .action(async (repo: string, options: GitAddOptions) => {
      try {
        if (!options.yes && !(await cli.confirm(`Connect ${repo}?`, true))) return
        const result = await withSources(context => connectRepository(context, repo, options))
        cli.success(`Connected ${result.repository.fullName}`)
        cli.info(`Connection: ${result.connection.name} (${result.connection.id})`)
        if (options.site) cli.info(`Application binding: ${options.site}`)
      }
      catch (error) { printError(error) }
    })

  app.command('git:import', 'Import site.repository entries from cloud.config.ts').option('--connection <id>', 'Reuse a connection ID or name').option('--token-env <name>', 'Environment variable containing provider token').option('--yes', 'Skip confirmation').action(async (options: { connection?: string, tokenEnv?: string, yes?: boolean }) => {
    try {
      await withSources(async (context) => {
        const entries = Object.entries(context.config.sites ?? {}).filter(([, site]) => site.repository?.url)
        if (!entries.length) throw new Error('No site.repository entries were found')
        if (!options.yes && !(await cli.confirm(`Import ${entries.length} repository configuration${entries.length === 1 ? '' : 's'}?`, true))) return
        for (const [site, value] of entries) {
          const repository = value.repository!
          const provider = repository.provider === 'custom' ? undefined : repository.provider
          await connectRepository(context, repository.url, { connection: options.connection, tokenEnv: options.tokenEnv, site, provider, branch: repository.branch ?? 'main', tag: repository.strategy === 'tag' ? repository.tag ?? repository.tagPattern ?? 'v*' : undefined, url: repository.url })
          cli.success(`Imported ${site} · ${repository.url}`)
        }
      })
    }
    catch (error) { printError(error) }
  })

  app.command('git:branches <repo>', 'List branches or tags visible to a connection').option('--connection <id>', 'Connection ID or name').option('--tags', 'List tags instead of branches').option('--deploy-key <id>', 'SSH deploy-key ID').action(async (repo: string, options: { connection?: string, tags?: boolean, deployKey?: string }) => {
    try {
      await withSources(async ({ sources, controlPlane }) => {
        const connection = findConnection(sources, controlPlane.organization.id, options.connection)
        if (!connection) throw new Error('Choose a connection with --connection <id>')
        const repository = sources.listRepositories(connection.id).find(item => item.id === repo || item.fullName.toLowerCase() === repo.toLowerCase())
        if (!repository) throw new Error(`Repository ${repo} was not found`)
        const result = await listSourceReferences(sources, { connectionId: connection.id, repository: repository.fullName, repositoryId: repository.id, type: options.tags ? 'tags' : 'branches', deployKeyId: options.deployKey ?? sources.listDeployKeys(connection.id)[0]?.id })
        cli.table([options.tags ? 'Tag' : 'Branch', 'Commit', 'Protected'], result.refs.map(item => [item.name, item.commitSha, item.protected ? 'yes' : 'no']))
      })
    }
    catch (error) { printError(error) }
  })

  app.command('git:deploy <branch>', 'Queue an idempotent deployment from a Git branch').option('--binding <id>', 'Source binding ID').option('--repo <owner/name>', 'Bound repository').option('--env <environment>', 'Target environment', { default: 'production' }).action(async (branch: string, options: { binding?: string, repo?: string, env?: string }) => {
    try {
      await withSources(async ({ sources, controlPlane }) => {
        const environment = controlPlane.environments.get(options.env ?? 'production')
        if (!environment) throw new Error(`Environment ${options.env} was not found`)
        const binding = sources.listBindings({ projectId: controlPlane.project.id, status: 'active' }).find(item => (!options.binding || item.id === options.binding) && (!options.repo || item.repositoryFullName.toLowerCase() === options.repo.toLowerCase()) && (!item.environmentId || item.environmentId === environment.id))
        if (!binding) throw new Error('No active source binding matched; use --binding or --repo')
        const refs = await listSourceReferences(sources, { connectionId: binding.connectionId, repository: binding.repositoryFullName, repositoryId: binding.repositoryId, type: 'branches', deployKeyId: binding.deployKeyId })
        const ref = refs.refs.find(item => item.name === branch)
        if (!ref) throw new Error(`Branch ${branch} was not found`)
        const operation = controlPlane.store.createOperation({ projectId: binding.projectId, environmentId: environment.id, resourceId: binding.resourceId, kind: 'deploy.source', idempotencyKey: `cli-source:${binding.id}:${ref.commitSha}`, correlationId: `cli-source:${binding.id}:${ref.commitSha}`, input: { source: { connectionId: binding.connectionId, bindingId: binding.id, repository: binding.repositoryFullName, commitSha: ref.commitSha, branch, monorepoRoot: binding.monorepoRoot, submodules: binding.submodules, cloneDepth: binding.cloneDepth ?? null } } })
        cli.success(`Deployment queued: ${operation.id}`)
        cli.info(`${binding.repositoryFullName}@${branch} · ${ref.commitSha}`)
      })
    }
    catch (error) { printError(error) }
  })

  app.command('git:webhook:add <repo>', 'Create and reconcile a signed auto-deploy webhook').option('--connection <id>', 'Connection ID or name').option('--base-url <url>', 'Public HTTPS dashboard URL').action(async (repo: string, options: { connection?: string, baseUrl?: string }) => {
    try {
      await withSources(async ({ sources, controlPlane }) => {
        const connection = findConnection(sources, controlPlane.organization.id, options.connection)
        if (!connection) throw new Error('Choose a connection with --connection <id>')
        const repository = sources.listRepositories(connection.id).find(item => item.id === repo || item.fullName.toLowerCase() === repo.toLowerCase())
        if (!repository) throw new Error(`Repository ${repo} was not found`)
        const baseUrl = options.baseUrl ?? process.env.TS_CLOUD_WEBHOOK_BASE_URL
        if (!baseUrl) throw new Error('Pass --base-url or set TS_CLOUD_WEBHOOK_BASE_URL')
        const created = sources.createWebhook({ connectionId: connection.id, repositoryId: repository.id, repositoryFullName: repository.fullName })
        const endpoint = webhookEndpoint(baseUrl, created.webhook)
        const webhook = await reconcileSourceWebhook(sources, created.webhook.id, baseUrl)
        cli.success(`Webhook ${webhook.status}: ${endpoint}`)
        cli.info('The signing secret is encrypted and is not printed.')
      })
    }
    catch (error) { printError(error) }
  })

  app.command('git:webhook:remove <webhook>', 'Disable and remove a provider webhook').option('--yes', 'Skip confirmation').action(async (webhook: string, options: { yes?: boolean }) => {
    try {
      await withSources(async ({ sources, controlPlane }) => {
        const candidate = sources.listConnections(controlPlane.organization.id).flatMap(item => sources.listWebhooks(item.id)).find(item => item.id === webhook || item.repositoryFullName.toLowerCase() === webhook.toLowerCase())
        if (!candidate) throw new Error(`Webhook ${webhook} was not found`)
        if (!options.yes && !(await cli.confirm(`Remove webhook for ${candidate.repositoryFullName}?`, true))) return
        const removed = await removeSourceWebhook(sources, candidate.id)
        cli.success(`Webhook disabled: ${removed.id}`)
      })
    }
    catch (error) { printError(error) }
  })

  app.command('git:disconnect <connection>', 'Preview and disconnect a Git provider connection').option('--yes', 'Skip confirmation').action(async (reference: string, options: { yes?: boolean }) => {
    try {
      await withSources(async ({ sources, controlPlane }) => {
        const connection = findConnection(sources, controlPlane.organization.id, reference)
        if (!connection) throw new Error(`Source connection ${reference} was not found`)
        const affected = sources.listBindings({ connectionId: connection.id, status: 'active' })
        cli.info(`${affected.length} active binding${affected.length === 1 ? '' : 's'} will be disabled.`)
        for (const binding of affected) cli.info(`  ${binding.repositoryFullName} · ${binding.branchRule ?? binding.defaultBranch} · ${binding.monorepoRoot}`)
        if (!options.yes && !(await cli.confirm(`Disconnect ${connection.name}?`, false))) return
        sources.disconnectConnection(connection.id)
        cli.success(`Disconnected ${connection.name}`)
      })
    }
    catch (error) { printError(error) }
  })
}
