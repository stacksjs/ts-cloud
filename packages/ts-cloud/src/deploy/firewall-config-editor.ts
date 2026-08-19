/**
 * Edit the host firewall's allowed TCP ports in the cloud config text
 * (`infrastructure.compute.firewall.allowedPorts`). SSH/80/443 are always open
 * and are never written here. The editor is comment/quote-aware (it reuses the
 * ssh-config-editor's `findMatching`) and creates the `firewall` block or the
 * `allowedPorts` array when they do not yet exist.
 *
 * ts-cloud reconciles UFW from this list on every deploy, so persisting the port
 * here is what makes a firewall change durable (a live `ufw allow` alone would be
 * undone on the next provision).
 */
import { findMatching } from './ssh-config-editor'

/** Ports that are always open and must never be written into allowedPorts. */
const ALWAYS_OPEN = new Set([22, 80, 443])

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

export interface FirewallPortsInput {
  configText: string
  /** The desired extra ports (SSH/80/443 stripped, deduped, sorted). */
  ports: number[]
}

/** Normalize a port list: integers in range, minus the always-open set, unique + sorted. */
export function normalizePorts(ports: number[]): number[] {
  return [...new Set(ports.filter((p) => isValidPort(p) && !ALWAYS_OPEN.has(p)))].sort((a, b) => a - b)
}

export function addFirewallPort(configText: string, port: number, existing: number[] = []): string {
  if (!isValidPort(port)) throw new Error('Port must be an integer between 1 and 65535.')
  if (ALWAYS_OPEN.has(port)) throw new Error(`Port ${port} (SSH/HTTP/HTTPS) is always open and is not managed here.`)
  return setFirewallPorts({ configText, ports: normalizePorts([...existing, port]) })
}

export function removeFirewallPort(configText: string, port: number, existing: number[] = []): string {
  return setFirewallPorts({ configText, ports: normalizePorts(existing.filter((p) => p !== port)) })
}

/** Find `keyword: {` or `keyword: [` within [start,end); return its bracket span. */
function findBlock(
  text: string,
  start: number,
  end: number,
  keyword: string,
  open: '{' | '[',
): { propStart: number; open: number; close: number } | null {
  const body = text.slice(start, end)
  const match = new RegExp(`\\b${keyword}\\s*:\\s*\\${open}`).exec(body)
  if (!match) return null
  const propStart = start + match.index
  const openIdx = text.indexOf(open, propStart)
  return { propStart, open: openIdx, close: findMatching(text, openIdx, open, open === '{' ? '}' : ']') }
}

function renderPortsArray(ports: number[]): string {
  return `allowedPorts: [${ports.join(', ')}]`
}

/**
 * Rewrite `compute.firewall.allowedPorts` to exactly `ports`. Creates the
 * `firewall` object and/or the `allowedPorts` array if missing.
 */
export function setFirewallPorts(input: FirewallPortsInput): string {
  const { configText } = input
  const ports = normalizePorts(input.ports)

  const computeMatch = /\bcompute\s*:\s*{/.exec(configText)
  if (!computeMatch) throw new Error('Could not find infrastructure.compute in the cloud config.')
  const computeOpen = configText.indexOf('{', computeMatch.index)
  const computeClose = findMatching(configText, computeOpen, '{', '}')

  const firewall = findBlock(configText, computeOpen + 1, computeClose, 'firewall', '{')

  if (firewall) {
    const portsArr = findBlock(configText, firewall.open + 1, firewall.close, 'allowedPorts', '[')
    if (portsArr) {
      // Replace the whole `allowedPorts: [...]` span (back up over leading indent).
      let lineStart = portsArr.propStart
      while (lineStart > 0 && configText[lineStart - 1] !== '\n' && /\s/.test(configText[lineStart - 1]!)) lineStart--
      const indent = configText.slice(lineStart, portsArr.propStart)
      return `${configText.slice(0, lineStart)}${indent}${renderPortsArray(ports)}${configText.slice(portsArr.close + 1)}`
    }
    // firewall exists but has no allowedPorts — insert it as the last property.
    const before = configText.slice(0, firewall.close).trimEnd()
    const after = configText.slice(firewall.close)
    const sep = before.endsWith(',') || before.endsWith('{') ? '' : ','
    return `${before}${sep}\n        ${renderPortsArray(ports)},\n      ${after}`
  }

  // No firewall block — insert `firewall: { allowedPorts: [...] }` into compute.
  const before = configText.slice(0, computeClose).trimEnd()
  const after = configText.slice(computeClose)
  const sep = before.endsWith(',') || before.endsWith('{') ? '' : ','
  return `${before}${sep}\n      firewall: {\n        enabled: true,\n        ${renderPortsArray(ports)},\n      },\n    ${after}`
}
