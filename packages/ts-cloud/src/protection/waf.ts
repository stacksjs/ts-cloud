/**
 * Web application firewall: generating zig-waf configuration.
 *
 * ts-cloud does not implement request inspection itself. `zig-waf` already is
 * that engine - a ModSecurity/Coraza-compatible SecLang implementation with
 * OWASP CRS anomaly scoring, native SQLi detection, and a `validate`
 * subcommand - and a second, worse regex-based inspector living here would be
 * a liability rather than defence in depth.
 *
 * The three layers divide cleanly, and none of them substitutes for another:
 *
 *   - `ddos.ts`  L3/L4. Packet floods, SYN storms, connection exhaustion.
 *                Kernel-level, no idea what HTTP is.
 *   - this file  L7 *content*. Is this request an attack? Injection, traversal,
 *                scanners, protocol abuse. Delegated to zig-waf.
 *   - `ratelimit.ts` L7 *volume*. Is this caller asking for too much? zig-waf
 *                has no rate limiting at all, so this stays in-process.
 *
 * **zig-waf is pre-alpha and says so.** Generated configs therefore default to
 * detection-only: rules evaluate, matches are logged and scored, nothing is
 * blocked. Turning that into enforcement is a deliberate act by an operator
 * who has read their own detection log, not something a deploy does quietly.
 */
import type { RateLimitRule } from './ratelimit'

export type WafMode = 'off' | 'detection' | 'blocking'

/**
 * OWASP CRS paranoia level.
 *
 * 1 is the only level safe to enable unattended: it is tuned for near-zero
 * false positives. Each level above trades precision for recall, and 3-4 will
 * block legitimate traffic on almost any real application until tuned.
 */
export type ParanoiaLevel = 1 | 2 | 3 | 4

export interface WafRuleExclusion {
  /** CRS rule id to disable. */
  ruleId: number
  /** Only for requests to paths matching this regex. Omit to disable globally. */
  pathPattern?: string
  /** Why, so the exclusion can be reviewed rather than inherited forever. */
  reason: string
}

export interface WafConfig {
  mode?: WafMode
  paranoiaLevel?: ParanoiaLevel
  /**
   * Inbound anomaly score at which a request is blocked, when mode is
   * `blocking`. The CRS default is 5, which one critical-severity match
   * reaches on its own.
   */
  inboundThreshold?: number
  /** Outbound score threshold, guarding against data leaking back out. */
  outboundThreshold?: number
  /** Largest request body inspected, in bytes. Beyond it, see `rejectOversizedBody`. */
  maxBodyBytes?: number
  /**
   * Reject a body too large to inspect, rather than passing it through
   * unexamined. Defaults to true: an attacker who can opt out of inspection by
   * padding a request has defeated the WAF.
   */
  rejectOversizedBody?: boolean
  /** Paths never inspected, e.g. a large upload endpoint. Each one is a hole. */
  bypassPaths?: string[]
  exclusions?: WafRuleExclusion[]
  /** Extra SecLang appended verbatim, for rules ts-cloud has no model for. */
  customRules?: string[]
  /** Where the engine writes its audit log. */
  auditLogPath?: string
  /**
   * Audit record format. Unset keeps the engine default (native serial). Forwarding to Guardian
   * switches it to OCSF, one JSON event per line, unless set explicitly.
   */
  auditFormat?: WafAuditFormat
  /** Ship audit events to a Guardian ingest endpoint. The local log stays as the fallback. */
  forward?: WafAuditForwarding
  /** Status returned to a blocked request. */
  blockStatus?: number
}

export type WafAuditFormat = 'Native' | 'JSON' | 'LegacyJSON' | 'OCSF'

/**
 * Where audit events are shipped.
 *
 * zig-waf only accepts credential-free URLs for remote endpoints, so the engine never holds the
 * token: it writes records to the local audit log, and a root-only systemd timer sends each new
 * whole line to `url` with `Authorization: Bearer <token>`. If the endpoint is down the log keeps
 * everything and the next run resumes from where the last accepted batch ended.
 */
export interface WafAuditForwarding {
  /** Guardian ingest URL. Must be https and carry no credentials. */
  url: string
  /** Per-host ingest token. Written to a 0600 file on the box, never into the WAF config. */
  token: string
  /** Seconds between shipments. @default 30 */
  intervalSeconds?: number
}

const DEFAULTS = {
  mode: 'detection' as WafMode,
  paranoiaLevel: 1 as ParanoiaLevel,
  inboundThreshold: 5,
  outboundThreshold: 4,
  maxBodyBytes: 13_107_200,
  rejectOversizedBody: true,
  auditLogPath: '/var/log/ts-cloud/waf-audit.log',
  blockStatus: 403,
}

/** Rule ids ts-cloud generates, kept out of the CRS range (900000+). */
const RULE_IDS = {
  bypassBase: 100_000,
  exclusionBase: 101_000,
  rateLimitBase: 102_000,
  customBase: 109_000,
}

/**
 * Escape a value for a SecLang double-quoted argument.
 *
 * Config text is assembled from operator input (paths, patterns, reasons); an
 * unescaped quote or newline ends the argument early and everything after it
 * becomes directives. That is config injection, and it is the one way a WAF
 * config file can make a system less safe than having none.
 */
export function escapeSecLang(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')
}

/**
 * Whether a regex is safe to hand to the engine.
 *
 * Rejects nested quantifiers, the classic catastrophic-backtracking shape.
 * A rule that hangs on one crafted request is an outage with extra steps.
 */
export function isSafePattern(pattern: string): boolean {
  if (pattern.length > 1000) return false
  if (/\([^)]*[+*]\)[+*]/.test(pattern)) return false
  if (/\[[^\]]*\][+*]\{/.test(pattern)) return false
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

export interface WafGenerationResult {
  config: string
  /** Rate-limit rules that could not be expressed in SecLang, with the reason. */
  unmappedRateLimits: Array<{ ruleId: string; reason: string }>
  warnings: string[]
  mode: WafMode
}

/**
 * Translate ts-cloud rate-limit rules into SecLang *matchers*.
 *
 * Only the matching half translates. SecLang has no token bucket and no
 * sliding window, so what lands in the config is a marker rule that tags a
 * request as belonging to a rate-limited route; the counting still happens in
 * `ratelimit.ts`. Rules whose key is not derivable from the request alone
 * cannot be tagged at all and are reported rather than dropped - a rate limit
 * that silently stops existing is exactly the failure this whole module is
 * meant to prevent.
 */
function rateLimitMarkers(
  rules: readonly RateLimitRule[],
  startId: number,
): { lines: string[]; unmapped: Array<{ ruleId: string; reason: string }> } {
  const lines: string[] = []
  const unmapped: Array<{ ruleId: string; reason: string }> = []
  let id = startId
  for (const rule of rules) {
    if (rule.enabled === false) continue
    if (rule.key && (rule.key.source === 'cookie' || rule.key.source === 'header') && !rule.key.name) {
      unmapped.push({ ruleId: rule.id, reason: 'The rule keys on a header or cookie but names none.' })
      continue
    }
    const pattern = rule.path ? globToRegex(rule.path) : '.*'
    if (!isSafePattern(pattern)) {
      unmapped.push({ ruleId: rule.id, reason: 'The path pattern compiles to an unsafe regular expression.' })
      continue
    }
    const conditions = [`SecRule REQUEST_URI "@rx ${escapeSecLang(pattern)}"`]
    if (rule.methods?.length)
      conditions.push(`  "chain,id:${id},phase:1,pass,nolog,setvar:'tx.ts_cloud_ratelimit=${escapeSecLang(rule.id)}'"`)
    else conditions.push(`  "id:${id},phase:1,pass,nolog,setvar:'tx.ts_cloud_ratelimit=${escapeSecLang(rule.id)}'"`)
    lines.push(`# Marks requests governed by the ts-cloud rate limit "${escapeSecLang(rule.id)}".`)
    lines.push(conditions.join(' \\\n'))
    if (rule.methods?.length)
      lines.push(`  SecRule REQUEST_METHOD "@within ${escapeSecLang(rule.methods.join(' ').toUpperCase())}" "t:none"`)
    lines.push('')
    id++
  }
  return { lines, unmapped }
}

/** Convert a ratelimit glob into an anchored regex for SecLang's `@rx`. */
export function globToRegex(glob: string): string {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '.*')
  return `^${escaped}$`
}

/**
 * Render a complete SecLang configuration.
 *
 * The output is deterministic - same input, same bytes - so a deploy can
 * compare it against what is already on the box and skip a reload when
 * nothing changed.
 */
/** Why a forwarding target was refused, or null when it is usable. */
export function wafForwardingProblem(forward: WafAuditForwarding): string | null {
  let url: URL
  try {
    url = new URL(forward.url)
  }
  catch {
    return 'its URL is not a valid URL'
  }
  if (url.protocol !== 'https:') return 'its URL is not https'
  if (url.username || url.password) return 'its URL carries credentials'
  if (/[\s'"`$\\]/.test(forward.url)) return 'its URL contains characters that are not safe in a shell file'
  if (!/^[\w.~+/=-]{16,512}$/.test(forward.token)) return 'its token is not 16 to 512 URL-safe characters'
  const interval = forward.intervalSeconds ?? 30
  if (!Number.isInteger(interval) || interval < 5 || interval > 3600) return 'its interval is not 5 to 3600 seconds'
  return null
}

function auditFormatLines(config: WafConfig): string[] {
  const format = config.auditFormat ?? (config.forward ? 'OCSF' : undefined)
  return format ? [`SecAuditLogFormat ${format}`] : []
}

export function renderWafConfig(config: WafConfig = {}, rateLimits: readonly RateLimitRule[] = []): WafGenerationResult {
  const mode = config.mode ?? DEFAULTS.mode
  const warnings: string[] = []
  const paranoia = config.paranoiaLevel ?? DEFAULTS.paranoiaLevel
  const inbound = config.inboundThreshold ?? DEFAULTS.inboundThreshold
  const outbound = config.outboundThreshold ?? DEFAULTS.outboundThreshold
  const maxBody = config.maxBodyBytes ?? DEFAULTS.maxBodyBytes
  const rejectOversized = config.rejectOversizedBody !== false

  if (mode === 'blocking' && paranoia >= 3)
    warnings.push(
      `Paranoia level ${paranoia} blocks legitimate traffic on most applications until it is tuned. Run it in detection mode first.`,
    )
  if (mode === 'blocking')
    warnings.push('zig-waf is pre-alpha. Blocking mode makes it a failure path for every request.')
  if (!rejectOversized)
    warnings.push('Oversized bodies are passed through uninspected, so padding a request bypasses every rule.')
  if (config.bypassPaths?.length)
    warnings.push(`${config.bypassPaths.length} path(s) bypass inspection entirely.`)
  if (config.forward) {
    const problem = wafForwardingProblem(config.forward)
    if (problem) warnings.push(`Audit forwarding was not configured: ${problem}.`)
  }

  const lines: string[] = [
    '# Managed by ts-cloud. Edits are overwritten on the next deploy.',
    `# Mode: ${mode}. Paranoia level: ${paranoia}.`,
    '',
  ]

  if (mode === 'off') {
    lines.push('SecRuleEngine Off', '')
    return { config: `${lines.join('\n')}\n`, unmappedRateLimits: [], warnings, mode }
  }

  lines.push(
    `SecRuleEngine ${mode === 'blocking' ? 'On' : 'DetectionOnly'}`,
    'SecRequestBodyAccess On',
    'SecResponseBodyAccess Off',
    `SecRequestBodyLimit ${maxBody}`,
    `SecRequestBodyNoFilesLimit ${Math.min(maxBody, 131_072)}`,
    // Reject rather than ProcessPartial: partial inspection of a body an
    // attacker controls the length of is inspection they can opt out of.
    `SecRequestBodyLimitAction ${rejectOversized ? 'Reject' : 'ProcessPartial'}`,
    'SecRequestBodyInMemoryLimit 131072',
    `SecAuditEngine ${mode === 'blocking' ? 'RelevantOnly' : 'On'}`,
    'SecAuditLogParts ABIJDEFHZ',
    `SecAuditLog ${escapeSecLang(config.auditLogPath ?? DEFAULTS.auditLogPath)}`,
    'SecAuditLogType Serial',
    ...auditFormatLines(config),
    `SecDefaultAction "phase:1,log,auditlog,${mode === 'blocking' ? `deny,status:${config.blockStatus ?? DEFAULTS.blockStatus}` : 'pass'}"`,
    '',
    '# CRS anomaly scoring setup.',
    `SecAction "id:900000,phase:1,pass,nolog,t:none,setvar:tx.paranoia_level=${paranoia}"`,
    `SecAction "id:900001,phase:1,pass,nolog,t:none,setvar:tx.inbound_anomaly_score_threshold=${inbound}"`,
    `SecAction "id:900002,phase:1,pass,nolog,t:none,setvar:tx.outbound_anomaly_score_threshold=${outbound}"`,
    'SecAction "id:900003,phase:1,pass,nolog,t:none,setvar:tx.critical_anomaly_score=5,setvar:tx.error_anomaly_score=4,setvar:tx.warning_anomaly_score=3,setvar:tx.notice_anomaly_score=2"',
    'SecAction "id:900004,phase:1,pass,nolog,t:none,setvar:tx.anomaly_score=0"',
    '',
  )

  let bypassId = RULE_IDS.bypassBase
  for (const path of config.bypassPaths ?? []) {
    const pattern = globToRegex(path)
    if (!isSafePattern(pattern)) {
      warnings.push(`Bypass path "${path}" was dropped: it compiles to an unsafe regular expression.`)
      continue
    }
    lines.push(
      `# Inspection bypass for ${escapeSecLang(path)}. Every bypass is an unguarded route.`,
      `SecRule REQUEST_URI "@rx ${escapeSecLang(pattern)}" "id:${bypassId},phase:1,pass,nolog,ctl:ruleEngine=Off"`,
      '',
    )
    bypassId++
  }

  let exclusionId = RULE_IDS.exclusionBase
  for (const exclusion of config.exclusions ?? []) {
    if (!Number.isInteger(exclusion.ruleId) || exclusion.ruleId <= 0) {
      warnings.push(`Exclusion with rule id "${exclusion.ruleId}" was dropped: the id is not a positive integer.`)
      continue
    }
    lines.push(`# ${escapeSecLang(exclusion.reason)}`)
    if (exclusion.pathPattern) {
      if (!isSafePattern(exclusion.pathPattern)) {
        warnings.push(`Exclusion for rule ${exclusion.ruleId} was dropped: its path pattern is unsafe.`)
        continue
      }
      lines.push(
        `SecRule REQUEST_URI "@rx ${escapeSecLang(exclusion.pathPattern)}" "id:${exclusionId},phase:1,pass,nolog,ctl:ruleRemoveById=${exclusion.ruleId}"`,
      )
      exclusionId++
    } else {
      lines.push(`SecRuleRemoveById ${exclusion.ruleId}`)
    }
    lines.push('')
  }

  const markers = rateLimitMarkers(rateLimits, RULE_IDS.rateLimitBase)
  if (markers.lines.length > 0) {
    lines.push(
      '# Rate-limit route markers. SecLang has no counters, so the tag is set',
      '# here and the counting stays in the ts-cloud limiter.',
      ...markers.lines,
    )
  }

  let customId = RULE_IDS.customBase
  for (const rule of config.customRules ?? []) {
    lines.push(`# Operator-supplied rule ${customId}.`, rule.trim(), '')
    customId++
  }

  if (mode === 'blocking')
    lines.push(
      '# Blocking decision: one rule, at the end, on the accumulated score.',
      `SecRule TX:ANOMALY_SCORE "@ge %{tx.inbound_anomaly_score_threshold}" "id:949110,phase:2,deny,status:${config.blockStatus ?? DEFAULTS.blockStatus},log,msg:'Inbound anomaly score exceeded (total: %{tx.anomaly_score})'"`,
      '',
    )

  return { config: `${lines.join('\n')}\n`, unmappedRateLimits: markers.unmapped, warnings, mode }
}

/**
 * Install script for the generated config.
 *
 * `zig-waf validate` runs before anything is swapped in, for the same reason
 * `nft -c` does in `ddos.ts`: a config that fails to compile would otherwise
 * leave the engine with no rules, and a WAF that silently stopped inspecting
 * is worse than one that was never installed - the dashboard still says it is on.
 */
export function renderWafInstallScript(
  config: WafConfig = {},
  rateLimits: readonly RateLimitRule[] = [],
  options: { binary?: string; configPath?: string } = {},
): string {
  const binary = options.binary ?? '/usr/local/bin/zig-waf'
  const configPath = options.configPath ?? '/etc/ts-cloud/waf.conf'
  const auditLog = config.auditLogPath ?? DEFAULTS.auditLogPath
  const rendered = renderWafConfig(config, rateLimits)
  const forward = config.forward && !wafForwardingProblem(config.forward) ? config.forward : undefined
  return `#!/usr/bin/env bash
# Managed by ts-cloud. Installs the zig-waf ruleset.
set -euo pipefail

if [ ! -x "${binary}" ]; then
  echo "ts-cloud: ${binary} is not installed; skipping WAF configuration" >&2
  exit 0
fi

install -d -m 0755 "$(dirname "${configPath}")"
install -d -m 0750 "$(dirname "${auditLog}")"

cat > "${configPath}.new" <<'WAF_EOF'
${rendered.config}WAF_EOF

# Compile the config before it goes live. A config that does not validate
# would leave the engine with no rules while still reporting itself enabled.
if ! "${binary}" validate "${configPath}.new"; then
  echo "ts-cloud: generated WAF config failed validation, keeping the previous one" >&2
  rm -f "${configPath}.new"
  exit 1
fi

if [ -f "${configPath}" ] && cmp -s "${configPath}.new" "${configPath}"; then
  rm -f "${configPath}.new"
  echo "ts-cloud: WAF config unchanged"
else
  mv "${configPath}.new" "${configPath}"
  echo "ts-cloud: WAF config installed (mode: ${rendered.mode})"
fi

${renderAuditRotation(auditLog)}
${forward ? renderAuditForwarder(auditLog, forward) : renderAuditForwarderRemoval()}
`
}

/** The local audit log is the fallback when forwarding is off or down, so it is always rotated. */
function renderAuditRotation(auditLog: string): string {
  return `# Rotate the audit log. copytruncate keeps the engine's open file handle valid.
cat > /etc/logrotate.d/ts-cloud-waf <<'ROTATE_EOF'
${auditLog} {
  daily
  maxsize 100M
  rotate 14
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
}
ROTATE_EOF`
}

const FORWARD_UNIT = 'ts-cloud-waf-forward'

/**
 * Ships new whole lines of the audit log to Guardian. State is "<inode> <offset>": a rotated or
 * truncated log starts again from zero, a failed POST leaves the offset alone so the batch is
 * retried, and a batch never ends mid-record.
 */
function renderAuditForwarder(auditLog: string, forward: WafAuditForwarding): string {
  const interval = forward.intervalSeconds ?? 30
  return `# Forward audit events to Guardian.
install -d -m 0755 /usr/local/lib/ts-cloud /var/lib/ts-cloud
umask 077
cat > /etc/ts-cloud/waf-forward.env <<'FORWARD_ENV_EOF'
GUARDIAN_URL='${forward.url}'
GUARDIAN_TOKEN='${forward.token}'
FORWARD_ENV_EOF
chmod 0600 /etc/ts-cloud/waf-forward.env
umask 022

cat > /usr/local/lib/ts-cloud/waf-forward.sh <<'FORWARD_SH_EOF'
#!/usr/bin/env bash
set -euo pipefail
. /etc/ts-cloud/waf-forward.env
log='${auditLog}'
state=/var/lib/ts-cloud/waf-forward.state
max_batch=5242880
[ -f "$log" ] || exit 0
inode=$(stat -c %i "$log")
size=$(stat -c %s "$log")
last_inode=""
last_offset=0
last_head=0
if [ -f "$state" ]; then read -r last_inode last_offset last_head < "$state" || true; fi
# The first bytes fingerprint the file: copytruncate keeps the inode, so a log truncated and
# refilled past the old offset is only recognisable by its content.
head_len=$(( last_offset < 256 ? last_offset : 256 ))
head_now=0
if [ "$head_len" -gt 0 ]; then head_now=$(head -c "$head_len" "$log" | cksum | cut -d' ' -f1); fi
if [ "$inode" != "$last_inode" ] || [ "$size" -lt "$last_offset" ] || [ "$head_now" != "$last_head" ]; then last_offset=0; fi
[ "$size" -gt "$last_offset" ] || exit 0
want=$(( size - last_offset ))
[ "$want" -gt "$max_batch" ] && want=$max_batch
batch=$(mktemp)
trap 'rm -f "$batch"' EXIT
tail -c +$(( last_offset + 1 )) "$log" | head -c "$want" > "$batch"
keep=$(stat -c %s "$batch")
if [ "$(tail -c 1 "$batch" | od -An -tx1 | tr -d ' \\n')" != "0a" ]; then
  keep=$(( keep - $(tail -n 1 "$batch" | wc -c) ))
fi
[ "$keep" -gt 0 ] || exit 0
truncate -s "$keep" "$batch"
curl -fsS --max-time 20 --retry 2 \\
  -H "Authorization: Bearer $GUARDIAN_TOKEN" \\
  -H 'Content-Type: application/x-ndjson' \\
  --data-binary @"$batch" "$GUARDIAN_URL" > /dev/null
new_offset=$(( last_offset + keep ))
new_head=$(head -c $(( new_offset < 256 ? new_offset : 256 )) "$log" | cksum | cut -d' ' -f1)
echo "$inode $new_offset $new_head" > "$state"
FORWARD_SH_EOF
chmod 0700 /usr/local/lib/ts-cloud/waf-forward.sh

cat > /etc/systemd/system/${FORWARD_UNIT}.service <<'FORWARD_SVC_EOF'
[Unit]
Description=Ship zig-waf audit events to Guardian
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/lib/ts-cloud/waf-forward.sh
Nice=10
FORWARD_SVC_EOF

cat > /etc/systemd/system/${FORWARD_UNIT}.timer <<'FORWARD_TIMER_EOF'
[Unit]
Description=Ship zig-waf audit events to Guardian every ${interval}s

[Timer]
OnBootSec=${interval}
OnUnitActiveSec=${interval}
AccuracySec=5

[Install]
WantedBy=timers.target
FORWARD_TIMER_EOF

systemctl daemon-reload
systemctl enable --now ${FORWARD_UNIT}.timer
echo "ts-cloud: WAF audit forwarding to Guardian enabled"`
}

/** Forwarding switched off: stop shipping and remove the token from the box. */
function renderAuditForwarderRemoval(): string {
  return `# Audit forwarding is not configured: make sure nothing is left shipping.
if [ -f /etc/systemd/system/${FORWARD_UNIT}.timer ]; then
  systemctl disable --now ${FORWARD_UNIT}.timer || true
  rm -f /etc/systemd/system/${FORWARD_UNIT}.timer /etc/systemd/system/${FORWARD_UNIT}.service
  systemctl daemon-reload
fi
rm -f /etc/ts-cloud/waf-forward.env /usr/local/lib/ts-cloud/waf-forward.sh`
}

/**
 * A WAF audit event, normalized for the telemetry pipeline.
 *
 * Blocked requests are a spend signal as much as a security one: a scraper
 * that the WAF stops still consumed the bandwidth to be stopped, and a sudden
 * rise in blocks is often the first visible symptom of an attack that is about
 * to show up on the bill.
 */
export interface WafEvent {
  timestamp: string
  ruleId?: number
  anomalyScore: number
  action: 'passed' | 'logged' | 'blocked'
  clientIp: string
  method: string
  path: string
  host?: string
  messages: string[]
}

/** Telemetry records for a batch of WAF events, ready for the spend meter. */
export function wafEventTelemetry(
  events: readonly WafEvent[],
  scope: { projectId: string; environmentId?: string; resourceId?: string },
): Array<Record<string, unknown>> {
  return events.map((event) => ({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    resourceId: scope.resourceId,
    kind: 'event' as const,
    source: 'zig-waf',
    name: event.action === 'blocked' ? 'waf.blocked' : 'waf.matched',
    timestamp: event.timestamp,
    value: 1,
    host: event.host,
    pathTemplate: event.path,
    method: event.method,
    attributes: {
      ruleId: event.ruleId ?? null,
      anomalyScore: event.anomalyScore,
      action: event.action,
      // The client IP is deliberately not recorded here. It is personal data
      // under GDPR, the audit log already has it for incident response, and
      // the metric only needs counts.
      messages: event.messages.slice(0, 5),
    },
  }))
}
