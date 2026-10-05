import { describe, expect, it } from 'bun:test'
import {
  buildAwsArtifactFetch,
  buildHostCleanupScript,
  buildLocalArtifactFetch,
  buildSiteDeployScript,
  buildStaticSiteDeployScript,
  releaseTarballTmpPath,
  resolveExecStart,
} from '../../src/drivers/shared/deploy-script'

describe('resolveExecStart', () => {
  it('rewrites bun start commands to absolute binary path', () => {
    expect(resolveExecStart('bun run server.ts', 'bun')).toBe('/usr/local/bin/bun run server.ts')
  })

  it('rewrites node start commands', () => {
    expect(resolveExecStart('node dist/index.js', 'node')).toBe('/usr/local/bin/node dist/index.js')
  })
})

describe('buildSiteDeployScript (zero-downtime cutover, ported sites)', () => {
  const opts = {
    siteName: 'web',
    slug: 'my-app',
    artifactFetch: buildLocalArtifactFetch(
      '/var/ts-cloud/staging/release.tar.gz',
      '/tmp/my-app-web-abc123-release.tar.gz',
    ),
    releaseId: 'abc123',
    execStart: '/usr/local/bin/bun run server.ts',
    envEntries: { NODE_ENV: 'production' },
    port: 3000,
  }

  it('unpacks into a release dir, links shared .env, and runs the release as its own templated instance', () => {
    const script = buildSiteDeployScript(opts)
    const joined = script.join('\n')
    expect(script[0]).toBe('set -euo pipefail')
    expect(joined).toContain('mv "/var/ts-cloud/staging/release.tar.gz" /tmp/my-app-web-abc123-release.tar.gz')
    // Tarball goes into THIS release dir, never the live one.
    // Extraction goes to $TS_CLOUD_STAGED, which is the release dir itself
    // unless that dir is the one currently being served (see buildResetReleaseDir).
    expect(joined).toContain('tar xzf /tmp/my-app-web-abc123-release.tar.gz -C "$TS_CLOUD_STAGED"')
    expect(joined).toContain('rm -rf /var/www/web/releases/abc123.incoming')
    // .env persists in shared/ and is symlinked into the release.
    expect(joined).toContain('/var/www/web/shared/.env')
    expect(joined).toContain('ln -sfn /var/www/web/shared/.env /var/www/web/releases/abc123/.env')
    // Templated unit pinned to its release dir so old + new can overlap.
    expect(joined).toContain('/etc/systemd/system/my-app-web@.service')
    expect(joined).toContain('WorkingDirectory=/var/www/web/releases/%i')
    expect(joined).toContain('EnvironmentFile=/var/www/web/releases/%i/.env')
    expect(joined).toContain('Environment=PORT=3000')
    expect(joined).toContain('systemctl restart my-app-web@abc123.service')
    // Only the release-scoped instance is restarted. The shared legacy unit is
    // never bluntly restarted in the zero-downtime path.
    expect(joined).not.toContain('systemctl restart my-app-web.service')
  })

  it('contains an app leak inside its own cgroup instead of the whole box', () => {
    // A shared box runs many tenants. Unbounded, one that leaks fills memory
    // and swap and the kernel starts OOM-killing arbitrary victims, so a leak
    // in one app takes every other tenant down with it.
    const script = buildSiteDeployScript(opts)
    const joined = script.join('\n')
    expect(joined).toContain('MemoryAccounting=true')

    /*
     * The default is `auto`, resolved against the box rather than baked in, so
     * the unit carries no `MemoryHigh=` of its own - the drop-in written on the
     * target supplies it. A flat number here was generous on a 15G host and
     * larger than the whole machine on a 2G one.
     *
     * Asserted against the unit's own directives rather than the joined script:
     * the slice reconcile legitimately writes `MemoryMax=infinity` - to REMOVE
     * a ceiling, not impose one - and a substring match cannot tell them apart.
     */
    const unitDirectives = script.filter(line => /^Memory(?:High|Max)=/.test(line))
    expect(unitDirectives).toEqual([])
    expect(joined).toContain('50-ts-cloud-memory.conf')
    expect(joined).toContain('TS_CLOUD_HIGH_MB=$((TS_CLOUD_MEM_MB / 8))')
    // Floored and capped: never below 512M on a tiny box, never above 4G on a
    // huge one, because this is a runaway guard and not a fair share.
    expect(joined).toContain('-lt 512 ] && TS_CLOUD_HIGH_MB=512')
    expect(joined).toContain('-gt 4096 ] && TS_CLOUD_HIGH_MB=4096')

    const tuned = buildSiteDeployScript({ ...opts, memoryHigh: '512M', memoryMax: '768M' }).join('\n')
    expect(tuned).toContain('MemoryHigh=512M')
    expect(tuned).toContain('MemoryMax=768M')
  })

  it('an explicit memoryHigh still wins over the box-resolved default', () => {
    // `auto` is a default, not a policy. A site that has measured itself must
    // be able to say so and have that be the end of it.
    const script = buildSiteDeployScript({ ...opts, memoryHigh: '1G', memoryMax: '1400M' })
    const joined = script.join('\n')

    expect(script.filter(l => /^Memory(?:High|Max)=/.test(l))).toEqual(['MemoryHigh=1G', 'MemoryMax=1400M'])
    // Nothing resolved on the box when the value came from config...
    expect(joined).not.toContain('TS_CLOUD_HIGH_MB')
    expect(joined).not.toContain('> /etc/systemd/system/my-app-web@.service.d/50-ts-cloud-memory.conf')
  })

  it('removes the box-resolved drop-in a site left behind before it declared its own limit', () => {
    /*
     * The drop-in outranks the unit file. wildloop's ingest worker declared
     * 1G/1536M, got them written into its unit, and kept running at the 1951M
     * an earlier `auto` deploy had dropped in - above its own MemoryMax.
     */
    const script = buildSiteDeployScript({ ...opts, memoryHigh: '1G', memoryMax: '1400M' })
    const removal = script.find(l => l.includes('rm -f /etc/systemd/system/my-app-web@.service.d/50-ts-cloud-memory.conf'))
    expect(removal).toBeDefined()
    // Reloaded only when something went, so a steady deploy does not churn.
    expect(script).toContain('if [ "$TS_CLOUD_MEM_CLEARED" = 1 ]; then systemctl daemon-reload; fi')
    // Removed after the unit file is written and reloaded, so the very next
    // reload applies the unit's own values.
    const unitWritten = script.findIndex(l => l === 'TS_CLOUD_UNIT_EOF')
    expect(script.indexOf(removal!)).toBeGreaterThan(unitWritten)

    // On `auto` the drop-in is the point, and is written, never removed.
    const auto = buildSiteDeployScript(opts).join('\n')
    expect(auto).toContain('> /etc/systemd/system/my-app-web@.service.d/50-ts-cloud-memory.conf')
    expect(auto).not.toContain('rm -f /etc/systemd/system/my-app-web@.service.d/50-ts-cloud-memory.conf')
  })

  it('reports what the box has been promised, so 500% committed is visible', () => {
    /*
     * The box this was written for carried 43 units declaring 76G of ceilings
     * against 15G of RAM. Every unit looked reasonable alone; nothing summed
     * them. Ceilings that add past the machine are not protection, they are
     * arithmetic nobody did.
     */
    const script = buildSiteDeployScript(opts)
    expect(script.join('\n')).toContain('% committed')

    /*
     * Reports, never refuses: soft ceilings are guards rather than
     * reservations, so being committed over 100% is normal and refusing a
     * deploy over it would be worse than the problem. Asserted on the report's
     * own lines - the script exits non-zero elsewhere for good reasons (the
     * deploy lock, the health gate) and a whole-script match would catch those.
     */
    const reportLines = script.filter(l => l.includes('TS_CLOUD_COMMIT') || l.includes('TS_CLOUD_PCT'))
    expect(reportLines.length).toBeGreaterThan(0)
    for (const line of reportLines)
      expect(line).not.toContain('exit 1')
  })

  it('reports commitment even when the ceiling came from config', () => {
    // The warning is about the box, not about this site, so opting out of the
    // auto default must not opt you out of knowing.
    const joined = buildSiteDeployScript({ ...opts, memoryHigh: '1G' }).join('\n')
    expect(joined).toContain('TS_CLOUD_COMMIT')
  })

  it('resets the implicit template slice so it cannot cap the service', () => {
    /*
     * systemd puts `my-app-web@abc123.service` into `system-my\x2dapp\x2dweb.slice`
     * on its own. Nothing here asks for that slice and nothing used to write to
     * it, so any value it picked up - stale, hand-set during an incident, or
     * left by an older release - silently capped the service, because the
     * kernel enforces the minimum down the hierarchy. Four tenants on one box
     * were pinned to 512M while their units read 2G.
     */
    const joined = buildSiteDeployScript(opts).join('\n')

    expect(joined).toContain('-p Slice --value')
    expect(joined).toContain('MemoryHigh=infinity MemoryMax=infinity')
    // Both stores: a --runtime property in /run outranks the persistent one.
    expect(joined).toContain('set-property --runtime "$TS_CLOUD_SLICE"')
    expect(joined).toContain('set-property "$TS_CLOUD_SLICE"')
  })

  it('never resets system.slice, which every other tenant shares', () => {
    // A non-templated unit reports `system.slice`. Clearing that would lift the
    // ceiling off every service on the box.
    const joined = buildSiteDeployScript(opts).join('\n')
    expect(joined).toContain('"$TS_CLOUD_SLICE" != "system.slice"')
  })

  it('reconciles the slice before the new instance is started', () => {
    /*
     * Order matters. The cutover deliberately runs the old and new instances
     * together on a SO_REUSEPORT socket, and they share this slice - so the
     * tenant's footprint doubles at exactly the moment of the deploy. Reset the
     * slice after starting and the overlap is throttled in
     * `mem_cgroup_handle_over_high`, which is uninterruptible sleep: no
     * response, and no reaction to SIGTERM either.
     */
    const script = buildSiteDeployScript(opts)
    const reconcile = script.findIndex(l => l.includes('MemoryHigh=infinity'))
    const start = script.findIndex(l => l === 'systemctl restart my-app-web@abc123.service')

    expect(reconcile).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(-1)
    expect(reconcile).toBeLessThan(start)
  })

  it('leaves the per-instance ceiling as the only authority', () => {
    // The point of clearing the slice is not "no limits" - it is one limit, on
    // the service, declared in config and visible in the repo.
    const joined = buildSiteDeployScript({ ...opts, memoryHigh: '1G', memoryMax: '1400M' }).join('\n')
    expect(joined).toContain('MemoryHigh=1G')
    expect(joined).toContain('MemoryMax=1400M')
    expect(joined).toContain('MemoryHigh=infinity MemoryMax=infinity')
  })

  it('lets a site opt out of the memory ceiling', () => {
    const joined = buildSiteDeployScript({ ...opts, memoryHigh: 'infinity' }).join('\n')
    expect(joined).toContain('MemoryHigh=infinity')
  })

  // What each failure actually leaves on the box is asserted by running the
  // cutover in cutover.behaviour.test.ts. These pin the order of the steps.
  it('health-gates the new instance BEFORE stopping the old one', () => {
    const script = buildSiteDeployScript(opts)
    const captureIdx = script.findIndex(l => l.startsWith('TS_CLOUD_OLD_UNITS='))
    const startIdx = script.findIndex(l => l === 'systemctl restart my-app-web@abc123.service')
    const gateIdx = script.findIndex(l => l.startsWith('TS_CLOUD_GATE_OK=1'))
    const activateIdx = script.findIndex(l => l === 'mv -Tf /var/www/web/current.tmp /var/www/web/current')
    const stopOldIdx = script.findIndex(l => l.startsWith('for TS_CLOUD_U in ${TS_CLOUD_OLD_UNITS}'))
    expect(captureIdx).toBeGreaterThan(-1)
    expect(captureIdx).toBeLessThan(startIdx)
    expect(startIdx).toBeLessThan(gateIdx)
    expect(gateIdx).toBeLessThan(activateIdx)
    expect(activateIdx).toBeLessThan(stopOldIdx)
  })

  it('remembers where current pointed before anything can change it', () => {
    const script = buildSiteDeployScript(opts)
    const prevIdx = script.findIndex(l => l.startsWith('TS_CLOUD_PREV_CURRENT='))
    const activateIdx = script.findIndex(l => l === 'mv -Tf /var/www/web/current.tmp /var/www/web/current')
    expect(prevIdx).toBeGreaterThan(-1)
    expect(prevIdx).toBeLessThan(activateIdx)
  })

  it('makes room on the port only when the new release says the port was taken', () => {
    const joined = buildSiteDeployScript(opts).join('\n')
    expect(joined).toContain('EADDRINUSE|address already in use')
    expect(joined).toContain('crashed on start — the previous release was never stopped')
  })

  it('polls the configured health path, before and after the old release is retired', () => {
    const script = buildSiteDeployScript({ ...opts, healthCheckPath: 'health' })
    const probes = script.map((l, i) => [l, i] as const).filter(([l]) => l.includes('http://127.0.0.1:3000/health')).map(([, i]) => i)
    const activateIdx = script.findIndex(l => l === 'mv -Tf /var/www/web/current.tmp /var/www/web/current')
    const stopOldIdx = script.findIndex(l => l.startsWith('for TS_CLOUD_U in ${TS_CLOUD_OLD_UNITS}'))
    expect(probes).toHaveLength(2)
    expect(probes[0]).toBeLessThan(activateIdx)
    expect(probes[1]).toBeGreaterThan(stopOldIdx)
  })

  // A single attempt made the gate a race against whatever the app does before
  // its first response, on a box whose speed depends on its co-tenants.
  it('keeps asking the health path rather than giving the release one chance', () => {
    const joined = buildSiteDeployScript({ ...opts, healthCheckPath: 'health' }).join('\n')
    const attempts = Number(joined.match(/for TS_CLOUD_I in \$\(seq 1 (\d+)\); do if curl -sf/)?.[1])
    expect(attempts).toBeGreaterThan(1)
    expect(joined).toContain('[ "$TS_CLOUD_HEALTHY" -eq 1 ] ||')
  })

  // The probe cannot tell the instances apart during the overlap, so the bind
  // check has to come first or the old release answers for the new one.
  it('waits for the new instance to hold the port before trusting a response', () => {
    const joined = buildSiteDeployScript({ ...opts, healthCheckPath: 'health' }).join('\n')
    expect(joined).toContain('systemctl show -p MainPID --value my-app-web@abc123.service')
    expect(joined).toContain('grep "pid=$TS_CLOUD_NEW_PID," >/dev/null')
    expect(joined.indexOf('TS_CLOUD_BOUND')).toBeLessThan(joined.indexOf('TS_CLOUD_HEALTHY'))
  })

  it('waits longer for the port than for a reply', () => {
    const joined = buildSiteDeployScript({ ...opts, healthCheckPath: 'health' }).join('\n')
    const bind = Number(joined.match(/seq 1 (\d+)\); do\n\s*TS_CLOUD_NEW_PID/)?.[1])
    const reply = Number(joined.match(/for TS_CLOUD_I in \$\(seq 1 (\d+)\); do if curl -sf/)?.[1])
    expect(bind).toBeGreaterThan(reply)
    expect(bind * 3).toBeGreaterThanOrEqual(180)
  })

  // A missing `ss -p` capability is not a broken release.
  it('falls back to the response probes where listener PIDs cannot be read', () => {
    const joined = buildSiteDeployScript({ ...opts, healthCheckPath: 'health' }).join('\n')
    expect(joined).toContain('if ss -ltnpH "sport = :3000" >/dev/null 2>&1; then')
    expect(joined).toContain('the response probes run without the bind check')
  })

  it('migrates off the legacy single unit with a one-time cutover and removes it', () => {
    const joined = buildSiteDeployScript(opts).join('\n')
    expect(joined).toContain('retiring pre-zero-downtime unit my-app-web.service')
    expect(joined).toContain('rm -f /etc/systemd/system/my-app-web.service')
  })

  it('never wipes the live directory (no destructive find/rm of the docroot)', () => {
    const joined = buildSiteDeployScript(opts).join('\n')
    expect(joined).not.toContain('find /var/www/web -mindepth')
  })

  it('prunes old releases after promotion', () => {
    const script = buildSiteDeployScript(opts)
    expect(script.join('\n')).toContain('mv -Tf /var/www/web/current.tmp /var/www/web/current')
    expect(script.some((l) => l.includes('rm -rf "$TS_CLOUD_OLD"'))).toBe(true)
  })

  it('guards the unit prune grep so an empty match list cannot fail the deploy under set -euo pipefail', () => {
    const script = buildSiteDeployScript(opts)
    const joined = script.join('\n')
    // The prune pipeline wraps grep in a brace group so `|| true` guards only
    // the grep — without it, grep exits 1 on "nothing to prune" and kills the
    // script at the very last step, after the new release is already live.
    expect(joined).toContain(
      '| { grep -v -e "^my-app-web@abc123.service$" -e "^my-app-web@\\.service$" || true; } | while read -r TS_CLOUD_U',
    )
    // Every `grep -v` in the generated script is guarded against exit 1.
    for (const line of script) {
      if (line.includes('grep -v')) expect(line).toContain('|| true')
    }
  })

  it('runs preStart in the new release dir after extraction, before the new instance starts', () => {
    const script = buildSiteDeployScript({
      ...opts,
      preStartCommands: ['bun install --frozen-lockfile', 'bun run build'],
    })
    const joined = script.join('\n')
    expect(joined).toContain('cd /var/www/web/releases/abc123')
    const extractIdx = script.findIndex((l) => l.includes('tar xzf'))
    const installIdx = script.findIndex((l) => l === 'bun install --frozen-lockfile')
    const startIdx = script.findIndex((l) => l === 'systemctl restart my-app-web@abc123.service')
    expect(extractIdx).toBeLessThan(installIdx)
    expect(installIdx).toBeLessThan(startIdx)
  })

  it('removes artifact env files before linking the resolved runtime env', () => {
    const script = buildSiteDeployScript(opts)
    const removeIdx = script.findIndex(line => line.startsWith('find /var/www/web/releases/abc123 '))
    const linkIdx = script.findIndex(line => line.includes('ln -sfn /var/www/web/shared/.env'))

    expect(removeIdx).toBeGreaterThan(-1)
    expect(script[removeIdx]).toContain("-name '.env*'")
    expect(script[removeIdx]).toContain("! -name '.env.example'")
    expect(removeIdx).toBeLessThan(linkIdx)
  })
})

describe('buildSiteDeployScript (restart cutover: portless sites / zeroDowntime off)', () => {
  const portless = {
    siteName: 'worker',
    slug: 'my-app',
    artifactFetch: buildLocalArtifactFetch('/tmp/staging.tar.gz', '/tmp/my-app-worker-abc123-release.tar.gz'),
    releaseId: 'abc123',
    execStart: '/usr/local/bin/bun run worker.ts',
    envEntries: {},
  }

  it('portless sites keep the single-unit restart flow (no overlap: double workers double-process)', () => {
    const script = buildSiteDeployScript(portless)
    const joined = script.join('\n')
    expect(joined).toContain('WorkingDirectory=/var/www/worker/current')
    expect(joined).toContain('systemctl restart my-app-worker.service')
    expect(joined).not.toContain('my-app-worker@')
    // Promote atomically BEFORE restarting.
    const activateIdx = script.findIndex((l) => l.includes('mv -Tf') && l.includes('/current'))
    const restartIdx = script.findIndex((l) => l === 'systemctl restart my-app-worker.service')
    expect(activateIdx).toBeLessThan(restartIdx)
  })

  // One `is-active` straight after `restart` passed a worker that crashed a
  // second later, and its restart loop became the live release.
  it('watches a restarted worker for the gate window and goes back to the previous release if it dies', () => {
    const script = buildSiteDeployScript(portless)
    const prevIdx = script.findIndex(l => l.startsWith('TS_CLOUD_PREV_CURRENT='))
    const activateIdx = script.findIndex(l => l === 'mv -Tf /var/www/worker/current.tmp /var/www/worker/current')
    const restartIdx = script.findIndex(l => l === 'systemctl restart my-app-worker.service')
    const watch = script.find(l => l.includes('did not stay up — restoring the previous release'))
    expect(prevIdx).toBeGreaterThan(-1)
    expect(prevIdx).toBeLessThan(activateIdx)
    expect(watch).toBeDefined()
    expect(script.indexOf(watch!)).toBeGreaterThan(restartIdx)
    expect(watch).toContain('$(seq 1 5)')
    expect(watch).toContain('ln -sfn "$TS_CLOUD_PREV_CURRENT" /var/www/worker/current.tmp')
    expect(watch).toContain('exit 1')
  })

  it('carries memory ceilings from config, so a portless site need not be bounded by hand', () => {
    const bounded = buildSiteDeployScript({ ...portless, memoryHigh: '512M', memoryMax: '768M' }).join('\n')
    expect(bounded).toContain('MemoryAccounting=true')
    expect(bounded).toContain('MemoryHigh=512M')
    expect(bounded).toContain('MemoryMax=768M')

    // Absent config it inherits the same box-resolved default as a ported
    // site, rather than staying unbounded. A portless unit shares the box with
    // everyone else, so "no ceiling" is the one setting that lets it take the
    // host down — which is the incident this default exists for.
    const defaulted = buildSiteDeployScript(portless).join('\n')
    expect(defaulted).toContain('50-ts-cloud-memory.conf')
    expect(defaulted).toContain('MemoryHigh=%sM')
    // Still no hard cap unless asked: a soft limit throttles, and only an
    // explicit `memoryMax` should be able to kill a worker outright.
    expect(defaulted).not.toContain('MemoryMax=')
  })

  it('lets declared limits outrank a stale auto drop-in and hand-set overrides', () => {
    // A plain unit is where `systemctl set-property` gets typed by hand, and
    // its overrides in system.control outrank the unit file just as the auto
    // drop-in does. What config now declares has to win over both.
    const bounded = buildSiteDeployScript({ ...portless, memoryHigh: '1G', memoryMax: '1536M' }).join('\n')
    for (const file of [
      '/etc/systemd/system/my-app-worker.service.d/50-ts-cloud-memory.conf',
      '/etc/systemd/system.control/my-app-worker.service.d/50-MemoryHigh.conf',
      '/etc/systemd/system.control/my-app-worker.service.d/50-MemoryMax.conf',
      '/run/systemd/system.control/my-app-worker.service.d/50-MemoryHigh.conf',
      '/run/systemd/system.control/my-app-worker.service.d/50-MemoryMax.conf',
    ])
      expect(bounded).toContain(`rm -f ${file}`)

    // On `auto` with only a hard cap declared: the cap's override goes, the
    // auto drop-in and a hand-set MemoryHigh are left alone.
    const capped = buildSiteDeployScript({ ...portless, memoryMax: '1536M' }).join('\n')
    expect(capped).toContain('rm -f /etc/systemd/system.control/my-app-worker.service.d/50-MemoryMax.conf')
    expect(capped).not.toContain('rm -f /etc/systemd/system.control/my-app-worker.service.d/50-MemoryHigh.conf')
    expect(capped).not.toContain('rm -f /etc/systemd/system/my-app-worker.service.d/50-ts-cloud-memory.conf')
    expect(capped).toContain('> /etc/systemd/system/my-app-worker.service.d/50-ts-cloud-memory.conf')

    // Nothing declared, nothing touched.
    expect(buildSiteDeployScript(portless).join('\n')).not.toContain('TS_CLOUD_MEM_CLEARED')
  })

  it('emits declared CPU/IO/task priority, in both unit shapes', () => {
    const qos = { cpuWeight: 500, ioWeight: 400, tasksMax: 256 }

    // Portless (restart) and ported (templated overlap) units must agree:
    // a site's declared priority should not depend on whether it has a port.
    for (const script of [
      buildSiteDeployScript({ ...portless, ...qos }),
      buildSiteDeployScript({ ...portless, siteName: 'web', port: 3000, ...qos }),
    ]) {
      const joined = script.join('\n')
      expect(joined).toContain('CPUWeight=500')
      expect(joined).toContain('IOWeight=400')
      expect(joined).toContain('TasksMax=256')
    }

    // Nothing is invented when nothing is asked for: a box running one
    // workload has no hierarchy to express, and a surprise one is worse than
    // none.
    const plain = buildSiteDeployScript(portless).join('\n')
    expect(plain).not.toContain('CPUWeight=')
    expect(plain).not.toContain('IOWeight=')
    expect(plain).not.toContain('TasksMax=')
  })

  it('lets a draining worker finish before systemd escalates to SIGKILL', () => {
    const draining = buildSiteDeployScript({ ...portless, stopTimeout: '15min' }).join('\n')
    expect(draining).toContain('TimeoutStopSec=15min')

    // systemd's 90s default is right for a service that stops at once, so
    // nothing is emitted unless a site asks. An ingest worker that finishes
    // its current shard was killed mid-write under the default.
    expect(buildSiteDeployScript(portless).join('\n')).not.toContain('TimeoutStopSec=')
  })

  it('zeroDowntime: false opts a ported site back into the restart flow', () => {
    const joined = buildSiteDeployScript({ ...portless, siteName: 'web', port: 3000, zeroDowntime: false }).join('\n')
    expect(joined).toContain('systemctl restart my-app-web.service')
    expect(joined).not.toContain('my-app-web@')
  })

  it('portless sites ignore zeroDowntime: true (overlap would double-process)', () => {
    const joined = buildSiteDeployScript({ ...portless, zeroDowntime: true }).join('\n')
    expect(joined).toContain('systemctl restart my-app-worker.service')
    expect(joined).not.toContain('my-app-worker@')
  })
})

describe('buildStaticSiteDeployScript (zero-downtime atomic release)', () => {
  const opts = {
    siteName: 'docs',
    artifactFetch: buildLocalArtifactFetch('/tmp/staging.tar.gz', '/tmp/docs-rel9-release.tar.gz'),
    releaseId: 'rel9',
  }

  it('unpacks into a release dir and swaps current atomically — no empty-docroot window, no restart', () => {
    const script = buildStaticSiteDeployScript(opts)
    const joined = script.join('\n')
    expect(joined).toContain('tar xzf /tmp/docs-rel9-release.tar.gz -C "$TS_CLOUD_STAGED"')
    expect(joined).toContain('rm -rf /var/www/docs/releases/rel9.incoming')
    expect(joined).toContain('mv -Tf /var/www/docs/current.tmp /var/www/docs/current')
    // No destructive wipe of the live docroot, and no systemd (static).
    expect(joined).not.toContain('find /var/www/docs -mindepth')
    expect(joined).not.toContain('systemctl')
    // Old releases pruned.
    expect(script.some((l) => l.includes('rm -rf "$TS_CLOUD_OLD"'))).toBe(true)
  })

  it('runs preStart (on-box build) in the release dir before the swap', () => {
    const script = buildStaticSiteDeployScript({ ...opts, preStartCommands: ['bun run docs:build'] })
    const buildIdx = script.findIndex((l) => l === 'bun run docs:build')
    const activateIdx = script.findIndex((l) => l.includes('mv -Tf') && l.includes('/current'))
    expect(buildIdx).toBeGreaterThan(-1)
    expect(buildIdx).toBeLessThan(activateIdx)
  })
})

describe('buildAwsArtifactFetch', () => {
  it('pulls tarball from S3 before extraction', () => {
    expect(
      buildAwsArtifactFetch(
        'my-app-production-deploy',
        'releases/web/abc.tar.gz',
        'us-east-1',
        '/tmp/my-app-web-abc-release.tar.gz',
      ),
    ).toEqual([
      'aws s3 cp "s3://my-app-production-deploy/releases/web/abc.tar.gz" /tmp/my-app-web-abc-release.tar.gz --region us-east-1',
    ])
  })
})

describe('buildHostCleanupScript', () => {
  it('bounds stale deploy data without touching active or rollback releases', () => {
    const joined = buildHostCleanupScript().join('\n')
    expect(joined).toContain('/var/ts-cloud/staging')
    expect(joined).toContain('TS_CLOUD_HC_STAGING_MIN=60 ')
    expect(joined).toContain('journalctl --vacuum-time="$TS_CLOUD_HC_JOURNAL_DAYS"d --vacuum-size="$TS_CLOUD_HC_JOURNAL_MB"M')
    expect(joined).toContain('TS_CLOUD_HC_JOURNAL_DAYS=14 TS_CLOUD_HC_JOURNAL_MB=512 TS_CLOUD_HC_IMAGE_HOURS=168')
    expect(joined).toContain('docker image prune --all --force --filter "until=${TS_CLOUD_HC_IMAGE_HOURS}h"')
    expect(joined).toContain('/var/ts-cloud/artifacts')
    expect(joined).not.toContain('/var/www')
    expect(joined).not.toContain('releases/')
  })
})

describe('releaseTarballTmpPath', () => {
  it('namespaces the staged tarball by slug, site, and release id (shared-box safe)', () => {
    expect(releaseTarballTmpPath('my-app', 'web', 'abc123')).toBe('/tmp/my-app-web-abc123-release.tar.gz')
    expect(releaseTarballTmpPath(undefined, 'docs', 'rel9')).toBe('/tmp/docs-rel9-release.tar.gz')
  })
})

/**
 * Two deploys of one site used to be free to run at once, and the second one's
 * `rm -rf releases/<id>` ran against a tree the first was still extracting
 * into — which fails with "Directory not empty", an error that reads like a
 * permissions problem and is really a race. It is easy to hit: a deploy whose
 * client is interrupted keeps running on the box, the operator sees a dead
 * terminal and re-runs.
 */
describe('deploy concurrency and re-deploys of a live release', () => {
  const opts = {
    siteName: 'web',
    slug: 'my-app',
    artifactFetch: buildLocalArtifactFetch(
      '/var/ts-cloud/staging/release.tar.gz',
      '/tmp/my-app-web-abc123-release.tar.gz',
    ),
    releaseId: 'abc123',
    execStart: '/usr/local/bin/bun run server.ts',
    envEntries: { NODE_ENV: 'production' },
    port: 3000,
  }

  const opts2 = {
    siteName: 'docs',
    artifactFetch: buildLocalArtifactFetch('/tmp/staging.tar.gz', '/tmp/docs-rel9-release.tar.gz'),
    releaseId: 'rel9',
  }

  it('takes the site lock before touching anything', () => {
    const script = buildSiteDeployScript(opts)
    const joined = script.join('\n')

    expect(joined).toContain('/var/www/web/.ts-cloud/deploy.lock')
    expect(joined).toContain('flock -w 900 9')

    // Before the first destructive step, or it is not a guard.
    const lockIdx = script.findIndex(line => line.includes('flock -w'))
    const destructiveIdx = script.findIndex(line => line.includes('rm -rf /var/www/web/releases/abc123'))
    expect(lockIdx).toBeGreaterThanOrEqual(0)
    expect(destructiveIdx).toBeGreaterThan(lockIdx)
  })

  it('never deletes the release the site is currently serving', () => {
    const joined = buildSiteDeployScript(opts).join('\n')

    // The unconditional wipe is gone: the delete is now inside the branch that
    // runs only when `current` points somewhere else.
    // Both sides resolved before comparing — see the behaviour test for why a
    // literal comparison here silently deleted the live release.
    expect(joined).toContain('TS_CLOUD_LIVE_PATH="$(readlink -f /var/www/web/current 2>/dev/null || true)"')
    expect(joined).toContain('if [ "$TS_CLOUD_IS_LIVE" = "yes" ]; then')
    expect(joined).toContain('TS_CLOUD_STAGED=/var/www/web/releases/abc123.incoming')
    expect(joined).toMatch(/else\n\s*rm -rf \/var\/www\/web\/releases\/abc123/)
  })

  it('swaps a staged release into place with renames, not a delete-then-extract', () => {
    const joined = buildSiteDeployScript(opts).join('\n')

    expect(joined).toContain('mv /var/www/web/releases/abc123 /var/www/web/releases/abc123.previous')
    expect(joined).toContain('mv /var/www/web/releases/abc123.incoming /var/www/web/releases/abc123')
    expect(joined).toContain('rm -rf /var/www/web/releases/abc123.previous')
  })

  it('locks the static-site path too', () => {
    const joined = buildStaticSiteDeployScript(opts2).join('\n')

    expect(joined).toContain('/var/www/docs/.ts-cloud/deploy.lock')
    expect(joined).toContain('flock -w 900 9')
  })
})

describe('liveness watchdog', () => {
  const base = {
    siteName: 'web',
    slug: 'my-app',
    artifactFetch: buildLocalArtifactFetch('/var/ts-cloud/staging/release.tar.gz', '/tmp/r.tar.gz'),
    releaseId: 'abc123',
    execStart: '/usr/local/bin/bun run server.ts',
    envEntries: { NODE_ENV: 'production' },
    port: 3000,
  }

  /**
   * `Restart=always` only catches a process that EXITS. The failure this
   * covers is the other one: a process that is alive and no longer serving.
   * One app on a shared box sat in exactly that state for eight days -
   * systemd reporting `active (running)`, the port still bound, 46 connections
   * queued in the accept backlog, and nothing anywhere noticing.
   */
  it('installs a timer that asks the service for an HTTP response', () => {
    const joined = buildSiteDeployScript(base).join('\n')

    expect(joined).toContain('/usr/local/sbin/my-app-web-liveness')
    expect(joined).toContain('/etc/systemd/system/my-app-web-liveness.timer')
    expect(joined).toContain('systemctl enable --now my-app-web-liveness.timer')
    expect(joined).toContain('curl -s -o /dev/null --max-time 10 "http://127.0.0.1:3000/"')
  })

  it('probes over HTTP rather than checking the listener', () => {
    // `ss` would have called the wedged process healthy: it was listening the
    // whole time. Only a request proves the event loop is still turning.
    const joined = buildSiteDeployScript(base).join('\n')
    const script = joined.slice(joined.indexOf('my-app-web-liveness <<'), joined.indexOf('TS_CLOUD_LIVENESS_EOF\nchmod'))

    expect(script).not.toContain('ss -ltn')
  })

  it('counts a response of any status as alive', () => {
    // No `-f`: a 404 on / is a routing opinion, not a wedged process, and
    // restarting on one would bounce a perfectly healthy service every minute.
    const joined = buildSiteDeployScript(base).join('\n')

    expect(joined).not.toContain('curl -sf -o /dev/null --max-time 5')
  })

  it('needs consecutive failures, and forgets them after a good response', () => {
    const joined = buildSiteDeployScript(base).join('\n')

    expect(joined).toContain('if [ "$TS_CLOUD_FAILS" -lt 3 ]; then')
    expect(joined).toContain('TS_CLOUD_STATE=/run/my-app-web-liveness')
    expect(joined).toContain('rm -f "$TS_CLOUD_STATE.fail"')
    expect(joined).toContain('flock -n 9 || exit 0')
  })

  it('resolves the unit at run time, so it survives the next release', () => {
    // The instance name carries the release id. Baking abc123 into the timer
    // would leave it probing a unit that no longer exists after one deploy.
    const joined = buildSiteDeployScript(base).join('\n')

    expect(joined).toContain(`list-units --plain --no-legend --type=service 'my-app-web@*.service'`)
    expect(joined).not.toContain('systemctl restart my-app-web@abc123.service"')
  })

  it('leaves a unit systemd already considers down to Restart=always', () => {
    expect(buildSiteDeployScript(base).join('\n')).toContain('systemctl is-active --quiet "$TS_CLOUD_UNIT" || exit 0')
  })

  it('honours the health path when one is configured', () => {
    const joined = buildSiteDeployScript({ ...base, healthCheckPath: '/health' }).join('\n')

    expect(joined).toContain('"http://127.0.0.1:3000/health"')
  })

  it('takes its timing from the site config', () => {
    const joined = buildSiteDeployScript({ ...base, liveness: { startupGraceSeconds: 900, timeoutSeconds: 20, maxBackoffSeconds: 7200 } }).join('\n')

    expect(joined).toContain('--max-time 20 "http://127.0.0.1:3000/"')
    expect(joined).toContain('-lt 900 ]; then')
    expect(joined).toContain('startup-grace=900s max-backoff=7200s')
  })

  it('can be turned off', () => {
    const joined = buildSiteDeployScript({ ...base, liveness: false }).join('\n')

    expect(joined).not.toContain('liveness.timer')
  })

  it('is not installed for a service with no port to ask', () => {
    // Workers and schedulers answer nothing on a port; a probe would call
    // every one of them dead.
    const joined = buildSiteDeployScript({ ...base, port: undefined, zeroDowntime: false }).join('\n')

    expect(joined).not.toContain('liveness.timer')
  })
})

describe('remote notices reach the log', () => {
  /*
   * The commitment report and every other thing the box says used to be
   * captured into `perInstance[].output` and never printed. A warning nobody
   * sees is not a warning, so `surfaceRemoteNotices` republishes the marked
   * lines - and only the marked lines, because remote stdout is whatever
   * arbitrary preStart commands chose to print.
   */
  const surface = (output: string): string[] => {
    const seen: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => { seen.push(String(args[0])) }
    try {
      for (const line of output.split('\n')) {
        const t = line.trim()
        if (t.startsWith('[ts-cloud]')) console.warn(t)
      }
    } finally {
      console.warn = original
    }
    return seen
  }

  it('surfaces ts-cloud notices', () => {
    const out = [
      'bun install v1.3.14',
      '  [ts-cloud] memory commitment: 78367M declared against 15613M RAM (501%)',
      'Catalog synced.',
    ].join('\n')

    expect(surface(out)).toEqual([
      '[ts-cloud] memory commitment: 78367M declared against 15613M RAM (501%)',
    ])
  })

  it('republishes nothing an app happened to print', () => {
    /*
     * The reason for the marker. The script carries the env here-document, and
     * an app that logs its own config on boot would otherwise have it echoed
     * straight into a public CI log.
     */
    const out = [
      'APP_KEY=super-secret-value',
      'DB_PASSWORD=hunter2',
      'listening on :3000',
    ].join('\n')

    expect(surface(out)).toEqual([])
  })
})

describe('resolveExecStart with an executable entry point', () => {
  const RELEASE = '/var/www/acme-main/releases/%i'

  it('runs a relative executable directly instead of feeding it to the runtime', () => {
    // The bug this exists for: `bun ./buddy serve` made bun parse a shell
    // script as JavaScript, and the unit crash-looped on its first line.
    expect(resolveExecStart('./buddy serve', 'bun', RELEASE))
      .toBe('/var/www/acme-main/releases/%i/buddy serve')
  })

  it('keeps every argument after the executable', () => {
    expect(resolveExecStart('./buddy serve --verbose', 'bun', RELEASE))
      .toBe('/var/www/acme-main/releases/%i/buddy serve --verbose')
  })

  it('leaves an already-absolute executable alone', () => {
    expect(resolveExecStart('/usr/bin/env myserver', 'bun', RELEASE)).toBe('/usr/bin/env myserver')
  })

  it('still hands a module to the runtime', () => {
    expect(resolveExecStart('dist/index.js', 'bun', RELEASE)).toBe('/usr/local/bin/bun dist/index.js')
    expect(resolveExecStart('server.ts', 'bun', RELEASE)).toBe('/usr/local/bin/bun server.ts')
    expect(resolveExecStart('./app/Worker.ts', 'bun', RELEASE)).toBe('/usr/local/bin/bun ./app/Worker.ts')
  })

  it('still swaps a leading runtime word for the absolute binary', () => {
    expect(resolveExecStart('bun run server.ts', 'bun', RELEASE)).toBe('/usr/local/bin/bun run server.ts')
    expect(resolveExecStart('bun storage/serve.js', 'bun', RELEASE)).toBe('/usr/local/bin/bun storage/serve.js')
  })

  it('does not invent an absolute path when it has nowhere to resolve from', () => {
    // systemd rejects a relative ExecStart, so emitting one would trade a
    // confusing failure for a different confusing failure.
    expect(resolveExecStart('./buddy serve', 'bun')).toBe('/usr/local/bin/bun ./buddy serve')
  })

  it('trims a trailing slash off the release directory', () => {
    expect(resolveExecStart('./buddy serve', 'bun', '/var/www/acme/releases/%i/'))
      .toBe('/var/www/acme/releases/%i/buddy serve')
  })
})

describe('stx image cache shared across releases', () => {
  // stx encodes every image a template renders before a production server
  // binds. Inside releases/<id> that started from nothing on every deploy and
  // outlasted the health check on a photo-heavy site.
  const artifactFetch = buildLocalArtifactFetch('/var/ts-cloud/staging/release.tar.gz', '/tmp/my-app-web-abc123-release.tar.gz')

  it('points a ported site at shared/stx-images and creates it', () => {
    const joined = buildSiteDeployScript({
      siteName: 'web',
      slug: 'my-app',
      artifactFetch,
      releaseId: 'abc123',
      execStart: '/usr/local/bin/bun run server.ts',
      envEntries: {},
      port: 3000,
    }).join('\n')

    expect(joined).toContain('Environment=STX_IMAGE_CACHE_DIR=/var/www/web/shared/stx-images')
    expect(joined).toMatch(/mkdir -p \/var\/www\/web\/releases \/var\/www\/web\/shared \/var\/www\/web\/shared\/stx-images/)
  })

  it('points a site without zero-downtime overlap at the same directory', () => {
    const joined = buildSiteDeployScript({
      siteName: 'web',
      slug: 'my-app',
      artifactFetch,
      releaseId: 'abc123',
      execStart: '/usr/local/bin/bun run server.ts',
      envEntries: {},
      port: 3000,
      zeroDowntime: false,
    }).join('\n')

    expect(joined).not.toContain('my-app-web@')
    expect(joined).toContain('Environment=STX_IMAGE_CACHE_DIR=/var/www/web/shared/stx-images')
  })
})
