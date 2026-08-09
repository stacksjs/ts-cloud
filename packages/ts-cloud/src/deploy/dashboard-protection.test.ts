import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { allRoutePolicies } from './dashboard-policy'

const serverSource = readFileSync(join(import.meta.dir, 'local-dashboard-server.ts'), 'utf8')
const pagePath = join(import.meta.dir, '..', '..', '..', 'ui', 'pages', 'server', 'firewall.stx')
const page = readFileSync(pagePath, 'utf8')

describe('protection route policies', () => {
  const policies = allRoutePolicies() as Record<string, { capability: string }>

  it('gates reads on security:read and writes on security:manage', () => {
    expect(policies['GET /api/protection']?.capability).toBe('security:read')
    expect(policies['GET /api/protection/ip-rules']?.capability).toBe('security:read')
    for (const route of [
      'POST /api/protection/attack-mode',
      'POST /api/protection/pause',
      'POST /api/protection/ip-rules',
      'DELETE /api/protection/ip-rules',
    ])
      expect(policies[route]?.capability).toBe('security:manage')
  })

  it('never lets a billing capability stand in for a security one', () => {
    for (const [route, policy] of Object.entries(policies))
      if (route.includes('/api/protection')) expect(policy.capability.startsWith('security:')).toBe(true)
  })
})

describe('protection dashboard routes', () => {
  it('registers every mutation as a trusted mutation', () => {
    for (const mutation of [
      "'POST /api/protection/attack-mode'",
      "'POST /api/protection/pause'",
      "'POST /api/protection/ip-rules'",
      "'DELETE /api/protection/ip-rules'",
    ])
      expect(serverSource).toContain(mutation)
  })

  it('checks the capability before serving anything', () => {
    const block = serverSource.slice(serverSource.indexOf("url.pathname.startsWith('/api/protection')"))
    expect(block.indexOf('security:read')).toBeLessThan(block.indexOf('return json({'))
  })

  it('records who changed the posture', () => {
    const block = serverSource.slice(
      serverSource.indexOf("url.pathname.startsWith('/api/protection')"),
      serverSource.indexOf("url.pathname.startsWith('/api/spend/')"),
    )
    expect(block).toContain('actorId: organizationPrincipal(user).actor?.id')
  })

  it('loads the protection module lazily, keeping it off the startup path', () => {
    expect(serverSource).toContain("await import('../protection')")
  })
})

describe('protection dashboard page', () => {
  it('reads only endpoints the server implements', () => {
    const called = [...page.matchAll(/'(\/api\/protection[a-z/-]*)'/g)].map((match) => match[1])
    expect(called.length).toBeGreaterThan(0)
    for (const endpoint of new Set(called)) expect(serverSource).toContain(`'${endpoint}'`)
  })

  it('confirms before challenging every visitor', () => {
    expect(page).toContain('challenges every visitor')
    expect(page).toContain('confirm(')
  })

  it('demands a reason before pausing mitigation, since it bills what it admits', () => {
    expect(page).toContain('bills all traffic')
    expect(page).toContain('Why are you pausing it?')
  })

  it('says both controls are time-boxed rather than leaving that to be discovered', () => {
    expect(page).toContain('lifts itself')
    expect(page).toContain('capped at 24 hours')
  })

  it('explains the allow-over-block precedence', () => {
    expect(page).toContain('Allow wins over block')
  })

  it('uses no vanilla DOM access outside the stx signal model', () => {
    const script = page.slice(page.indexOf('<script client>'), page.indexOf('</script>', page.indexOf('<script client>')))
    expect(script).not.toMatch(/\bdocument\.|\bwindow\.|\bvar\s/)
  })
})
