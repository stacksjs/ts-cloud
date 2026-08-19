import { describe, expect, it } from 'bun:test'
import { summarizeRemoteFailures } from './remote-failure'

describe('summarizeRemoteFailures', () => {
  /**
   * The failure this fixes: "One or more SSH deploy commands failed" was the
   * ENTIRE error an operator got, while the line explaining it sat unused in
   * perInstance.
   */
  it('appends the failing instance output to the summary', () => {
    const message = summarizeRemoteFailures(
      [{ instanceId: 'i-1', status: 'Failed', error: 'Remote SSH command failed (exit 127)\npsql: command not found' }],
      'One or more SSH deploy commands failed',
    )
    expect(message).toContain('One or more SSH deploy commands failed')
    expect(message).toContain('i-1: Failed')
    expect(message).toContain('psql: command not found')
  })

  it('falls back to stdout when nothing was captured on stderr', () => {
    const message = summarizeRemoteFailures(
      [{ instanceId: 'i-1', status: 'Failed', output: 'ERROR: role "loghq" cannot be created' }],
      'failed',
    )
    expect(message).toContain('role "loghq" cannot be created')
  })

  it('ignores the instances that succeeded', () => {
    const message = summarizeRemoteFailures(
      [
        { instanceId: 'i-ok', status: 'Success', output: 'all good' },
        { instanceId: 'i-bad', status: 'Failed', error: 'boom' },
      ],
      'failed',
    )
    expect(message).toContain('i-bad')
    expect(message).not.toContain('i-ok')
  })

  it('counts the instances it does not quote', () => {
    const message = summarizeRemoteFailures(
      Array.from({ length: 5 }, (_, i) => ({ instanceId: `i-${i}`, status: 'Failed', error: 'boom' })),
      'failed',
    )
    expect(message).toContain('(+2 more instances failed)')
  })

  it('keeps the tail of a long output, where the failure is named', () => {
    const long = `${'noise\n'.repeat(2000)}FATAL: the actual reason`
    const message = summarizeRemoteFailures([{ instanceId: 'i-1', status: 'Failed', error: long }], 'failed')
    expect(message).toContain('FATAL: the actual reason')
    expect(message.length).toBeLessThan(long.length)
  })

  it('returns the bare summary when nothing is marked failed', () => {
    expect(summarizeRemoteFailures([], 'failed')).toBe('failed')
  })
})
