import { AWSClient } from './client'

export interface WebAclSummary {
  Name?: string
  Id?: string
  ARN?: string
}
export interface WafRule {
  Name?: string
  Priority?: number
  Action?: string
}

/** Minimal WAFv2 client (JSON API) — enough to list a web ACL's rules. */
export class WAFv2Client {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  private async call(target: string, body: Record<string, any>): Promise<any> {
    return this.client.request({
      service: 'wafv2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSWAF_20190729.${target}` },
      body: JSON.stringify(body),
    })
  }

  /** List regional web ACLs. */
  async listWebACLs(scope: 'REGIONAL' | 'CLOUDFRONT' = 'REGIONAL'): Promise<WebAclSummary[]> {
    const r = await this.call('ListWebACLs', { Scope: scope, Limit: 100 })
    return r?.WebACLs ?? []
  }

  /** Get a web ACL's rules (action label flattened from the rule's Action map). */
  async getWebACLRules(name: string, id: string, scope: 'REGIONAL' | 'CLOUDFRONT' = 'REGIONAL'): Promise<WafRule[]> {
    const r = await this.call('GetWebACL', { Name: name, Id: id, Scope: scope })
    const rules = r?.WebACL?.Rules ?? []
    return rules.map((rule: any) => ({
      Name: rule.Name,
      Priority: rule.Priority,
      Action: rule.Action
        ? Object.keys(rule.Action)[0]
        : rule.OverrideAction
          ? Object.keys(rule.OverrideAction)[0]
          : 'count',
    }))
  }
}
