import { describe, expect, it } from 'bun:test'
import { scopeCloudConfig, scopeDashboardData } from './dashboard-scope'

const admin = { role: 'admin' as const, sites: {} }
const member = { role: 'member' as const, sites: { blog: 'owner' as const } }

/** Data shaped like `resolveServerDashboardData` output, for two tenants. */
function fixture(): Record<string, any> {
  return {
    mode: 'server',
    environment: 'production',
    server: { name: 'box', ip: '203.0.113.10', provider: 'hetzner' },
    systemMetrics: { load: 1.2, memTotalMb: 8192 },
    services: [{ name: 'mysql', status: 'running' }],
    sshKeys: [{ name: 'chris', fingerprint: 'SHA256:abc' }],
    backup: { enabled: true, destination: 's3://secret-bucket' },
    sites: [
      { name: 'blog', domain: 'blog.example.com' },
      { name: 'secret', domain: 'secret.example.com' },
    ],
    sitesDetail: [
      { name: 'blog', domain: 'blog.example.com', envKeys: ['BLOG_KEY'] },
      { name: 'secret', domain: 'secret.example.com', envKeys: ['SECRET_KEY'] },
    ],
    workers: [
      { name: 'blog:default', site: 'blog' },
      { name: 'secret:default', site: 'secret' },
    ],
    serverDeploymentsDetail: [
      { site: 'blog', sha: 'aaa1111', status: 'ok' },
      { site: 'secret', sha: 'bbb2222', status: 'ok' },
    ],
    serverLogs: [
      { source: 'acme-blog', message: 'blog line' },
      { source: 'acme-blog-queues', message: 'blog queue line' },
      { source: 'acme-secret', message: 'secret line' },
      { source: 'nginx', message: 'box line' },
      { source: 'mysql', message: 'db line' },
    ],
    security: {
      ports: [{ proto: 'tcp', listen: '0.0.0.0:22' }],
      firewall: { status: 'active', rules: ['ALLOW 22/tcp'] },
      authEvents: [{ message: 'Failed password for root' }],
      tlsCertificates: [
        { domain: 'blog.example.com', daysRemaining: 60 },
        { domain: 'secret.example.com', daysRemaining: 12 },
      ],
    },
    diagnostics: [
      { name: 'Live server probe', status: 'pass' },
      { name: 'Firewall', status: 'pass' },
      { name: 'TLS certificates', status: 'pass' },
      { name: 'Route conflicts', status: 'pass' },
    ],
    activity: [
      { type: 'deploy', title: 'blog deployed aaa1111' },
      { type: 'deploy', title: 'secret deployed bbb2222' },
      { type: 'log', title: 'acme-secret error' },
      { type: 'log', title: 'acme-blog error' },
      { type: 'ssh', title: 'chris authorized' },
    ],
  }
}

const scopeMember = (): Record<string, any> => scopeDashboardData(fixture(), { user: member, slug: 'acme' })

describe('scopeDashboardData', () => {
  it('passes an admin the full payload untouched', () => {
    const data = fixture()
    expect(scopeDashboardData(data, { user: admin, slug: 'acme' })).toBe(data)
  })

  it('never leaks another tenant anywhere in a member payload', () => {
    // The strongest check: the other tenant's name must not survive anywhere in
    // the serialized response, whatever shape a future field takes.
    const serialized = JSON.stringify(scopeMember())
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('bbb2222')
  })

  it('drops the box-level surface for a member', () => {
    const scoped = scopeMember()
    expect(scoped.systemMetrics).toBeUndefined()
    expect(scoped.services).toBeUndefined()
    expect(scoped.sshKeys).toBeUndefined()
    expect(scoped.backup).toBeUndefined()
    expect(scoped.security.ports).toEqual([])
    expect(scoped.security.firewall).toBeNull()
    expect(scoped.security.authEvents).toEqual([])
  })

  it('blanks the box identity rather than omitting it, so no sample name is shown', () => {
    // The pages fall back to a placeholder server name when `server` is absent,
    // which would invent a box for the member.
    const scoped = scopeMember()
    expect(scoped.server).toEqual({ name: '' })
    expect(JSON.stringify(scoped)).not.toContain('203.0.113.10')
    expect(JSON.stringify(scoped)).not.toContain('hetzner')
  })

  it("keeps only the member's sites, workers and deployments", () => {
    const scoped = scopeMember()
    expect(scoped.sites.map((s: any) => s.name)).toEqual(['blog'])
    expect(scoped.sitesDetail.map((s: any) => s.name)).toEqual(['blog'])
    expect(scoped.workers.map((w: any) => w.site)).toEqual(['blog'])
    expect(scoped.serverDeploymentsDetail.map((d: any) => d.site)).toEqual(['blog'])
  })

  it("keeps the member's own app, queue and daemon logs but no box logs", () => {
    const sources = scopeMember().serverLogs.map((l: any) => l.source)
    expect(sources).toEqual(['acme-blog', 'acme-blog-queues'])
  })

  it('keeps only certificates for domains the member runs', () => {
    expect(scopeMember().security.tlsCertificates.map((c: any) => c.domain)).toEqual(['blog.example.com'])
  })

  it("filters activity to the member's sites and drops ssh events", () => {
    const activity = scopeMember().activity
    expect(activity.map((a: any) => a.title)).toEqual(['blog deployed aaa1111', 'acme-blog error'])
  })

  it('keeps only site-relevant diagnostics', () => {
    expect(scopeMember().diagnostics.map((d: any) => d.name)).toEqual(['TLS certificates', 'Route conflicts'])
  })

  it('gives a member with no grants an empty but well-formed payload', () => {
    const scoped = scopeDashboardData(fixture(), { user: { role: 'member', sites: {} }, slug: 'acme' })
    expect(scoped.sites).toEqual([])
    expect(scoped.serverLogs).toEqual([])
    expect(scoped.activity).toEqual([])
    expect(scoped.serverLogsEmptyReason).toBeTruthy()
  })

  it('tolerates missing collections', () => {
    const scoped = scopeDashboardData({ mode: 'server' }, { user: member, slug: 'acme' })
    expect(scoped.sites).toEqual([])
    expect(scoped.security.tlsCertificates).toEqual([])
  })
})

describe('scopeCloudConfig', () => {
  const config = {
    project: { name: 'acme', slug: 'acme', region: 'fsn1' },
    compute: { provider: 'hetzner', sshKeys: [{ fingerprint: 'SHA256:abc' }] },
    sites: { blog: { domain: 'blog.example.com' }, secret: { domain: 'secret.example.com' } },
  }

  it('leaves an admin config untouched', () => {
    expect(scopeCloudConfig(config, admin)).toBe(config)
  })

  it('drops compute details and other tenants for a member', () => {
    const scoped = scopeCloudConfig(config, member)
    expect(scoped.compute).toBeUndefined()
    expect(Object.keys(scoped.sites)).toEqual(['blog'])
    expect(JSON.stringify(scoped)).not.toContain('SHA256:abc')
    expect(JSON.stringify(scoped)).not.toContain('secret')
  })
})
