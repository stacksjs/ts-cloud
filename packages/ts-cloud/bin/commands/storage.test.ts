import { describe, expect, it } from 'bun:test'
import { volumeRows } from './storage'
describe('volume CLI presentation', () => {
  it('prints ownership, consumer, usage, and backup state without raw provider state', () => {
    const rows = volumeRows([
      {
        name: 'uploads',
        provider: 'docker',
        type: 'docker',
        status: 'attached',
        capacityBytes: 1024,
        usedBytes: 512,
        attachments: [{ observedState: 'attached' }],
        backupState: 'protected',
        orphaned: false,
      },
    ] as any)
    expect(rows).toEqual([['uploads', 'docker/docker', 'attached', '1 KB', '512 B', '1', 'protected', 'managed']])
  })
})
