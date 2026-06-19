/**
 * Quick Deploy (Forge's push-to-deploy): generate a CI pipeline for the app's
 * git provider that runs `cloud deploy` on push to the deploy branch. ts-cloud
 * deploys from the operator's machine/CI (git-clone-on-server), so the modern
 * equivalent of Forge's deploy webhook is a provider-native pipeline rather than
 * an inbound webhook — keyed off `site.repository.provider`.
 */
import type { CloudConfig } from '@ts-cloud/core'

export interface QuickDeployFile {
  /** Repo-relative path to write the pipeline to. */
  path: string
  /** File contents. */
  content: string
  /** Resolved git provider. */
  provider: 'github' | 'gitlab' | 'bitbucket'
  /** Branch the pipeline triggers on. */
  branch: string
}

/** First site that declares a git repository (quick deploy is repo-scoped). */
function primaryRepoSite(config: CloudConfig): { provider?: string, branch?: string } | undefined {
  const sites = config.sites || {}
  for (const site of Object.values(sites)) {
    if (site?.repository?.url)
      return { provider: site.repository.provider, branch: site.repository.branch }
  }
  return undefined
}

/**
 * Build the CI pipeline file for the config's git provider, or `null` when no
 * site has a github/gitlab/bitbucket repository (the `custom` provider and
 * webhook-less setups have no native pipeline to generate). `environment`
 * selects which `cloud deploy <env>` runs.
 */
export function buildQuickDeployCi(config: CloudConfig, environment: string = 'production'): QuickDeployFile | null {
  const repo = primaryRepoSite(config)
  const provider = repo?.provider
  if (provider !== 'github' && provider !== 'gitlab' && provider !== 'bitbucket')
    return null
  const branch = repo?.branch || 'main'
  const cmd = `bunx --bun ts-cloud deploy ${environment}`

  if (provider === 'github') {
    return {
      provider,
      branch,
      path: '.github/workflows/deploy.yml',
      content: `name: Deploy
on:
  push:
    branches: [${branch}]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      # Provide the provider credentials your config needs as repo secrets.
      - run: ${cmd}
        env:
          HETZNER_API_TOKEN: \${{ secrets.HETZNER_API_TOKEN }}
          AWS_ACCESS_KEY_ID: \${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
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
    - if: '$CI_COMMIT_BRANCH == "${branch}"'
  script:
    - bun install --frozen-lockfile
    - ${cmd}
  # Set HETZNER_API_TOKEN / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY as CI vars.
`,
    }
  }

  return {
    provider,
    branch,
    path: 'bitbucket-pipelines.yml',
    content: `pipelines:
  branches:
    ${branch}:
      - step:
          name: Deploy
          image: oven/bun:latest
          script:
            - bun install --frozen-lockfile
            - ${cmd}
          # Set HETZNER_API_TOKEN / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY as repo vars.
`,
  }
}
