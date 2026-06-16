/**
 * Host firewall (UFW) provisioning, mirroring Forge's per-server firewall.
 *
 * Defaults to deny-incoming / allow-outgoing, with SSH (OpenSSH), HTTP (80),
 * and HTTPS (443) always open so deploys and web traffic keep working, plus
 * any extra ports the config lists (e.g. a Reverb/websocket port). On Hetzner
 * this is layered on top of the cloud firewall; on a bare box it's the primary
 * line of defence.
 */
import type { ComputeFirewallConfig } from '@ts-cloud/core'

/** Ports always allowed so SSH deploys + web traffic are never locked out. */
export const UFW_BASE_PORTS: readonly number[] = [80, 443]

/**
 * Build the UFW provisioning commands. Idempotent: `ufw allow` is a no-op when
 * a rule already exists, and `--force enable` is safe to re-run.
 */
export function buildUfwScript(firewall: ComputeFirewallConfig = {}): string[] {
  if (firewall.enabled === false)
    return []

  const ports = [...new Set([...UFW_BASE_PORTS, ...(firewall.allowedPorts || [])])]
    .filter(p => p > 0)
    .sort((a, b) => a - b)

  const lines = [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get install -y ufw',
    'ufw default deny incoming',
    'ufw default allow outgoing',
    // Named profile keeps the SSH port open even if it's non-standard.
    'ufw allow OpenSSH',
  ]
  for (const port of ports)
    lines.push(`ufw allow ${port}/tcp`)
  lines.push('ufw --force enable')
  return lines
}
