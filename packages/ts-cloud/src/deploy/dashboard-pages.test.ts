import { describe, expect, it } from 'bun:test'
import { isBoxOnlyPage } from './local-dashboard-server'

describe('isBoxOnlyPage', () => {
  it('lets members open their own pages', () => {
    for (const page of ['/server/sites', '/server/deployments', '/server/logs'])
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
      '/server/backups',
      '/server/metrics',
      '/server/security',
      '/server/services',
      '/server/actions',
      '/server/diagnostics',
      '/serverless',
      '/serverless/secrets',
    ]
    for (const page of boxPages)
      expect(isBoxOnlyPage(page)).toBe(true)
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
