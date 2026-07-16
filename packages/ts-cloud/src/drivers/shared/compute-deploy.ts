import type {
  CloudConfig,
  CloudDriver,
  DeploySiteReleaseOptions,
  DeploySiteReleaseResult,
  EnvironmentType,
} from '@ts-cloud/core'
import { copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasManagementDashboardSite, resolveProjectStackName } from '@ts-cloud/core'
import { buildManagementDashboardArtifact, ensureManagementDashboard, managementDashboardSiteNames } from '../../deploy/management-dashboard'
import { isPhpSite, resolveSiteKind, siteInstallBase } from '../../deploy/site-target'
import {
  buildAwsArtifactFetch,
  buildLocalArtifactFetch,
  buildSiteDeployScript,
  buildStaticSiteDeployScript,
  resolveExecStart,
} from './deploy-script'
import { buildSslScript, resolveSslProvider } from './certbot'
import { buildManagedDbEnv } from './db-provision'
import { buildFleetServicesEnv } from './fleet'
import { resolveNotifications, sendNotifications } from './notifications'
import { buildHealthCheckScript, buildLaravelDeployScript } from './laravel-deploy'
import { buildSiteServicesScript, siteHasServices } from './app-services'
import { buildNginxVhostScript, resolveNginxSnippet } from './nginx-vhost'
import { buildPhpFpmPoolScript, phpFpmPoolListen } from './php-fpm-pool'
import { buildDeployHistoryHeader, buildSiteOwnerGuard } from './releases'
import { buildRpxConfig, buildRpxProvisionScript, usesRpxProxy } from './rpx-gateway'

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
    stackName,
  })

  if (targets.length === 0) {
    const hint = driver.name === 'aws'
      ? `Stack '${stackName}' has no EC2 instances tagged Project=${slug} Environment=${environment} Role=app, and .ts-cloud/state/${stackName}.json pins no live instance. For a shared box, record its instanceId there.`
      : `No Hetzner servers labeled ts-cloud/project=${slug} ts-cloud/environment=${environment} ts-cloud/role=app, and .ts-cloud/state/${stackName}.json pins no live server. For a shared box, record its serverId there.`
    return { success: false, error: hint }
  }

  // PHP/Laravel sites deploy via git clone + atomic releases on the box (no
  // tarball upload). The box clones the repo, runs the deploy script inside the
  // new release, flips `current`, then nginx is (re)pointed at it.
  if (isPhpSite(site)) {
    const compute = config.infrastructure?.compute
    const phpVersion = site.phpVersion ?? compute?.php?.default ?? compute?.php?.versions?.[0]
    const appBase = siteInstallBase(slug, siteName)

    // Auto-wire DB_* into the app's .env. In a fleet (dedicated services box),
    // point DB/Redis/Meilisearch at the services box's private IP; otherwise
    // use the on-box/managed database host. Explicit site.env values win.
    const dbEnv = outputs.servicesPrivateIp
      ? buildFleetServicesEnv(outputs.servicesPrivateIp, config.infrastructure?.appDatabase)
      : buildManagedDbEnv(config.infrastructure?.appDatabase)
    const siteWithEnv = Object.keys(dbEnv).length > 0
      ? { ...site, env: { ...dbEnv, ...(site.env || {}) } }
      : site

    const deployScript = buildLaravelDeployScript({
      siteName,
      site: siteWithEnv,
      releaseId: sha,
      appBase,
      defaultPhpVersion: phpVersion,
    })

    // nginx vhost (skipped when the operator fronts the box with rpx instead).
    // A `custom` cert is baked straight into the vhost; Let's Encrypt is layered
    // on afterwards by certbot, which rewrites the :80 block to add :443.
    const useNginx = !usesRpxProxy(compute)
    const sslProvider = resolveSslProvider(site)
    const customCert = sslProvider === 'custom' && site.ssl?.certPath && site.ssl?.keyPath
      ? { certPath: site.ssl.certPath, keyPath: site.ssl.keyPath }
      : undefined

    // Site isolation (Forge-style): a dedicated Linux user + php-fpm pool. The
    // vhost points at the pool's per-site port instead of the shared php-fpm.
    const poolScript = site.isolation ? buildPhpFpmPoolScript({ siteName, appBase }) : []
    const vhostScript = useNginx
      ? buildNginxVhostScript({
          siteName,
          domain: site.domain || siteName,
          aliases: site.aliases,
          type: site.type,
          appDir: `${appBase}/current`,
          webDirectory: site.webDirectory,
          phpVersion,
          fastcgiPass: site.isolation ? phpFpmPoolListen(siteName) : undefined,
          redirects: site.redirects,
          ssl: customCert,
          auth: site.auth && site.auth.enabled !== false && site.auth.password
            ? { username: site.auth.username || 'admin', password: site.auth.password, realm: site.auth.realm }
            : undefined,
          serverSnippet: resolveNginxSnippet(site.nginx, compute?.nginxTemplates),
          clientMaxBodySize: site.nginx?.clientMaxBodySize,
          hsts: site.ssl?.hsts,
          tlsProtocols: site.ssl?.tlsProtocols,
          security: site.security,
        })
      : []
    const sslScript = useNginx ? buildSslScript(site) : []

    // Reconcile queue workers / scheduler / daemons after the release is live.
    const servicesScript = siteHasServices(site)
      ? buildSiteServicesScript({ slug, siteName, site, phpVersion, appBase })
      : []

    // Post-deploy health check (Forge-style): fail the deploy if the live site
    // doesn't respond. Runs last, after the release is flipped + nginx is up.
    const healthCheckScript = useNginx ? buildHealthCheckScript(site) : []

    logger.step(`Deploying PHP site '${siteName}' to ${targets.length} target(s)...`)
    const phpResult = await driver.runRemoteDeploy({
      targets,
      commands: [...buildSiteOwnerGuard(appBase, slug), ...deployScript, ...poolScript, ...vhostScript, ...sslScript, ...servicesScript, ...healthCheckScript],
      comment: `ts-cloud deploy ${slug}/${siteName}@${sha}`,
      tags: { Project: slug, Environment: environment, Role: 'app' },
    })

    const notifications = resolveNotifications(config.notifications, site.notifications)
    if (!phpResult.success) {
      await sendNotifications(notifications, 'deploy-failed', `❌ Deploy of ${slug}/${siteName}@${sha} failed: ${phpResult.error || 'unknown error'}`)
      return {
        success: false,
        error: phpResult.error || 'Remote PHP deploy failed',
        instanceCount: phpResult.instanceCount,
        perInstance: phpResult.perInstance,
      }
    }
    const deployedUrl = site.domain ? ` → https://${site.domain}` : ''
    await sendNotifications(notifications, 'deploy', `✅ Deployed ${slug}/${siteName}@${sha}${deployedUrl}`)
    return {
      success: true,
      instanceCount: phpResult.instanceCount,
      perInstance: phpResult.perInstance,
    }
  }

  if (!localTarballPath)
    return { success: false, error: `Site '${siteName}' requires a release tarball but none was provided` }

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

  // server-static sites are shipped to /var/www/<site> (no systemd); server-app
  // sites run as a systemd service.
  const kind = resolveSiteKind(site)
  // Slug-namespaced install dir — the single source of truth for this site's
  // on-disk release tree (see siteInstallBase). Every downstream path (systemd
  // WorkingDirectory, rpx static root, ownership guard, deploy history) derives
  // from it so a shared box never collides two projects on /var/www/<name>.
  const appBase = siteInstallBase(slug, siteName)
  const baseScript = kind === 'server-static'
    ? buildStaticSiteDeployScript({
        siteName,
        appDir: appBase,
        artifactFetch,
        releaseId: sha,
        preStartCommands: site.preStart,
      })
    : buildSiteDeployScript({
        siteName,
        slug,
        appDir: appBase,
        artifactFetch,
        releaseId: sha,
        // PHP sites branch out above, so a non-PHP runtime is guaranteed here.
        execStart: resolveExecStart(site.start!, runtime as 'bun' | 'node' | 'deno'),
        envEntries: site.env || {},
        port: site.port,
        preStartCommands: site.preStart,
        sharedPaths: site.sharedPaths,
        // Ported sites cut over with SO_REUSEPORT overlap + health gate by
        // default; `zeroDowntime: false` opts back into stop/start. Portless
        // sites (workers/schedulers) always stop/start — see the builder.
        zeroDowntime: site.zeroDowntime !== false,
        healthCheckPath: site.healthCheck?.path,
      })

  // A static site served on the box can be fronted by nginx (default) with
  // HTTP Basic auth + Let's Encrypt — this is how the ts-cloud UI is published
  // behind htpasswd. When the operator runs rpx instead, skip the vhost.
  const compute = config.infrastructure?.compute
  const wantsNginxStatic = kind === 'server-static' && !usesRpxProxy(compute) && !!site.domain
  const staticVhost = wantsNginxStatic
    ? buildNginxVhostScript({
        siteName,
        domain: site.domain!,
        aliases: site.aliases,
        type: site.type === 'spa' ? 'spa' : 'static',
        appDir: `${appBase}/current`,
        webDirectory: '',
        redirects: site.redirects,
        auth: site.auth && site.auth.enabled !== false && site.auth.password
          ? { username: site.auth.username || 'admin', password: site.auth.password, realm: site.auth.realm }
          : undefined,
        serverSnippet: resolveNginxSnippet(site.nginx, compute?.nginxTemplates),
        clientMaxBodySize: site.nginx?.clientMaxBodySize,
        hsts: site.ssl?.hsts,
        tlsProtocols: site.ssl?.tlsProtocols,
        security: site.security,
      })
    : []
  const staticSsl = wantsNginxStatic ? buildSslScript(site) : []

  // Reconcile background services (scheduler / queue workers / daemons) for
  // non-PHP sites too — not just Laravel. The framework driver (app-services)
  // renders the right commands for Stacks (bun) vs Laravel, so a Stacks
  // server-app can run its scheduler + workers the same way.
  const servicesScript = siteHasServices(site)
    ? buildSiteServicesScript({ slug, siteName, site, appBase })
    : []

  const remoteScript = [
    ...buildDeployHistoryHeader(appBase, {
      releaseId: sha,
      commit: sha,
      branch: (site as any).branch ?? 'main',
    }),
    // After the history header (so a refusal is still recorded), before
    // anything touches the release layout.
    ...buildSiteOwnerGuard(appBase, slug),
    ...baseScript,
    ...staticVhost,
    ...staticSsl,
    ...servicesScript,
  ]

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
  runtime: 'bun' | 'node' | 'deno' | 'php'
  tarballForSite: (siteName: string) => string
  logger?: ComputeDeployLogger
  /** Project root used to resolve/build the management dashboard UI. Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * The FULL site model for regenerating the rpx gateway, distinct from `config`
   * which may be narrowed to a single site for a partial deploy. The rpx gateway
   * MUST always be reloaded with every route, so a single-site deploy can never
   * drop the other sites' routes. Defaults to `config` when omitted.
   */
  rpxConfig?: CloudConfig
}

/**
 * Deploy every site that targets the compute server — both dynamic apps
 * (`server` + `start`, run as systemd services) and static sites (`server`
 * without `start`, shipped to `/var/www/<site>`). Bucket sites are skipped.
 */
export async function deployAllComputeSites(options: DeployAllSitesOptions): Promise<boolean> {
  const { config, environment, driver, sha, runtime, tarballForSite, logger = noopLogger } = options
  const slug = config.project.slug
  const cwd = options.cwd ?? process.cwd()

  // Auto-inject the management dashboard (the @ts-cloud/ui stx app) so EVERY
  // consumer of this shared path — the ts-cloud CLI, Stacks' `buddy deploy`, or
  // any other driver-API caller — ships the cockpit alongside the app. Idempotent:
  // a no-op when the CLI already injected it or the user configured one.
  const hadDashboard = hasManagementDashboardSite(config)
  ensureManagementDashboard(config, { cwd, logger: { info: logger.info, warn: logger.warn } })
  // The dashboard sites WE injected this deploy — one per apex domain (all share
  // the same UI artifact). Empty when the user configured one by hand.
  const injectedDashboardSites = hadDashboard ? [] : managementDashboardSiteNames(config)
  // Keep the rpx route source in sync so the gateway routes every dashboard too
  // (it may be a different object than `config` on a single-site deploy).
  if (options.rpxConfig && options.rpxConfig !== config && !hasManagementDashboardSite(options.rpxConfig))
    ensureManagementDashboard(options.rpxConfig, { cwd, logger: { info: () => {}, warn: () => {} } })

  // When WE injected the dashboard(s) (e.g. a Stacks deploy that never built a
  // tarball for it), build its artifact ONCE and reuse it for every per-apex
  // host. If the build fails, drop all injected dashboard sites so a UI build
  // hiccup can never block the real app deploy.
  let dashboardTarball: string | null = null
  // Each injected dashboard host needs its OWN local tarball file: the release
  // upload derives the staging filename per-site, so pointing several sites at
  // one shared path left the per-apex hosts (dashboard-<other-domain>) without a
  // staged tarball — only the primary `dashboard` landed, and the rest failed
  // their `cp` from staging. Build once, then copy per site.
  const dashboardTarballBySite = new Map<string, string>()
  if (injectedDashboardSites.length > 0) {
    dashboardTarball = buildManagementDashboardArtifact(config.sites?.[injectedDashboardSites[0]] as any, { cwd, slug, sha, siteName: injectedDashboardSites[0], logger: { info: logger.info, warn: logger.warn } })
    if (!dashboardTarball) {
      logger.warn('Management dashboard: no artifact available — skipping dashboard site(s) for this deploy.')
      for (const name of injectedDashboardSites) {
        if (config.sites)
          delete (config.sites as Record<string, unknown>)[name]
      }
    }
    else {
      for (const name of injectedDashboardSites) {
        if (name === injectedDashboardSites[0]) {
          dashboardTarballBySite.set(name, dashboardTarball)
          continue
        }
        try {
          const copy = join(tmpdir(), `${slug}-${name}-${sha}.tar.gz`)
          copyFileSync(dashboardTarball, copy)
          dashboardTarballBySite.set(name, copy)
        }
        catch {
          dashboardTarballBySite.set(name, dashboardTarball)
        }
      }
    }
  }

  const sites = config.sites || {}
  const deployable = Object.entries(sites).filter(([name, site]) => {
    if (!site)
      return false
    const kind = resolveSiteKind(site)
    if (kind === 'bucket') {
      logger.warn(`Site '${name}' targets a bucket — skipping (handled by the static-site path, not compute).`)
      return false
    }
    // Redirect-only sites ship nothing — they become a gateway redirect route in
    // reloadRpxGateway. Nothing to build/upload here.
    if (kind === 'redirect')
      return false
    return true
  })

  if (deployable.length === 0) return true

  // Use the internally-built dashboard tarball when we injected it; otherwise the
  // consumer supplies every tarball (the CLI builds the dashboard in its own loop).
  const tarballFor = (siteName: string): string =>
    dashboardTarballBySite.get(siteName) ?? tarballForSite(siteName)

  for (const [siteName, site] of deployable) {
    logger.step(`Deploying site: ${siteName}`)
    // PHP/Laravel sites clone from git on the box — no local tarball to build.
    const localTarballPath = isPhpSite(site) ? undefined : tarballFor(siteName)
    const result = await deploySiteRelease(driver, {
      config,
      environment,
      siteName,
      site,
      slug,
      sha,
      runtime,
      localTarballPath,
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
  // Always regenerate the gateway from the FULL site model (never a single-site
  // subset), so a partial deploy can never drop the other sites' routes.
  const routeSource = options.rpxConfig ?? config
  const proxy = routeSource.infrastructure?.compute?.proxy ?? config.infrastructure?.compute?.proxy
  if (proxy?.engine !== 'rpx')
    return true

  const sites = routeSource.sites || {}
  const rpxConfig = buildRpxConfig(sites, { proxy, slug: config.project.slug })
  if (rpxConfig.proxies.length === 0) {
    logger.warn('rpx gateway: no server sites with a domain to route — skipping gateway reload.')
    return true
  }

  const targets = await driver.findComputeTargets({
    slug: config.project.slug,
    environment,
    role: 'app',
    stackName: resolveProjectStackName(config, environment),
  })
  if (targets.length === 0) {
    logger.warn('rpx gateway: no compute targets found — skipping gateway reload.')
    return true
  }

  logger.step(`Reloading rpx gateway with ${rpxConfig.proxies.length} route(s)...`)
  const script = buildRpxProvisionScript({ proxy, config: rpxConfig, slug: config.project.slug })
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
