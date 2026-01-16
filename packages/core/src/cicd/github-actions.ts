/**
 * GitHub Actions Workflow Generator
 * Generate CI/CD workflows for GitHub Actions
 */

export interface GitHubActionsOptions {
  workflowName?: string
  trigger?: 'push' | 'pull_request' | 'workflow_dispatch' | 'schedule'
  branches?: string[]
  schedule?: string // Cron expression
  environments?: string[]
  awsRegion?: string
  awsRole?: string // OIDC role ARN
  nodeVersion?: string
  bunVersion?: string
  deployCommand?: string
  testCommand?: string
  buildCommand?: string
  lintCommand?: string
}

/**
 * Generate deployment workflow
 */
export function generateDeploymentWorkflow(options: GitHubActionsOptions = {}): string {
  const {
    workflowName = 'Deploy',
    trigger = 'push',
    branches = ['main'],
    environments = ['production'],
    awsRegion = 'us-east-1',
    awsRole,
    bunVersion = 'latest',
    deployCommand = 'bun run cloud deploy',
    testCommand = 'bun test',
    buildCommand = 'bun run build',
  } = options

  const usesOIDC = !!awsRole

  return `name: ${workflowName}

on:
  ${trigger}:
    branches:
${branches.map(b => `      - ${b}`).join('\n')}

env:
  AWS_REGION: ${awsRegion}
  BUN_VERSION: ${bunVersion}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        with:
          bun-version: \${{ env.BUN_VERSION }}

      - name: Install dependencies
        run: bun install

      - name: Run tests
        run: ${testCommand}

      - name: Build
        run: ${buildCommand}

  deploy:
    needs: test
    runs-on: ubuntu-latest
    ${environments.length > 0 ? `environment: ${environments[0]}` : ''}
    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        with:
          bun-version: \${{ env.BUN_VERSION }}

      - name: Install dependencies
        run: bun install

      ${usesOIDC
        ? `- name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${awsRole}
          aws-region: \${{ env.AWS_REGION }}`
        : `- name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ env.AWS_REGION }}`}

      - name: Deploy to AWS
        run: ${deployCommand}

      - name: Post-deployment tests
        run: bun run cloud test:smoke
`
}

/**
 * Generate multi-environment deployment workflow
 */
export function generateMultiEnvWorkflow(options: {
  environments: Array<{ name: string; branch: string }>
  awsRegion?: string
  awsRole?: string
}): string {
  const { environments, awsRegion = 'us-east-1', awsRole } = options
  const usesOIDC = !!awsRole

  return `name: Multi-Environment Deploy

on:
  push:
    branches:
${environments.map(env => `      - ${env.branch}`).join('\n')}

env:
  AWS_REGION: ${awsRegion}

jobs:
  determine-environment:
    runs-on: ubuntu-latest
    outputs:
      environment: \${{ steps.set-env.outputs.environment }}
    steps:
      - name: Determine environment
        id: set-env
        run: |
${environments.map((env, i) => `          ${i > 0 ? 'elif' : 'if'} [[ "\${{ github.ref }}" == "refs/heads/${env.branch}" ]]; then
            echo "environment=${env.name}" >> $GITHUB_OUTPUT`).join('\n')}
          fi

  deploy:
    needs: determine-environment
    runs-on: ubuntu-latest
    environment: \${{ needs.determine-environment.outputs.environment }}
    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1

      - name: Install dependencies
        run: bun install

      ${usesOIDC
        ? `- name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${awsRole}
          aws-region: \${{ env.AWS_REGION }}`
        : `- name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ env.AWS_REGION }}`}

      - name: Deploy
        run: bun run cloud deploy --env=\${{ needs.determine-environment.outputs.environment }}
`
}

/**
 * Generate PR preview workflow
 */
export function generatePRPreviewWorkflow(options: {
  awsRegion?: string
  awsRole?: string
  ttl?: number
} = {}): string {
  const { awsRegion = 'us-east-1', awsRole, ttl = 24 } = options
  const usesOIDC = !!awsRole

  return `name: PR Preview Environment

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

env:
  AWS_REGION: ${awsRegion}
  TTL_HOURS: ${ttl}

jobs:
  preview:
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
      pull-requests: write

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1

      - name: Install dependencies
        run: bun install

      ${usesOIDC
        ? `- name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${awsRole}
          aws-region: \${{ env.AWS_REGION }}`
        : `- name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ env.AWS_REGION }}`}

      - name: Deploy preview environment
        id: deploy
        run: |
          bun run cloud env:preview \\
            --branch=\${{ github.head_ref }} \\
            --pr=\${{ github.event.pull_request.number }} \\
            --commit=\${{ github.event.pull_request.head.sha }} \\
            --ttl=\${{ env.TTL_HOURS }}

          PREVIEW_URL=\$(bun run cloud env:preview --get-url \${{ github.head_ref }})
          echo "preview_url=\$PREVIEW_URL" >> $GITHUB_OUTPUT

      - name: Comment PR with preview URL
        if: steps.deploy.outputs.preview_url
        uses: actions/github-script@v7
        with:
          script: |
            const previewUrl = '\${{ steps.deploy.outputs.preview_url }}';
            const body = \`:rocket: Preview environment deployed!\\n\\n\` +
              \`**URL:** \${previewUrl}\\n\\n\` +
              \`**Branch:** \${{ github.head_ref }}\\n\` +
              \`**Commit:** \${{ github.event.pull_request.head.sha }}\\n\` +
              \`**Expires:** \${{ env.TTL_HOURS }} hours from now\\n\\n\` +
              \`_This preview will be automatically destroyed after \${{ env.TTL_HOURS }} hours or when the PR is closed._\`;

            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: body
            });

  cleanup:
    if: github.event.action == 'closed'
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1

      - name: Install dependencies
        run: bun install

      ${usesOIDC
        ? `- name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${awsRole}
          aws-region: \${{ env.AWS_REGION }}`
        : `- name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ env.AWS_REGION }}`}

      - name: Destroy preview environment
        run: |
          bun run cloud env:preview --destroy \\
            --branch=\${{ github.head_ref }} \\
            --pr=\${{ github.event.pull_request.number }}
`
}

/**
 * Generate scheduled deployment workflow
 */
export function generateScheduledWorkflow(options: {
  schedule: string
  environment: string
  awsRegion?: string
  awsRole?: string
}): string {
  const { schedule, environment, awsRegion = 'us-east-1', awsRole } = options
  const usesOIDC = !!awsRole

  return `name: Scheduled Deployment

on:
  schedule:
    - cron: '${schedule}'
  workflow_dispatch:

env:
  AWS_REGION: ${awsRegion}
  ENVIRONMENT: ${environment}

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: \${{ env.ENVIRONMENT }}
    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1

      - name: Install dependencies
        run: bun install

      ${usesOIDC
        ? `- name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${awsRole}
          aws-region: \${{ env.AWS_REGION }}`
        : `- name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ env.AWS_REGION }}`}

      - name: Deploy
        run: bun run cloud deploy --env=\${{ env.ENVIRONMENT }}
`
}

/**
 * Generate matrix deployment workflow (multiple regions/accounts)
 */
export function generateMatrixWorkflow(options: {
  matrix: Array<{ environment: string; region: string; account?: string }>
  awsRole?: string
}): string {
  const { matrix, awsRole } = options
  const usesOIDC = !!awsRole

  return `name: Matrix Deployment

on:
  workflow_dispatch:
    inputs:
      environments:
        description: 'Environments to deploy (comma-separated)'
        required: false
        default: 'all'

jobs:
  deploy:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
${matrix.map(m => `          - environment: ${m.environment}
            region: ${m.region}${m.account ? `\n            account: ${m.account}` : ''}`).join('\n')}
    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1

      - name: Install dependencies
        run: bun install

      ${usesOIDC
        ? `- name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${awsRole}
          aws-region: \${{ matrix.region }}`
        : `- name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ matrix.region }}`}

      - name: Deploy to \${{ matrix.environment }} (\${{ matrix.region }})
        run: bun run cloud deploy --env=\${{ matrix.environment }} --region=\${{ matrix.region }}
`
}
