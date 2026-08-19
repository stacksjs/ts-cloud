/**
 * Probe whether an origin already terminates TLS for a hostname.
 *
 * This exists to break a genuine chicken-and-egg in the "put Cloudflare's proxy
 * in front of a self-hosted box" flow:
 *
 *  - the box issues its certificate with an ACME **HTTP-01** challenge, which
 *    needs the hostname to reach it on `:80`;
 *  - turning the proxy on makes the hostname resolve to Cloudflare instead, and
 *    with `Always Use HTTPS` the challenge is redirected to `:443`, where the
 *    box has no certificate yet — so the handshake fails, the challenge fails,
 *    and the certificate never gets issued.
 *
 * Publishing the record unproxied until the origin can actually serve TLS, then
 * proxying it, resolves that without anyone having to know the ordering. The
 * probe connects to the box **by address** with the public hostname as SNI,
 * which is exactly the connection Cloudflare will make.
 */
import { connect } from 'node:tls'

export interface OriginTlsProbeResult {
  /** A TLS handshake completed at all. */
  reachable: boolean
  /**
   * The certificate is valid for this hostname and chains to a public root —
   * i.e. `Full (strict)` will work.
   */
  trusted: boolean
  /** Why the probe is not `trusted`, when it isn't. */
  reason?: string
}

export interface ProbeOriginTlsOptions {
  /** Origin address to connect to (IPv4 or IPv6). */
  address: string
  /** Hostname to present as SNI and verify the certificate against. */
  serverName: string
  /** @default 443 */
  port?: number
  /** @default 5000 */
  timeoutMs?: number
}

/**
 * Connect to `address:port` with `serverName` as SNI and report what the origin
 * presents.
 *
 * Verification is deliberately not enforced at the socket (`rejectUnauthorized:
 * false`) so an untrusted certificate produces a *description* rather than a
 * thrown error — "reachable but the cert doesn't cover this name" and "nothing
 * is listening" call for different advice, and collapsing them into one failure
 * loses that. Node still performs the checks and reports them through
 * `authorized` / `authorizationError`.
 *
 * Never throws: a probe is a hint used to pick a safe ordering, and a probe
 * that fails for its own reasons must not fail a deploy.
 */
export async function probeOriginTls(options: ProbeOriginTlsOptions): Promise<OriginTlsProbeResult> {
  const { address, serverName, port = 443, timeoutMs = 5000 } = options

  return new Promise<OriginTlsProbeResult>((resolve) => {
    let settled = false
    const finish = (result: OriginTlsProbeResult): void => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      }
      catch {
        // The socket may already be gone; the result is what matters.
      }
      resolve(result)
    }

    const socket = connect({
      host: address,
      port,
      servername: serverName,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    })

    socket.once('secureConnect', () => {
      if (socket.authorized) {
        finish({ reachable: true, trusted: true })
        return
      }
      finish({
        reachable: true,
        trusted: false,
        reason: socket.authorizationError
          ? String(socket.authorizationError)
          : 'origin certificate is not trusted for this hostname',
      })
    })

    socket.once('timeout', () => {
      finish({ reachable: false, trusted: false, reason: `no TLS handshake within ${timeoutMs}ms` })
    })

    socket.once('error', (error: Error) => {
      finish({ reachable: false, trusted: false, reason: error.message })
    })
  })
}
