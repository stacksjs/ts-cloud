import type {
  CloudConfig,
  CloudDriver,
  DeploySiteReleaseOptions,
  DeploySiteReleaseResult,
  EnvironmentType,
} from '@ts-cloud/core'
import { resolveProjectStackName } from '@ts-cloud/core'
import { resolveSiteKind } from '../../deploy/site-target'
import {
  buildAwsArtifactFetch,
  buildLocalArtifactFetch,
  buildSiteDeployScript,
  buildStaticSiteDeployScript,
  resolveExecStart,
} from './deploy-script'
import { buildRpxConfig, buildRpxProvisionScript } from './rpx-gateway'

export interface ComputeDeployLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  step(message: string): void
  success(message: string): void
}

const noopLogger: ComputeDeployLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  step: () => {},
  success: () => {},
}

/**
 * Deploy a single site release tarball to compute targets via the active driver.
 */
export async function deploySiteRelease(
  driver: CloudDriver,
  options: DeploySiteReleaseOptions,
  logger: ComputeDeployLogger = noopLogger,
): Promise<DeploySiteReleaseResult> {
  const {
    config,
    environment,
    siteName,
    site,
    slug,
    sha,
    runtime,
    localTarballPath,
  } = options

  const remoteKey = `releases/${siteName}/${sha}.tar.gz`
  const stackName = resolveProjectStackName(config, environment)
  const outputs = await driver.getComputeOutputs({ config, environment })

  const targets = await driver.findComputeTargets({
    slug,
    environment,
    role: 'app',
  })

  if (targets.length === 0) {
    const hint = driver.name === 'aws'
      ? `Stack '${stackName}' has no EC2 instances tagged Project=${slug} Environment=${environment} Role=app.`
      : `No Hetzner servers labeled ts-cloud/project=${slug} ts-cloud/environment=${environment} ts-cloud/role=app.`
    return { success: false, error: hint }
  }

  const uploadResult = await driver.uploadRelease({
    config,
    environment,
    localPath: localTarballPath,
    remoteKey,
    targets,
  })

  const artifactFetch = driver.name === 'aws'
    ? buildAwsArtifactFetch(outputs.deployBucketName!, remoteKey, config.project.region || 'us-east-1', siteName)
    : buildLocalArtifactFetch(uploadResult.artifactRef, siteName)

  // server-static sites are shipped to /var/www/<site> (no systemd) and served
  // by the operator's own proxy (e.g. rpx + tlsx); server-app sites run as a
  // systemd service.
  const remoteScript = resolveSiteKind(site) === 'server-static'
    ? buildStaticSiteDeployScript({
        siteName,
        artifactFetch,
        preStartCommands: site.preStart,
      })
    : buildSiteDeployScript({
        siteName,
        slug,
        artifactFetch,
        execStart: resolveExecStart(site.start!, runtime),
        envEntries: site.env || {},
        port: site.port,
        preStartCommands: site.preStart,
      })

  logger.step(`Deploying to ${targets.length} target(s)...`)
  const result = await driver.runRemoteDeploy({
    targets,
    commands: remoteScript,
    comment: `ts-cloud deploy ${slug}/${siteName}@${sha}`,
    tags: {
      Project: slug,
      Environment: environment,
      Role: 'app',
    },
  })

  if (!result.success) {
    return {
      success: false,
      error: result.error || 'Remote deploy failed',
      instanceCount: result.instanceCount,
      perInstance: result.perInstance,
    }
  }

  return {
    success: true,
    instanceCount: result.instanceCount,
    perInstance: result.perInstance,
  }
}

export interface DeployAllSitesOptions {
  config: CloudConfig
  environment: EnvironmentType
  driver: CloudDriver
  sha: string
  runtime: 'bun' | 'node' | 'deno'
  tarballForSite: (siteName: string) => string
  logger?: ComputeDeployLogger
}

/**
 * Deploy every site that targets the compute server — both dynamic apps
 * (`server` + `start`, run as systemd services) and static sites (`server`
 * without `start`, shipped to `/var/www/<site>`). Bucket sites are skipped.
 */
export async function deployAllComputeSites(options: DeployAllSitesOptions): Promise<boolean> {
  const { config, environment, driver, sha, runtime, tarballForSite, logger = noopLogger } = options
  const slug = config.project.slug
  const sites = config.sites || {}
  const deployable = Object.entries(sites).filter(([name, site]) => {
    if (!site)
      return false
    const kind = resolveSiteKind(site)
    if (kind === 'bucket') {
      logger.warn(`Site '${name}' targets a bucket — skipping (handled by the static-site path, not compute).`)
      return false
    }
    return true
  })

  if (deployable.length === 0) return true

  for (const [siteName, site] of deployable) {
    logger.step(`Deploying site: ${siteName}`)
    const result = await deploySiteRelease(driver, {
      config,
      environment,
      siteName,
      site,
      slug,
      sha,
      runtime,
      localTarballPath: tarballForSite(siteName),
    }, logger)

    if (!result.success) {
      logger.error(`Deploy of '${siteName}' failed: ${result.error || 'unknown error'}`)
      if (result.perInstance) {
        for (const inst of result.perInstance) {
          logger.error(`  ${inst.instanceId}: ${inst.status}${inst.error ? ` — ${inst.error}` : ''}`)
        }
      }
      return false
    }

    logger.success(`Deployed ${slug}/${siteName}@${sha} to ${result.instanceCount} target(s)`)
    if (result.perInstance) {
      for (const inst of result.perInstance) {
        logger.info(`  ✓ ${inst.instanceId}: ${inst.status}`)
      }
    }
  }

  // After shipping every server site, regenerate the rpx gateway config from
  // the (now-current) sites model and reload it, so newly added
  // server-app/server-static sites appear in the gateway automatically. Opt-in
  // via `compute.proxy.engine === 'rpx'`; a no-op otherwise.
  const reloaded = await reloadRpxGateway(options)
  if (!reloaded)
    return false

  return true
}

/**
 * Regenerate the rpx gateway config from the sites model and (re)start the
 * gateway on the compute targets. No-op (returns `true`) unless
 * `compute.proxy.engine === 'rpx'`. Re-runnable: the provision script writes the
 * launcher + unit and `systemctl restart`s, which reloads the new routes.
 */
export async function reloadRpxGateway(options: DeployAllSitesOptions): Promise<boolean> {
  const { config, environment, driver, logger = noopLogger } = options
  const proxy = config.infrastructure?.compute?.proxy
  if (proxy?.engine !== 'rpx')
    return true

  const sites = config.sites || {}
  const rpxConfig = buildRpxConfig(sites, { proxy })
  if (rpxConfig.proxies.length === 0) {
    logger.warn('rpx gateway: no server sites with a domain to route — skipping gateway reload.')
    return true
  }

  const targets = await driver.findComputeTargets({
    slug: config.project.slug,
    environment,
    role: 'app',
  })
  if (targets.length === 0) {
    logger.warn('rpx gateway: no compute targets found — skipping gateway reload.')
    return true
  }

  logger.step(`Reloading rpx gateway with ${rpxConfig.proxies.length} route(s)...`)
  const script = buildRpxProvisionScript({ proxy, config: rpxConfig })
  const result = await driver.runRemoteDeploy({
    targets,
    commands: script,
    comment: `ts-cloud rpx gateway reload ${config.project.slug}`,
    tags: {
      Project: config.project.slug,
      Environment: environment,
      Role: 'app',
    },
  })

  if (!result.success) {
    logger.error(`rpx gateway reload failed: ${result.error || 'unknown error'}`)
    return false
  }
  logger.success(`rpx gateway reloaded on ${result.instanceCount} target(s)`)
  return true
}
