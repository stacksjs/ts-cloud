/**
 * Move a deployed site from one box to another.
 *
 * The second of the consolidation operations: three boxes with one app each
 * should be able to become one box with three sites, and today that is an
 * afternoon of SSH. What makes it an afternoon is not the individual steps but
 * the fact that a half-finished one leaves nothing to tell you what already
 * happened — so this is expressed as a plan on the same scaffolding as
 * `server:rename` (see `./plan`), where every step re-derives its own state and
 * a run that dies is resumed by running it again.
 *
 * It moves the site's on-box footprint WHOLESALE — the whole
 * `/var/www/<slug>-<site>` tree (every release, `shared/`, and the `current`
 * symlink) plus the systemd units that run it. Copying those units is not a
 * parallel mechanism: they are literally the units the deploy wrote, moved. The
 * alternative, rebuilding from the repo on the target, would not be a move — it
 * would be a fresh deploy that happens to be preceded by a data copy, and it
 * would silently pick up whatever the repo says today rather than what is
 * actually running.
 *
 * **Nothing here is irreversible.** The source's tree is never deleted, only
 * drained: its units are stopped and disabled and its gateway route removed, so
 * a bad cutover is undone by starting them again and pointing DNS back. That is
 * the reversibility the operation is required to have — it lasts until the
 * source SERVER is deleted, which is a separate, deliberately separate,
 * destructive operation (`server:destroy`).
 *
 * Ordering is chosen for what a failure in the middle leaves behind. The source
 * keeps serving until the target has passed a health gate, DNS is cut over only
 * after that, and the source is drained last — so every prefix of this plan is a
 * working system, either on the old box or the new one.
 *
 * @see https://github.com/stacksjs/ts-cloud/issues/167
 */
import type { OperationPlan, OperationStep } from './plan'

/** Where a snapshot archive is staged on both boxes. */
export function siteMoveArchivePath(slug: string, siteName: string): string {
  return `/tmp/ts-cloud-move-${slug}-${siteName}.tar.gz`
}

/** Systemd unit-file glob covering a site's app, scheduler, queue and daemon units. */
export function siteUnitGlob(slug: string, siteName: string): string {
  return `${slug}-${siteName}*.service`
}

/** Single-quote a value for safe embedding in the generated shell. */
function sh(value: string): string {
  return `'${value.split('\'').join('\'\\\'\'')}'`
}

/**
 * Stop the site's BACKGROUND units on the source — scheduler, queue workers,
 * daemons — leaving the web service running.
 *
 * The snapshot has to be consistent, and background work is what writes to it: a
 * queue worker committing to a SQLite database halfway through `tar` produces an
 * archive with a torn page in it. The web service keeps serving because the
 * source is still the live site at this point; read traffic during the copy is
 * fine, and stopping it here would be an outage taken long before the target is
 * ready to replace it.
 */
export function buildPauseWorkersScript(slug: string, siteName: string): string {
  return [
    'set -eu',
    `for unit in $(ls /etc/systemd/system/ 2>/dev/null | grep -E ${sh(backgroundUnitPattern(slug, siteName))} || true); do`,
    '  systemctl stop "$unit" 2>/dev/null || true',
    'done',
  ].join('\n')
}

/** Background units for a site: scheduler, queue workers, daemons. */
function backgroundUnitPattern(slug: string, siteName: string): string {
  return `^${slug}-${siteName}-((queue|daemon)-.*|scheduler)\\.service$`
}

/**
 * Read-only companion to {@link buildPauseWorkersScript}. Separate because a
 * plan's `satisfied()` must never mutate: if checking whether the workers are
 * paused also paused them, a dry run would change the world.
 */
export function buildWorkersStateScript(slug: string, siteName: string): string {
  return reportActiveUnits(backgroundUnitPattern(slug, siteName))
}

/** Emit one `active:<unit>` line per running unit matching `pattern`. */
function reportActiveUnits(pattern: string): string {
  return [
    `ls /etc/systemd/system/ 2>/dev/null | grep -E ${sh(pattern)} | while read -r unit; do`,
    '  systemctl is-active "$unit" >/dev/null 2>&1 && echo "active:$unit" || true',
    'done',
  ].join('\n')
}

/** Are the site's background units all stopped on the source? */
export function parseWorkersPaused(output: string): boolean {
  return !output.split('\n').some(line => line.trim().startsWith('active:'))
}

/**
 * Archive the site's whole footprint on the source: its install tree and its
 * unit files, in one tarball.
 *
 * `-h` is deliberately NOT passed: `current` and the shared-path symlinks must
 * stay symlinks. Dereferencing them would flatten `current` into a second copy
 * of the live release and turn every shared path into a per-release file again —
 * which is the exact failure `sharedPaths` exists to prevent.
 */
export function buildSnapshotScript(slug: string, siteName: string, appBase: string): string {
  const archive = siteMoveArchivePath(slug, siteName)
  return [
    'set -eu',
    `test -d ${sh(appBase)} || { echo "no site tree at ${appBase}" >&2; exit 1; }`,
    `rm -f ${sh(archive)}`,
    // Two roots in one archive, each stored relative to its own parent so the
    // restore can place them without a path-rewriting step.
    `tar czf ${sh(archive)}`
    + ` -C "$(dirname ${sh(appBase)})" "$(basename ${sh(appBase)})"`
    + ` -C /etc/systemd/system $(cd /etc/systemd/system && ls ${siteUnitGlob(slug, siteName)} 2>/dev/null | tr '\\n' ' ')`,
    `sha256sum ${sh(archive)} | cut -d' ' -f1`,
  ].join('\n')
}

/**
 * Unpack the archive on the target and bring the app up.
 *
 * The app unit is started but the gateway is not yet pointed at it: the site
 * has to answer on loopback before anything is routed to it, and DNS is not
 * touched until it has. Background units are enabled but NOT started — they stay
 * paused until the source has been drained, so the two boxes can never both be
 * running the same scheduler against the same data.
 */
export function buildRestoreScript(slug: string, siteName: string, appBase: string): string {
  const archive = siteMoveArchivePath(slug, siteName)
  return [
    'set -eu',
    `test -f ${sh(archive)} || { echo "archive not staged at ${archive}" >&2; exit 1; }`,
    `mkdir -p "$(dirname ${sh(appBase)})"`,
    // Extract the tree first, then the units, from the same archive.
    `tar xzf ${sh(archive)} -C "$(dirname ${sh(appBase)})" "$(basename ${sh(appBase)})"`,
    `tar xzf ${sh(archive)} -C /etc/systemd/system --wildcards ${sh(siteUnitGlob(slug, siteName))} 2>/dev/null || true`,
    'systemctl daemon-reload',
    `systemctl enable ${slug}-${siteName}.service 2>/dev/null || true`,
    `systemctl restart ${slug}-${siteName}.service`,
    `rm -f ${sh(archive)}`,
  ].join('\n')
}

/** Is the site's tree already on the target, with its app unit running? */
export function buildTargetStateScript(slug: string, siteName: string, appBase: string): string {
  return [
    `test -d ${sh(appBase)} && echo tree:present || echo tree:absent`,
    `systemctl is-active ${slug}-${siteName}.service >/dev/null 2>&1 && echo unit:active || echo unit:inactive`,
  ].join('\n')
}

/** Does the target already hold the site's tree AND run its app unit? */
export function parseTargetReady(output: string): boolean {
  return output.includes('tree:present') && output.includes('unit:active')
}

/**
 * Health gate on the target, before any traffic is sent to it.
 *
 * Polls loopback rather than the public name on purpose: the public name still
 * points at the SOURCE at this point in the plan, so asking it would cheerfully
 * report the old box as healthy and wave a broken target through.
 */
export function buildHealthGateScript(port: number, path = '/', attempts = 10): string {
  const url = `http://127.0.0.1:${port}${path.startsWith('/') ? path : `/${path}`}`
  return [
    'set -eu',
    `for i in $(seq 1 ${attempts}); do`,
    `  if curl -fsS -o /dev/null --max-time 5 ${sh(url)}; then echo healthy; exit 0; fi`,
    '  sleep 3',
    'done',
    `echo "no healthy response from ${url}" >&2`,
    'exit 1',
  ].join('\n')
}

/**
 * Drain the site on the source: stop and disable every unit, and drop its
 * gateway fragment so the old box stops answering for it.
 *
 * The tree is left exactly where it is. That is what keeps the whole operation
 * reversible: undoing a bad cutover is `systemctl start` plus pointing DNS back,
 * with the data still sitting on the source. It stops being reversible when the
 * source SERVER is deleted, which this operation deliberately does not do.
 */
export function buildDrainSourceScript(slug: string, siteName: string): string {
  return [
    'set -eu',
    `for unit in $(ls /etc/systemd/system/ 2>/dev/null | grep -E ${sh(siteUnitPattern(slug, siteName))} || true); do`,
    '  systemctl disable --now "$unit" 2>/dev/null || true',
    'done',
    `rm -f /etc/rpx/sites.d/${slug}.json 2>/dev/null || true`,
    'systemctl reload rpx-gateway.service 2>/dev/null || systemctl restart rpx-gateway.service 2>/dev/null || true',
  ].join('\n')
}

/** Every unit belonging to a site: the app, its template, and its background units. */
function siteUnitPattern(slug: string, siteName: string): string {
  return `^${slug}-${siteName}[-@.]`
}

/**
 * Read-only companion to {@link buildDrainSourceScript} — see
 * {@link buildWorkersStateScript} for why the two are not one script.
 */
export function buildSourceStateScript(slug: string, siteName: string): string {
  return reportActiveUnits(siteUnitPattern(slug, siteName))
}

/** Is the site fully stopped on the source? */
export function parseSourceDrained(output: string): boolean {
  return !output.split('\n').some(line => line.trim().startsWith('active:'))
}

/**
 * The side effects a move needs, injected so the operation is testable without
 * two live boxes, a provider, or a DNS account.
 */
export interface SiteMoveEffects {
  /** Run a script on the source box; resolves with stdout, rejects on failure. */
  runOnSource: (script: string) => Promise<string>
  /** Run a script on the target box. */
  runOnTarget: (script: string) => Promise<string>
  /**
   * Carry the staged archive from the source to the target. Separate from the
   * two exec effects because how bytes get between two boxes is a deployment
   * decision — through the operator, over a direct SSH hop, via object storage —
   * and none of it belongs in this plan.
   */
  transferArchive: () => Promise<void>
  /** Is the archive already staged on the target? Lets the transfer resume. */
  archiveStaged: () => Promise<boolean>
  /** Point the site's hostname at the target. Resolves with any provider warnings. */
  cutoverDns: () => Promise<string[]>
  /** Address the site's hostname currently publishes, for the cutover check. */
  publishedAddress: () => Promise<string | undefined>
  /** Refresh the target's gateway so it routes the site. */
  refreshTargetGateway: () => Promise<void>
  /** Does the target's gateway already route this site? */
  targetRoutesSite: () => Promise<boolean>
}

export interface SiteMoveOptions {
  slug: string
  siteName: string
  /** Install base on both boxes — `siteInstallBase(slug, siteName)`. */
  appBase: string
  /** Source and target box names, for the plan's own prose. */
  from: string
  to: string
  /** Target's public address, which DNS is cut over to. */
  targetAddress: string
  /** Loopback port the health gate polls. Omitted for a portless site. */
  port?: number
  /** Health-check path, defaulting to `/`. */
  healthCheckPath?: string
}

/**
 * Build the plan that moves `siteName` from one box to another.
 *
 * Async because the preconditions — the site exists on the source, the target is
 * not already serving a different tree there — are checked here rather than
 * becoming steps. A precondition is not a unit of work.
 */
export async function planSiteMove(options: SiteMoveOptions, effects: SiteMoveEffects): Promise<OperationPlan> {
  const { slug, siteName, appBase, from, to, targetAddress } = options

  if (from === to) throw new Error(`'${siteName}' is already on ${to}.`)

  const steps: OperationStep[] = [
    {
      id: 'pause-workers',
      title: `Stop background work on ${from} so the snapshot is consistent`,
      satisfied: async () => parseWorkersPaused(await effects.runOnSource(buildWorkersStateScript(slug, siteName))),
      apply: async () => {
        await effects.runOnSource(buildPauseWorkersScript(slug, siteName))
      },
    },
    {
      id: 'snapshot',
      title: `Archive the site's tree and units on ${from}`,
      change: { from: `${from}:${appBase}`, to: siteMoveArchivePath(slug, siteName) },
      // Always re-taken: an archive from an earlier attempt predates whatever
      // the source served since, and a move that silently shipped stale data
      // would be worse than one that copies twice.
      satisfied: async () => false,
      apply: async () => {
        await effects.runOnSource(buildSnapshotScript(slug, siteName, appBase))
      },
    },
    {
      id: 'transfer',
      title: `Carry the archive to ${to}`,
      change: { from, to },
      satisfied: () => effects.archiveStaged(),
      apply: () => effects.transferArchive(),
    },
    {
      id: 'restore',
      title: `Unpack the site on ${to} and start it`,
      change: { from: siteMoveArchivePath(slug, siteName), to: `${to}:${appBase}` },
      satisfied: async () => parseTargetReady(await effects.runOnTarget(buildTargetStateScript(slug, siteName, appBase))),
      apply: async () => {
        await effects.runOnTarget(buildRestoreScript(slug, siteName, appBase))
      },
    },
  ]

  // A portless site — a worker or a scheduler — has nothing to poll, and gating
  // on a port it never binds would fail every move of one.
  if (options.port != null) {
    const { port } = options
    steps.push({
      id: 'health',
      title: `Wait for the site to answer on ${to} (127.0.0.1:${port})`,
      // Re-run every time: this is the gate that decides whether traffic may be
      // moved, and a gate that remembers a previous pass is not a gate.
      satisfied: async () => false,
      apply: async () => {
        await effects.runOnTarget(buildHealthGateScript(port, options.healthCheckPath ?? '/'))
      },
    })
  }

  steps.push(
    {
      id: 'gateway',
      title: `Route the site on ${to}`,
      satisfied: () => effects.targetRoutesSite(),
      apply: () => effects.refreshTargetGateway(),
    },
    {
      id: 'dns',
      title: `Point DNS at ${to}`,
      change: { from: `${from}`, to: targetAddress },
      satisfied: async () => (await effects.publishedAddress()) === targetAddress,
      apply: async () => {
        const warnings = await effects.cutoverDns()
        // A cutover that reported success while editing nothing is the failure
        // this whole ordering exists to avoid; refuse to continue to the drain.
        if (warnings.length > 0) throw new Error(warnings.join('; '))
      },
    },
    {
      id: 'drain-source',
      title: `Stop the site on ${from}, leaving its files in place`,
      satisfied: async () => parseSourceDrained(await effects.runOnSource(buildSourceStateScript(slug, siteName))),
      apply: async () => {
        await effects.runOnSource(buildDrainSourceScript(slug, siteName))
      },
    },
  )

  return { operation: 'site:move', target: siteName, steps }
}
