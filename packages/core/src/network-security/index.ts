/**
 * Network Security - WAF, Shield, security groups, NACLs
 */

export interface WAFRule { id: string; name: string; priority: number; action: 'allow' | 'block' | 'count'; conditions: string[] }
export interface ShieldProtection { id: string; resourceArn: string; protectionType: 'standard' | 'advanced' }
export interface SecurityGroup { id: string; name: string; vpcId: string; rules: Array<{ protocol: string; port: number; source: string }> }
export interface NACL { id: string; vpcId: string; rules: Array<{ ruleNumber: number; protocol: string; action: 'allow' | 'deny' }> }

export class NetworkSecurityManager {
  private wafRules = new Map<string, WAFRule>()
  private shieldProtections = new Map<string, ShieldProtection>()
  private securityGroups = new Map<string, SecurityGroup>()
  private nacls = new Map<string, NACL>()
  private counter = 0

  createWAFRule(name: string, priority: number, action: 'allow' | 'block' | 'count', conditions: string[]): WAFRule {
    const id = `waf-${Date.now()}-${this.counter++}`
    const rule = { id, name, priority, action, conditions }
    this.wafRules.set(id, rule)
    return rule
  }

  enableShield(resourceArn: string, protectionType: 'standard' | 'advanced' = 'standard'): ShieldProtection {
    const id = `shield-${Date.now()}-${this.counter++}`
    const protection = { id, resourceArn, protectionType }
    this.shieldProtections.set(id, protection)
    return protection
  }

  createSecurityGroup(name: string, vpcId: string, rules: Array<{ protocol: string; port: number; source: string }>): SecurityGroup {
    const id = `sg-${Date.now()}-${this.counter++}`
    const sg = { id, name, vpcId, rules }
    this.securityGroups.set(id, sg)
    return sg
  }

  createNACL(vpcId: string, rules: Array<{ ruleNumber: number; protocol: string; action: 'allow' | 'deny' }>): NACL {
    const id = `nacl-${Date.now()}-${this.counter++}`
    const nacl = { id, vpcId, rules }
    this.nacls.set(id, nacl)
    return nacl
  }

  clear(): void { this.wafRules.clear(); this.shieldProtections.clear(); this.securityGroups.clear(); this.nacls.clear() }
}

export const networkSecurityManager: NetworkSecurityManager = new NetworkSecurityManager()
