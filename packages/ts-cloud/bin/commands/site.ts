import type { CLI } from '@stacksjs/clapp'
import type { CloudConfig } from '@ts-cloud/core'
import type { FleetServer } from '../../src/fleet'
import type { SiteMoveEffects } from '../../src/operations/site-move'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import * as cli from '../../src/utils/cli'
import { resolveAppDatabase } from '@ts-cloud/core'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { createDnsProvider } from '../../src/dns'
import { normalizePublicIpv6, reconcileAddressRecords, verifyAddressRecord } from '../../src/deploy/server-dns'
import { addSiteToCloudConfig } from '../../src/deploy/site-config-editor'
import { siteInstallBase } from '../../src/deploy/site-target'
import { buildBackupScript } from '../../src/deploy/dashboard-database'
import { buildDatabaseSetupScript, isLocalDatabase } from '../../src/drivers/shared/db-provision'
import { buildBackupRestoreScript } from '../../src/drivers/shared/backups'
import { buildRpxConfig, buildRpxFragmentRefreshScript, DEFAULT_RPX_CERTS_DIR } from '../../src/drivers/shared/rpx-gateway'
import { FleetStore, SystemFleetSshTransport } from '../../src/fleet'
import { applyPlan, formatPlan, resolvePlan } from '../../src/operations/plan'
import {
  buildCertificatePackScript,
  buildCertificateStateScript,
  buildCertificateUnpackScript,
  certificatesMatch,
  parseCertificateState,
  planSiteMove,
  siteMoveArchivePath,
  siteMoveCertArchivePath,
} from '../../src/operations/site-move'
import { loadValidatedConfig, resolveDnsProviderConfig } from './shared'

interface SiteAddOptions {
  config?: string
  root?: string
  domain?: string
  path?: string
  deploy?: 'bucket' | 'server'
  build?: string
  start?: string
  port?: string
  type?: string
  pathRewriteStyle?: 'directory' | 'flat'
  dryRun?: boolean
}

interface SiteMoveCommandOptions {
  to?: string
  from?: string
  apply?: boolean
  json?: boolean
}

/**
 * Run one script on a fleet server over the enrolled, host-key-pinned SSH
 * endpoint, and fail loudly on a non-zero exit.
 *
 * Pinned-only by construction (the transport refuses anything else): a move
 * copies an application's entire dataset between two machines, which is the last
 * place to accept an unverified host.
 */
async function execOn(transport: SystemFleetSshTransport, server: FleetServer, script: string): Promise<string> {
  const result = await transport.exec(server, script)
  if (result.code !== 0)
    throw new Error(`${server.name}: ${result.stderr.trim() || result.stdout.trim() || `exited ${result.code}`}`)
  return result.stdout
}

/** `scp` one file off a server, or onto it, over the enrolled endpoint. */
async function copyFile(server: FleetServer, from: string, to: string): Promise<void> {
  const child = Bun.spawn(
    ['scp', '-P', String(server.sshPort), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', from, to],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`scp failed: ${stderr.trim() || `exited ${code}`}`)
}

/**
 * Move a deployed site to another box: plan it, print it, and perform it only
 * when asked.
 *
 * The archive travels THROUGH this machine rather than directly between the two
 * boxes. A direct hop would need the target to hold a credential for the source,
 * which is exactly the credential-radius problem consolidation already has
 * (#169) — and the operator running this already has verified access to both.
 */
async function runSiteMove(siteName: string, options: SiteMoveCommandOptions): Promise<void> {
  if (!options.to) throw new Error('Name the target server with --to <server>.')

  const config = (await loadValidatedConfig()) as CloudConfig
  const site = config.sites?.[siteName]
  if (!site) throw new Error(`Site '${siteName}' is not in cloud.config.ts.`)

  const slug = config.project.slug
  const controlPlane = initializeDashboardControlPlane(process.cwd(), config)
  try {
    const store = new FleetStore(controlPlane.store)
    const servers = store.list(controlPlane.project.id)
    const pick = (name: string): FleetServer => {
      const found = servers.find((item) => item.id === name || item.name === name)
      if (!found) throw new Error(`Server ${name} was not found. Run \`cloud server:list\`.`)
      if (found.trustState !== 'pinned')
        throw new Error(`${found.name} has no pinned host key. Run \`cloud server:validate ${found.name}\` first.`)
      return found
    }

    const target = pick(options.to)
    // Without --from, the source is the only OTHER enrolled server, which is the
    // common shape; anything ambiguous has to be named rather than guessed.
    const candidates = servers.filter((item) => item.id !== target.id)
    if (!options.from && candidates.length !== 1)
      throw new Error(
        `Name the source server with --from <server> — ${candidates.length} others are enrolled.`,
      )
    const source = pick(options.from ?? candidates[0].name)

    const transport = new SystemFleetSshTransport()
    const appBase = siteInstallBase(slug, siteName)
    const archive = siteMoveArchivePath(slug, siteName)
    const domain = site.domain
    const dnsName = config.infrastructure?.dns?.provider
    const proxy = config.infrastructure?.compute?.proxy?.engine === 'rpx'
      ? config.infrastructure.compute.proxy
      : undefined
    // The registrable apex: config `dns.domain` wins, else the last two labels.
    const configuredZone = config.infrastructure?.dns?.domain as string | undefined
    const zoneFor = (fqdn: string): string =>
      configuredZone && fqdn.endsWith(configuredZone) ? configuredZone : fqdn.split('.').slice(-2).join('.')

    // An ON-BOX engine database has to be carried separately: it lives in the
    // engine's data directory, not in the site tree. An external one needs
    // nothing — the target reaches the same endpoint the source did. SQLite
    // needs nothing either; it is under `shared/` and rides along in the tree.
    const appDatabase = resolveAppDatabase(config)
    const onBoxDatabase =
      appDatabase?.name && isLocalDatabase(appDatabase) ? { name: appDatabase.name } : undefined
    const dumpPath = `/tmp/ts-cloud-move-${slug}-${siteName}.sql.gz`
    const certArchive = siteMoveCertArchivePath(slug, siteName)
    const certsDir = proxy?.certsDir ?? DEFAULT_RPX_CERTS_DIR
    // Every hostname this site is served on needs its own certificate.
    const certDomains = [domain, ...(site.aliases ?? [])].filter((value): value is string => !!value)
    const engine = (appDatabase?.engine ?? 'mysql') as 'mysql' | 'mariadb' | 'postgres'

    const effects: SiteMoveEffects = {
      runOnSource: (script) => execOn(transport, source, script),
      runOnTarget: (script) => execOn(transport, target, script),
      archiveStaged: async () => {
        const result = await transport.exec(target, `test -f ${archive} && echo staged || true`)
        return result.stdout.includes('staged')
      },
      transferArchive: async () => {
        const local = `${process.cwd()}/.ts-cloud-move-${slug}-${siteName}.tar.gz`
        await copyFile(source, `${source.sshUser}@${source.endpoint}:${archive}`, local)
        await copyFile(target, local, `${target.sshUser}@${target.endpoint}:${archive}`)
        await Bun.file(local).delete().catch(() => {})
      },
      targetRoutesSite: async () => {
        if (!proxy || !domain) return true
        const result = await transport.exec(
          target,
          `grep -qF ${JSON.stringify(domain)} /etc/rpx/sites.d/${slug}.json 2>/dev/null && echo routed || true`,
        )
        return result.stdout.includes('routed')
      },
      refreshTargetGateway: async () => {
        if (!proxy)
          throw new Error(
            'This project does not run the rpx gateway, so the move cannot publish a route. '
            + `Point ${target.name}'s web server at ${appBase}/current yourself, then re-run to continue.`,
          )
        // The SAME builder the deploy uses to write the fragment — one code
        // path, so a moved site is routed byte-identically to a deployed one.
        await execOn(transport, target, buildRpxFragmentRefreshScript({
          config: buildRpxConfig(config.sites ?? {}, { proxy, slug }),
          slug,
          preserveManagementDashboardRoutes: true,
        }).join('\n'))
      },
      publishedAddress: async () => {
        // No hostname or no configured provider: there is no cutover to make,
        // so report the target as already published rather than looping on a
        // step that can never be satisfied.
        if (!domain || !dnsName) return target.endpoint
        const dnsConfig = resolveDnsProviderConfig(dnsName)
        if (!dnsConfig) return undefined
        const published = await verifyAddressRecord(
          createDnsProvider(dnsConfig),
          zoneFor(domain),
          domain,
          target.endpoint,
          'A',
        )
        return published ? target.endpoint : undefined
      },
      ...(onBoxDatabase
        ? {
            database: {
              // The SAME dump the backup command takes, written to a known path
              // so the transfer and the restore can find it without parsing.
              dump: async () => {
                await execOn(
                  transport,
                  source,
                  [
                    'set -euo pipefail',
                    'eval "$(cd /opt/pantry && pantry env 2>/dev/null)" || true',
                    ...buildBackupScript(engine, onBoxDatabase.name, '/tmp', appDatabase),
                    `mv -f "$(ls -1t /tmp/${onBoxDatabase.name}-*.sql.gz | head -1)" ${dumpPath}`,
                  ].join('\n'),
                )
              },
              dumpStaged: async () => {
                const result = await transport.exec(target, `test -s ${dumpPath} && echo staged || true`)
                return result.stdout.includes('staged')
              },
              transferDump: async () => {
                const local = `${process.cwd()}/.ts-cloud-move-${slug}-${siteName}.sql.gz`
                await copyFile(source, `${source.sshUser}@${source.endpoint}:${dumpPath}`, local)
                await copyFile(target, local, `${target.sshUser}@${target.endpoint}:${dumpPath}`)
                await Bun.file(local).delete().catch(() => {})
              },
              restore: async () => {
                await execOn(
                  transport,
                  target,
                  [
                    // Create the role + database first, with the SAME idempotent
                    // script provisioning runs, then load the dump into it.
                    ...buildDatabaseSetupScript(appDatabase, config.infrastructure?.compute?.managedServices ?? {}),
                    ...buildBackupRestoreScript(appDatabase, { from: dumpPath }),
                    `rm -f ${dumpPath}`,
                  ].join('\n'),
                )
              },
              targetHasData: async () => {
                const query =
                  engine === 'postgres'
                    ? `psql -tAc "select count(*) from information_schema.tables where table_schema='public'" -d ${onBoxDatabase.name} 2>/dev/null || echo 0`
                    : `mysql -N -B -e "select count(*) from information_schema.tables where table_schema='${onBoxDatabase.name}'" 2>/dev/null || echo 0`
                const result = await transport.exec(
                  target,
                  `eval "$(cd /opt/pantry && pantry env 2>/dev/null)" || true\n${query}`,
                )
                return Number.parseInt(result.stdout.trim().split('\n').pop() ?? '0', 10) > 0
              },
            },
          }
        : {}),
      ...(proxy
        ? {
            certificates: {
              inPlace: async () => {
                const state = buildCertificateStateScript(certsDir, certDomains)
                const [onSource, onTarget] = await Promise.all([
                  transport.exec(source, state),
                  transport.exec(target, state),
                ])
                return certificatesMatch(
                  parseCertificateState(onSource.stdout),
                  parseCertificateState(onTarget.stdout),
                )
              },
              carry: async () => {
                await execOn(transport, source, buildCertificatePackScript(certsDir, certDomains, certArchive))
                const local = `${process.cwd()}/.ts-cloud-move-${slug}-${siteName}-certs.tar.gz`
                // A site behind on-demand TLS may have no certificate yet; the
                // pack script says so and exits clean rather than failing.
                const staged = await transport.exec(source, `test -s ${certArchive} && echo staged || true`)
                if (!staged.stdout.includes('staged')) return
                await copyFile(source, `${source.sshUser}@${source.endpoint}:${certArchive}`, local)
                await copyFile(target, local, `${target.sshUser}@${target.endpoint}:${certArchive}`)
                await Bun.file(local).delete().catch(() => {})
                await execOn(transport, target, buildCertificateUnpackScript(certsDir, certArchive))
                await transport.exec(source, `rm -f ${certArchive}`)
              },
            },
          }
        : {}),
      cutoverDns: async () => {
        if (!domain) return []
        if (!dnsName) return [`No DNS provider configured — point ${domain} at ${target.endpoint} manually.`]
        const dnsConfig = resolveDnsProviderConfig(dnsName)
        if (!dnsConfig) return [`DNS provider '${dnsName}' is not configured.`]
        const report = await reconcileAddressRecords({
          provider: createDnsProvider(dnsConfig),
          zone: zoneFor(domain),
          fqdn: domain,
          ipv4: target.endpoint,
          ipv6: normalizePublicIpv6(undefined),
        })
        return report.warnings
      },
    }

    const plan = await planSiteMove(
      {
        slug,
        siteName,
        appBase,
        from: source.name,
        to: target.name,
        targetAddress: target.endpoint,
        port: site.port,
        healthCheckPath: site.healthCheck?.path,
        database: onBoxDatabase,
      },
      effects,
    )
    const resolved = await resolvePlan(plan)

    if (!options.apply) {
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              operation: plan.operation,
              target: plan.target,
              move: { site: siteName, from: source.name, to: target.name, address: target.endpoint },
              steps: resolved.map((item) => ({
                id: item.step.id,
                title: item.step.title,
                state: item.state,
                change: item.step.change,
                reason: item.reason,
              })),
            },
            null,
            2,
          ),
        )
        return
      }
      for (const line of formatPlan(plan, resolved)) console.log(line)
      console.log(`  The source keeps its files either way — reversible until ${source.name} is destroyed.`)
      console.log('  Re-run with --apply to perform it.')
      return
    }

    const outcome = await applyPlan(plan, resolved, {
      log: (message) => cli.info(message),
      audit: (event) =>
        controlPlane.store.appendEvent({
          projectId: controlPlane.project.id,
          type: `${event.operation}.${event.step}.${event.state}`,
          level: event.state === 'failed' ? 'error' : 'info',
          payload: {
            site: siteName,
            from: source.name,
            to: target.name,
            ...(event.error ? { error: event.error } : {}),
          },
        }),
    })

    if (options.json) console.log(JSON.stringify({ schemaVersion: 1, outcome }, null, 2))
    if (!outcome.success) {
      const failed = outcome.steps.find((step) => step.state === 'failed')
      throw new Error(
        `${plan.operation} stopped at '${failed?.title}': ${failed?.error}. `
        + `${source.name} still has the site and its files; re-run the same command to continue from here.`,
      )
    }
    if (!options.json)
      cli.success(
        `Moved ${siteName} from ${source.name} to ${target.name}. `
        + `${source.name} keeps its copy until you destroy it.`,
      )
  } finally {
    controlPlane.store.close()
  }
}

export function registerSiteCommands(app: CLI): void {
  app
    .command('site:move <name>', 'Move a deployed site to another server')
    .option('--to <server>', 'Target server (enrolled name or id)')
    .option('--from <server>', 'Source server; inferred when only one other is enrolled')
    .option('--apply', 'Perform the reviewed move plan')
    .option('--json', 'Print structured JSON')
    .action(async (name: string, options: SiteMoveCommandOptions) => {
      try {
        await runSiteMove(name, options)
      } catch (error) {
        cli.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    })
  app
    .command('site:add <name>', 'Add a site entry to cloud.config.ts')
    .option('--config <path>', 'Path to cloud config file')
    .option('--root <path>', 'Directory to deploy')
    .option('--domain <domain>', 'Domain for the site')
    .option('--path <path>', 'Path prefix for the site')
    .option('--deploy <target>', 'Deployment target: server or bucket')
    .option('--build <command>', 'Build command to run before deployment')
    .option('--start <command>', 'Start command for server apps')
    .option('--port <port>', 'Port for server apps')
    .option('--type <type>', 'Site type, e.g. static, laravel, php')
    .option('--path-rewrite-style <style>', 'Static rewrite style: directory or flat')
    .option('--dry-run', 'Print the updated config without writing')
    .action(async (name: string, options?: SiteAddOptions) => {
      const configPath = options?.config || 'cloud.config.ts'
      const root = options?.root

      if (!root) {
        cli.error('Missing --root <path>')
        return
      }

      if (!existsSync(configPath)) {
        cli.error(`Config file not found: ${configPath}`)
        return
      }

      try {
        const updated = addSiteToCloudConfig({
          configText: await readFile(configPath, 'utf8'),
          name,
          root,
          domain: options?.domain,
          path: options?.path,
          deploy: normalizeDeploy(options?.deploy),
          build: options?.build,
          start: options?.start,
          port: normalizePort(options?.port),
          type: options?.type,
          pathRewriteStyle: normalizePathRewriteStyle(options?.pathRewriteStyle),
        })

        if (options?.dryRun) {
          console.log(updated)
          return
        }

        await writeFile(configPath, updated)
        cli.success(`Added site '${name}' to ${configPath}`)
      } catch (error) {
        cli.error(error instanceof Error ? error.message : String(error))
      }
    })
}

function normalizeDeploy(value: string | undefined): 'bucket' | 'server' | undefined {
  if (!value) return undefined
  if (value === 'bucket' || value === 'server') return value
  throw new Error(`Invalid --deploy '${value}'. Expected 'server' or 'bucket'.`)
}

function normalizePathRewriteStyle(value: string | undefined): 'directory' | 'flat' | undefined {
  if (!value) return undefined
  if (value === 'directory' || value === 'flat') return value
  throw new Error(`Invalid --path-rewrite-style '${value}'. Expected 'directory' or 'flat'.`)
}

function normalizePort(value: string | undefined): number | undefined {
  if (!value) return undefined

  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid --port '${value}'. Expected a TCP port between 1 and 65535.`)
  }

  return port
}
