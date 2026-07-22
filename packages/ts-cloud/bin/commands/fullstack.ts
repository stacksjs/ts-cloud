import type { CLI } from '@stacksjs/clapp'
import * as output from '../../src/utils/cli'
import { buildAndPushContainerImage } from '../../src/deploy/container-image'
import { createExistingStaticFullStackDependencies, deployExistingStaticFullStack, estimateExistingStaticFullStackMonthlyCost } from '../../src/deploy/fullstack-container'
import { getDnsProvider } from './shared'

export function registerFullStackCommands(app: CLI): void {
  app
    .command('container:artifact <repository>', 'Build, scan, push, and resolve an immutable ECR container artifact')
    .option('--context <path>', 'Docker build context', { default: '.' })
    .option('--dockerfile <path>', 'Dockerfile path')
    .option('--platform <platform>', 'Target platform', { default: 'linux/amd64' })
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--profile <name>', 'AWS credential profile')
    .action(
      async (
        repository: string,
        options: {
          context?: string
          dockerfile?: string
          platform?: 'linux/amd64' | 'linux/arm64'
          region?: string
          profile?: string
        },
      ) => {
        try {
          const result = await buildAndPushContainerImage({
            repository,
            context: options.context || '.',
            dockerfile: options.dockerfile,
            platform: options.platform,
            region: options.region,
            profile: options.profile,
          })
          output.success('Immutable container artifact published.')
          output.info(JSON.stringify(result, null, 2))
        } catch (error) {
          output.error(error instanceof Error ? error.message : String(error))
          process.exitCode = 1
        }
      },
    )

  app
    .command(
      'deploy:fullstack <distributionId> <alias>',
      'Plan or deploy an ECS/RDS/Redis/SQS/SES backend behind an existing static site',
    )
    .option('--name <name>', 'Application display name')
    .option('--slug <slug>', 'Application slug')
    .option('--image <digest-uri>', 'Immutable ECR image URI with @sha256 digest')
    .option('--stack <name>', 'Backend CloudFormation stack name')
    .option('--path <pattern>', 'CloudFront backend path', { default: '/api/*' })
    .option('--origin-id <id>', 'CloudFront origin ID')
    .option('--origin-domain <domain>', 'DNS name for the ALB origin')
    .option('--certificate-arn <arn>', 'ACM certificate matching the origin domain')
    .option('--dns-provider <provider>', 'External DNS provider (porkbun, godaddy, cloudflare, route53)')
    .option('--origin-secret-env <name>', 'Environment variable holding the CloudFront-to-ALB secret', {
      default: 'TS_CLOUD_ORIGIN_SECRET',
    })
    .option('--desired-count <count>', 'Baseline Fargate task count', { default: '1' })
    .option('--no-database', 'Do not provision PostgreSQL')
    .option('--no-cache', 'Do not provision Redis')
    .option('--no-queue', 'Do not provision SQS')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--profile <name>', 'AWS credential profile')
    .option('--skip-health-check', 'Skip the ALB health gate before CloudFront')
    .option('--apply', 'Provision and change live routing')
    .option('--confirm <text>', 'Exact distribution:path:stack confirmation')
    .action(
      async (
        distributionId: string,
        alias: string,
        options: {
          name?: string
          slug?: string
          image?: string
          stack?: string
          path?: string
          originId?: string
          originDomain?: string
          certificateArn?: string
          dnsProvider?: string
          originSecretEnv?: string
          desiredCount?: string
          database?: boolean
          cache?: boolean
          queue?: boolean
          region?: string
          profile?: string
          skipHealthCheck?: boolean
          apply?: boolean
          confirm?: string
        },
      ) => {
        try {
          if (!options.slug) throw new Error('--slug is required')
          if (!options.image) throw new Error('--image must be an immutable digest URI from container:artifact')
          const secretVariable = options.originSecretEnv || 'TS_CLOUD_ORIGIN_SECRET'
          const originVerifySecret = process.env[secretVariable]
          if (options.apply && !originVerifySecret)
            throw new Error(`${secretVariable} must contain a stable random CloudFront-to-ALB secret before apply`)
          const baseDependencies = createExistingStaticFullStackDependencies({
            region: options.region,
            profile: options.profile,
          })
          const dependencies =
            options.originDomain && options.apply
              ? { ...baseDependencies, dns: getDnsProvider(options.dnsProvider) }
              : baseDependencies
          const result = await deployExistingStaticFullStack(
            {
              name: options.name || options.slug,
              slug: options.slug,
              imageUri: options.image,
              distributionId,
              expectedAlias: alias,
              stackName: options.stack,
              pathPattern: options.path,
              originId: options.originId,
              originDomain: options.originDomain,
              certificateArn: options.certificateArn,
              originVerifySecret,
              desiredCount: Number(options.desiredCount) || 1,
              database: options.database !== false,
              cache: options.cache !== false,
              queue: options.queue !== false,
              region: options.region,
              profile: options.profile,
              skipHealthCheck: !!options.skipHealthCheck,
              apply: !!options.apply,
              confirm: options.confirm,
            },
            dependencies,
          )
          output.info(JSON.stringify(result, null, 2))
          if (result.applied)
            output.success('Full-stack backend is healthy and the CloudFront path patch was submitted.')
          else
            output.info(
              `Plan only. Apply with --confirm '${distributionId}:${result.distribution.pathPattern}:${result.stack.name}'.`,
            )
        } catch (error) {
          output.error(error instanceof Error ? error.message : String(error))
          process.exitCode = 1
        }
      },
    )

  app
    .command('deploy:fullstack:cost', 'Estimate the always-on full-stack backend baseline')
    .option('--desired-count <count>', 'Fargate task count', { default: '1' })
    .option('--multi-az-database', 'Estimate a two-instance database baseline')
    .action((options: { desiredCount?: string; multiAzDatabase?: boolean }) =>
      output.info(
        JSON.stringify(
          estimateExistingStaticFullStackMonthlyCost({
            desiredCount: Number(options.desiredCount) || 1,
            multiAzDatabase: !!options.multiAzDatabase,
          }),
          null,
          2,
        ),
      ),
    )
}
