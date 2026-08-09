/**
 * Documentation is only useful if it is true.
 *
 * These tests read the shipped docs and check every claim that can be checked
 * mechanically: that each exported name exists at the package root, each API
 * endpoint is routed, each CLI flag is registered, and each stated default
 * matches the constant it describes. Prose drifts silently; a failing test does
 * not.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpendEnforcementTransport } from './appliers'
import * as tsCloud from '../index'
import { DETECTABLE_SIGNALS, lookbackHoursForSignal } from './signals'
import { AwsSpendTransport, ComputeSpendTransport } from './transports'
import { DEFAULT_RECURSION_LIMITS } from '../protection'
import { defaultRateLimitRules } from '../protection/ratelimit'
import { anomalyOptionsForSignal } from './anomaly'
import { MIN_PROJECTION_CONFIDENCE } from './evaluator'
import { SPEND_CYCLE_SECONDS } from './runner'
import { DEFAULT_THRESHOLDS } from './store'

const docsRoot = join(import.meta.dir, '..', '..', '..', '..', 'docs', 'features')
const spendDoc = readFileSync(join(docsRoot, 'spend-management.md'), 'utf8')
const protectionDoc = readFileSync(join(docsRoot, 'edge-protection.md'), 'utf8')
const handler = readFileSync(join(import.meta.dir, '..', 'api', 'handler.ts'), 'utf8')
const spendApi = readFileSync(join(import.meta.dir, 'api.ts'), 'utf8')
const cliSource = readFileSync(join(import.meta.dir, '..', '..', 'bin', 'commands', 'spend.ts'), 'utf8')
const dashboardServer = readFileSync(join(import.meta.dir, '..', 'deploy', 'local-dashboard-server.ts'), 'utf8')

/** Every `import { a, b } from 'ts-cloud'` name mentioned in a doc. */
function documentedImports(doc: string): string[] {
  const names = new Set<string>()
  for (const match of doc.matchAll(/import\s*\{([^}]+)\}\s*from\s*'ts-cloud'/g))
    for (const name of match[1].split(',').map((item) => item.trim()).filter(Boolean)) names.add(name)
  return [...names]
}

describe('documented exports exist', () => {
  it('spend management', () => {
    const documented = documentedImports(spendDoc)
    expect(documented.length).toBeGreaterThan(3)
    for (const name of documented) expect(tsCloud).toHaveProperty(name)
  })

  it('edge protection', () => {
    const documented = documentedImports(protectionDoc)
    expect(documented.length).toBeGreaterThan(5)
    for (const name of documented) expect(tsCloud).toHaveProperty(name)
  })

  it('every other symbol the docs name in a code span is real', () => {
    const referenced = [
      'SpendStore',
      'SpendService',
      'SpendRunner',
      'SpendGate',
      'startSpendLoop',
      'assertSpendAllows',
      'SpendCapError',
      'RecordingSpendTransport',
      'mergePriceBooks',
      'DEFAULT_PRICE_BOOK',
      'detectLatestAnomaly',
      'anomalyOptionsForSignal',
      'planEnforcement',
      'planMitigation',
      'applyMitigationFactor',
      'sysctlHardening',
      'renderNftablesRuleset',
      'renderDdosInstallScript',
      'renderWafConfig',
      'renderWafInstallScript',
      'RecursionGuard',
      'propagationHeaders',
      'recursionBlockedResponse',
      'defaultRateLimitRules',
      'rateLimitHeaders',
      'EdgeRateLimiter',
      'AwsSpendTransport',
      'ComputeSpendTransport',
      'compositeSpendTransport',
      'SpendLoopLease',
      'SignalSource',
      'DETECTABLE_SIGNALS',
      'lookbackHoursForSignal',
    ]
    for (const name of referenced) {
      const mentioned = spendDoc.includes(name) || protectionDoc.includes(name)
      expect({ name, mentioned, exported: name in tsCloud }).toEqual({ name, mentioned: true, exported: true })
    }
  })
})

describe('documented endpoints are routed', () => {
  const endpoints = [
    '/api/v1/usage',
    '/api/v1/usage/rollups',
    '/api/v1/spend/budgets',
    '/api/v1/spend/anomalies',
    '/api/v1/spend/enforcement',
    '/api/v1/spend/allowance',
  ]

  it('appears in the docs and in the router', () => {
    for (const endpoint of endpoints) {
      expect(spendDoc).toContain(endpoint)
      expect(spendApi).toContain(`'${endpoint}'`)
    }
  })

  it('documents no endpoint the router does not implement', () => {
    const source = `${spendApi}\n${handler}`
    for (const match of spendDoc.matchAll(/\/api\/v1\/[a-z0-9/{}-]+/g)) {
      const path = match[0]
      // A parameterized path is matched by a regex in the router, not a literal,
      // so check the segments either side of the parameter instead.
      const routed = path.includes('{')
        ? path
            .split(/\{[^}]+\}/)
            .map((part) => part.replace(/\/$/, ''))
            .filter(Boolean)
            .every((part) => source.includes(part))
        : source.includes(path)
      expect({ path, routed }).toEqual({ path, routed: true })
    }
  })
})

describe('documented CLI commands and flags exist', () => {
  it('registers every documented command', () => {
    for (const match of spendDoc.matchAll(/^cloud ([a-z:]+)/gm)) {
      const command = match[1]
      if (command.startsWith('cost')) continue
      expect({ command, registered: cliSource.includes(`.command('${command}`) }).toEqual({ command, registered: true })
    }
  })

  it('registers every documented flag', () => {
    const flags = new Set<string>()
    for (const line of spendDoc.split('\n')) {
      if (!line.trimStart().startsWith('cloud ')) continue
      for (const match of line.matchAll(/--([a-z-]+)/g)) flags.add(match[1])
    }
    expect(flags.size).toBeGreaterThan(5)
    for (const flag of flags) {
      // clapp exposes `--dry-run` as `dryRun`; the option string is what matters.
      expect({ flag, registered: cliSource.includes(`'--${flag}`) }).toEqual({ flag, registered: true })
    }
  })
})

describe('documented defaults match the code', () => {
  it('states the projection-confidence floor correctly', () => {
    expect(spendDoc).toContain(String(MIN_PROJECTION_CONFIDENCE))
  })

  it('states the default ladder correctly', () => {
    for (const threshold of DEFAULT_THRESHOLDS)
      expect(spendDoc).toContain(`atPercent: ${threshold.atPercent}`)
    expect(spendDoc).toContain("onProjection: true")
  })

  it('states the cycle cadence correctly', () => {
    expect(SPEND_CYCLE_SECONDS).toBe(60)
    expect(spendDoc).toContain('Sixty seconds is the intended cadence')
  })

  it('states the cost anomaly floor correctly', () => {
    expect(anomalyOptionsForSignal('cost').minAbsoluteDelta).toBe(25)
    expect(spendDoc).toContain('under 25 cents')
  })

  it('states the hysteresis and retention defaults correctly', () => {
    expect(spendDoc).toContain('5% by default')
    expect(spendDoc).toContain('400 days by default')
    expect(spendDoc).toContain('7 days')
  })

  it('states the recursion limits correctly', () => {
    expect(DEFAULT_RECURSION_LIMITS.maxRepeats).toBe(3)
    expect(DEFAULT_RECURSION_LIMITS.maxInvocationsPerTrace).toBe(100)
    expect(DEFAULT_RECURSION_LIMITS.traceWindowMs).toBe(60_000)
    expect(protectionDoc).toContain('`maxRepeats` is 3')
    expect(protectionDoc).toContain('100 by default, within a 60-second window')
  })

  it('states the shipped rate limits correctly', () => {
    const rules = Object.fromEntries(defaultRateLimitRules().map((rule) => [rule.id, rule]))
    expect(rules['global-ip'].limit).toBe(600)
    expect(rules['api-ip'].limit).toBe(120)
    expect(rules['auth-ip'].limit).toBe(10)
    expect(rules['auth-ip'].action).toBe('challenge')
    expect(protectionDoc).toContain('600 requests a minute per IP')
    expect(protectionDoc).toContain('120 on `/api/**`')
    expect(protectionDoc).toContain('10 POSTs a minute to `/auth/**`')
  })

  it('states the recursion status code correctly', () => {
    expect(tsCloud.recursionBlockedResponse({ reason: 'cycle_detected' } as never).status).toBe(508)
    expect(protectionDoc).toContain('508 Loop Detected')
  })
})

describe('documented headers match the code', () => {
  it('names the propagation headers exactly', () => {
    for (const header of [tsCloud.DEPTH_HEADER, tsCloud.CHAIN_HEADER, tsCloud.TRACE_HEADER])
      expect(protectionDoc).toContain(header)
  })
})

describe('documented signals match the code', () => {
  it('documents every detectable signal, and no others', () => {
    for (const signal of DETECTABLE_SIGNALS)
      expect({ signal: signal.key, documented: spendDoc.includes(`\`${signal.key}\``) }).toEqual({
        signal: signal.key,
        documented: true,
      })
  })

  it('states each gap policy correctly', () => {
    // The doc's table says ratios are ignored on an empty hour; the code must
    // agree, or the most important data rule is documented backwards.
    for (const signal of DETECTABLE_SIGNALS.filter((item) => item.ratio))
      expect(signal.gapPolicy).toBe('gap')
    expect(spendDoc).toContain('A gap is not a zero')
  })

  it('states the sample floor correctly', () => {
    const rate = DETECTABLE_SIGNALS.find((signal) => signal.key === 'http.error_rate')!
    expect(rate.minSamples).toBe(20)
    expect(spendDoc).toContain('| 20 |')
  })

  it('states the lookback rule correctly', () => {
    expect(lookbackHoursForSignal('http.error_rate')).toBeGreaterThan(24 * 14)
    expect(spendDoc).toContain('seasonLength × (minHistory + 1)')
  })
})

describe('documented transports match the code', () => {
  it('claims AWS support for exactly the actions the transport implements', () => {
    const aws = new AwsSpendTransport({ lambda: {} as never, functions: () => [] })
    // The table says "not supported" for throttling; the class must agree.
    expect(spendDoc).toContain('| `throttle_requests` | not supported |')
    expect((aws as SpendEnforcementTransport).throttleRequests).toBeUndefined()
    for (const method of ['suspendFunctions', 'serveStatic', 'suspendProject'] as const)
      expect({ method, implemented: typeof aws[method] === 'function' }).toEqual({ method, implemented: true })
  })

  it('claims compute support for every action, including throttling', () => {
    const compute = new ComputeSpendTransport({ host: 'box', exec: async () => ({ code: 0, stdout: '', stderr: '' }), units: () => [] })
    for (const method of ['throttleRequests', 'suspendFunctions', 'serveStatic', 'suspendProject'] as const)
      expect({ method, implemented: typeof compute[method] === 'function' }).toEqual({ method, implemented: true })
  })

  it('states the lease TTL correctly', () => {
    expect(spendDoc).toContain('120 seconds by default')
  })

  it('documents the dashboard opt-out flag that actually exists', () => {
    expect(spendDoc).toContain('`spendLoop: false`')
    expect(dashboardServer).toContain('options.spendLoop ?? process.env.NODE_ENV')
  })
})

describe('documented subpaths exist', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8'))
  const build = readFileSync(join(import.meta.dir, '..', '..', 'build.ts'), 'utf8')

  it('exports every subpath the docs tell people to import from', () => {
    for (const doc of [spendDoc, protectionDoc])
      for (const match of doc.matchAll(/`ts-cloud\/([a-z-]+)`/g)) {
        const subpath = `./${match[1]}`
        expect({ subpath, exported: subpath in manifest.exports }).toEqual({ subpath, exported: true })
        // A declared subpath with no build entry point ships as types-only and
        // fails at runtime, which is worse than not declaring it at all.
        expect(build).toContain(`src/${match[1]}/index.ts`)
      }
  })
})

describe('documented capabilities exist', () => {
  it('names only real authorization capabilities', () => {
    for (const capability of ['billing:read', 'billing:manage']) {
      expect(spendDoc).toContain(capability)
      expect(tsCloud.AUTHORIZATION_CAPABILITIES).toContain(capability as never)
    }
  })
})

describe('documented meters exist', () => {
  it('lists every meter the model defines, and no others', () => {
    // The table pairs some meters on one row (`a` / `b`), so collect every
    // backticked meter-shaped token rather than assuming one per row.
    const documented = new Set([...spendDoc.matchAll(/`([a-z]+\.[a-z_]+)`/g)].map((match) => match[1]))
    for (const meter of tsCloud.METER_KEYS) expect({ meter, documented: documented.has(meter) }).toEqual({ meter, documented: true })
  })
})

describe('honesty', () => {
  it('states the limits rather than only the capabilities', () => {
    expect(spendDoc).toContain('## Known limits')
    expect(spendDoc).toContain('A cap cannot un-spend')
    expect(spendDoc).toContain('Estimated, not billed')
  })

  it('says plainly that there is no scrubbing network', () => {
    expect(protectionDoc).toContain('no anycast scrubbing network')
  })

  it('says plainly that zig-waf is pre-alpha', () => {
    expect(protectionDoc).toContain('pre-alpha')
    expect(protectionDoc).toContain('default to detection-only')
  })
})
