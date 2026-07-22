import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveSiteBucketName, resolveSiteStackName } from '@ts-cloud/core'
import { ACMClient } from '../aws/acm'
import { CloudFormationClient } from '../aws/cloudformation'
import { invalidateCache, uploadStaticFiles } from './static-site'
import { generateExternalDnsStaticSiteTemplate } from './static-site-external-dns'

export interface SiteStackMigrationPlan {
  oldStackName: string
  newStackName: string
  oldBucket: string
  newBucket: string
  distributionId: string
  oacId: string
  certificateArn: string
  templatePath: string
  importPath: string
}

export interface SiteStackMigrationOptions {
  config: CloudConfig
  environment: EnvironmentType
  siteKey: string
  oldStackName: string
  oldBucket: string
  distributionId: string
  oacId: string
  outputDir: string
}

export function buildSiteStackMigrationPlan(
  options: SiteStackMigrationOptions & { certificateArn?: string },
): SiteStackMigrationPlan {
  const { config, environment, siteKey, oldStackName, oldBucket, distributionId, oacId, outputDir } = options
  const site = config.sites?.[siteKey]
  if (!site?.domain) {
    throw new Error(`Site '${siteKey}' has no domain configured`)
  }

  const newStackName = resolveSiteStackName(config, siteKey, site, environment)
  const newBucket = resolveSiteBucketName(config.project.slug, environment, siteKey, site.bucket)
  const compute = config.infrastructure?.compute
  const domain = site.domain
  const domainParts = domain.split('.')
  const isApex = domainParts.length === 2
  const wwwDomain = isApex ? `www.${domain}` : undefined
  const aliases = wwwDomain ? [domain, wwwDomain] : [domain]

  const certificateArn = options.certificateArn || site.certificateArn || ''

  const template = generateExternalDnsStaticSiteTemplate({
    bucketName: newBucket,
    domain,
    aliases,
    certificateArn: certificateArn || 'PLACEHOLDER_CERT',
    defaultRootObject: 'index.html',
    errorDocument: '404.html',
    passthroughUrls: !!site.installScript,
    dynamicApp: !!compute?.cloudFrontOriginDomain,
    computeOriginDomain: compute?.cloudFrontOriginDomain,
    computeOriginPort: compute?.cloudFrontOriginPort ?? 3000,
    computeOriginId: compute?.cloudFrontOriginId ?? `${config.project.slug}-site-ec2`,
    retainOnStackDelete: false,
  })

  const importResources = [
    {
      ResourceType: 'AWS::CloudFront::Distribution',
      LogicalResourceId: 'CloudFrontDistribution',
      ResourceIdentifier: { Id: distributionId },
    },
    {
      ResourceType: 'AWS::CloudFront::OriginAccessControl',
      LogicalResourceId: 'CloudFrontOAC',
      ResourceIdentifier: { Id: oacId },
    },
    {
      ResourceType: 'AWS::S3::Bucket',
      LogicalResourceId: 'S3Bucket',
      ResourceIdentifier: { BucketName: newBucket },
    },
  ]

  mkdirSync(outputDir, { recursive: true })

  // Import template: no Outputs (added on follow-up deploy); S3BucketPolicy created after import.
  const importTemplate = JSON.parse(JSON.stringify(template)) as {
    Resources: Record<string, unknown>
    Outputs?: unknown
  }
  delete importTemplate.Outputs
  delete importTemplate.Resources.S3BucketPolicy
  for (const resource of Object.values(importTemplate.Resources) as Array<{
    DeletionPolicy?: string
    UpdateReplacePolicy?: string
  }>) {
    resource.DeletionPolicy = 'Retain'
    resource.UpdateReplacePolicy = 'Retain'
  }

  const templatePath = join(outputDir, 'site-stack-template.json')
  const importTemplatePath = join(outputDir, 'site-stack-import-template.json')
  const importPath = join(outputDir, 'site-stack-import.json')
  writeFileSync(templatePath, JSON.stringify(template, null, 2))
  writeFileSync(importTemplatePath, JSON.stringify(importTemplate, null, 2))
  writeFileSync(importPath, JSON.stringify(importResources, null, 2))

  return {
    oldStackName,
    newStackName,
    oldBucket,
    newBucket,
    distributionId,
    oacId,
    certificateArn,
    templatePath,
    importPath,
  }
}

export async function resolveSiteCertificateArn(domain: string, region = 'us-east-1'): Promise<string> {
  const acm = new ACMClient(region)
  const existing = await acm.findCertificateByDomain(domain)
  if (existing?.CertificateArn && existing.Status === 'ISSUED') {
    return existing.CertificateArn
  }
  throw new Error(`No issued ACM certificate found for ${domain} in ${region}`)
}

export async function deployRetainPoliciesToStack(
  stackName: string,
  templatePath: string,
  region: string,
): Promise<void> {
  const templateBody = readFileSync(templatePath, 'utf8')
  const template = JSON.parse(templateBody) as {
    Resources: Record<string, { DeletionPolicy?: string; UpdateReplacePolicy?: string }>
  }
  for (const resource of Object.values(template.Resources)) {
    resource.DeletionPolicy = 'Retain'
    resource.UpdateReplacePolicy = 'Retain'
  }

  const cfn = new CloudFormationClient(region)
  const exists = await cfn
    .describeStacks({ stackName })
    .then((r) => (r.Stacks?.length ?? 0) > 0)
    .catch(() => false)
  if (!exists) {
    throw new Error(`Stack ${stackName} does not exist`)
  }

  await cfn.updateStack({
    stackName,
    templateBody: JSON.stringify(template),
    capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
  })
  await cfn.waitForStack(stackName, 'stack-update-complete')
}

export async function deleteStackRetainResources(stackName: string, region: string): Promise<void> {
  const cfn = new CloudFormationClient(region)
  await cfn.deleteStack(stackName)
  await cfn.waitForStack(stackName, 'stack-delete-complete')
}

export async function importSiteStack(plan: SiteStackMigrationPlan, region: string): Promise<void> {
  const { execSync } = await import('node:child_process')
  const templateBody = readFileSync(plan.templatePath, 'utf8').replace('PLACEHOLDER_CERT', plan.certificateArn)
  const importTemplatePath = join(dirname(plan.templatePath), 'site-stack-import-template.json')
  const importTemplateBody = readFileSync(importTemplatePath, 'utf8').replace('PLACEHOLDER_CERT', plan.certificateArn)
  const cfn = new CloudFormationClient(region)

  const exists = await cfn
    .describeStacks({ stackName: plan.newStackName })
    .then((r) => (r.Stacks?.length ?? 0) > 0)
    .catch(() => false)
  if (exists) {
    writeFileSync(plan.templatePath, templateBody)
    await cfn.updateStack({
      stackName: plan.newStackName,
      templateBody,
      capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
    })
    await cfn.waitForStack(plan.newStackName, 'stack-update-complete')
    return
  }

  const templateFile = `${importTemplatePath}.resolved.json`
  writeFileSync(templateFile, importTemplateBody)

  const changeSetName = `${plan.newStackName}-import`
  execSync(
    [
      'aws cloudformation create-change-set',
      `--stack-name ${plan.newStackName}`,
      `--change-set-name ${changeSetName}`,
      '--change-set-type IMPORT',
      `--template-body file://${templateFile}`,
      `--resources-to-import file://${plan.importPath}`,
      '--capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM',
      `--region ${region}`,
      '--tags Key=ManagedBy,Value=ts-cloud Key=Project,Value=pantry',
    ].join(' '),
    { stdio: 'inherit' },
  )

  execSync(
    [
      'aws cloudformation wait change-set-create-complete',
      `--stack-name ${plan.newStackName}`,
      `--change-set-name ${changeSetName}`,
      `--region ${region}`,
    ].join(' '),
    { stdio: 'inherit' },
  )

  execSync(
    [
      'aws cloudformation execute-change-set',
      `--stack-name ${plan.newStackName}`,
      `--change-set-name ${changeSetName}`,
      `--region ${region}`,
    ].join(' '),
    { stdio: 'inherit' },
  )

  execSync(
    ['aws cloudformation wait stack-import-complete', `--stack-name ${plan.newStackName}`, `--region ${region}`].join(
      ' ',
    ),
    { stdio: 'inherit' },
  )
}

export async function syncSiteBucket(oldBucket: string, newBucket: string, region: string): Promise<void> {
  const { S3Client } = await import('../aws/s3')
  const s3 = new S3Client(region)

  const buckets = await s3.listBuckets()
  const names = buckets.Buckets?.map((b) => b.Name) || []
  if (!names.includes(newBucket)) {
    await s3.createBucket(newBucket)
  }

  const { execSync } = await import('node:child_process')
  execSync(`aws s3 sync s3://${oldBucket} s3://${newBucket} --region ${region}`, { stdio: 'inherit' })
}

export async function uploadSiteAssets(plan: SiteStackMigrationPlan, sourceDir: string, region: string): Promise<void> {
  await uploadStaticFiles({
    sourceDir,
    bucket: plan.newBucket,
    region,
  })
  await invalidateCache(plan.distributionId)
}
