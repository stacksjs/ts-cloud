import { describe, expect, it } from 'bun:test'
import { renderLoginPage } from './dashboard-login-page'

describe('renderLoginPage', () => {
  it('renders enabled SSO choices before the local recovery path', () => {
    const page = renderLoginPage(false, [{ slug: 'workforce', name: 'Acme Workforce' }])
    expect(page).toContain('href="/auth/oidc/workforce/start?return=%2F"')
    expect(page).toContain('Continue with Acme Workforce')
    expect(page).toContain('or use local recovery')
    expect(page.indexOf('Continue with Acme Workforce')).toBeLessThan(page.indexOf('name="username"'))
  })

  it('escapes provider labels and surfaces callback failure accessibly', () => {
    const page = renderLoginPage(false, [{ slug: 'safe-slug', name: '<script>alert(1)</script>' }])
    expect(page).not.toContain('Continue with <script>')
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(page).toContain('role="alert" aria-live="polite"')
    expect(page).toContain("has('sso_error')")
  })
})
