import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { buildQuickDeployCi } from '../../src/deploy/quick-deploy'

function cfg(provider?: string, branch?: string): CloudConfig {
  return {
    project: { name: 'Acme', slug: 'acme' },
    sites: { main: { root: '.', repository: { url: 'git@github.com:acme/app.git', provider: provider as any, branch } } },
  } as unknown as CloudConfig
}

describe('buildQuickDeployCi', () => {
  it('generates a GitHub Actions workflow on push to the branch', () => {
    const ci = buildQuickDeployCi(cfg('github', 'main'))!
    expect(ci.path).toBe('.github/workflows/deploy.yml')
    expect(ci.provider).toBe('github')
    expect(ci.content).toContain('branches: [main]')
    expect(ci.content).toContain('bunx --bun ts-cloud deploy production')
    expect(ci.content).toContain('HETZNER_API_TOKEN')
  })

  it('generates GitLab CI', () => {
    const ci = buildQuickDeployCi(cfg('gitlab', 'release'), 'staging')!
    expect(ci.path).toBe('.gitlab-ci.yml')
    expect(ci.content).toContain('$CI_COMMIT_BRANCH == "release"')
    expect(ci.content).toContain('ts-cloud deploy staging')
  })

  it('generates Bitbucket Pipelines', () => {
    const ci = buildQuickDeployCi(cfg('bitbucket'))!
    expect(ci.path).toBe('bitbucket-pipelines.yml')
    expect(ci.content).toContain('branches:')
    expect(ci.content).toContain('main:') // default branch
  })

  it('defaults the branch to main', () => {
    expect(buildQuickDeployCi(cfg('github'))!.content).toContain('branches: [main]')
  })

  it('returns null for custom/unknown providers or no repo', () => {
    expect(buildQuickDeployCi(cfg('custom'))).toBeNull()
    expect(buildQuickDeployCi(cfg(undefined))).toBeNull()
    expect(buildQuickDeployCi({ project: { name: 'x', slug: 'x' }, sites: {} } as unknown as CloudConfig)).toBeNull()
  })
})
