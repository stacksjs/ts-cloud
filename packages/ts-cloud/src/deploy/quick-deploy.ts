/**
 * Quick Deploy (Forge's push-to-deploy): generate a CI pipeline for the app's
 * git provider that runs `cloud deploy` on push to the deploy branch. ts-cloud
 * deploys from the operator's machine/CI, so the modern equivalent of Forge's
 * deploy webhook is a provider-native pipeline rather than an inbound webhook.
 * The provider can come from a configured site repository or from the CLI's
 * origin-remote detection, while the branch belongs to the target environment.
 */
import type { CloudConfig } from '@ts-cloud/core'

export type QuickDeployProvider = 'github' | 'gitlab' | 'bitbucket'

export interface QuickDeployOptions {
  /** Provider override, normally inferred from the origin remote by the CLI. */
  provider?: QuickDeployProvider
  /** Limit the generated deploy command to one configured site. */
  site?: string
  /** Skip DNS verification when DNS is already managed or attached elsewhere. */
  skipDnsVerification?: boolean
  /** Dependency setup used by the generated GitHub Actions workflow. */
  setup?: 'bun' | 'pantry'
}

export interface QuickDeployFile {
  /** Repo-relative path to write the pipeline to. */
  path: string
  /** File contents. */
  content: string
  /** Resolved git provider. */
  provider: QuickDeployProvider
  /** Branch the pipeline triggers on. */
  branch: string
}

/** First site that declares a git repository (legacy provider/branch fallback). */
function primaryRepoSite(config: CloudConfig): { provider?: string, branch?: string } | undefined {
  const sites = config.sites || {}
  for (const site of Object.values(sites)) {
    if (site?.repository?.url)
      return { provider: site.repository.provider, branch: site.repository.branch }
  }
  return undefined
}

/** Resolve a supported CI provider from a git remote URL. */
export function inferQuickDeployProvider(remoteUrl: string): QuickDeployProvider | undefined {
  const normalized = remoteUrl.trim().toLowerCase()
  if (normalized.includes('github.com')) return 'github'
  if (normalized.includes('gitlab.com')) return 'gitlab'
  if (normalized.includes('bitbucket.org')) return 'bitbucket'
  return undefined
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function githubExpressionString(value: string): string {
  return value.replace(/'/g, `''`)
}

function deployCommand(environment: string, options: QuickDeployOptions): string {
  const parts = [
    'bunx --bun @stacksjs/ts-cloud deploy',
    '--env',
    shellArg(environment),
  ]
  if (options.site) parts.push('--site', shellArg(options.site))
  if (options.skipDnsVerification) parts.push('--skip-dns-verification')
  parts.push('--yes')
  return parts.join(' ')
}

/**
 * Build the CI pipeline file for the resolved git provider, or `null` when no
 * github/gitlab/bitbucket provider is available. `environment` selects both the
 * environment-specific deploy branch and the `cloud deploy --env` target.
 */
export function buildQuickDeployCi(
  config: CloudConfig,
  environment: string = 'production',
  options: QuickDeployOptions = {},
): QuickDeployFile | null {
  const repo = primaryRepoSite(config)
  const provider = options.provider || repo?.provider
  if (provider !== 'github' && provider !== 'gitlab' && provider !== 'bitbucket')
    return null
  const environmentConfig = config.environments?.[environment as keyof typeof config.environments]
  const branch = environmentConfig?.deployBranch || repo?.branch || 'main'
  const cmd = deployCommand(environment, options)
  const yamlBranch = JSON.stringify(branch)
  const yamlEnvironment = JSON.stringify(environment)
  const environmentUrl = environmentConfig?.domain
    ? environmentConfig.domain.startsWith('http') ? environmentConfig.domain : `https://${environmentConfig.domain}`
    : undefined
  const githubEnvironmentUrl = environmentUrl ? `\n      url: ${JSON.stringify(environmentUrl)}` : ''
  const githubSetup = options.setup === 'pantry'
    ? `      - name: Setup Pantry
        uses: home-lang/pantry/packages/action@main`
    : `      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile`

  if (provider === 'github') {
    return {
      provider,
      branch,
      path: '.github/workflows/deploy.yml',
      content: `name: Deploy ${environment}
run-name: Deploy ${environment} from \${{ github.ref_name }}

on:
  push:
    branches: [${yamlBranch}]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ts-cloud-${environment}
  cancel-in-progress: false

jobs:
  deploy:
    if: github.ref_name == '${githubExpressionString(branch)}'
    runs-on: ubuntu-latest
    environment:
      name: ${yamlEnvironment}${githubEnvironmentUrl}
    steps:
      - uses: actions/checkout@v6
${githubSetup}
      # Provide the provider credentials your config needs as repo secrets.
      - run: ${cmd}
        env:
          HCLOUD_TOKEN: \${{ secrets.HCLOUD_TOKEN }}
          HETZNER_API_TOKEN: \${{ secrets.HETZNER_API_TOKEN }}
          AWS_ACCESS_KEY_ID: \${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          TS_CLOUD_UI_DISABLE: '1'
`,
    }
  }

  if (provider === 'gitlab') {
    return {
      provider,
      branch,
      path: '.gitlab-ci.yml',
      content: `deploy:
  image: oven/bun:latest
  rules:
    - if: '$CI_COMMIT_BRANCH == ${yamlBranch}'
  environment: ${environment}
  script:
    - bun install --frozen-lockfile
    - ${cmd}
  # Set HCLOUD_TOKEN / HETZNER_API_TOKEN / AWS credentials as CI variables.
`,
    }
  }

  return {
    provider,
    branch,
    path: 'bitbucket-pipelines.yml',
    content: `pipelines:
  branches:
    ${yamlBranch}:
      - step:
          name: Deploy ${environment}
          deployment: ${environment}
          image: oven/bun:latest
          script:
            - bun install --frozen-lockfile
            - ${cmd}
          # Set HCLOUD_TOKEN / HETZNER_API_TOKEN / AWS credentials as repo variables.
`,
  }
}
