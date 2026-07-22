import { describe, expect, it } from 'bun:test'
import type { DataService } from '../../src'
import { dataActionChanges, dataServiceRows, operationTargetsService } from './database'

describe('data-service CLI helpers', () => {
  it('serializes lifecycle changes without credential values', () => {
    expect(
      dataActionChanges({
        plan: 'db.r7g.large',
        storage: '100',
        engineVersion: '17.1',
        retention: 'final_backup',
        confirm: 'orders-db',
        compatibilityReviewed: true,
        backupId: 'snapshot-1',
        cidrs: '203.0.113.8/32, 198.51.100.4/32',
      }),
    ).toEqual({
      plan: 'db.r7g.large',
      storageGb: 100,
      engineVersion: '17.1',
      retention: 'final_backup',
      confirm: 'orders-db',
      compatibilityReviewed: true,
      backupId: 'snapshot-1',
      allowedCidrs: ['203.0.113.8/32', '198.51.100.4/32'],
    })
  })
  it('renders safe list metadata only', () => {
    const service = {
      id: 'data-1',
      name: 'orders-db',
      engine: 'postgres',
      provider: 'aws_rds',
      status: 'available',
      plan: 'db.t4g.micro',
      publicExposure: false,
      managementEnabled: true,
      credentialRef: 'secret://data-services/project/orders/app',
    } as DataService
    const serialized = JSON.stringify(dataServiceRows([service]))
    expect(serialized).toContain('orders-db')
    expect(serialized).not.toContain('secret://')
  })

  it('matches queue operations through the public operation envelope', () => {
    expect(operationTargetsService({ serviceId: 'data-1', action: 'backup' }, 'data-1')).toBeTrue()
    expect(operationTargetsService({ serviceId: 'data-2' }, 'data-1')).toBeFalse()
    expect(operationTargetsService(null, 'data-1')).toBeFalse()
  })
})
