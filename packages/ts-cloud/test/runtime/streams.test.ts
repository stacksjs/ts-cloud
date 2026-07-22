import { describe, expect, it } from 'bun:test'
import { RuntimeStreamRegistry } from '../../src/runtime'

describe('runtime stream registry', () => {
  it('reconnects from a cursor without replaying acknowledged chunks', () => {
    const streams = new RuntimeStreamRegistry()
    const session = streams.create('logs', 'workload:one')
    streams.append(session.id, 'one')
    streams.append(session.id, 'two')
    expect(streams.read(session.id, 'workload:one', 1)?.chunks.map((chunk) => chunk.data)).toEqual(['two'])
    expect(streams.read(session.id, 'workload:two', 0)).toBeUndefined()
  })

  it('bounds output and tells lagging clients to reset', () => {
    const streams = new RuntimeStreamRegistry({ maxBufferBytes: 1024 })
    const session = streams.create('exec', 'workload:one')
    streams.append(session.id, 'a'.repeat(700))
    streams.append(session.id, 'b'.repeat(700))
    streams.append(session.id, 'c'.repeat(700))
    const snapshot = streams.read(session.id, 'workload:one', 1)!
    expect(snapshot.reset).toBeTrue()
    expect(snapshot.droppedBytes).toBe(1400)
    expect(snapshot.chunks[0].data).toBe('c'.repeat(700))
  })

  it('cancels, notifies, and aborts an open session', () => {
    const streams = new RuntimeStreamRegistry()
    const session = streams.create('exec', 'workload:one')
    let state = 'open'
    streams.subscribe(session.id, session.workloadId, (snapshot) => (state = snapshot.state))
    streams.cancel(session.id, session.workloadId)
    expect(state).toBe('cancelled')
    expect(streams.signal(session.id)?.aborted).toBeTrue()
  })
})
