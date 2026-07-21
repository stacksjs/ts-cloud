import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { buildQuickDeployCi, inferQuickDeployProvider } from '../../src/deploy/quick-deploy'

function cfg(provider?: string, branch?: string): CloudConfig {
  return {
    project: { name: 'Acme', slug: 'acme' },
    sites: { main: { root: '.', repository: { url: 'git@github.com:acme/app.git', provider: provider as any, branch } } },
  } as unknown as CloudConfig
}

function environmentCfg(deployBranch: string, provider: 'aws' | 'hetzner' = 'aws'): CloudConfig {
  return {
    project: { name: 'Acme', slug: 'acme' },
    cloud: { provider },
    environments: { production: { type: 'production', deployBranch, domain: 'docs.example.com' } },
    infrastructure: provider === 'hetzner' ? { compute: { runtime: 'bun' } } : undefined,
    sites: { docs: { root: 'dist' } },
  } as unknown as CloudConfig
}

describe('buildQuickDeployCi', () => {
  it('generates a GitHub Actions workflow on push to the branch', () => {
    const ci = buildQuickDeployCi(cfg('github', 'main'))!
    expect(ci.path).toBe('.github/workflows/deploy.yml')
    expect(ci.provider).toBe('github')
    expect(ci.content).toContain('branches: ["main"]')
    expect(ci.content).toContain("bunx --bun @stacksjs/ts-cloud deploy --env 'production' --yes")
    expect(ci.content).toContain("if: github.ref_name == 'main'")
    expect(ci.content).toContain('name: "production"')
    expect(ci.content).toContain('HCLOUD_TOKEN')
    expect(ci.content).toContain('HETZNER_API_TOKEN')
  })

  it('generates GitLab CI', () => {
    const ci = buildQuickDeployCi(cfg('gitlab', 'release'), 'staging')!
    expect(ci.path).toBe('.gitlab-ci.yml')
    expect(ci.content).toContain('$CI_COMMIT_BRANCH == "release"')
    expect(ci.content).toContain("@stacksjs/ts-cloud deploy --env 'staging' --yes")
  })

  it('generates Bitbucket Pipelines', () => {
    const ci = buildQuickDeployCi(cfg('bitbucket'))!
    expect(ci.path).toBe('bitbucket-pipelines.yml')
    expect(ci.content).toContain('branches:')
    expect(ci.content).toContain('"main":') // default branch
  })

  it('defaults the branch to main', () => {
    expect(buildQuickDeployCi(cfg('github'))!.content).toContain('branches: ["main"]')
  })

  it('prefers the environment deploy branch over the repository branch', () => {
    const config = cfg('github', 'legacy')
    config.environments = { production: { type: 'production', deployBranch: 'main' } }
    expect(buildQuickDeployCi(config)!.branch).toBe('main')
  })

  it('generates for artifact-based sites with a provider override', () => {
    const ci = buildQuickDeployCi(environmentCfg('main'), 'production', {
      provider: 'github',
      site: 'docs',
      skipDnsVerification: true,
      setup: 'pantry',
    })!
    expect(ci.provider).toBe('github')
    expect(ci.branch).toBe('main')
    expect(ci.content).toContain("--site 'docs'")
    expect(ci.content).toContain('--skip-dns-verification')
    expect(ci.content).toContain('--yes')
    expect(ci.content).toContain('home-lang/pantry/packages/action@main')
    expect(ci.content).not.toContain('bun install --frozen-lockfile')
    expect(ci.content).toContain('url: "https://docs.example.com"')
    expect(ci.content).not.toContain('Configure deployment SSH key')
  })

  it('configures an SSH key for Hetzner compute deploys', () => {
    const ci = buildQuickDeployCi(environmentCfg('main', 'hetzner'), 'production', {
      provider: 'github',
      sshPrivateKeySecret: 'PRODUCTION_SSH_KEY',
    })!
    expect(ci.content).toContain('name: Configure deployment SSH key')
    expect(ci.content).toContain('SSH_PRIVATE_KEY: ${{ secrets.PRODUCTION_SSH_KEY }}')
    expect(ci.content).toContain('PRODUCTION_SSH_KEY is required for Hetzner compute deployments')
    expect(ci.content).toContain('chmod 600 "$HOME/.ssh/id_ed25519"')
    expect(ci.content).toContain('ssh-keygen -y -f "$HOME/.ssh/id_ed25519"')
  })

  it('rejects unsafe SSH secret names before interpolating workflow YAML', () => {
    expect(() => buildQuickDeployCi(environmentCfg('main', 'hetzner'), 'production', {
      provider: 'github',
      sshPrivateKeySecret: 'KEY }} injected: true',
    })).toThrow("Invalid SSH private key secret name 'KEY }} injected: true'")
  })

  it('infers supported providers from common git remote formats', () => {
    expect(inferQuickDeployProvider('git@github.com:acme/app.git')).toBe('github')
    expect(inferQuickDeployProvider('https://gitlab.com/acme/app.git')).toBe('gitlab')
    expect(inferQuickDeployProvider('ssh://git@bitbucket.org/acme/app.git')).toBe('bitbucket')
    expect(inferQuickDeployProvider('ssh://git@example.com/acme/app.git')).toBeUndefined()
  })

  it('returns null for custom/unknown providers or no repo', () => {
    expect(buildQuickDeployCi(cfg('custom'))).toBeNull()
    expect(buildQuickDeployCi(cfg(undefined))).toBeNull()
    expect(buildQuickDeployCi({ project: { name: 'x', slug: 'x' }, sites: {} } as unknown as CloudConfig)).toBeNull()
  })
})
