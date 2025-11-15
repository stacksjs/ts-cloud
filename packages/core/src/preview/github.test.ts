import { describe, expect, it } from 'bun:test'
import { generatePreviewWorkflow, generateCleanupWorkflow, generateCostReportWorkflow } from './github'

describe('GitHub Workflow Generation', () => {
  describe('generatePreviewWorkflow', () => {
    it('should generate basic preview workflow', () => {
      const workflow = generatePreviewWorkflow()

      expect(workflow).toContain('name: Preview Environment')
      expect(workflow).toContain('pull_request:')
      expect(workflow).toContain('types: [opened, synchronize, reopened, closed]')
      expect(workflow).toContain('bun run cloud env:preview')
    })

    it('should include custom workflow name', () => {
      const workflow = generatePreviewWorkflow({
        workflowName: 'Custom Preview',
      })

      expect(workflow).toContain('name: Custom Preview')
    })

    it('should configure trigger type', () => {
      const workflow = generatePreviewWorkflow({
        trigger: 'push',
      })

      expect(workflow).toContain('push:')
      expect(workflow).not.toContain('pull_request:')
    })

    it('should configure branch filters', () => {
      const workflow = generatePreviewWorkflow({
        branches: ['main', 'develop', 'staging'],
      })

      expect(workflow).toContain('- main')
      expect(workflow).toContain('- develop')
      expect(workflow).toContain('- staging')
    })

    it('should configure AWS region', () => {
      const workflow = generatePreviewWorkflow({
        awsRegion: 'eu-west-1',
      })

      expect(workflow).toContain('AWS_REGION: eu-west-1')
    })

    it('should use IAM role when provided', () => {
      const workflow = generatePreviewWorkflow({
        awsRole: 'arn:aws:iam::123456789012:role/github-actions',
      })

      expect(workflow).toContain('role-to-assume: arn:aws:iam::123456789012:role/github-actions')
      expect(workflow).not.toContain('AWS_ACCESS_KEY_ID')
      expect(workflow).not.toContain('AWS_SECRET_ACCESS_KEY')
    })

    it('should use access keys when IAM role not provided', () => {
      const workflow = generatePreviewWorkflow()

      expect(workflow).toContain('AWS_ACCESS_KEY_ID')
      expect(workflow).toContain('AWS_SECRET_ACCESS_KEY')
      expect(workflow).not.toContain('role-to-assume')
    })

    it('should configure TTL', () => {
      const workflow = generatePreviewWorkflow({
        ttl: 48,
      })

      expect(workflow).toContain('TTL_HOURS: 48')
    })

    it('should include deploy step', () => {
      const workflow = generatePreviewWorkflow()

      expect(workflow).toContain('Deploy preview environment')
      expect(workflow).toContain('--branch=${{ github.head_ref }}')
      expect(workflow).toContain('--pr=${{ github.event.pull_request.number }}')
      expect(workflow).toContain('--commit=${{ github.event.pull_request.head.sha }}')
      expect(workflow).toContain('--ttl=${{ env.TTL_HOURS }}')
    })

    it('should include PR comment step', () => {
      const workflow = generatePreviewWorkflow()

      expect(workflow).toContain('Comment PR with preview URL')
      expect(workflow).toContain('actions/github-script@v7')
      expect(workflow).toContain('github.rest.issues.createComment')
      expect(workflow).toContain('Preview environment deployed')
    })

    it('should include destroy step', () => {
      const workflow = generatePreviewWorkflow()

      expect(workflow).toContain('Destroy preview environment')
      expect(workflow).toContain('github.event.action == \'closed\'')
      expect(workflow).toContain('--destroy')
    })

    it('should include cleanup job', () => {
      const workflow = generatePreviewWorkflow()

      expect(workflow).toContain('cleanup:')
      expect(workflow).toContain('Cleanup stale environments')
      expect(workflow).toContain('bun run cloud env:cleanup')
    })

    it('should use latest Bun version', () => {
      const workflow = generatePreviewWorkflow()

      expect(workflow).toContain('uses: oven-sh/setup-bun@v1')
      expect(workflow).toContain('bun-version: latest')
    })

    it('should include proper permissions', () => {
      const workflow = generatePreviewWorkflow()

      expect(workflow).toContain('permissions:')
      expect(workflow).toContain('id-token: write')
      expect(workflow).toContain('contents: read')
      expect(workflow).toContain('pull-requests: write')
    })
  })

  describe('generateCleanupWorkflow', () => {
    it('should generate basic cleanup workflow', () => {
      const workflow = generateCleanupWorkflow()

      expect(workflow).toContain('name: Cleanup Stale Preview Environments')
      expect(workflow).toContain('schedule:')
      expect(workflow).toContain('workflow_dispatch:')
      expect(workflow).toContain('bun run cloud env:cleanup')
    })

    it('should use default schedule', () => {
      const workflow = generateCleanupWorkflow()

      expect(workflow).toContain('cron: \'0 0 * * *\'') // Daily at midnight
    })

    it('should configure custom schedule', () => {
      const workflow = generateCleanupWorkflow({
        schedule: '0 2 * * *', // 2am daily
      })

      expect(workflow).toContain('cron: \'0 2 * * *\'')
    })

    it('should configure max age', () => {
      const workflow = generateCleanupWorkflow({
        maxAge: 72,
      })

      expect(workflow).toContain('--max-age=72')
    })

    it('should configure keep count', () => {
      const workflow = generateCleanupWorkflow({
        keepCount: 5,
      })

      expect(workflow).toContain('--keep-count=5')
    })

    it('should include default maxAge and keepCount', () => {
      const workflow = generateCleanupWorkflow()

      expect(workflow).toContain('--max-age=48')
      expect(workflow).toContain('--keep-count=10')
    })

    it('should include report step', () => {
      const workflow = generateCleanupWorkflow()

      expect(workflow).toContain('Report cleanup results')
      expect(workflow).toContain('bun run cloud env:list --status=destroyed')
    })

    it('should use ubuntu-latest runner', () => {
      const workflow = generateCleanupWorkflow()

      expect(workflow).toContain('runs-on: ubuntu-latest')
    })
  })

  describe('generateCostReportWorkflow', () => {
    it('should generate basic cost report workflow', () => {
      const workflow = generateCostReportWorkflow()

      expect(workflow).toContain('name: Preview Environment Cost Report')
      expect(workflow).toContain('schedule:')
      expect(workflow).toContain('workflow_dispatch:')
      expect(workflow).toContain('bun run cloud env:cost --json')
    })

    it('should use default schedule', () => {
      const workflow = generateCostReportWorkflow()

      expect(workflow).toContain('cron: \'0 8 * * 1\'') // Monday at 8am
    })

    it('should configure custom schedule', () => {
      const workflow = generateCostReportWorkflow({
        schedule: '0 9 * * 5', // Friday at 9am
      })

      expect(workflow).toContain('cron: \'0 9 * * 5\'')
    })

    it('should include cost generation step', () => {
      const workflow = generateCostReportWorkflow()

      expect(workflow).toContain('Generate cost report')
      expect(workflow).toContain('COST_JSON=$(bun run cloud env:cost --json)')
      expect(workflow).toContain('echo "cost_json=$COST_JSON" >> $GITHUB_OUTPUT')
    })

    it('should send to Slack when webhook provided', () => {
      const workflow = generateCostReportWorkflow({
        webhookUrl: 'https://hooks.slack.com/services/xxx/yyy/zzz',
      })

      expect(workflow).toContain('Send cost report to Slack')
      expect(workflow).toContain('SLACK_WEBHOOK_URL: https://hooks.slack.com/services/xxx/yyy/zzz')
      expect(workflow).toContain('curl -X POST')
      expect(workflow).toContain('Preview Environment Cost Report')
    })

    it('should echo cost when webhook not provided', () => {
      const workflow = generateCostReportWorkflow()

      expect(workflow).toContain('Send cost report')
      expect(workflow).toContain('echo "${{ steps.cost.outputs.cost_json }}"')
      expect(workflow).not.toContain('SLACK_WEBHOOK_URL')
      expect(workflow).not.toContain('curl')
    })

    it('should include proper permissions', () => {
      const workflow = generateCostReportWorkflow()

      expect(workflow).toContain('permissions:')
      expect(workflow).toContain('id-token: write')
      expect(workflow).toContain('contents: read')
    })
  })
})
