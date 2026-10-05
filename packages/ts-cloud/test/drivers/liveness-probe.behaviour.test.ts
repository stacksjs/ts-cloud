import type { LivenessOptions } from '../../src/drivers/shared/deploy-script'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { buildLivenessUnits, buildSiteDeployScript, buildLocalArtifactFetch } from '../../src/drivers/shared/deploy-script'

/**
 * These run the generated liveness script instead of asserting on its text.
 *
 * The probe restarted a release three minutes into each boot, three boots in a
 * row: the server had bound its port and then kept its main thread busy with
 * an image warm-up, so every check timed out, and every restart threw the
 * warm-up away and began it again. Visitors got nine minutes of 502s from a
 * release that would have been healthy in five. What decides whether that can
 * happen again is how the script behaves against a unit of a given age, which
 * only running it can show.
 *
 * The script runs under `sh` against a sandbox: `/run` and `/proc/uptime` are
 * rewritten to files in a temp dir, and `systemctl`, `logger`, `flock`, `date`
 * and (unless a test wants the real one) `curl` are shims that read and record
 * state there. Nothing touches systemd.
 *
 * The shims are shell functions defined at the top of the script rather than
 * executables on PATH. A run calls them a dozen times, and as separate
 * `#!/bin/sh` processes they made each run cost ~100ms on macOS, so the tests
 * that drive a dozen runs brushed against bun's 5s timeout under a loaded
 * full-suite run. Functions shadow the commands the same way, without a fork
 * and exec per call.
 */
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const UNIT = 'acme-web@abc123.service'
/**
 * The probe runs as `#!/bin/sh`, which is dash on the Ubuntu boxes it lands
 * on. dash is stricter than bash's POSIX mode, so run under it when it exists.
 */
const SH = existsSync('/bin/dash') ? '/bin/dash' : 'sh'

interface Box {
  dir: string
  /** Seconds since boot, as /proc/uptime reports it. */
  uptime: number
  /** Seconds since boot at which the unit last became active. */
  activeSince: number
  /** Wall clock, epoch seconds, as `date +%s` reports it. */
  now: number
  /** Exit code the curl shim returns; `null` uses the real curl. */
  curl: number | null
}

function extractScript(lines: string[]): string {
  const joined = lines.join('\n')
  const open = joined.indexOf(`<<'TS_CLOUD_LIVENESS_EOF'\n`)
  const close = joined.indexOf('\nTS_CLOUD_LIVENESS_EOF\n')
  return joined.slice(open + `<<'TS_CLOUD_LIVENESS_EOF'\n`.length, close + 1)
}

function sandbox(options: LivenessOptions & { port?: number } = {}): { box: Box, run: () => Promise<void>, log: () => string[], restarts: () => number, state: (name: string) => string | null } {
  const dir = mkdtempSync(join(tmpdir(), 'ts-cloud-liveness-'))
  dirs.push(dir)

  const script = extractScript(buildLivenessUnits({
    unitBase: 'acme-web',
    unitPattern: 'acme-web@*.service',
    port: options.port ?? 3000,
    ...options,
  }))
    .replaceAll('/run/', `${dir}/run-`)
    .replaceAll('/proc/uptime', `${dir}/uptime`)
  const [shebang, ...body] = script.split('\n')
  // Builtins only (read, printf, case), so a shim call never execs anything.
  const shims = [
    'flock() { return 0; }',
    `logger() { shift 2; printf '%s\\n' "$*" >> '${dir}/log'; }`,
    `date() { read -r ts_cloud_test_now < '${dir}/now'; printf '%s\\n' "$ts_cloud_test_now"; }`,
    'systemctl() {',
    '  case "$1" in',
    `    list-units) echo "${UNIT} loaded active running Acme" ;;`,
    '    is-active) return 0 ;;',
    `    show) case "$*" in *ActiveEnterTimestampMonotonic*) read -r ts_cloud_test_since < '${dir}/since'; printf '%s\\n' "$ts_cloud_test_since" ;; *MainPID*) echo 0 ;; esac ;;`,
    `    restart) echo "$2" >> '${dir}/restarts' ;;`,
    '  esac',
    '}',
  ]

  const box: Box = { dir, uptime: 1000, activeSince: 1, now: 1_700_000_000, curl: 28 }

  const run = async (): Promise<void> => {
    writeFileSync(join(dir, 'uptime'), `${box.uptime}.42 9999.00\n`)
    writeFileSync(join(dir, 'since'), `${box.activeSince * 1_000_000}\n`)
    writeFileSync(join(dir, 'now'), `${box.now}\n`)
    const curl = box.curl === null ? [] : [`curl() { return ${box.curl}; }`]
    writeFileSync(join(dir, 'liveness.sh'), [shebang, ...shims, ...curl, ...body].join('\n'))

    const proc = Bun.spawn([SH, join(dir, 'liveness.sh')], {
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    if (code !== 0 || stderr !== '')
      throw new Error(`liveness script exited ${code}: ${stderr}`)
  }

  const read = (name: string): string | null => existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null

  return {
    box,
    run,
    log: () => (read('log') ?? '').split('\n').filter(Boolean),
    restarts: () => (read('restarts') ?? '').split('\n').filter(Boolean).length,
    state: (name: string) => read(`run-acme-web-liveness.${name}`),
  }
}

/** One timer tick: the clocks move on by `seconds`, then the check runs. */
async function tick(sb: ReturnType<typeof sandbox>, seconds = 60): Promise<void> {
  sb.box.uptime += seconds
  sb.box.now += seconds
  await sb.run()
}

describe('the generated liveness script parses', () => {
  const parse = async (shell: string, script: string): Promise<{ code: number, error: string }> => {
    const file = join(mkdtempSync(join(tmpdir(), 'ts-cloud-liveness-parse-')), 'script.sh')
    dirs.push(join(file, '..'))
    writeFileSync(file, script)
    const proc = Bun.spawn([shell, '-n', file], { stdout: 'pipe', stderr: 'pipe' })
    const [error, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    return { code, error }
  }

  const base = {
    siteName: 'web',
    slug: 'acme',
    artifactFetch: buildLocalArtifactFetch('/var/ts-cloud/staging/release.tar.gz', '/tmp/r.tar.gz'),
    releaseId: 'abc123',
    execStart: '/usr/local/bin/bun run server.ts',
    envEntries: { NODE_ENV: 'production' },
    port: 3000,
  }

  // The probe runs under /bin/sh, which is dash on Ubuntu; the deploy script
  // that writes it runs under bash. Both have to accept what they are given.
  it.each([[SH], ['bash']])('the probe itself parses under %s', async (shell) => {
    const result = await parse(shell, extractScript(buildLivenessUnits({ unitBase: 'acme-web', unitPattern: 'acme-web@*.service', port: 3000 })))
    expect(result.error).toBe('')
    expect(result.code).toBe(0)
  })

  it.each([
    ['zero-downtime', {}],
    ['restart', { zeroDowntime: false }],
  ] as const)('the whole %s deploy script parses under bash, heredocs included', async (_mode, extra) => {
    const result = await parse('bash', `set -euo pipefail\n${buildSiteDeployScript({ ...base, ...extra }).join('\n')}\n`)
    expect(result.error).toBe('')
    expect(result.code).toBe(0)
  })

  it('closes every heredoc it opens at column 0', () => {
    const lines = buildSiteDeployScript(base).join('\n').split('\n')
    lines.forEach((line, i) => {
      const opener = line.match(/<<'([A-Z_]+)'/)
      if (!opener)
        return
      const rest = lines.slice(i + 1)
      const exact = rest.indexOf(opener[1])
      const loose = rest.findIndex(l => l.trim() === opener[1])
      expect(exact).toBeGreaterThanOrEqual(0)
      expect(exact).toBe(loose)
    })
  })
})

describe('startup grace', () => {
  it('never restarts a unit that is still inside its grace, however many checks fail', async () => {
    // The incident: bound, busy warming up, answering nothing for minutes.
    const sb = sandbox()
    sb.box.activeSince = sb.box.uptime
    // Five checks: two more than the three that used to trigger a restart.
    for (let i = 0; i < 5; i++)
      await tick(sb)

    expect(sb.restarts()).toBe(0)
    expect(sb.log().at(-1)).toContain('inside its 600s startup grace')
    expect(sb.log().at(-1)).toContain('no response within 10s')
    // Failures inside the grace are not banked against the unit afterwards.
    expect(sb.state('fail')).toBeNull()
  })

  it('restarts after the grace once the usual consecutive failures accrue', async () => {
    const sb = sandbox()
    sb.box.activeSince = sb.box.uptime
    sb.box.uptime += 600
    sb.box.now += 600

    await sb.run()
    await tick(sb)
    expect(sb.restarts()).toBe(0)
    expect(sb.log().at(-1)).toContain('check 2 of 3 failed')

    await tick(sb)
    expect(sb.restarts()).toBe(1)
    expect(sb.log().at(-1)).toContain(`restarting ${UNIT} (liveness restart 1 in a row)`)
    expect(sb.state('fail')).toBeNull()
  })

  it('takes a configured grace', async () => {
    const sb = sandbox({ startupGraceSeconds: 120, failuresBeforeRestart: 1 })
    sb.box.activeSince = sb.box.uptime
    await tick(sb, 100)
    expect(sb.restarts()).toBe(0)
    await tick(sb, 30)
    expect(sb.restarts()).toBe(1)
  })

  it('measures the grace from the last restart, not the first start', async () => {
    const sb = sandbox({ failuresBeforeRestart: 1 })
    await tick(sb)
    expect(sb.restarts()).toBe(1)

    // systemd resets ActiveEnterTimestamp on restart; the new run is young.
    sb.box.activeSince = sb.box.uptime
    await tick(sb)
    await tick(sb)
    expect(sb.restarts()).toBe(1)
  })

  it('falls back to the plain failure count when systemd cannot say how old the unit is', async () => {
    const sb = sandbox({ failuresBeforeRestart: 1 })
    sb.box.activeSince = 0
    await tick(sb)
    expect(sb.restarts()).toBe(1)
  })
})

describe('restart back-off', () => {
  /** Drive a unit that never answers, restarting it as systemd would. */
  async function restartTimes(sb: ReturnType<typeof sandbox>, ticks: number, seconds: number): Promise<number[]> {
    const times: number[] = []
    const start = sb.box.now
    for (let i = 0; i < ticks; i++) {
      const before = sb.restarts()
      await tick(sb, seconds)
      if (sb.restarts() > before) {
        times.push((sb.box.now - start) / 60)
        sb.box.activeSince = sb.box.uptime
      }
    }
    return times
  }

  it('spaces restarts of a release that never comes back further and further apart', async () => {
    // Five-minute ticks and a 20 minute ceiling keep this to a dozen runs;
    // the default ladder is pinned separately below.
    const sb = sandbox({ startupGraceSeconds: 0, failuresBeforeRestart: 1, maxBackoffSeconds: 1200 })
    const times = await restartTimes(sb, 12, 300)
    const gaps = times.slice(1).map((t, i) => t - times[i])

    expect(times[0]).toBe(5)
    expect(gaps).toEqual([5, 10, 20, 20])
    expect(sb.log().filter(l => l.startsWith('holding off: 3 liveness restart(s) in a row'))).toHaveLength(3)
  })

  it('waits 5, 10, 20, 40, then 60 minutes by default before each further restart', async () => {
    const sb = sandbox()
    const waits: string[] = []
    for (let streak = 1; streak <= 6; streak++) {
      // Two failures already banked and a streak of `streak` restarts, the
      // last one just now: this check is the third failure.
      writeFileSync(join(sb.box.dir, 'run-acme-web-liveness.fail'), '2\n')
      writeFileSync(join(sb.box.dir, 'run-acme-web-liveness.restarts'), `${streak} ${sb.box.now}\n`)
      await sb.run()
      waits.push(sb.log().at(-1)!.match(/next restart allowed in (\d+)s/)![1])
    }
    expect(waits).toEqual(['300', '600', '1200', '2400', '3600', '3600'])
    expect(sb.restarts()).toBe(0)
  })

  it('says how long it is holding off for', async () => {
    const sb = sandbox({ startupGraceSeconds: 0, failuresBeforeRestart: 1 })
    await tick(sb)
    await tick(sb)
    expect(sb.restarts()).toBe(1)
    expect(sb.log().at(-1)).toBe(`holding off: 1 liveness restart(s) in a row have not brought ${UNIT} back; next restart allowed in 240s (no response within 10s on 127.0.0.1:3000/)`)
  })

  it('can be switched off', async () => {
    const sb = sandbox({ startupGraceSeconds: 0, failuresBeforeRestart: 1, maxBackoffSeconds: 0 })
    for (let i = 0; i < 5; i++)
      await tick(sb)
    expect(sb.restarts()).toBe(5)
  })

  it('forgets the streak once the service has answered with no restart for the back-off ceiling', async () => {
    const sb = sandbox({ startupGraceSeconds: 0, failuresBeforeRestart: 1 })
    await tick(sb)
    expect(sb.state('restarts')).not.toBeNull()

    sb.box.curl = 0
    await tick(sb)
    expect(sb.state('restarts')).not.toBeNull()
    await tick(sb, 3600)
    expect(sb.state('restarts')).toBeNull()

    sb.box.curl = 28
    await tick(sb)
    expect(sb.restarts()).toBe(2)
    expect(sb.log().at(-1)).toContain('liveness restart 1 in a row')
  })
})

describe('what counts as alive', () => {
  it('forgets failures on the first answer', async () => {
    const sb = sandbox()
    await tick(sb)
    await tick(sb)
    expect(sb.state('fail')).toBe('2\n')
    sb.box.curl = 0
    await tick(sb)
    expect(sb.state('fail')).toBeNull()
  })

  it('names a refused connection differently from a slow one', async () => {
    const sb = sandbox()
    sb.box.curl = 7
    await tick(sb)
    expect(sb.log().at(-1)).toBe('check 1 of 3 failed on 127.0.0.1:3000/ (connection refused)')
  })

  // Real curl waits out a real 1s --max-time on the silent listener, so this
  // one gets room beyond the 5s default for three real-curl runs under load.
  it('against a real port: an answer is alive, a listener that never answers is not', async () => {
    // Real curl. A server that accepts and then says nothing is what a wedged
    // (or warming) event loop looks like from outside.
    let answer = true
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => answer ? new Response('ok') : new Promise<Response>(() => {}),
    })
    try {
      const sb = sandbox({ port: server.port, timeoutSeconds: 1, startupGraceSeconds: 0 })
      sb.box.curl = null
      await tick(sb)
      expect(sb.log()).toEqual([])

      answer = false
      await tick(sb)
      expect(sb.log().at(-1)).toBe(`check 1 of 3 failed on 127.0.0.1:${server.port}/ (no response within 1s)`)
    }
    finally {
      server.stop(true)
    }

    const closed = sandbox({ port: server.port, startupGraceSeconds: 0 })
    closed.box.curl = null
    await tick(closed)
    expect(closed.log().at(-1)).toBe(`check 1 of 3 failed on 127.0.0.1:${server.port}/ (connection refused)`)
  }, 30_000)
})

describe('the deploy', () => {
  it('starts each release with no failures and no restart streak held against it', () => {
    const joined = buildLivenessUnits({ unitBase: 'acme-web', unitPattern: 'acme-web@*.service', port: 3000 }).join('\n')
    const afterScript = joined.slice(joined.indexOf('\nTS_CLOUD_LIVENESS_EOF\n'))
    expect(afterScript).toContain('rm -f /run/acme-web-liveness.fail /run/acme-web-liveness.restarts')
  })
})
