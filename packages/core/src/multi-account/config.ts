/**
 * Multi-Account Configuration
 * Best practices and configuration for multi-account setups
*/

import type { AWSAccount, CrossAccountRole } from './manager'

/**
 * Account structure presets
*/
export interface AccountStructure {
  name: string
  description: string
  accounts: AccountStructureDefinition[]
  organizationalUnits?: OUDefinition[]
}

export interface AccountStructureDefinition {
  alias: string
  email: string
  role: AWSAccount['role']
  ou?: string
  description: string
}

export interface OUDefinition {
  name: string
  parent?: string
  policies?: string[]
}

/**
 * AWS best practices: Multi-account structure
 * Based on AWS Well-Architected Framework
*/
export const RECOMMENDED_ACCOUNT_STRUCTURES: Record<string, AccountStructure> = {
  basic: {
    name: 'Basic (3 Accounts)',
    description: 'Simple structure for small teams',
    accounts: [
      {
        alias: 'management',
        email: 'aws+management@example.com',
        role: 'management',
        ou: 'root',
        description: 'Management account for AWS Organizations',
      },
      {
        alias: 'production',
        email: 'aws+production@example.com',
        role: 'production',
        ou: 'workloads',
        description: 'Production workloads',
      },
      {
        alias: 'development',
        email: 'aws+development@example.com',
        role: 'development',
        ou: 'workloads',
        description: 'Development and testing',
      },
    ],
    organizationalUnits: [
      { name: 'root' },
      { name: 'workloads', parent: 'root' },
    ],
  },

  standard: {
    name: 'Standard (5 Accounts)',
    description: 'Recommended for most organizations',
    accounts: [
      {
        alias: 'management',
        email: 'aws+management@example.com',
        role: 'management',
        ou: 'root',
        description: 'Management account',
      },
      {
        alias: 'security',
        email: 'aws+security@example.com',
        role: 'security',
        ou: 'security',
        description: 'Security tooling and audit logs',
      },
      {
        alias: 'shared-services',
        email: 'aws+shared@example.com',
        role: 'shared-services',
        ou: 'infrastructure',
        description: 'Shared services (CI/CD, monitoring)',
      },
      {
        alias: 'production',
        email: 'aws+production@example.com',
        role: 'production',
        ou: 'workloads',
        description: 'Production environment',
      },
      {
        alias: 'staging',
        email: 'aws+staging@example.com',
        role: 'staging',
        ou: 'workloads',
        description: 'Staging environment',
      },
      {
        alias: 'development',
        email: 'aws+development@example.com',
        role: 'development',
        ou: 'workloads',
        description: 'Development environment',
      },
    ],
    organizationalUnits: [
      { name: 'root' },
      { name: 'security', parent: 'root' },
      { name: 'infrastructure', parent: 'root' },
      { name: 'workloads', parent: 'root' },
    ],
  },

  enterprise: {
    name: 'Enterprise (7+ Accounts)',
    description: 'For large organizations with strict compliance requirements',
    accounts: [
      {
        alias: 'management',
        email: 'aws+management@example.com',
        role: 'management',
        ou: 'root',
        description: 'Management account',
      },
      {
        alias: 'audit',
        email: 'aws+audit@example.com',
        role: 'security',
        ou: 'security',
        description: 'Audit and compliance',
      },
      {
        alias: 'log-archive',
        email: 'aws+logs@example.com',
        role: 'security',
        ou: 'security',
        description: 'Centralized log storage',
      },
      {
        alias: 'shared-services',
        email: 'aws+shared@example.com',
        role: 'shared-services',
        ou: 'infrastructure',
        description: 'Shared infrastructure',
      },
      {
        alias: 'network',
        email: 'aws+network@example.com',
        role: 'shared-services',
        ou: 'infrastructure',
        description: 'Network infrastructure (Transit Gateway)',
      },
      {
        alias: 'production',
        email: 'aws+production@example.com',
        role: 'production',
        ou: 'production-ou',
        description: 'Production workloads',
      },
      {
        alias: 'staging',
        email: 'aws+staging@example.com',
        role: 'staging',
        ou: 'non-production-ou',
        description: 'Staging environment',
      },
      {
        alias: 'development',
        email: 'aws+development@example.com',
        role: 'development',
        ou: 'non-production-ou',
        description: 'Development environment',
      },
    ],
    organizationalUnits: [
      { name: 'root' },
      { name: 'security', parent: 'root', policies: ['deny-root-access'] },
      { name: 'infrastructure', parent: 'root' },
      { name: 'production-ou', parent: 'root', policies: ['require-mfa'] },
      { name: 'non-production-ou', parent: 'root' },
    ],
  },
}

/**
 * Service Control Policies (SCPs) - AWS best practices
*/
export const RECOMMENDED_SCPS = {
  denyRootAccess: {
    name: 'Deny Root User Access',
    description: 'Prevent root user from performing any actions',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyRootUser',
          Effect: 'Deny',
          Action: '*',
          Resource: '*',
          Condition: {
            StringLike: {
              'aws:PrincipalArn': 'arn:aws:iam::*:root',
            },
          },
        },
      ] as const,
    },
  },

  requireMFA: {
    name: 'Require MFA for All Actions',
    description: 'Require MFA for console and API access',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'RequireMFA',
          Effect: 'Deny',
          Action: '*',
          Resource: '*',
          Condition: {
            BoolIfExists: {
              'aws:MultiFactorAuthPresent': 'false',
            },
          },
        },
      ] as const,
    },
  },

  denyRegions: {
    name: 'Deny Access to Non-Approved Regions',
    description: 'Restrict operations to specific regions',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyNonApprovedRegions',
          Effect: 'Deny',
          NotAction: [
            'iam:*',
            'organizations:*',
            'route53:*',
            'cloudfront:*',
            'support:*',
            's3:*',
          ],
          Resource: '*',
          Condition: {
            StringNotEquals: {
              'aws:RequestedRegion': [
                'us-east-1',
                'us-west-2',
              ],
            },
          },
        },
      ] as const,
    },
  },

  preventLeaving: {
    name: 'Prevent Leaving Organization',
    description: 'Prevent accounts from leaving the organization',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'PreventLeaving',
          Effect: 'Deny',
          Action: 'organizations:LeaveOrganization',
          Resource: '*',
        },
      ] as const,
    },
  },

  denyS3Unencrypted: {
    name: 'Deny Unencrypted S3 Uploads',
    description: 'Require encryption for all S3 uploads',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyUnencryptedS3Uploads',
          Effect: 'Deny',
          Action: 's3:PutObject',
          Resource: '*',
          Condition: {
            StringNotEquals: {
              's3:x-amz-server-side-encryption': [
                'AES256',
                'aws:kms',
              ],
            },
          },
        },
      ] as const,
    },
  },
}

/**
 * Common cross-account role configurations
*/
export const COMMON_CROSS_ACCOUNT_ROLES = {
  deploymentRole: {
    name: 'CrossAccountDeploymentRole',
    description: 'Role for deploying infrastructure from CI/CD',
    permissions: [
      'cloudformation:*',
      's3:*',
      'ec2:*',
      'ecs:*',
      'lambda:*',
      'iam:GetRole',
      'iam:PassRole',
      'logs:*',
      'events:*',
    ] as const,
  },

  readOnlyRole: {
    name: 'CrossAccountReadOnlyRole',
    description: 'Read-only access for monitoring and auditing',
    permissions: [
      'cloudformation:Describe*',
      'cloudformation:List*',
      'ec2:Describe*',
      'ecs:Describe*',
      'lambda:Get*',
      'lambda:List*',
      's3:Get*',
      's3:List*',
      'logs:Get*',
      'logs:Describe*',
    ] as const,
  },

  securityAuditRole: {
    name: 'CrossAccountSecurityAuditRole',
    description: 'Security audit and compliance checks',
    permissions: [
      'iam:Get*',
      'iam:List*',
      'iam:Generate*',
      'access-analyzer:*',
      'guardduty:Get*',
      'guardduty:List*',
      'securityhub:Get*',
      'securityhub:List*',
      'config:Describe*',
      'config:Get*',
      'config:List*',
    ] as const,
  },

  breakGlassRole: {
    name: 'CrossAccountBreakGlassRole',
    description: 'Emergency access role (use with caution)',
    permissions: ['*'] as const,
  },
}

/**
 * Get recommended account structure
*/
export function getRecommendedStructure(size: 'basic' | 'standard' | 'enterprise'): AccountStructure {
  return RECOMMENDED_ACCOUNT_STRUCTURES[size]
}

/**
 * Generate cross-account role CloudFormation
*/
export function generateCrossAccountRoleCF(
  role: CrossAccountRole,
  managedPolicies?: string[],
): any {
  return {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: role.roleName,
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              AWS: `arn:aws:iam::${role.sourceAccountId}:root`,
            },
            Action: 'sts:AssumeRole',
            ...(role.externalId && {
              Condition: {
                StringEquals: {
                  'sts:ExternalId': role.externalId,
                },
              },
            }),
          },
        ],
      },
      Policies: [
        {
          PolicyName: `${role.roleName}Policy`,
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: role.permissions,
                Resource: '*',
              },
            ],
          },
        },
      ],
      ...(managedPolicies && {
        ManagedPolicyArns: managedPolicies,
      }),
      MaxSessionDuration: role.sessionDuration || 3600,
      Tags: [
        { Key: 'ManagedBy', Value: 'TS-Cloud' },
        { Key: 'SourceAccount', Value: role.sourceAccountId },
      ],
    },
  }
}

/**
 * Validate account structure
*/
export function validateAccountStructure(structure: AccountStructure): {
  valid: boolean
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []

  // Check for management account
  const managementAccounts = structure.accounts.filter(a => a.role === 'management')
  if (managementAccounts.length === 0) {
    errors.push('No management account defined')
  }
  if (managementAccounts.length > 1) {
    errors.push('Multiple management accounts defined')
  }

  // Check for duplicate emails
  const emails = structure.accounts.map(a => a.email)
  const duplicates = emails.filter((email, index) => emails.indexOf(email) !== index)
  if (duplicates.length > 0) {
    errors.push(`Duplicate email addresses: ${duplicates.join(', ')}`)
  }

  // Check for duplicate aliases
  const aliases = structure.accounts.map(a => a.alias)
  const duplicateAliases = aliases.filter((alias, index) => aliases.indexOf(alias) !== index)
  if (duplicateAliases.length > 0) {
    errors.push(`Duplicate aliases: ${duplicateAliases.join(', ')}`)
  }

  // Warnings for best practices
  if (!structure.accounts.some(a => a.role === 'security')) {
    warnings.push('No dedicated security account - consider adding one for audit logs')
  }

  if (structure.accounts.length < 3) {
    warnings.push('Less than 3 accounts - consider separating environments')
  }

  if (!structure.accounts.some(a => a.role === 'production')) {
    warnings.push('No production account defined')
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Format account structure for display
*/
export function formatAccountStructure(structure: AccountStructure): string {
  const lines: string[] = []

  lines.push(`${structure.name}`)
  lines.push('─'.repeat(structure.name.length))
  lines.push(structure.description)
  lines.push('')

  if (structure.organizationalUnits) {
    lines.push('Organizational Units:')
    for (const ou of structure.organizationalUnits) {
      const prefix = ou.parent ? '  └─ ' : '  '
      lines.push(`${prefix}${ou.name}`)
    }
    lines.push('')
  }

  lines.push('Accounts:')
  for (const account of structure.accounts) {
    lines.push(`  ${account.alias.padEnd(20)} ${account.role.padEnd(15)} ${account.email}`)
    lines.push(`  ${''.padEnd(20)} ${account.description}`)
    lines.push('')
  }

  return lines.join('\n')
}
