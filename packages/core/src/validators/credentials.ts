/**
 * AWS Credentials Validation
 * Validate credentials before deployment
*/

import type { AWSCredentials } from '../aws/credentials'
import { resolveCredentials, getAccountId } from '../aws/credentials'
import { CredentialError, DebugLogger } from '../errors'

export interface CredentialValidationResult {
  valid: boolean
  accountId?: string
  region?: string
  error?: string
}

/**
 * Validate AWS credentials
*/
export async function validateCredentials(
  profile: string = 'default',
): Promise<CredentialValidationResult> {
  try {
    DebugLogger.verbose('Resolving AWS credentials...')

    // Resolve credentials
    const credentials = await resolveCredentials(profile)

    if (!credentials.accessKeyId || !credentials.secretAccessKey) {
      throw new CredentialError(
        'AWS credentials are incomplete',
        'Ensure both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set',
      )
    }

    DebugLogger.verbose('Credentials resolved successfully')
    DebugLogger.debug('Access Key ID:', credentials.accessKeyId.substring(0, 8) + '...')

    // Test credentials by getting caller identity
    DebugLogger.verbose('Testing credentials with GetCallerIdentity...')

    let accountId: string
    try {
      accountId = await getAccountId(credentials)
      DebugLogger.verbose('Credentials are valid')
      DebugLogger.debug('Account ID:', accountId)
    }
    catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('InvalidClientTokenId')) {
          throw new CredentialError(
            'Invalid AWS access key ID',
            'Check that your AWS_ACCESS_KEY_ID is correct',
          )
        }
        else if (error.message.includes('SignatureDoesNotMatch')) {
          throw new CredentialError(
            'Invalid AWS secret access key',
            'Check that your AWS_SECRET_ACCESS_KEY is correct',
          )
        }
        else if (error.message.includes('ExpiredToken')) {
          throw new CredentialError(
            'AWS credentials have expired',
            'Refresh your temporary credentials or use long-term credentials',
          )
        }
        else {
          throw new CredentialError(
            `Failed to validate credentials: ${error.message}`,
            'Verify your AWS credentials are correct and have the necessary permissions',
          )
        }
      }
      throw error
    }

    return {
      valid: true,
      accountId,
      region: credentials.region,
    }
  }
  catch (error) {
    if (error instanceof CredentialError) {
      throw error
    }

    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Check IAM permissions
*/
export async function checkIAMPermissions(
  credentials: AWSCredentials,
  requiredActions: string[],
): Promise<{ allowed: string[], denied: string[] }> {
  // TODO: Implement using IAM SimulatePrincipalPolicy API
  // For now, return all as allowed
  return {
    allowed: requiredActions,
    denied: [],
  }
}

/**
 * Get required IAM permissions for deployment
*/
export function getRequiredPermissions(config: any): string[] {
  const permissions = new Set<string>([
    // CloudFormation permissions (always required)
    'cloudformation:CreateStack',
    'cloudformation:UpdateStack',
    'cloudformation:DeleteStack',
    'cloudformation:DescribeStacks',
    'cloudformation:DescribeStackEvents',
    'cloudformation:GetTemplate',
    'cloudformation:ListStacks',
  ])

  // Add permissions based on infrastructure config
  if (config.infrastructure) {
    if (config.infrastructure.storage) {
      permissions.add('s3:CreateBucket')
      permissions.add('s3:DeleteBucket')
      permissions.add('s3:PutBucketPolicy')
      permissions.add('s3:PutBucketVersioning')
      permissions.add('s3:PutBucketEncryption')
      permissions.add('s3:PutObject')
      permissions.add('s3:GetObject')
    }

    if (config.infrastructure.compute) {
      if (config.infrastructure.compute.server) {
        permissions.add('ec2:RunInstances')
        permissions.add('ec2:TerminateInstances')
        permissions.add('ec2:DescribeInstances')
        permissions.add('autoscaling:CreateAutoScalingGroup')
        permissions.add('autoscaling:UpdateAutoScalingGroup')
        permissions.add('autoscaling:DeleteAutoScalingGroup')
        permissions.add('elasticloadbalancing:CreateLoadBalancer')
        permissions.add('elasticloadbalancing:DeleteLoadBalancer')
      }

      if (config.infrastructure.compute.fargate) {
        permissions.add('ecs:CreateCluster')
        permissions.add('ecs:DeleteCluster')
        permissions.add('ecs:CreateService')
        permissions.add('ecs:UpdateService')
        permissions.add('ecs:DeleteService')
        permissions.add('ecs:RegisterTaskDefinition')
      }
    }

    if (config.infrastructure.database) {
      if (config.infrastructure.database.postgres || config.infrastructure.database.mysql) {
        permissions.add('rds:CreateDBInstance')
        permissions.add('rds:DeleteDBInstance')
        permissions.add('rds:ModifyDBInstance')
        permissions.add('rds:DescribeDBInstances')
      }

      if (config.infrastructure.database.dynamodb) {
        permissions.add('dynamodb:CreateTable')
        permissions.add('dynamodb:DeleteTable')
        permissions.add('dynamodb:UpdateTable')
        permissions.add('dynamodb:DescribeTable')
      }
    }

    if (config.infrastructure.functions) {
      permissions.add('lambda:CreateFunction')
      permissions.add('lambda:DeleteFunction')
      permissions.add('lambda:UpdateFunctionCode')
      permissions.add('lambda:UpdateFunctionConfiguration')
      permissions.add('lambda:AddPermission')
    }

    if (config.infrastructure.cdn) {
      permissions.add('cloudfront:CreateDistribution')
      permissions.add('cloudfront:UpdateDistribution')
      permissions.add('cloudfront:DeleteDistribution')
      permissions.add('cloudfront:GetDistribution')
    }

    if (config.infrastructure.network) {
      permissions.add('ec2:CreateVpc')
      permissions.add('ec2:DeleteVpc')
      permissions.add('ec2:CreateSubnet')
      permissions.add('ec2:DeleteSubnet')
      permissions.add('ec2:CreateInternetGateway')
      permissions.add('ec2:DeleteInternetGateway')
      permissions.add('ec2:CreateNatGateway')
      permissions.add('ec2:DeleteNatGateway')
      permissions.add('ec2:CreateRouteTable')
      permissions.add('ec2:DeleteRouteTable')
      permissions.add('ec2:CreateSecurityGroup')
      permissions.add('ec2:DeleteSecurityGroup')
    }
  }

  // IAM permissions (always required for creating roles)
  permissions.add('iam:CreateRole')
  permissions.add('iam:DeleteRole')
  permissions.add('iam:AttachRolePolicy')
  permissions.add('iam:DetachRolePolicy')
  permissions.add('iam:PutRolePolicy')
  permissions.add('iam:GetRole')
  permissions.add('iam:PassRole')

  return Array.from(permissions).sort()
}

/**
 * Suggest IAM policy for deployment
*/
export function suggestIAMPolicy(config: any): string {
  const permissions = getRequiredPermissions(config)

  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Action: permissions,
      Resource: '*',
    }],
  }, null, 2)
}
