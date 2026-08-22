/**
 * MTA-STS — the policy that tells other mail servers TLS is not optional.
 *
 * SMTP's STARTTLS is opportunistic: a sender that cannot negotiate TLS delivers
 * in plaintext instead, and an attacker who can strip the STARTTLS banner gets
 * exactly that. MTA-STS (RFC 8461) is how a domain says "do not do that for
 * me" — senders that honour it refuse to deliver unless the connection is
 * authenticated TLS to a listed MX.
 *
 * It has two halves, and this module exists because half of it is worse than
 * none:
 *
 *   1. a `_mta-sts.<domain>` TXT record advertising a policy id;
 *   2. the policy itself, served at
 *      `https://mta-sts.<domain>/.well-known/mta-sts.txt`.
 *
 * A domain that publishes the record and does not serve the policy has told
 * every sender to go looking for a file that 404s. They fall back to
 * opportunistic TLS — so mail keeps flowing and nothing breaks, which is
 * precisely why this stays broken for years once it happens. stacksjs.com had
 * exactly that state.
 *
 * ## Why the policy is served by a listener rather than redirected
 *
 * RFC 8461 §3.3 requires the policy to be fetched over HTTPS with a certificate
 * valid for `mta-sts.<domain>`, and forbids following redirects. So the policy
 * cannot be pointed at a file living somewhere more convenient: the host needs
 * its own vhost, its own certificate, and something answering on it.
 */
import type { ResolvedMailService } from '@ts-cloud/core'

/**
 * How strictly senders should apply the policy.
 *
 * - `testing` — report failures, deliver anyway. Where a new policy starts.
 * - `enforce` — refuse to deliver when TLS to a listed MX cannot be
 *   authenticated. This is the mode that can bounce real mail, and it is only
 *   safe once the MX set is right and its certificate is valid for the MX name.
 * - `none` — the documented way to retire a policy. Publish it, let the old
 *   `max_age` lapse, and only then remove the record; deleting the record while
 *   senders still cache an `enforce` policy leaves them enforcing a policy the
 *   domain no longer has.
 */
export type MtaStsMode = 'testing' | 'enforce' | 'none'

export interface MtaStsPolicy {
  /** Host the policy is served from — `mta-sts.<domain>`. */
  host: string
  /** The file's contents, served at `/.well-known/mta-sts.txt`. */
  body: string
  /**
   * Policy id for the TXT record.
   *
   * Derived from the policy body, not from a timestamp. Senders cache by id and
   * only refetch when it changes, so an id that moves on every deploy causes
   * pointless refetches, and one that never moves means a corrected MX list is
   * ignored until `max_age` lapses. Content-derived, both problems go away.
   */
  id: string
  /** `_mta-sts.<domain>` TXT value. */
  txt: string
}

/** Seconds senders may cache the policy. RFC 8461 suggests at least a few days. */
const DEFAULT_MAX_AGE = 604800

/**
 * A short, stable id for a policy body.
 *
 * Only has to be ≤32 printable characters and change when the policy does, so a
 * cheap non-cryptographic digest is enough — this is a cache key, not a
 * signature.
 */
function policyId(body: string): string {
  let h1 = 0x811C9DC5
  let h2 = 0x01000193

  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85EBCA6B) >>> 0
  }

  return `${h1.toString(36)}${h2.toString(36)}`.padEnd(12, '0').slice(0, 12)
}

/**
 * Build the policy for one domain.
 *
 * `mx` lists the hostnames senders may deliver to. It defaults to the mail
 * server's own hostname because that is what ts-cloud's MX record points at;
 * a domain whose mail also lands somewhere else must list that host too, or
 * `enforce` will reject the mail it delivers there.
 */
export function buildMtaStsPolicy(
  mail: Pick<ResolvedMailService, 'hostname'>,
  domain: string,
  options: { mode?: MtaStsMode, maxAge?: number, mx?: string[] } = {},
): MtaStsPolicy {
  const mode = options.mode ?? 'testing'
  const maxAge = options.maxAge ?? DEFAULT_MAX_AGE
  const mx = options.mx?.length ? options.mx : [mail.hostname]

  // CRLF line endings: RFC 8461 §3.2 defines the format in terms of CRLF, and
  // a parser that splits strictly on it reads an LF-only file as one long line.
  const body = `${[
    'version: STSv1',
    `mode: ${mode}`,
    ...mx.map(host => `mx: ${host}`),
    `max_age: ${maxAge}`,
  ].join('\r\n')}\r\n`

  const id = policyId(body)

  return {
    host: `mta-sts.${domain}`,
    body,
    id,
    txt: `v=STSv1; id=${id}`,
  }
}

/**
 * The port the policy listener binds on the box.
 *
 * 8461 is the RFC number, which makes it recognisable in an `ss -lntp` beside a
 * dozen application ports that all look alike.
 */
export const MTA_STS_PORT = 8461

/**
 * A listener that serves exactly one file and nothing else.
 *
 * Deliberately not a static-file server pointed at a directory: this vhost is
 * reachable from the whole internet and has one legitimate URL, so anything it
 * can be persuaded to serve beyond that is surface for no benefit. Every other
 * path is a 404, including `/`.
 */
export function buildMtaStsServer(policy: MtaStsPolicy, port: number = MTA_STS_PORT): string {
  const body = JSON.stringify(policy.body)

  return [
    `const policy = ${body}`,
    `Bun.serve({`,
    `  port: ${port},`,
    `  hostname: '127.0.0.1',`,
    `  fetch(req) {`,
    `    const { pathname } = new URL(req.url)`,
    `    if (pathname !== '/.well-known/mta-sts.txt') return new Response('Not Found', { status: 404 })`,
    `    return new Response(policy, { headers: { 'content-type': 'text/plain; charset=utf-8' } })`,
    `  },`,
    `})`,
  ].join('\n')
}
