/**
 * GitHub integration for preview environments
 * Generates GitHub Actions workflows for automated preview deployments
*/

export interface GitHubWorkflowOptions {
  workflowName?: string
  trigger?: 'pull_request' | 'push' | 'workflow_dispatch'
  branches?: string[]
  awsRegion?: string
  awsRole?: string
  configFile?: string
  ttl?: number
}

/**
 * Generate GitHub Actions workflow for preview environments
*/
export function generatePreviewWorkflow(options: GitHubWorkflowOptions = {}): string {
  const {
    workflowName = 'Preview Environment',
    trigger = 'pull_request',
    branches = ['main', 'develop'],
    awsRegion = 'us-east-1',
    awsRole,
    configFile = 'cloud.config.ts',
    ttl = 24,
  } = options

  return `name: ${workflowName}

on:
  ${trigger}:
    types: [opened, synchronize, reopened, closed]
    branches:
${branches.map(b => `      - ${b}`).join('\n')}

env:
  AWS_REGION: ${awsRegion}
  TTL_HOURS: ${ttl}

jobs:
  preview:
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
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      ${awsRole
        ? `- name: Configure AWS credentials
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
        if: github.event.action != 'closed'
        id: deploy
        run: |
          # Create preview environment
          bun run cloud env:preview \\
            --branch=\${{ github.head_ref }} \\
            --pr=\${{ github.event.pull_request.number }} \\
            --commit=\${{ github.event.pull_request.head.sha }} \\
            --ttl=\${{ env.TTL_HOURS }}

          # Get preview URL
          PREVIEW_URL=\$(bun run cloud env:preview --get-url \${{ github.head_ref }})
          echo "preview_url=\$PREVIEW_URL" >> $GITHUB_OUTPUT

      - name: Comment PR with preview URL
        if: github.event.action != 'closed' && steps.deploy.outputs.preview_url
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

      - name: Destroy preview environment
        if: github.event.action == 'closed'
        run: |
          bun run cloud env:preview --destroy \\
            --branch=\${{ github.head_ref }} \\
            --pr=\${{ github.event.pull_request.number }}

      - name: Comment PR on destruction
        if: github.event.action == 'closed'
        uses: actions/github-script@v7
        with:
          script: |
            const body = ':wastebasket: Preview environment destroyed.';
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: body
            });

  # Cleanup stale preview environments
  cleanup:
    runs-on: ubuntu-latest
    if: github.event.action == 'closed'
    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      ${awsRole
        ? `- name: Configure AWS credentials
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

      - name: Cleanup stale environments
        run: |
          # Clean up environments older than TTL
          bun run cloud env:cleanup --max-age=\${{ env.TTL_HOURS }}
`
}

/**
 * Generate scheduled cleanup workflow
*/
export function generateCleanupWorkflow(options: {
  schedule?: string
  maxAge?: number
  keepCount?: number
} = {}): string {
  const {
    schedule = '0 0 * * *', // Daily at midnight
    maxAge = 48, // 48 hours
    keepCount = 10,
  } = options

  return `name: Cleanup Stale Preview Environments

on:
  schedule:
    - cron: '${schedule}'
  workflow_dispatch:

env:
  AWS_REGION: us-east-1

jobs:
  cleanup:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ env.AWS_REGION }}

      - name: Cleanup stale environments
        run: |
          bun run cloud env:cleanup \\
            --max-age=${maxAge} \\
            --keep-count=${keepCount}

      - name: Report cleanup results
        run: |
          bun run cloud env:list --status=destroyed
`
}

/**
 * Generate cost report workflow
*/
export function generateCostReportWorkflow(options: {
  schedule?: string
  webhookUrl?: string
} = {}): string {
  const {
    schedule = '0 8 * * 1', // Weekly on Monday at 8am
    webhookUrl,
  } = options

  return `name: Preview Environment Cost Report

on:
  schedule:
    - cron: '${schedule}'
  workflow_dispatch:

env:
  AWS_REGION: us-east-1

jobs:
  cost-report:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ env.AWS_REGION }}

      - name: Generate cost report
        id: cost
        run: |
          COST_JSON=\$(bun run cloud env:cost --json)
          echo "cost_json=\$COST_JSON" >> $GITHUB_OUTPUT

      - name: Send cost report${webhookUrl ? ' to Slack' : ''}
        ${webhookUrl
          ? `env:
          SLACK_WEBHOOK_URL: ${webhookUrl}
        run: |
          curl -X POST -H 'Content-type: application/json' \\
            --data '{"text":"Preview Environment Cost Report\\n\${{ steps.cost.outputs.cost_json }}"}' \\
            \$SLACK_WEBHOOK_URL`
          : `run: |
          echo "\${{ steps.cost.outputs.cost_json }}"`}
`
}
