import type { CLI } from '@stacksjs/clapp'
import type { MigrateEndpoint, ObjectStorageProvider } from '../../src'
import { migrateObjectStorage } from '../../src'
import * as cli from '../../src/utils/cli'

const PROVIDERS: ObjectStorageProvider[] = ['aws', 'backblaze', 'hetzner']

interface MigrateStorageOptions {
  from?: string
  to?: string
  fromRegion?: string
  toRegion?: string
  fromEndpoint?: string
  toEndpoint?: string
  fromPrefix?: string
  toPrefix?: string
  include?: string
  exclude?: string
  dryRun?: boolean
  force?: boolean
  deleteExtraneous?: boolean
  concurrency?: string
  verify?: boolean
}

/** Parse a `provider:bucket` spec into its parts, validating the provider. */
function parseEndpointSpec(spec: string, label: string): { provider: ObjectStorageProvider, bucket: string } {
  const idx = spec.indexOf(':')
  if (idx === -1) {
    throw new Error(`--${label} must be in the form <provider:bucket> (e.g. aws:my-bucket), got "${spec}"`)
  }
  const provider = spec.slice(0, idx) as ObjectStorageProvider
  const bucket = spec.slice(idx + 1)
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider "${provider}" for --${label}. Supported: ${PROVIDERS.join(', ')}`)
  }
  if (!bucket) {
    throw new Error(`--${label} is missing a bucket name (expected <provider:bucket>)`)
  }
  return { provider, bucket }
}

function csv(value?: string): string[] | undefined {
  if (!value)
    return undefined
  const parts = value.split(',').map(s => s.trim()).filter(Boolean)
  return parts.length > 0 ? parts : undefined
}

export function registerMigrateCommands(app: CLI): void {
  app
    .command('migrate:storage', 'Migrate object-storage data between providers (AWS S3 ↔ Hetzner ↔ Backblaze)')
    .option('--from <provider:bucket>', 'Source endpoint, e.g. aws:stacks-production-email')
    .option('--to <provider:bucket>', 'Destination endpoint, e.g. hetzner:stacks-mail')
    .option('--from-region <region>', 'Source region/location (default: provider default)')
    .option('--to-region <region>', 'Destination region/location (default: provider default)')
    .option('--from-endpoint <host>', 'Source endpoint host override (no scheme)')
    .option('--to-endpoint <host>', 'Destination endpoint host override (no scheme)')
    .option('--from-prefix <prefix>', 'Only read source keys under this prefix (stripped from dest key)')
    .option('--to-prefix <prefix>', 'Prepend this prefix to every destination key')
    .option('--include <csv>', 'Only copy keys under these comma-separated prefixes')
    .option('--exclude <csv>', 'Skip keys under these comma-separated prefixes')
    .option('--dry-run', 'Print the plan (what would copy / what is excluded) without writing')
    .option('--force', 'Re-copy even if the destination already has an object of the same size')
    .option('--delete-extraneous', 'Delete destination keys not present in the source (default OFF)')
    .option('--concurrency <n>', 'Max concurrent copies', { default: '8' })
    .option('--verify', 'After copying, re-list the destination and assert object count + sizes match')
    .action(async (options: MigrateStorageOptions) => {
      cli.header('Migrate Object Storage')

      try {
        if (!options.from || !options.to) {
          throw new Error('Both --from <provider:bucket> and --to <provider:bucket> are required')
        }

        const from = parseEndpointSpec(options.from, 'from')
        const to = parseEndpointSpec(options.to, 'to')
        const include = csv(options.include)
        const exclude = csv(options.exclude)
        const concurrency = Number.parseInt(options.concurrency || '8', 10)

        const fromEndpoint: MigrateEndpoint = {
          provider: from.provider,
          bucket: from.bucket,
          region: options.fromRegion,
          endpoint: options.fromEndpoint,
          prefix: options.fromPrefix,
        }
        const toEndpoint: MigrateEndpoint = {
          provider: to.provider,
          bucket: to.bucket,
          region: options.toRegion,
          endpoint: options.toEndpoint,
          prefix: options.toPrefix,
        }

        cli.info(`Source:      ${from.provider}:${from.bucket}${options.fromPrefix ? `/${options.fromPrefix}` : ''}`)
        cli.info(`Destination: ${to.provider}:${to.bucket}${options.toPrefix ? `/${options.toPrefix}` : ''}`)
        if (include)
          cli.info(`Include:     ${include.join(', ')}`)
        if (exclude)
          cli.info(`Exclude:     ${exclude.join(', ')}`)
        cli.info(`Concurrency: ${concurrency}`)
        if (options.dryRun)
          cli.warn('Dry run — no objects will be written')
        if (options.deleteExtraneous && !options.dryRun)
          cli.warn('Delete-extraneous ON — destination keys not in the source will be removed')

        const spinner = new cli.Spinner('Listing source objects...')
        spinner.start()

        let lastLogged = 0
        const result = await migrateObjectStorage({
          from: fromEndpoint,
          to: toEndpoint,
          include,
          exclude,
          dryRun: options.dryRun,
          force: options.force,
          deleteExtraneous: options.deleteExtraneous,
          concurrency,
          verify: options.verify,
          onProgress: (ev) => {
            // Throttle spinner updates so large migrations stay readable.
            if (ev.index - lastLogged >= 1 || ev.index === ev.total) {
              lastLogged = ev.index
              const verb = ev.action === 'planned' ? 'plan' : ev.action
              spinner.text = `[${ev.index}/${ev.total}] ${verb}: ${ev.key}`
            }
          },
        })

        spinner.succeed(options.dryRun ? 'Plan ready' : 'Migration complete')

        // --- Report ---------------------------------------------------------
        if (options.dryRun && result.plan) {
          cli.info(`\nWould copy ${result.plan.length} object(s):`)
          for (const item of result.plan.slice(0, 50)) {
            cli.info(`  ${item.key}  ->  ${item.destKey}  (${cli.formatBytes(item.size)})`)
          }
          if (result.plan.length > 50)
            cli.info(`  ... and ${result.plan.length - 50} more`)
        }

        if (result.excludedKeys.length > 0) {
          cli.info(`\nEXCLUDED ${result.excludedKeys.length} key(s) (deliberately not migrated):`)
          for (const key of result.excludedKeys.slice(0, 50))
            cli.info(`  ${key}`)
          if (result.excludedKeys.length > 50)
            cli.info(`  ... and ${result.excludedKeys.length - 50} more`)
        }

        if (result.deleted.length > 0) {
          cli.warn(`\nDeleted ${result.deleted.length} extraneous destination key(s):`)
          for (const key of result.deleted.slice(0, 50))
            cli.warn(`  ${key}`)
        }

        cli.info('\nSummary:')
        if (options.dryRun) {
          cli.info(`  would copy:  ${result.plan?.length ?? 0}`)
        }
        else {
          cli.success(`  copied:      ${result.copied} (${cli.formatBytes(result.bytesCopied)})`)
          cli.info(`  skipped:     ${result.skipped} (already present)`)
        }
        cli.info(`  excluded:    ${result.excluded}`)
        if (result.deleted.length > 0)
          cli.info(`  deleted:     ${result.deleted.length}`)

        if (result.errors.length > 0) {
          cli.error(`  errors:      ${result.errors.length}`)
          for (const err of result.errors.slice(0, 20))
            cli.error(`    ${err.key}: ${err.message}`)
        }

        if (result.verification) {
          const v = result.verification
          if (v.ok) {
            cli.success(`\nVerification PASSED — ${v.matched} object(s) present at destination with matching sizes`)
          }
          else {
            cli.error(`\nVerification FAILED — ${v.missing.length} missing, ${v.sizeMismatches.length} size mismatch(es)`)
            for (const key of v.missing.slice(0, 20))
              cli.error(`  missing: ${key}`)
            for (const m of v.sizeMismatches.slice(0, 20))
              cli.error(`  size:    ${m.key} expected ${m.expected} got ${m.actual}`)
          }
        }

        if (result.errors.length > 0 || result.verification?.ok === false) {
          process.exit(1)
        }
      }
      catch (error: any) {
        cli.error(`Migration failed: ${error.message}`)
        process.exit(1)
      }
    })
}
