/**
 * Certificate coverage check for the rpx gateway.
 *
 * The gateway serves every hostname in every `sites.d/<slug>.json`. A
 * certificate is renewed only for the hostnames some project's
 * `renew-certs-<slug>.sh` names. Nothing made those two sets agree, and when
 * they drift the failure is silent for up to ninety days and then total: a
 * site file left behind by a renamed project kept routing three hostnames
 * that no renewal script listed, their certificates ran out, and every
 * browser refused the site for two weeks before anyone noticed.
 *
 * This check runs at the end of every renewal script, so on every deploy and
 * every night. It reports, and fails the renewal unit, when
 *  - the gateway serves a hostname no renewal script covers (box-wide: such a
 *    hostname has no owner left to report it, so every project's run does),
 *  - a certificate this project renews, or an uncovered one, is within
 *    `warnDays` of expiry or already expired. Renewal starts thirty days
 *    out, so a certificate that close has already failed to renew, or
 *  - a hostname this project renews has no certificate on disk at all.
 *
 * The logic lives in {@link CERT_COVERAGE_SOURCE} as plain JavaScript because
 * it has to run on the box with nothing but bun. {@link certCoverageReport}
 * evaluates that same source, so the tests exercise the code the box runs.
 */

export const RPX_CERT_COVERAGE_WARN_DAYS = 14

/** A gateway site file, as read from `sites.d`. Only what the check needs. */
export interface CertCoverageFragment {
  /** File name, for the report (`uptime-status.json`). */
  file: string
  proxies?: Array<{ to?: string }>
  localCa?: { hosts?: string[] }
  https?: boolean
}

export interface CertCoverageInput {
  fragments: CertCoverageFragment[]
  /** Every renewal script on the box, by file name and content. */
  renewScripts: Array<{ file: string, content: string }>
  /**
   * Certificate expiry by certificate file stem (`example.com`,
   * `_wildcard.example.com`), in epoch milliseconds.
   */
  certExpiry: Record<string, number | undefined>
  /**
   * File name of the renewal script that is running. Its hostnames are the
   * ones checked for expiry. Omit to check every served hostname.
   */
  ownScript?: string
  /** Epoch milliseconds. */
  now: number
  /** @default 14 */
  warnDays?: number
}

export interface CertCoverageReport {
  /** Served hostnames no renewal script covers, with the site files routing them. */
  uncovered: Array<{ host: string, files: string[], daysLeft?: number }>
  /** Certificates inside the warning window; `daysLeft` is negative once expired. */
  expiring: Array<{ host: string, daysLeft: number }>
  /** Hostnames this project renews that have no certificate on disk. */
  missing: string[]
  /** One line per finding, ready to print. Empty when everything is covered. */
  lines: string[]
}

/**
 * The check itself, as the JavaScript the box runs. Self-contained on
 * purpose: no imports, no closure, nothing from this module.
 */
export const CERT_COVERAGE_SOURCE: string = `function certCoverageReport(input) {
  var warnDays = typeof input.warnDays === 'number' ? input.warnDays : ${RPX_CERT_COVERAGE_WARN_DAYS}
  var day = 24 * 60 * 60 * 1000
  var norm = function (host) { return String(host || '').trim().toLowerCase() }

  // What each renewal script covers: its DOMAINS list, and its wildcards.
  var covered = new Set()
  var wildcardApexes = new Set()
  var own = new Set()
  var hasOwn = false
  for (var i = 0; i < (input.renewScripts || []).length; i++) {
    var script = input.renewScripts[i]
    var isOwn = input.ownScript !== undefined && script.file === input.ownScript
    if (isOwn) hasOwn = true
    var domains = /^DOMAINS='([^']*)'/m.exec(script.content || '')
    var names = domains ? domains[1].split(',').map(norm).filter(Boolean) : []
    for (var j = 0; j < names.length; j++) {
      covered.add(names[j])
      if (isOwn) own.add(names[j])
    }
    var wildcard = /^wildcard '([^']+)'/gm
    var match
    while ((match = wildcard.exec(script.content || '')) !== null) {
      var apex = norm(match[1])
      wildcardApexes.add(apex)
      if (isOwn) own.add('*.' + apex)
    }
  }

  // What the gateway serves over TLS it expects a real certificate for.
  var lanHosts = new Set()
  for (var a = 0; a < (input.fragments || []).length; a++) {
    var lan = (input.fragments[a].localCa && input.fragments[a].localCa.hosts) || []
    for (var b = 0; b < lan.length; b++) lanHosts.add(norm(lan[b]))
  }
  var served = new Map()
  for (var c = 0; c < (input.fragments || []).length; c++) {
    var fragment = input.fragments[c]
    if (fragment.https === false) continue
    var routes = fragment.proxies || []
    for (var d = 0; d < routes.length; d++) {
      var host = norm(routes[d] && routes[d].to)
      if (!host || host.indexOf(':') !== -1 || host.indexOf('.') === -1 || lanHosts.has(host)) continue
      if (!served.has(host)) served.set(host, [])
      if (served.get(host).indexOf(fragment.file) === -1) served.get(host).push(fragment.file)
    }
  }

  var parentOf = function (host) { return host.slice(host.indexOf('.') + 1) }
  var isCovered = function (host) {
    if (host.indexOf('*.') === 0) return wildcardApexes.has(host.slice(2))
    return covered.has(host) || wildcardApexes.has(parentOf(host))
  }
  var expiryOf = function (host) {
    var certs = input.certExpiry || {}
    if (host.indexOf('*.') === 0) return certs['_wildcard.' + host.slice(2)]
    return certs[host] !== undefined ? certs[host] : certs['_wildcard.' + parentOf(host)]
  }
  var daysLeftOf = function (host) {
    var expiry = expiryOf(host)
    return typeof expiry === 'number' ? Math.floor((expiry - input.now) / day) : undefined
  }
  var when = function (daysLeft) {
    if (daysLeft < 0) return 'expired ' + (-daysLeft) + ' day' + (daysLeft === -1 ? '' : 's') + ' ago'
    return 'expires in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's')
  }

  var report = { uncovered: [], expiring: [], missing: [], lines: [] }
  var hosts = Array.from(served.keys()).sort()
  for (var e = 0; e < hosts.length; e++) {
    var name = hosts[e]
    var left = daysLeftOf(name)
    if (!isCovered(name)) {
      var files = served.get(name)
      var entry = { host: name, files: files }
      if (left !== undefined) entry.daysLeft = left
      report.uncovered.push(entry)
      report.lines.push('rpx-cert-coverage: ' + name + ' is served by the gateway (' + files.join(', ') + ') but no renewal script covers it. '
        + (left === undefined ? 'It has no certificate on disk.' : 'Its certificate ' + when(left) + ' and will not renew.')
        + ' Declare it in the owning project (a site domain or alias) and deploy, or remove the stale site file.')
      continue
    }
    if (hasOwn && !own.has(name) && !(name.indexOf('*.') !== 0 && own.has('*.' + parentOf(name)))) continue
    if (left === undefined) {
      report.missing.push(name)
      report.lines.push('rpx-cert-coverage: ' + name + ' is served by the gateway but has no certificate on disk. Check that its DNS points at this box and read the issuance output above.')
    }
    else if (left <= warnDays) {
      report.expiring.push({ host: name, daysLeft: left })
      report.lines.push('rpx-cert-coverage: the certificate for ' + name + ' ' + when(left) + '. Renewal starts 30 days before expiry, so it has been failing. Read the renewal output above.')
    }
  }
  return report
}`

/** Run the box's own check against an in-memory snapshot. */
// eslint-disable-next-line no-new-func
export const certCoverageReport: (input: CertCoverageInput) => CertCoverageReport = new Function(`${CERT_COVERAGE_SOURCE}\nreturn certCoverageReport`)()

/**
 * The script the renewal run executes on the box:
 * `bun <file> <sitesDir> <rpxDir> <certsDir> <ownScript> <warnDays>`.
 * Prints one line per finding to stderr and exits 1 when there is any.
 */
export function renderCertCoverageCheck(): string {
  return `// Generated by ts-cloud. Reports gateway hostnames whose certificate will not renew.
${CERT_COVERAGE_SOURCE}

const { readdirSync, readFileSync } = require('node:fs')
const { X509Certificate } = require('node:crypto')
const [sitesDir, rpxDir, certsDir, ownScript, warnDays] = process.argv.slice(2)
const list = (dir) => { try { return readdirSync(dir).sort() } catch { return [] } }

const fragments = []
for (const file of list(sitesDir).filter(name => name.endsWith('.json'))) {
  try { fragments.push({ ...JSON.parse(readFileSync(sitesDir + '/' + file, 'utf8')), file }) }
  catch {}
}
const renewScripts = []
for (const file of list(rpxDir).filter(name => /^renew-certs.*\\.sh$/.test(name))) {
  try { renewScripts.push({ file, content: readFileSync(rpxDir + '/' + file, 'utf8') }) }
  catch {}
}
const certExpiry = {}
for (const file of list(certsDir).filter(name => name.endsWith('.crt') && !name.endsWith('.chain.crt'))) {
  try { certExpiry[file.slice(0, -4)] = Date.parse(new X509Certificate(readFileSync(certsDir + '/' + file)).validTo) }
  catch {}
}

const report = certCoverageReport({ fragments, renewScripts, certExpiry, ownScript, now: Date.now(), warnDays: Number(warnDays) || undefined })
for (const line of report.lines) console.error(line)
process.exit(report.lines.length > 0 ? 1 : 0)
`
}
