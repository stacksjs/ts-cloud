import type { HetznerServer } from './client'
import { normalizePublicIpv6 } from '../../deploy/server-dns'

/** Desired PTR changes, after the driver has verified ownership and residency. */
export function planServerReverseDns(server: HetznerServer, hostname?: string): Array<{ ip: string; hostname: string }> {
  if (!hostname) return []
  if (hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(hostname)) throw new Error('Reverse DNS requires a valid fully qualified hostname')
  const changes: Array<{ ip: string; hostname: string }> = []
  const { ipv4, ipv6 } = server.public_net
  if (ipv4?.ip && ipv4.dns_ptr !== hostname) changes.push({ ip: ipv4.ip, hostname })
  const address = normalizePublicIpv6(ipv6?.ip)
  if (address && !ipv6?.dns_ptr?.some(row => row.ip === address && row.dns_ptr === hostname)) changes.push({ ip: address, hostname })
  return changes
}
