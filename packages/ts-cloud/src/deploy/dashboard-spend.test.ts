import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dashboardPageRoutes, routesForDashboard } from './dashboard-route-manifest'
import { allRoutePolicies } from './dashboard-policy'

const serverSource = readFileSync(join(import.meta.dir, 'local-dashboard-server.ts'), 'utf8')
const uiRoot = join(import.meta.dir, '..', '..', '..', 'ui')
const pagePath = join(uiRoot, 'pages', 'operations', 'spend.stx')
const navPath = join(uiRoot, 'pages', 'partials', 'nav.stx')

describe('spend route manifest', () => {
  it('registers the page in both server and serverless dashboards', () => {
    const route = dashboardPageRoutes.find((item) => item.id === 'spend.overview')
    expect(route).toMatchObject({ path: '/operations/spend', group: 'operations', adminOnly: false })
    expect(route?.modes).toEqual(['server', 'serverless'])
  })

  it('is visible to a member, whose access is decided server-side by capability', () => {
    expect(routesForDashboard('server', true).map((item) => item.id)).toContain('spend.overview')
    expect(routesForDashboard('serverless', true).map((item) => item.id)).toContain('spend.overview')
  })
})

describe('spend route policies', () => {
  const policies = allRoutePolicies() as Record<string, { capability: string }>

  it('gates reads on billing:read', () => {
    for (const route of [
      'GET /api/usage',
      'GET /api/spend/budgets',
      'GET /api/spend/enforcement',
      'GET /api/spend/anomalies',
    ])
      expect(policies[route]?.capability).toBe('billing:read')
  })

  it('gates every mutation on billing:manage', () => {
    for (const route of [
      'POST /api/spend/budgets',
      'PATCH /api/spend/budgets',
      'DELETE /api/spend/budgets',
      'POST /api/spend/check',
      'POST /api/spend/release',
      'POST /api/spend/anomalies/acknowledge',
    ])
      expect(policies[route]?.capability).toBe('billing:manage')
  })

  it('never lets a project capability stand in for a billing one', () => {
    // The failure this guards: a member who can deploy quietly gaining the
    // ability to raise the cap that is supposed to constrain them.
    for (const [route, policy] of Object.entries(policies))
      if (route.includes('/api/spend/') || route === 'GET /api/usage')
        expect(policy.capability.startsWith('billing:')).toBe(true)
  })
})

describe('spend dashboard server', () => {
  it('registers every mutating spend route in the trusted-mutation list', () => {
    for (const mutation of [
      "'POST /api/spend/budgets'",
      "'PATCH /api/spend/budgets'",
      "'DELETE /api/spend/budgets'",
      "'POST /api/spend/check'",
      "'POST /api/spend/release'",
      "'POST /api/spend/anomalies/acknowledge'",
    ])
      expect(serverSource).toContain(mutation)
  })

  it('checks billing:read before serving any spend data', () => {
    const block = serverSource.slice(serverSource.indexOf("url.pathname.startsWith('/api/spend/')"))
    // The capability check must precede the first handler, not merely appear
    // somewhere in the block: an early `return json(...)` above it would leak.
    expect(block.indexOf('billing:read')).toBeLessThan(
      block.indexOf("if (url.pathname === '/api/usage' && req.method === 'GET')"),
    )
    expect(block.indexOf('billing:read')).toBeLessThan(block.indexOf('return json({'))
  })

  it('creates budgets in dry run unless the operator opts out', () => {
    expect(serverSource).toContain('dryRun: body.dryRun !== false')
  })

  it('previews a cycle unless asked to apply', () => {
    expect(serverSource).toContain('if (body.apply !== true)')
  })

  it('lifts the gate before deleting a budget', () => {
    const block = serverSource.slice(serverSource.indexOf("url.pathname === '/api/spend/budgets' && req.method === 'DELETE'"))
    expect(block.indexOf('spendGate.closeBudget')).toBeLessThan(block.indexOf('spendStore.deleteBudget'))
  })

  it('scopes every spend query to the dashboard organization', () => {
    const block = serverSource.slice(
      serverSource.indexOf("url.pathname.startsWith('/api/spend/')"),
      serverSource.indexOf("url.pathname.startsWith('/api/health/')"),
    )
    // No spend query may run without an organization filter.
    expect(block).toContain('organizationId: controlPlane.organization.id')
    expect(block).not.toContain('listBudgets({ organizationId: undefined')
  })
})

describe('spend loop on the dashboard', () => {
  it('starts the loop, so budgets evaluate without anyone opening the page', () => {
    expect(serverSource).toContain('startSpendLoop(runner')
    expect(serverSource).toContain('options.spendLoop ?? process.env.NODE_ENV')
  })

  it('takes a lease, so a spend:work worker on the same box does not double-run', () => {
    expect(serverSource).toContain('new SpendLoopLease(controlPlane.store')
  })

  it('stops the loop when the server stops', () => {
    const stopBlock = serverSource.slice(serverSource.indexOf('server.stop = ('))
    expect(stopBlock).toContain('stopSpendLoop?.()')
  })

  it('keeps the loop off the startup path by importing it lazily', () => {
    // A static import would pull the spend graph into every server construction,
    // which is what made the dashboard integration tests flaky.
    expect(serverSource).not.toMatch(/^import \{[^}]*SpendRunner[^}]*\} from '\.\.\/spend'/m)
    expect(serverSource).toContain("await import('../spend')")
  })
})

describe('spend dashboard page', () => {
  const page = existsSync(pagePath) ? readFileSync(pagePath, 'utf8') : ''

  it('exists', () => {
    expect(existsSync(pagePath)).toBe(true)
  })

  it('reads only endpoints the server implements', () => {
    const called = [...page.matchAll(/'(\/api\/[a-z0-9/-]+)/gi)].map((match) => match[1])
    expect(called.length).toBeGreaterThan(0)
    for (const endpoint of new Set(called)) expect(serverSource).toContain(`'${endpoint}'`)
  })

  it('defaults the create form to dry run', () => {
    expect(page).toContain('name="dryRun" type="checkbox" checked')
  })

  it('tells the operator a low-confidence projection is not actionable', () => {
    expect(page).toContain('Too early in the period to act on this forecast')
  })

  it('says plainly that a manual lift is re-applied', () => {
    expect(page).toContain('next spend cycle re-applies it')
  })

  it('explains an empty state instead of showing a blank panel', () => {
    for (const empty of ['No budgets', 'No metered usage yet', 'No anomalies detected', 'Nothing is being enforced'])
      expect(page).toContain(empty)
  })

  it('uses no vanilla DOM access outside the stx signal model', () => {
    const script = page.slice(page.indexOf('<script client>'), page.indexOf('</script>'))
    expect(script).not.toMatch(/\bdocument\.|\bwindow\.|\bvar\s/)
  })
})

describe('spend navigation', () => {
  const nav = readFileSync(navPath, 'utf8')

  it('links the page from both dashboard modes', () => {
    expect(nav.match(/\/operations\/spend/g)?.length).toBe(2)
  })

  it('hides the link from anyone without billing:read', () => {
    expect(nav).toContain("canView('billing:read')")
  })
})
