import type { CloudConfig } from '@stacksjs/ts-cloud'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureManagementDashboard, resolveUiSource } from '../../src/deploy/management-dashboard'

function cfg(): CloudConfig {
  return {
    project: { name: 'Acme', slug: 'acme' },
    environments: { production: { type: 'production' } },
    sites: { main: { root: 'dist', domain: 'acme.com', deploy: 'server', type: 'static' } },
  } as unknown as CloudConfig
}

const ENV_KEYS = ['TS_CLOUD_UI_PASSWORD', 'TS_CLOUD_UI_USERNAME', 'TS_CLOUD_UI_DOMAIN', 'TS_CLOUD_UI_DISABLE', 'TS_CLOUD_UI_REALM']
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k] })

/** A temp project dir with a local packages/ui checkout so resolveUiSource finds it. */
function repoCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tscloud-uirepo-'))
  mkdirSync(join(dir, 'packages', 'ui', 'pages'), { recursive: true })
  writeFileSync(join(dir, 'packages', 'ui', 'package.json'), '{"name":"@ts-cloud/ui"}')
  return dir
}

describe('resolveUiSource', () => {
  it('detects a local packages/ui checkout and builds it', () => {
    const dir = repoCwd()
    try {
      expect(resolveUiSource(dir)).toEqual({ uiRoot: 'packages/ui/dist', build: 'cd packages/ui && bun install && bun run build' })
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('returns null when no UI is available', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tscloud-noui-'))
    try {
      expect(resolveUiSource(dir)).toBeNull()
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('ensureManagementDashboard', () => {
  it('injects the dashboard with htpasswd when TS_CLOUD_UI_PASSWORD is set', () => {
    const dir = repoCwd()
    try {
      process.env.TS_CLOUD_UI_PASSWORD = 'hunter2'
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      const d = (c.sites as any).dashboard
      expect(d.domain).toBe('dashboard.acme.com')
      expect(d.auth).toEqual({ username: 'admin', password: 'hunter2', realm: undefined })
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('injects WITHOUT auth when no password is set', () => {
    const dir = repoCwd()
    try {
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      expect((c.sites as any).dashboard.auth).toBeUndefined()
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('honors TS_CLOUD_UI_DISABLE', () => {
    const dir = repoCwd()
    try {
      process.env.TS_CLOUD_UI_DISABLE = '1'
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      expect((c.sites as any).dashboard).toBeUndefined()
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('honors TS_CLOUD_UI_DOMAIN override', () => {
    const dir = repoCwd()
    try {
      process.env.TS_CLOUD_UI_DOMAIN = 'panel.acme.io'
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      expect((c.sites as any).dashboard.domain).toBe('panel.acme.io')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('does nothing when no UI is available', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tscloud-noui2-'))
    try {
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      expect((c.sites as any).dashboard).toBeUndefined()
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
