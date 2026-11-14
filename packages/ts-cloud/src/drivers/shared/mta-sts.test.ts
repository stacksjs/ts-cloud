import { describe, expect, it } from 'bun:test'
import { buildMtaStsPolicy, buildMtaStsServer } from './mta-sts'

const MAIL = { hostname: 'mail.example.com' }

describe('buildMtaStsPolicy', () => {
  it('serves from the host the spec requires', () => {
    // RFC 8461 fixes this name. A policy served anywhere else is not found,
    // and the domain silently keeps opportunistic TLS.
    expect(buildMtaStsPolicy(MAIL, 'example.com').host).toBe('mta-sts.example.com')
  })

  it('uses CRLF line endings', () => {
    // §3.2 defines the format in terms of CRLF; a strict parser reads an
    // LF-only file as a single unparseable line.
    const { body } = buildMtaStsPolicy(MAIL, 'example.com')

    expect(body).toContain('\r\n')
    expect(body.endsWith('\r\n')).toBe(true)
    expect(body.split('\r\n').filter(Boolean)).toEqual([
      'version: STSv1',
      'mode: testing',
      'mx: mail.example.com',
      'max_age: 604800',
    ])
  })

  it('starts in testing mode, not enforce', () => {
    // enforce is the mode that bounces real mail when the MX set or its
    // certificate is wrong, and a brand new policy is exactly when they are.
    expect(buildMtaStsPolicy(MAIL, 'example.com').body).toContain('mode: testing')
  })

  it('lists every MX it is given', () => {
    const { body } = buildMtaStsPolicy(MAIL, 'example.com', { mx: ['a.example.com', 'b.example.com'] })

    expect(body).toContain('mx: a.example.com')
    expect(body).toContain('mx: b.example.com')
  })

  it('derives the id from the policy, so it changes when the policy does', () => {
    // Senders cache by id and refetch only when it changes. A timestamp id
    // causes needless refetches; a fixed one means a corrected MX list is
    // ignored until max_age lapses.
    const a = buildMtaStsPolicy(MAIL, 'example.com')
    const b = buildMtaStsPolicy(MAIL, 'example.com')
    const changed = buildMtaStsPolicy(MAIL, 'example.com', { mode: 'enforce' })

    expect(a.id).toBe(b.id)
    expect(changed.id).not.toBe(a.id)
    expect(a.txt).toBe(`v=STSv1; id=${a.id}`)
  })

  it('keeps the id within the length the record allows', () => {
    const { id } = buildMtaStsPolicy(MAIL, 'example.com')

    expect(id.length).toBeLessThanOrEqual(32)
    expect(id).toMatch(/^[A-Za-z0-9]+$/)
  })
})

describe('buildMtaStsServer', () => {
  it('serves the policy at the well-known path and nothing else', async () => {
    // This vhost faces the whole internet and has exactly one legitimate URL.
    const policy = buildMtaStsPolicy(MAIL, 'example.com')
    const source = buildMtaStsServer(policy, 0)

    expect(source).toContain("pathname !== '/.well-known/mta-sts.txt'")
    expect(source).toContain('status: 404')
    expect(source).toContain('text/plain')
  })

  it('answers a request it cannot parse with 400 before it reads the path', async () => {
    // A scanner sending an empty Host gives Bun a bare path for a URL, and
    // `new URL('/')` throws: a 500 for the client's own malformed request.
    const source = buildMtaStsServer(buildMtaStsPolicy(MAIL, 'example.com'), 0)
    const guard = source.indexOf('URL.canParse(req.url)')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(source.indexOf('new URL(req.url)'))

    // And the handler it describes really does: run it against both shapes.
    const body = source.slice(source.indexOf('fetch(req) {') + 'fetch(req) {'.length, source.lastIndexOf('},'))
    const handler = new Function('policy', 'req', body) as (policy: string, req: { url: string }) => Response
    expect(handler('p', { url: '/' }).status).toBe(400)
    expect(handler('p', { url: 'http://127.0.0.1/.well-known/mta-sts.txt' }).status).toBe(200)
    expect(handler('p', { url: 'http://127.0.0.1/other' }).status).toBe(404)
  })

  it('embeds the policy body verbatim, CRLF included', () => {
    const policy = buildMtaStsPolicy(MAIL, 'example.com')
    const source = buildMtaStsServer(policy)

    expect(source).toContain(JSON.stringify(policy.body))
  })

  it('binds loopback, because the gateway terminates TLS in front of it', () => {
    expect(buildMtaStsServer(buildMtaStsPolicy(MAIL, 'example.com'))).toContain("hostname: '127.0.0.1'")
  })
})
