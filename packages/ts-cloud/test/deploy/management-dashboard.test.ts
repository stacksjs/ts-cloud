import type { CloudConfig } from '@stacksjs/ts-cloud'
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveManagementDashboardPort } from '@ts-cloud/core'
import { buildManagementDashboardArtifact, ensureManagementDashboard, LIVE_STAGE_DIR, resolveDashboardVersion, resolveUiSource } from '../../src/deploy/management-dashboard'

function cfg(): CloudConfig {
  return {
    project: { name: 'Acme', slug: 'acme' },
    environments: { production: { type: 'production' } },
    sites: { main: { root: 'dist', domain: 'acme.com', deploy: 'server', type: 'static' } },
  } as unknown as CloudConfig
}

const ENV_KEYS = ['TS_CLOUD_UI_PASSWORD', 'TS_CLOUD_UI_PUBLIC', 'TS_CLOUD_UI_USERNAME', 'TS_CLOUD_UI_DOMAIN', 'TS_CLOUD_UI_DISABLE', 'TS_CLOUD_UI_REALM', 'TS_CLOUD_UI_STATIC', 'TS_CLOUD_UI_VERSION', 'TS_CLOUD_UI_PORT']
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k] })

/**
 * A temp project dir with a local packages/ui checkout (so resolveUiSource
 * finds it) and a cloud config (so the live dashboard has something to ship).
 */
function repoCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tscloud-uirepo-'))
  mkdirSync(join(dir, 'packages', 'ui', 'pages'), { recursive: true })
  writeFileSync(join(dir, 'packages', 'ui', 'package.json'), '{"name":"@ts-cloud/ui"}')
  writeFileSync(join(dir, 'cloud.config.ts'), 'export default { project: { name: "Acme", slug: "acme" } }\n')
  return dir
}

/** Static mode is now opt-in; these tests exercise that path. */
function staticCwd(): string {
  process.env.TS_CLOUD_UI_STATIC = '1'
  return repoCwd()
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
  it('injects the dashboard with htpasswd when TS_CLOUD_UI_PASSWORD is set (static mode)', () => {
    const dir = staticCwd()
    try {
      process.env.TS_CLOUD_UI_PASSWORD = 'hunter2'
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      // Domain-keyed — the bare `dashboard` key would collide across attachTo tenants.
      const d = (c.sites as any)['dashboard-acme-com']
      expect(d.domain).toBe('dashboard.acme.com')
      expect(d.auth).toEqual({ username: 'admin', password: 'hunter2', realm: undefined })
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('auto-generates + persists a password when none is set (static mode)', () => {
    const dir = staticCwd()
    try {
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      const auth = (c.sites as any)['dashboard-acme-com'].auth
      expect(auth?.username).toBe('admin')
      expect(typeof auth?.password).toBe('string')
      expect(auth.password.length).toBeGreaterThan(16)
      // Persisted so the credential is stable across deploys and retrievable.
      const credFile = join(dir, '.ts-cloud', 'dashboard-credentials.json')
      expect(existsSync(credFile)).toBe(true)
      const saved = JSON.parse(readFileSync(credFile, 'utf8'))
      expect(saved.password).toBe(auth.password)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('reuses the persisted password on a second deploy (static mode)', () => {
    const dir = staticCwd()
    try {
      const first = (ensureManagementDashboard(cfg(), { cwd: dir }).sites as any)['dashboard-acme-com'].auth.password
      const second = (ensureManagementDashboard(cfg(), { cwd: dir }).sites as any)['dashboard-acme-com'].auth.password
      expect(second).toBe(first)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('serves WITHOUT auth only when TS_CLOUD_UI_PUBLIC is explicitly set (static mode)', () => {
    const dir = staticCwd()
    try {
      process.env.TS_CLOUD_UI_PUBLIC = '1'
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      expect((c.sites as any)['dashboard-acme-com'].auth).toBeUndefined()
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('honors TS_CLOUD_UI_DISABLE', () => {
    const dir = repoCwd()
    try {
      process.env.TS_CLOUD_UI_DISABLE = '1'
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      expect((c.sites as any)['dashboard-acme-com']).toBeUndefined()
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('honors TS_CLOUD_UI_DOMAIN override', () => {
    const dir = repoCwd()
    try {
      process.env.TS_CLOUD_UI_DOMAIN = 'panel.acme.io'
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      expect((c.sites as any)['dashboard-panel-acme-io'].domain).toBe('panel.acme.io')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('does nothing when no UI is available (static mode)', () => {
    process.env.TS_CLOUD_UI_STATIC = '1'
    const dir = mkdtempSync(join(tmpdir(), 'tscloud-noui2-'))
    try {
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      expect((c.sites as any)['dashboard-acme-com']).toBeUndefined()
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('ensureManagementDashboard (live, the default)', () => {
  it('injects a live service with no htpasswd in front of it', () => {
    const dir = repoCwd()
    try {
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      const d = (c.sites as any)['dashboard-acme-com']
      expect(d.domain).toBe('dashboard.acme.com')
      expect(d.port).toBe(deriveManagementDashboardPort('dashboard.acme.com'))
      expect(d.type).toBeUndefined()
      // The dashboard authenticates itself; a shared Basic-auth password in
      // front would block every collaborator at the door.
      expect(d.auth).toBeUndefined()
      expect(d.sharedPaths).toEqual(['.ts-cloud'])
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('ignores TS_CLOUD_UI_PASSWORD in live mode rather than half-applying it', () => {
    const dir = repoCwd()
    try {
      process.env.TS_CLOUD_UI_PASSWORD = 'hunter2'
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      expect((c.sites as any)['dashboard-acme-com'].auth).toBeUndefined()
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('stages the project cloud config and a package.json for the box', () => {
    const dir = repoCwd()
    try {
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      const root = (c.sites as any)['dashboard-acme-com'].root as string
      expect(root).toBe(LIVE_STAGE_DIR)

      const stage = join(dir, root)
      // The box resolves the same sites from this config.
      expect(existsSync(join(stage, 'cloud.config.ts'))).toBe(true)
      // Inlined, not copied: a real config imports things that do not exist on the box.
      const staged = readFileSync(join(stage, 'cloud.config.ts'), 'utf8')
      expect(staged).not.toMatch(/^\s*import\s/m)
      expect(staged).toContain('export default')
      const pkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'))
      expect(pkg.dependencies['@stacksjs/ts-cloud']).toBeTruthy()
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  /**
   * A real config imports things that do not exist on the box — Stacks' does
   * `import { servers } from '~/cloud/servers'` — so the config is shipped as
   * the already-resolved object, not as a copy of the source file.
   */
  it('inlines the resolved config, needing no config file on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tscloud-nocfgfile-'))
    try {
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      expect((c.sites as any)['dashboard-acme-com']).toBeTruthy()

      const staged = readFileSync(join(dir, LIVE_STAGE_DIR, 'cloud.config.ts'), 'utf8')
      expect(staged).not.toMatch(/^\s*import\s/m)
      expect(staged).toContain('export default')
      expect(staged).toContain('acme.com')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('needs no UI on the deploy host: the box installs it from npm', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tscloud-noui3-'))
    try {
      // No packages/ui here at all — live mode does not care.
      const c = ensureManagementDashboard(cfg(), { cwd: dir })
      expect((c.sites as any)['dashboard-acme-com']).toBeTruthy()
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('skips the live dashboard when the config has no project slug', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tscloud-noslug-'))
    try {
      const broken = { ...cfg(), project: {} } as any
      const c = ensureManagementDashboard(broken, { cwd: dir })
      expect((c.sites as any)['dashboard-acme-com']).toBeUndefined()
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('honors TS_CLOUD_UI_PORT', () => {
    const dir = repoCwd()
    try {
      process.env.TS_CLOUD_UI_PORT = '7800'
      const d = (ensureManagementDashboard(cfg(), { cwd: dir }).sites as any)['dashboard-acme-com']
      expect(d.port).toBe(7800)
      expect(d.start).toContain('--port 7800')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('pins the ts-cloud version the box installs', () => {
    const dir = repoCwd()
    try {
      process.env.TS_CLOUD_UI_VERSION = '0.7.21'
      ensureManagementDashboard(cfg(), { cwd: dir })
      const pkg = JSON.parse(readFileSync(join(dir, LIVE_STAGE_DIR, 'package.json'), 'utf8'))
      expect(pkg.dependencies['@stacksjs/ts-cloud']).toBe('0.7.21')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('resolveDashboardVersion', () => {
  it('defaults to a caret range on this package version, not `latest`', () => {
    // A box should run a dashboard matching the CLI that deployed it, rather
    // than drifting to whatever `latest` happens to be mid-deploy.
    expect(resolveDashboardVersion()).toMatch(/^\^\d+\.\d+\.\d+/)
  })

  it('honors an explicit override', () => {
    process.env.TS_CLOUD_UI_VERSION = 'next'
    try {
      expect(resolveDashboardVersion()).toBe('next')
    }
    finally { delete process.env.TS_CLOUD_UI_VERSION }
  })
})

describe('buildManagementDashboardArtifact', () => {
  /** A temp dir standing in for a pre-built UI root. */
  function builtRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tscloud-uiroot-'))
    writeFileSync(join(dir, 'index.html'), '<html></html>')
    return dir
  }

  it('packages an already-built UI root (build: false) into a tarball', () => {
    const root = builtRoot()
    try {
      const tarball = buildManagementDashboardArtifact({ root, build: false }, { cwd: process.cwd(), slug: 'acme', sha: 'abc123' })
      expect(tarball).toBeTruthy()
      expect(existsSync(tarball!)).toBe(true)
      expect(statSync(tarball!).size).toBeGreaterThan(0)
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('runs the build command before packaging', () => {
    const root = mkdtempSync(join(tmpdir(), 'tscloud-uibuild-'))
    try {
      // The "build" writes the artifact the tarball then captures.
      const tarball = buildManagementDashboardArtifact(
        { root, build: `printf '<html></html>' > "${join(root, 'index.html')}"` },
        { cwd: process.cwd(), slug: 'acme', sha: 'def456' },
      )
      expect(tarball).toBeTruthy()
      expect(existsSync(join(root, 'index.html'))).toBe(true)
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('returns null (no throw) when the build command fails', () => {
    const root = builtRoot()
    try {
      const tarball = buildManagementDashboardArtifact({ root, build: 'exit 1' }, { cwd: process.cwd(), slug: 'acme', sha: 'x' })
      expect(tarball).toBeNull()
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('returns null when the build output root does not exist', () => {
    const tarball = buildManagementDashboardArtifact({ root: '/no/such/dashboard/root', build: false }, { cwd: process.cwd(), slug: 'acme', sha: 'x' })
    expect(tarball).toBeNull()
  })

  it('returns null when no site/root is provided', () => {
    expect(buildManagementDashboardArtifact(undefined, { cwd: process.cwd(), slug: 'acme', sha: 'x' })).toBeNull()
  })
})
