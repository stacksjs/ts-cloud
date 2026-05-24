export interface HetznerFirewallRuleInput {
  allowSsh?: boolean
  sitePorts: number[]
}

export type HetznerInboundFirewallRule = {
  direction: 'in'
  protocol: 'tcp'
  port: string
  source_ips: string[]
  description?: string
}

export function buildHetznerFirewallRules(config: HetznerFirewallRuleInput): HetznerInboundFirewallRule[] {
  const openPorts = new Set<number>([80, 443, ...config.sitePorts])
  if (config.allowSsh) {
    openPorts.add(22)
  }

  return [...openPorts].map((port) => {
    return {
      direction: 'in',
      protocol: 'tcp',
      port: String(port),
      source_ips: ['0.0.0.0/0', '::/0'],
      description: `ts-cloud port ${port}`,
    }
  })
}
