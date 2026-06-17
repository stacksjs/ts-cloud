/**
 * Serverless application deploy orchestrator (Laravel-Vapor-equivalent).
 *
 * Drives the full pipeline for `environments.<env>.app`:
 *   build hooks → package → ensure artifact bucket → upload artifact →
 *   deploy/update CloudFormation stack → update function code + env →
 *   sync assets → run deploy hooks → health check.
 *
 * Plus the operational verbs: redeploy (no rebuild), rollback (previous
 * release), and maintenance mode (down/up).
 */

import type { CloudConfig, EnvironmentType, ServerlessAppConfig } from '@ts-cloud/core'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  artifactKey,
  composeServerlessAppTemplate,
  laravelServerlessEnvDefaults,
  packagePhpApp,
  packageServerlessApp,
  resolveServerlessAppStackName,
  resolveServerlessRuntime,
  resolveServerlessArtifactBucketName,
  resolveServerlessAssetBucketName,
} from '@ts-cloud/core'
import { CloudFormationClient } from '../aws/cloudformation'
import { LambdaClient } from '../aws/lambda'
import { S3Client } from '../aws/s3'
import { SecretsManagerClient } from '../aws/secrets-manager'
import * as cli from '../utils/cli'

export interface DeployServerlessOptions {
  /** Project root for entry resolution + build hooks. @default process.cwd() */
  projectRoot?: string
  /** Skip the local build hooks (already run). */
  skipBuild?: boolean
  /** Skip running the post-deploy `deploy` hooks. */
  skipDeployHooks?: boolean
  /** Skip the post-deploy HTTP health check. */
  skipHealthCheck?: boolean
}

export interface ResolvedContext {
  app: ServerlessAppConfig
  slug: string
  region: string
  stackName: string
  artifactBucket: string
  assetsBucket: string
}

interface ReleaseRecord {
  sha: string
  /** Code source for this release (S3 zip or ECR image). */
  code: CodeSource
  previousSha?: string
  /** Code source of the prior release (for rollback). */
  previousCode?: CodeSource
  /** Resolved per-function environment at deploy time (for rollback). */
  functionEnv: Record<string, Record<string, string>>
  functionNames: { http: string, queue?: string, cli: string }
  assetUrl?: string
  timestamp: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveContext(config: CloudConfig, environment: EnvironmentType): ResolvedContext {
  const app = config.environments?.[environment]?.app
  if (!app)
    throw new Error(`No serverless app configured for environment '${environment}'. Add environments.${environment}.app to your config.`)
  const slug = config.project.slug
  const region = config.environments?.[environment]?.region || config.project.region || 'us-east-1'
  return {
    app,
    slug,
    region,
    stackName: resolveServerlessAppStackName(config, environment),
    artifactBucket: resolveServerlessArtifactBucketName(slug, environment),
    assetsBucket: resolveServerlessAssetBucketName(slug, environment),
  }
}

/** Lambda update operations can race with each other; retry on conflict. */
async function withConflictRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    }
    catch (err: any) {
      const code = err?.code || err?.name || ''
      const msg = String(err?.message || '')
      if (code === 'ResourceConflictException' || /update is in progress|currently in the following state/i.test(msg)) {
        lastErr = err
        await new Promise(r => setTimeout(r, 3000))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

const RELEASE_KEY = (slug: string, env: string): string => `releases/${slug}/${env}/current.json`

async function readRelease(s3: S3Client, bucket: string, slug: string, env: string): Promise<ReleaseRecord | null> {
  try {
    return await s3.getObjectJson<ReleaseRecord>(bucket, RELEASE_KEY(slug, env))
  }
  catch {
    return null
  }
}

async function writeRelease(s3: S3Client, bucket: string, slug: string, env: string, record: ReleaseRecord): Promise<void> {
  await s3.putObjectJson(bucket, RELEASE_KEY(slug, env), record)
}

/** Resolve secrets from Secrets Manager into a flat env map. */
async function resolveSecrets(app: ServerlessAppConfig, region: string): Promise<Record<string, string>> {
  if (!app.secrets) return {}
  const sm = new SecretsManagerClient(region)
  const out: Record<string, string> = {}

  const entries: Array<{ envName: string, secretId: string }> = Array.isArray(app.secrets)
    ? app.secrets.map(name => ({ envName: name.split('/').pop()!.toUpperCase().replace(/[^A-Z0-9_]/g, '_'), secretId: name }))
    : Object.entries(app.secrets).map(([envName, secretId]) => ({ envName, secretId }))

  for (const { envName, secretId } of entries) {
    const value = await sm.getSecretValue({ SecretId: secretId })
    const str = value.SecretString ?? ''
    // A JSON object secret expands into individual env vars; a scalar maps 1:1.
    try {
      const parsed = JSON.parse(str)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) out[k] = String(v)
        continue
      }
    }
    catch {}
    out[envName] = str
  }
  return out
}

/**
 * Derive framework env vars (DB/Redis hosts) from the deployed stack outputs so
 * a Laravel app connects to the Aurora/RDS-Proxy/ElastiCache resources the
 * composer created. Returns an empty map when nothing data-related is attached.
 */
export function infraEnvFromOutputs(app: ServerlessAppConfig, outputs: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  // Prefer the RDS Proxy endpoint (connection pooling) over the cluster endpoint.
  const dbHost = outputs.DbProxyEndpoint || outputs.DbEndpoint
  if (dbHost) {
    env.DB_CONNECTION = 'mysql'
    env.DB_HOST = dbHost
    env.DB_PORT = '3306'
    env.DB_DATABASE = env.DB_DATABASE || 'app'
  }
  if (outputs.CacheEndpoint) {
    env.REDIS_HOST = outputs.CacheEndpoint
    env.REDIS_PORT = '6379'
    if (app.cache?.driver === 'elasticache') {
      env.CACHE_STORE = 'redis'
      env.CACHE_DRIVER = 'redis'
      env.SESSION_DRIVER = 'redis'
    }
  }
  return env
}

/** Build the complete environment for one function. Exported for testing. */
export function buildFunctionEnv(
  app: ServerlessAppConfig,
  ctx: ResolvedContext,
  environment: EnvironmentType,
  mode: 'http' | 'queue' | 'cli',
  secrets: Record<string, string>,
  assetUrl: string | undefined,
  queueName: string | undefined,
  infraEnv: Record<string, string> = {},
): Record<string, string> {
  const laravelDefaults = app.kind === 'php'
    ? laravelServerlessEnvDefaults({ cacheDriver: app.cache?.driver === 'elasticache' ? 'redis' : 'dynamodb' })
    : {}

  return {
    TSCLOUD_LAMBDA_MODE: mode,
    TSCLOUD_ENV: environment,
    MAINTENANCE_MODE: '0',
    ...(app.octane ? { TSCLOUD_OCTANE: '1' } : {}),
    ...(app.serveAssets ? { TSCLOUD_SERVE_ASSETS: '1' } : {}),
    ...(app.redirectRobotsTxt === false ? { TSCLOUD_REDIRECT_ROBOTS_TXT: '0' } : {}),
    ...laravelDefaults,
    ...infraEnv,
    ...(ctx.app.cache?.driver !== 'elasticache' ? { TSCLOUD_CACHE_TABLE: `${ctx.slug}-${environment}-cache` } : {}),
    ...(queueName ? { TSCLOUD_QUEUE: queueName, SQS_QUEUE: queueName } : {}),
    ...(assetUrl ? { ASSET_URL: assetUrl } : {}),
    ...(app.env ?? {}),
    ...secrets,
  }
}

function contentType(file: string): string {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
  const map: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain',
    '.map': 'application/json',
  }
  return map[ext] ?? 'application/octet-stream'
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield * walk(full)
    else yield full
  }
}

async function uploadAssets(s3: S3Client, bucket: string, dir: string, prefix: string, includeDotfiles = false): Promise<number> {
  let count = 0
  for (const file of walk(dir)) {
    const rel = relative(dir, file).replace(/\\/g, '/')
    // Vapor excludes dotfiles by default; include them only when opted in.
    if (!includeDotfiles && rel.split('/').some(seg => seg.startsWith('.')))
      continue
    await s3.putObject({
      bucket,
      key: `${prefix}/${rel}`,
      body: readFileSync(file),
      contentType: contentType(file),
      cacheControl: 'public, max-age=31536000, immutable',
    })
    count++
  }
  return count
}

/** Code source for a function update: an S3 zip or an ECR image. */
export type CodeSource =
  | { kind: 'zip', bucket: string, key: string }
  | { kind: 'image', imageUri: string }

/** Apply env + code to one function, serialized to avoid update conflicts. */
async function applyFunction(lambda: LambdaClient, name: string, env: Record<string, string>, code: CodeSource): Promise<void> {
  await withConflictRetry(() => lambda.updateFunctionConfiguration({ FunctionName: name, Environment: { Variables: env } }))
  await lambda.waitForFunctionActive(name, 120)
  const codeParams = code.kind === 'image'
    ? { FunctionName: name, ImageUri: code.imageUri }
    : { FunctionName: name, S3Bucket: code.bucket, S3Key: code.key }
  await withConflictRetry(() => lambda.updateFunctionCode(codeParams))
  await lambda.waitForFunctionActive(name, 120)
}

// ── Deploy ───────────────────────────────────────────────────────────────────

export async function deployServerlessApp(
  config: CloudConfig,
  environment: EnvironmentType,
  opts: DeployServerlessOptions = {},
): Promise<void> {
  const ctx = resolveContext(config, environment)
  const { app, slug, region, stackName, artifactBucket } = ctx
  const projectRoot = opts.projectRoot ?? process.cwd()

  cli.header(`Deploying serverless app: ${slug} (${environment})`)
  cli.info(`Stack: ${stackName}`)
  cli.info(`Region: ${region}`)

  const s3 = new S3Client(region)
  const cfn = new CloudFormationClient(region)
  const lambda = new LambdaClient(region)

  const isPhp = app.kind === 'php'
  const imageMode = app.packaging === 'image'
  const resolved = resolveServerlessRuntime(app)

  // 1–2. Produce the deployable artifact: a container image (>250 MB apps) or a
  //      ZIP uploaded to S3. `codeSource` is what each function is pointed at.
  let handlers: { http: string, queue: string, cli: string }
  let codeSource: CodeSource
  let artifactSha: string
  let runtimeLayers: string[] | undefined
  const parameters: Array<{ ParameterKey: string, ParameterValue: string }> = []

  if (imageMode && resolved.usesLayer && resolved.layerKind !== 'php') {
    throw new Error(
      `packaging: 'image' currently supports PHP and managed Node runtimes. `
      + `${resolved.kind}${resolved.kind === 'node' ? ` ${resolved.version}` : ''} uses a custom runtime — `
      + `use the default zip packaging (the runtime layer is built + attached automatically).`,
    )
  }

  if (imageMode) {
    cli.step('Building + pushing container image')
    const { buildAndPushServerlessImage } = await import('./serverless-image')
    const built = await buildAndPushServerlessImage({
      app,
      projectRoot,
      region,
      repository: `${slug}-${environment}`,
      skipBuild: opts.skipBuild,
      onStep: m => cli.info(`  ${m}`),
    })
    handlers = built.handlers
    codeSource = { kind: 'image', imageUri: built.imageUri }
    artifactSha = built.tag
    parameters.push({ ParameterKey: 'ImageUri', ParameterValue: built.imageUri })
  }
  else {
    cli.step('Packaging application')
    const artifact = isPhp
      ? packagePhpApp({ projectRoot, app, skipBuild: opts.skipBuild, onStep: m => cli.info(`  ${m}`) })
      : await packageServerlessApp({ projectRoot, app, skipBuild: opts.skipBuild, onStep: m => cli.info(`  ${m}`) })
    const key = artifactKey(slug, environment, artifact.sha256)
    cli.info(`Artifact: ${artifact.sha256.slice(0, 12)} (${(artifact.zip.length / 1024).toFixed(0)} KB)`)
    handlers = artifact.handlers
    artifactSha = artifact.sha256

    // Custom-runtime apps (PHP, Bun, or newer Node) need a provided.al2023 layer.
    if (resolved.usesLayer) {
      const envArn = resolved.layerEnvVar ? process.env[resolved.layerEnvVar] : undefined
      runtimeLayers = app.layers ?? (envArn ? [envArn] : undefined)
      if (!runtimeLayers?.length) {
        const buildCmd = resolved.layerKind === 'php'
          ? 'serverless:build-php-layer'
          : resolved.layerKind === 'bun'
            ? 'serverless:build-bun-layer'
            : 'serverless:build-node-layer'
        throw new Error(
          `${resolved.kind} apps on provided.al2023 need a runtime layer. Set environments.<env>.app.layers `
          + `or the ${resolved.layerEnvVar} env var (build one with \`cloud ${buildCmd}\`)`
          + `${resolved.kind === 'node' ? ', or use a managed Node version (18/20/22)' : ''}.`,
        )
      }
    }

    // Ensure artifact bucket + upload (skip if unchanged).
    if (!(await s3.bucketExists(artifactBucket))) {
      cli.step(`Creating artifact bucket ${artifactBucket}`)
      await s3.createBucket(artifactBucket)
    }
    // headObject resolves to null (not a throw) for a missing key.
    const exists = await s3.headObject(artifactBucket, key).then(r => r !== null).catch(() => false)
    if (exists) {
      cli.info('Artifact already uploaded — reusing')
    }
    else {
      cli.step('Uploading artifact')
      await s3.putObject({ bucket: artifactBucket, key, body: artifact.zip, contentType: 'application/zip' })
    }
    codeSource = { kind: 'zip', bucket: artifactBucket, key }
    parameters.push(
      { ParameterKey: 'ArtifactBucket', ParameterValue: artifactBucket },
      { ParameterKey: 'ArtifactKey', ParameterValue: key },
    )
  }

  // 3. Compose + deploy the CloudFormation stack.
  const composed = composeServerlessAppTemplate({ config, environment, app, handlers, runtimeLayers })
  const templateBody = JSON.stringify(composed.template)
  const capabilities = ['CAPABILITY_NAMED_IAM']

  // Resolve the current stack status; a stale failed/deleting stack can't be
  // updated, and a ROLLBACK_COMPLETE/REVIEW stack must be deleted before create.
  const status = await cfn.describeStacks({ stackName }).then(r => r.Stacks[0]?.StackStatus as string | undefined).catch(() => undefined)
  let stackExists = status !== undefined
  if (status && /DELETE_IN_PROGRESS/.test(status)) {
    cli.step('Waiting for an in-progress stack delete to finish')
    await cfn.waitForStack(stackName, 'stack-delete-complete').catch(() => {})
    stackExists = false
  }
  else if (status && /(?:ROLLBACK_COMPLETE|REVIEW_IN_PROGRESS|CREATE_FAILED)/.test(status)) {
    cli.step(`Deleting unusable stack (status ${status}) before recreate`)
    await cfn.deleteStack(stackName)
    await cfn.waitForStack(stackName, 'stack-delete-complete').catch(() => {})
    stackExists = false
  }
  cli.step(stackExists ? 'Updating infrastructure stack' : 'Creating infrastructure stack')
  try {
    if (stackExists) {
      await cfn.updateStack({ stackName, templateBody, parameters, capabilities })
      await cfn.waitForStack(stackName, 'stack-update-complete')
    }
    else {
      await cfn.createStack({ stackName, templateBody, parameters, capabilities, onFailure: 'DELETE' })
      await cfn.waitForStack(stackName, 'stack-create-complete')
    }
  }
  catch (err: any) {
    if (/No updates are to be performed/i.test(String(err?.message))) {
      cli.info('No infrastructure changes')
    }
    else {
      throw err
    }
  }

  const outputs = await cfn.getStackOutputs(stackName).catch(() => ({} as Record<string, string>))

  // 4. Assets → S3 + ASSET_URL.
  let assetUrl: string | undefined
  if (app.assets) {
    const assetsDir = join(projectRoot, app.assets)
    if (existsSync(assetsDir)) {
      // Prefer the custom asset CDN host (assetDomain) over CloudFront's default.
      const cdn = app.assetDomain || outputs.AssetsCdnDomain
      assetUrl = cdn ? `https://${cdn}/${artifactSha}` : undefined
      cli.step(`Syncing assets from ${app.assets}`)
      const n = await uploadAssets(s3, ctx.assetsBucket, assetsDir, artifactSha, app.dotFilesAsAssets)
      cli.info(`Uploaded ${n} asset(s)${assetUrl ? ` → ${assetUrl}` : ''}`)
    }
    else {
      cli.warn(`Assets directory not found: ${assetsDir}`)
    }
  }

  // 5. Resolve secrets + apply env/code to each function.
  cli.step('Resolving secrets')
  const secrets = await resolveSecrets(app, region)

  // For a managed Aurora cluster, inject DB_USERNAME/DB_PASSWORD from the
  // auto-created secret ({slug}/{env}/db) so the app can actually connect.
  if (app.database?.connection === 'aurora-serverless') {
    try {
      const sm = new SecretsManagerClient(region)
      const v = await sm.getSecretValue({ SecretId: `${slug}/${environment}/db` })
      const creds = JSON.parse(v.SecretString ?? '{}') as { username?: string, password?: string }
      if (creds.username) secrets.DB_USERNAME = creds.username
      if (creds.password) secrets.DB_PASSWORD = creds.password
    }
    catch (err: any) {
      cli.warn(`Could not resolve Aurora DB credentials: ${err.message}`)
    }
  }

  // Release state lives in the artifact bucket; ensure it exists (image mode
  // may not have created it above).
  if (!(await s3.bucketExists(artifactBucket))) {
    await s3.createBucket(artifactBucket)
  }
  const prior = await readRelease(s3, artifactBucket, slug, environment)
  const functionEnv: Record<string, Record<string, string>> = {}
  const primaryQueue = composed.queueNames[0]
  const infraEnv = infraEnvFromOutputs(app, outputs)

  cli.step('Activating functions')
  functionEnv.http = buildFunctionEnv(app, ctx, environment, 'http', secrets, assetUrl, primaryQueue, infraEnv)
  await applyFunction(lambda, composed.functionNames.http, functionEnv.http, codeSource)

  functionEnv.cli = buildFunctionEnv(app, ctx, environment, 'cli', secrets, assetUrl, primaryQueue, infraEnv)
  await applyFunction(lambda, composed.functionNames.cli, functionEnv.cli, codeSource)

  if (composed.queueNames.length) {
    functionEnv.queue = buildFunctionEnv(app, ctx, environment, 'queue', secrets, assetUrl, primaryQueue, infraEnv)
    await applyFunction(lambda, composed.functionNames.queue, functionEnv.queue, codeSource)
  }

  // 6. Snapshot the release for rollback.
  await writeRelease(s3, artifactBucket, slug, environment, {
    sha: artifactSha,
    code: codeSource,
    previousSha: prior?.sha,
    previousCode: prior?.code,
    functionEnv,
    functionNames: {
      http: composed.functionNames.http,
      cli: composed.functionNames.cli,
      ...(composed.queueNames.length ? { queue: composed.functionNames.queue } : {}),
    },
    assetUrl,
    timestamp: new Date().toISOString(),
  })

  // 7. Deploy hooks (remote, via the CLI function).
  if (!opts.skipDeployHooks && app.deploy?.length) {
    cli.step('Running deploy hooks')
    for (const command of app.deploy) {
      cli.info(`  deploy: ${command}`)
      const res = await lambda.invoke({
        FunctionName: composed.functionNames.cli,
        InvocationType: 'RequestResponse',
        Payload: { command },
        LogType: 'Tail',
      })
      if (res.FunctionError) {
        throw new Error(`Deploy hook failed (${command}): ${res.Payload}`)
      }
    }
  }

  // 8. Health check.
  const endpoint = outputs.HttpApiEndpoint
  if (!opts.skipHealthCheck && endpoint) {
    cli.step('Health check')
    try {
      const r = await fetch(endpoint, { method: 'GET' })
      cli.info(`GET ${endpoint} → ${r.status}`)
    }
    catch (err: any) {
      cli.warn(`Health check could not reach ${endpoint}: ${err.message}`)
    }
  }

  cli.box([
    'Serverless deploy complete',
    '',
    endpoint ? `URL:   ${endpoint}` : '',
    `Stack: ${stackName}`,
    `Build: ${artifactSha.slice(0, 12)}`,
  ].filter(Boolean).join('\n'), 'green')
}

// ── Redeploy (no rebuild) ─────────────────────────────────────────────────────

export async function redeployServerlessApp(config: CloudConfig, environment: EnvironmentType): Promise<void> {
  const ctx = resolveContext(config, environment)
  const s3 = new S3Client(ctx.region)
  const lambda = new LambdaClient(ctx.region)

  const release = await readRelease(s3, ctx.artifactBucket, ctx.slug, environment)
  if (!release)
    throw new Error('No previous release to redeploy. Run a full deploy first.')

  cli.header(`Redeploying ${ctx.slug} (${environment}) — build ${release.sha.slice(0, 12)}`)
  for (const [mode, name] of Object.entries(release.functionNames)) {
    if (!name) continue
    cli.step(`Re-activating ${mode} (${name})`)
    await applyFunction(lambda, name, release.functionEnv[mode] ?? {}, release.code)
  }
  cli.success('Redeploy complete')
}

// ── Rollback ───────────────────────────────────────────────────────────────--

export async function rollbackServerlessApp(config: CloudConfig, environment: EnvironmentType): Promise<void> {
  const ctx = resolveContext(config, environment)
  const s3 = new S3Client(ctx.region)
  const lambda = new LambdaClient(ctx.region)

  const release = await readRelease(s3, ctx.artifactBucket, ctx.slug, environment)
  if (!release?.previousCode)
    throw new Error('No previous release to roll back to.')

  cli.header(`Rolling back ${ctx.slug} (${environment}) → ${release.previousSha?.slice(0, 12)}`)
  for (const [mode, name] of Object.entries(release.functionNames)) {
    if (!name) continue
    cli.step(`Restoring ${mode} (${name})`)
    // Restore prior code; keep the current env (env rollback is best-effort).
    await applyFunction(lambda, name, release.functionEnv[mode] ?? {}, release.previousCode)
  }

  // Swap the release pointer so a subsequent rollback is idempotent-safe.
  await writeRelease(s3, ctx.artifactBucket, ctx.slug, environment, {
    ...release,
    sha: release.previousSha ?? release.sha,
    code: release.previousCode,
    previousSha: undefined,
    previousCode: undefined,
    timestamp: new Date().toISOString(),
  })
  cli.success('Rollback complete')
}

// ── Maintenance mode ──────────────────────────────────────────────────────────

export async function setMaintenance(
  config: CloudConfig,
  environment: EnvironmentType,
  enabled: boolean,
  bypassSecret?: string,
): Promise<void> {
  const ctx = resolveContext(config, environment)
  const lambda = new LambdaClient(ctx.region)
  const httpName = `${ctx.slug}-${environment}-http`

  const fn = await lambda.getFunction(httpName)
  const env = { ...(fn.Configuration?.Environment?.Variables ?? {}) } as Record<string, string>
  env.MAINTENANCE_MODE = enabled ? '1' : '0'
  if (enabled && bypassSecret) env.MAINTENANCE_BYPASS_SECRET = bypassSecret
  if (!enabled) delete env.MAINTENANCE_BYPASS_SECRET

  await withConflictRetry(() => lambda.updateFunctionConfiguration({ FunctionName: httpName, Environment: { Variables: env } }))
  cli.success(enabled ? 'Application is now in maintenance mode (503)' : 'Application is live')
}

/** Invoke the CLI function with an arbitrary command (e.g. `cloud command "migrate"`). */
export async function runRemoteCommand(config: CloudConfig, environment: EnvironmentType, command: string): Promise<string> {
  const ctx = resolveContext(config, environment)
  const lambda = new LambdaClient(ctx.region)
  const cliName = `${ctx.slug}-${environment}-cli`
  const res = await lambda.invoke({ FunctionName: cliName, InvocationType: 'RequestResponse', Payload: { command }, LogType: 'Tail' })
  if (res.FunctionError)
    throw new Error(`Command failed: ${res.Payload}`)
  return res.Payload ?? ''
}

/**
 * Run a SQL statement against a (private, in-VPC) serverless database via the CLI
 * function — no bastion needed. Requires the `tscloud/serverless` PHP bridge
 * (`tscloud:db-query`). The SQL is base64-encoded so it survives the runtime's
 * whitespace argument parsing.
 */
export async function runDbQuery(config: CloudConfig, environment: EnvironmentType, sql: string): Promise<string> {
  const b64 = Buffer.from(sql, 'utf-8').toString('base64')
  return runRemoteCommand(config, environment, `tscloud:db-query --sql-base64=${b64}`)
}
