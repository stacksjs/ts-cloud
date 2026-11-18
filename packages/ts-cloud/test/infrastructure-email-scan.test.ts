/**
 * `infrastructure.email.server.scan` reaches the SES receipt rule. It used to be ignored: the
 * generator always enabled scanning, so `scan: false` in an app's config did nothing.
 */

import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { InfrastructureGenerator } from '../src/generators/infrastructure'

function receiptRule(server: { enabled?: boolean, scan?: boolean }): any {
  const generator = new InfrastructureGenerator({
    config: {
      project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
      environments: { production: { type: 'production', region: 'us-east-1' } },
      infrastructure: { email: { domain: 'acme.test', hostedZoneId: 'Z123', server } },
    } as CloudConfig,
    environment: 'production',
  })
  generator.generate()
  const template = JSON.parse(generator.toJSON())
  return Object.values(template.Resources).find((r: any) => r.Type === 'AWS::SES::ReceiptRule')
}

describe('infrastructure.email.server.scan', () => {
  it('scans inbound mail when scan is not set', () => {
    expect(receiptRule({ enabled: true }).Properties.Rule.ScanEnabled).toBe(true)
  })

  it('turns scanning off when scan is false', () => {
    expect(receiptRule({ enabled: true, scan: false }).Properties.Rule.ScanEnabled).toBe(false)
  })

  it('creates no inbound pipeline unless the server is enabled', () => {
    expect(receiptRule({ scan: true })).toBeUndefined()
  })
})
