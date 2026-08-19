import type { RateLimitRule } from './ratelimit'
import type { WafEvent } from './waf'
import { describe, expect, it } from 'bun:test'
import {
  escapeSecLang,
  globToRegex,
  isSafePattern,
  renderWafConfig,
  renderWafInstallScript,
  wafEventTelemetry,
} from './waf'

describe('SecLang escaping', () => {
  it('escapes quotes and backslashes so an argument cannot be ended early', () => {
    expect(escapeSecLang('a"b')).toBe('a\\"b')
    expect(escapeSecLang('a\\b')).toBe('a\\\\b')
  })

  it('flattens newlines so a value cannot become a directive', () => {
    expect(escapeSecLang('safe\nSecRuleEngine Off')).toBe('safe SecRuleEngine Off')
    expect(escapeSecLang('safe\r\nSecRuleEngine Off')).toContain(' SecRuleEngine')
  })

  it('keeps an injected directive inside its argument in a rendered config', () => {
    const { config } = renderWafConfig({
      exclusions: [{ ruleId: 942100, reason: 'legit\nSecRuleEngine Off', pathPattern: '^/x$' }],
    })
    expect(config).not.toMatch(/^SecRuleEngine Off$/m)
  })
})

describe('pattern safety', () => {
  it('rejects nested quantifiers that backtrack catastrophically', () => {
    expect(isSafePattern('(a+)+')).toBe(false)
    expect(isSafePattern('(ab*)*')).toBe(false)
  })

  it('rejects an invalid or oversized regex', () => {
    expect(isSafePattern('([')).toBe(false)
    expect(isSafePattern('a'.repeat(1001))).toBe(false)
  })

  it('accepts an ordinary anchored path pattern', () => {
    expect(isSafePattern('^/api/[^/]*$')).toBe(true)
  })
})

describe('glob conversion', () => {
  it('anchors and distinguishes single- from multi-segment wildcards', () => {
    expect(globToRegex('/api/*')).toBe('^/api/[^/]*$')
    expect(globToRegex('/api/**')).toBe('^/api/.*$')
  })

  it('escapes regex metacharacters in the literal part', () => {
    expect(globToRegex('/a.b')).toBe('^/a\\.b$')
  })
})

describe('config generation', () => {
  it('defaults to detection-only, because the engine is pre-alpha', () => {
    const result = renderWafConfig()
    expect(result.mode).toBe('detection')
    expect(result.config).toContain('SecRuleEngine DetectionOnly')
    expect(result.config).not.toContain('SecRuleEngine On')
  })

  it('emits a single short config when the WAF is off', () => {
    const result = renderWafConfig({ mode: 'off' })
    expect(result.config).toContain('SecRuleEngine Off')
    expect(result.config).not.toContain('SecAuditLog ')
  })

  it('warns loudly when asked to block', () => {
    const result = renderWafConfig({ mode: 'blocking' })
    expect(result.config).toContain('SecRuleEngine On')
    expect(result.warnings.join(' ')).toContain('pre-alpha')
  })

  it('warns when a high paranoia level is combined with blocking', () => {
    const result = renderWafConfig({ mode: 'blocking', paranoiaLevel: 4 })
    expect(result.warnings.join(' ')).toContain('blocks legitimate traffic')
  })

  it('does not warn about paranoia in detection mode, where it is harmless', () => {
    const result = renderWafConfig({ mode: 'detection', paranoiaLevel: 4 })
    expect(result.warnings.join(' ')).not.toContain('blocks legitimate traffic')
  })

  it('rejects an oversized body by default rather than passing it uninspected', () => {
    expect(renderWafConfig().config).toContain('SecRequestBodyLimitAction Reject')
    const permissive = renderWafConfig({ rejectOversizedBody: false })
    expect(permissive.config).toContain('SecRequestBodyLimitAction ProcessPartial')
    expect(permissive.warnings.join(' ')).toContain('bypasses every rule')
  })

  it('writes the configured anomaly thresholds', () => {
    const { config } = renderWafConfig({ inboundThreshold: 10, outboundThreshold: 8, paranoiaLevel: 2 })
    expect(config).toContain('setvar:tx.inbound_anomaly_score_threshold=10')
    expect(config).toContain('setvar:tx.outbound_anomaly_score_threshold=8')
    expect(config).toContain('setvar:tx.paranoia_level=2')
  })

  it('adds the score-based blocking rule only in blocking mode', () => {
    expect(renderWafConfig({ mode: 'blocking' }).config).toContain('id:949110')
    expect(renderWafConfig({ mode: 'detection' }).config).not.toContain('id:949110')
  })

  it('honours a custom block status', () => {
    expect(renderWafConfig({ mode: 'blocking', blockStatus: 429 }).config).toContain('status:429')
  })

  it('warns about every bypass path, because each one is an unguarded route', () => {
    const result = renderWafConfig({ bypassPaths: ['/uploads/**', '/webhooks/*'] })
    expect(result.config).toContain('ctl:ruleEngine=Off')
    expect(result.warnings.join(' ')).toContain('2 path(s) bypass')
  })

  it('neutralizes regex metacharacters in a bypass glob rather than trusting them', () => {
    // Globs are escaped on conversion, so a backtracking pattern in a path is
    // matched literally instead of compiled.
    const result = renderWafConfig({ bypassPaths: ['/(a+)+'] })
    // Escaped twice, and both are needed: once for the regex, once for the
    // SecLang argument, so the engine ends up matching the literal path.
    expect(result.config).toContain(String.raw`@rx ^/\\(a\\+\\)\\+$`)
    expect(result.config).not.toContain('"@rx ^/(a+)+$"')
  })

  it('drops a bypass path too long to compile safely', () => {
    const result = renderWafConfig({ bypassPaths: [`/${'a'.repeat(1200)}`] })
    expect(result.warnings.join(' ')).toContain('unsafe regular expression')
    expect(result.config).not.toContain('aaaa')
  })

  it('drops an exclusion whose raw regex backtracks catastrophically', () => {
    // Unlike a glob, an exclusion pattern is a regex the operator wrote, so it
    // reaches the engine as-is and has to be checked.
    const result = renderWafConfig({
      exclusions: [{ ruleId: 942100, pathPattern: '^/(a+)+$', reason: 'search' }],
    })
    expect(result.warnings.join(' ')).toContain('path pattern is unsafe')
    expect(result.config).not.toContain('(a+)+')
  })

  it('scopes an exclusion to a path when one is given, and globally otherwise', () => {
    const scoped = renderWafConfig({
      exclusions: [{ ruleId: 942100, pathPattern: '^/search', reason: 'Search queries look like SQLi.' }],
    })
    expect(scoped.config).toContain('ctl:ruleRemoveById=942100')
    const global = renderWafConfig({ exclusions: [{ ruleId: 942100, reason: 'Known false positive.' }] })
    expect(global.config).toContain('SecRuleRemoveById 942100')
  })

  it('records the reason for an exclusion in the config', () => {
    const { config } = renderWafConfig({
      exclusions: [{ ruleId: 942100, reason: 'Search queries look like SQLi.' }],
    })
    expect(config).toContain('# Search queries look like SQLi.')
  })

  it('drops an exclusion with a nonsensical rule id', () => {
    const result = renderWafConfig({ exclusions: [{ ruleId: -1, reason: 'oops' }] })
    expect(result.warnings.join(' ')).toContain('not a positive integer')
    expect(result.config).not.toContain('SecRuleRemoveById -1')
  })

  it('is deterministic, so a deploy can skip an unchanged config', () => {
    const options = { mode: 'detection' as const, paranoiaLevel: 2 as const, bypassPaths: ['/a/*'] }
    expect(renderWafConfig(options).config).toBe(renderWafConfig(options).config)
  })
})

describe('rate-limit markers', () => {
  const rules: RateLimitRule[] = [
    { id: 'api-ip', limit: 120, windowMs: 60_000, path: '/api/**', key: { source: 'ip' } },
    { id: 'login', limit: 10, windowMs: 60_000, path: '/auth/login', methods: ['POST'], key: { source: 'ip' } },
  ]

  it('tags rate-limited routes without pretending SecLang can count', () => {
    const { config } = renderWafConfig({}, rules)
    expect(config).toContain("setvar:'tx.ts_cloud_ratelimit=api-ip'")
    expect(config).toContain('counting stays in the ts-cloud limiter')
  })

  it('chains a method condition when the rule has one', () => {
    const { config } = renderWafConfig({}, rules)
    expect(config).toContain('chain')
    expect(config).toContain('SecRule REQUEST_METHOD "@within POST"')
  })

  it('skips a disabled rule', () => {
    const { config } = renderWafConfig({}, [{ ...rules[0], enabled: false }])
    expect(config).not.toContain('api-ip')
  })

  it('reports a rule it cannot express rather than dropping it silently', () => {
    const result = renderWafConfig({}, [{ id: 'by-header', limit: 10, windowMs: 1000, key: { source: 'header' } }])
    expect(result.unmappedRateLimits).toEqual([
      { ruleId: 'by-header', reason: 'The rule keys on a header or cookie but names none.' },
    ])
  })

  it('reports a rule whose path is too long to compile safely', () => {
    const result = renderWafConfig({}, [{ id: 'bad', limit: 10, windowMs: 1000, path: `/${'a'.repeat(1200)}` }])
    expect(result.unmappedRateLimits[0].reason).toContain('unsafe regular expression')
  })
})

describe('install script', () => {
  it('validates before swapping and keeps the old config on failure', () => {
    const script = renderWafInstallScript()
    expect(script).toContain('validate "/etc/ts-cloud/waf.conf.new"')
    expect(script.indexOf('validate')).toBeLessThan(script.indexOf('mv "/etc/ts-cloud/waf.conf.new"'))
    expect(script).toContain('keeping the previous one')
  })

  it('skips cleanly when the binary is not installed', () => {
    expect(renderWafInstallScript()).toContain('is not installed; skipping WAF configuration')
  })

  it('avoids a reload when the rendered config is byte-identical', () => {
    expect(renderWafInstallScript()).toContain('cmp -s')
  })

  it('honours custom binary and config paths', () => {
    const script = renderWafInstallScript({}, [], { binary: '/opt/zig-waf', configPath: '/srv/waf.conf' })
    expect(script).toContain('/opt/zig-waf')
    expect(script).toContain('/srv/waf.conf')
  })
})

describe('event telemetry', () => {
  const events: WafEvent[] = [
    {
      timestamp: '2026-07-16T12:00:00.000Z',
      ruleId: 942100,
      anomalyScore: 5,
      action: 'blocked',
      clientIp: '203.0.113.7',
      method: 'POST',
      path: '/api/search',
      host: 'app.example.com',
      messages: ['SQL injection detected'],
    },
    {
      timestamp: '2026-07-16T12:00:01.000Z',
      anomalyScore: 3,
      action: 'logged',
      clientIp: '203.0.113.8',
      method: 'GET',
      path: '/',
      messages: [],
    },
  ]

  it('names blocked and merely-matched events differently', () => {
    const records = wafEventTelemetry(events, { projectId: 'proj-1' })
    expect(records.map((record) => record.name)).toEqual(['waf.blocked', 'waf.matched'])
  })

  it('keeps the client IP out of the metric stream', () => {
    const records = wafEventTelemetry(events, { projectId: 'proj-1' })
    expect(JSON.stringify(records)).not.toContain('203.0.113.7')
  })

  it('carries the score and rule id for correlation', () => {
    const [record] = wafEventTelemetry(events, { projectId: 'proj-1', environmentId: 'env-1' })
    expect(record.environmentId).toBe('env-1')
    expect((record.attributes as any).ruleId).toBe(942100)
    expect((record.attributes as any).anomalyScore).toBe(5)
  })

  it('bounds the message list so one noisy request cannot bloat a record', () => {
    const noisy: WafEvent = { ...events[0], messages: Array.from({ length: 50 }, (_, index) => `m${index}`) }
    const [record] = wafEventTelemetry([noisy], { projectId: 'proj-1' })
    expect((record.attributes as any).messages).toHaveLength(5)
  })
})
