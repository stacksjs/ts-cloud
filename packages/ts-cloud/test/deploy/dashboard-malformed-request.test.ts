import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * The control panel answers a request it cannot parse with 400.
 *
 * Bun builds `req.url` from the request line and the Host header. A request
 * with no usable host arrives as a bare path, and the handler's first
 * `new URL(req.url)` threw, so every such probe was a 500 and a stack in the
 * journal (seen on a production box as `TypeError: Invalid URL, input: "/"`).
 * The guard has to come before anything in the handler reads the URL or
 * clones the request for the audit log.
 */
const source = readFileSync(new URL('../../src/deploy/local-dashboard-server.ts', import.meta.url), 'utf8')

test('the dashboard handler turns an unparseable URL away before it reads it', () => {
  const handler = source.slice(source.indexOf('async fetch(req, runtimeServer) {'))
  const guard = handler.indexOf('URL.canParse(req.url)')
  expect(guard).toBeGreaterThan(-1)
  expect(guard).toBeLessThan(handler.indexOf('const url = new URL(req.url)'))
  expect(guard).toBeLessThan(handler.indexOf('req.clone()'))
  expect(handler.slice(guard, guard + 200)).toContain('status: 400')
})
