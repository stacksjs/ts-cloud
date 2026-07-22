import { describe, expect, it } from 'bun:test'
import { draftFromConfiguredSite } from './application'

describe('application config import', () => {
  it('maps static and Laravel sites into the shared onboarding schema', () => {
    expect(
      draftFromConfiguredSite({
        siteSlug: 'docs',
        projectId: 'project',
        environmentId: 'prod',
        site: { type: 'static', root: 'dist', build: 'bun run build', domain: 'docs.example.com' },
      }),
    ).toMatchObject({
      slug: 'docs',
      build: { kind: 'static', publishDirectory: 'dist' },
      runtime: { target: 'server' },
      domain: { hostname: 'docs.example.com' },
    })
    expect(
      draftFromConfiguredSite({
        siteSlug: 'api',
        projectId: 'project',
        environmentId: 'prod',
        site: { type: 'laravel', phpVersion: '8.4', port: 8080 },
      }),
    ).toMatchObject({
      slug: 'api',
      build: { kind: 'server', runtime: 'php', runtimeVersion: '8.4' },
      runtime: { port: 8080 },
    })
  })
})
