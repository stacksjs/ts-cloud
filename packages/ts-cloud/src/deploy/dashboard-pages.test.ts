import { describe, expect, it } from 'bun:test'
import {
  canOpenDashboardPage,
  isBoxOnlyPage,
  isTrustedMutationRequest,
  resolveOidcDashboardOrigin,
} from './local-dashboard-server'

describe('isBoxOnlyPage', () => {
  it('lets members open their own pages', () => {
    for (const page of [
      '/server/sites',
      '/server/deployments',
      '/server/logs',
      '/operations/releases',
      '/operations/jobs',
      '/data/backups',
      '/security',
      '/account/security',
    ])
      expect(isBoxOnlyPage(page)).toBe(false)
  })

  it('resolves the .html and trailing-slash forms of the same page', () => {
    expect(isBoxOnlyPage('/server/sites.html')).toBe(false)
    expect(isBoxOnlyPage('/server/sites/')).toBe(false)
    expect(isBoxOnlyPage('/server/team.html')).toBe(true)
  })

  it('keeps box pages away from members', () => {
    const boxPages = [
      '/server/database',
      '/server/team',
      '/server/firewall',
      '/server/ssh-keys',
      '/server/terminal',
      '/server/metrics',
      '/server/security',
      '/server/services',
      '/server/actions',
      '/server/diagnostics',
      '/serverless',
      '/serverless/secrets',
    ]
    for (const page of boxPages) expect(isBoxOnlyPage(page)).toBe(true)
  })

  it('is an allowlist: an unknown page is box-only by default', () => {
    expect(isBoxOnlyPage('/server/some-future-page')).toBe(true)
  })

  it('leaves shared assets alone', () => {
    for (const asset of ['/assets/app.css', '/main.js', '/icon.svg', '/logo.png'])
      expect(isBoxOnlyPage(asset)).toBe(false)
  })

  it('treats the root as handled elsewhere', () => {
    expect(isBoxOnlyPage('/')).toBe(false)
  })
})

describe('isTrustedMutationRequest', () => {
  it('rejects cross-site browser mutations and mismatched origins', () => {
    expect(
      isTrustedMutationRequest(
        new Request('https://cloud.example/api/auth/password/change', {
          method: 'POST',
          headers: { origin: 'https://evil.example' },
        }),
      ),
    ).toBe(false)
    expect(
      isTrustedMutationRequest(
        new Request('https://cloud.example/api/logout', {
          method: 'POST',
          headers: { 'sec-fetch-site': 'cross-site' },
        }),
      ),
    ).toBe(false)
  })

  it('allows same-origin browsers, safe reads, and header-light CLI requests', () => {
    expect(
      isTrustedMutationRequest(
        new Request('https://cloud.example/api/auth/password/change', {
          method: 'POST',
          headers: { origin: 'https://cloud.example' },
        }),
      ),
    ).toBe(true)
    expect(isTrustedMutationRequest(new Request('https://cloud.example/api/me'))).toBe(true)
    expect(
      isTrustedMutationRequest(
        new Request('https://cloud.example/api/auth/sessions/revoke-others', { method: 'POST' }),
      ),
    ).toBe(true)
  })
})

describe('resolveOidcDashboardOrigin', () => {
  it('uses explicit HTTPS configuration and safe loopback defaults', () => {
    expect(resolveOidcDashboardOrigin('127.0.0.1', 7676, {})).toBe('http://127.0.0.1:7676')
    expect(resolveOidcDashboardOrigin('0.0.0.0', 7676, { TS_CLOUD_DASHBOARD_ORIGIN: 'https://cloud.acme.test' })).toBe(
      'https://cloud.acme.test',
    )
    expect(resolveOidcDashboardOrigin('0.0.0.0', 7676, { TS_CLOUD_UI_DOMAIN: 'cloud.acme.test' })).toBe(
      'https://cloud.acme.test',
    )
  })

  it('refuses host-header fallback and insecure public or path origins', () => {
    expect(resolveOidcDashboardOrigin('0.0.0.0', 7676, {})).toBeUndefined()
    expect(
      resolveOidcDashboardOrigin('0.0.0.0', 7676, { TS_CLOUD_DASHBOARD_ORIGIN: 'http://cloud.acme.test' }),
    ).toBeUndefined()
    expect(
      resolveOidcDashboardOrigin('0.0.0.0', 7676, { TS_CLOUD_DASHBOARD_ORIGIN: 'https://cloud.acme.test/base' }),
    ).toBeUndefined()
  })
})

describe('canOpenDashboardPage', () => {
  it('preserves the legacy member allowlist during migration', () => {
    const legacy = {
      role: 'member' as const,
      sites: { blog: 'collaborator' as const },
      capabilities: ['runtime:read' as const],
      organizationSource: 'legacy',
    }
    expect(canOpenDashboardPage('/server/sites', legacy as any)).toBe(true)
    expect(canOpenDashboardPage('/account/security', legacy as any)).toBe(true)
    expect(canOpenDashboardPage('/server/metrics', legacy as any)).toBe(false)
  })

  it('maps organization capabilities to inspectable pages without exposing terminal', () => {
    const operator = {
      role: 'member' as const,
      sites: {},
      capabilities: [
        'project:read',
        'runtime:read',
        'runtime:logs',
        'backups:read',
        'runtime:restart',
        'automation:read',
      ] as const,
      organizationSource: 'invitation',
    }
    expect(canOpenDashboardPage('/server/metrics', operator as any)).toBe(true)
    expect(canOpenDashboardPage('/data/backups', operator as any)).toBe(true)
    expect(canOpenDashboardPage('/operations/jobs', operator as any)).toBe(true)
    expect(canOpenDashboardPage('/account/security', operator as any)).toBe(true)
    expect(canOpenDashboardPage('/server/terminal', operator as any)).toBe(false)
    expect(canOpenDashboardPage('/server/some-future-page', operator as any)).toBe(false)
  })
})
