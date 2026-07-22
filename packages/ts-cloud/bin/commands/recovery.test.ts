import { describe, expect, it } from 'bun:test'
import type { BackupPolicy, RecoveryPoint } from '../../src/backups'
import { recoveryPointRows } from './recovery'

describe('recovery CLI inventory', () => {
  it('renders provider-neutral state without manifest or secret data', () => {
    const rows = recoveryPointRows([{
      id: 'point-1', status: 'available', verificationState: 'verified', kind: 'logical_database', policyId: 'policy-1', pointInTime: '2026-07-21T00:00:00.000Z', sizeBytes: 2048, held: true, pinned: false, manifest: { credential: 'must-not-render' },
    } as RecoveryPoint], [{ id: 'policy-1', name: 'orders-hourly' } as BackupPolicy])
    expect(rows).toEqual([['point-1', 'available', 'verified', 'logical_database', 'orders-hourly', '2026-07-21T00:00:00.000Z', '2048 B', 'hold']])
    expect(JSON.stringify(rows)).not.toContain('must-not-render')
  })
})
