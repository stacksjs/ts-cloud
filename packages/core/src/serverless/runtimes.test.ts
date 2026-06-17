import { describe, expect, it } from 'bun:test'
import { sharedRuntimeLoop } from './runtimes'

describe('shared runtime loop', () => {
  it('implements the Lambda Runtime API event loop', () => {
    const src = sharedRuntimeLoop()
    expect(src).toContain('AWS_LAMBDA_RUNTIME_API')
    expect(src).toContain('invocation/next')
    expect(src).toContain('invocation/${requestId}/response')
    expect(src).toContain('invocation/${requestId}/error')
    // Resolves the handler from _HANDLER so one artifact serves http/queue/cli.
    expect(src).toContain('_HANDLER')
    expect(src).toContain('LAMBDA_TASK_ROOT')
  })

  it('is plain ESM (runs under both node and bun, no node-only imports)', () => {
    const src = sharedRuntimeLoop()
    expect(src).not.toContain('require(')
    expect(src).toContain('await import(')
  })
})

describe('runtime bootstraps', () => {
  it('node + bun bootstraps run the shared loop with their binary', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'runtimes')
    const node = readFileSync(join(dir, 'node-bootstrap'), 'utf-8')
    const bun = readFileSync(join(dir, 'bun-bootstrap'), 'utf-8')
    expect(node).toContain('/opt/bin/node /opt/runtime.mjs')
    expect(bun).toContain('/opt/bin/bun /opt/runtime.mjs')
  })
})
