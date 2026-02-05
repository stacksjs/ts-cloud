/**
 * Stack Diff Analyzer
 * Analyzes differences between CloudFormation templates for stack updates
*/

import type { CloudFormationResource, CloudFormationTemplate } from '@stacksjs/ts-cloud-aws-types'

export interface ResourceDiff {
  logicalId: string
  action: 'add' | 'remove' | 'update' | 'replace'
  resourceType: string
  changes?: PropertyChange[]
  reason?: string
}

export interface PropertyChange {
  path: string
  oldValue: any
  newValue: any
  requiresReplacement?: boolean
}

export interface StackDiff {
  added: ResourceDiff[]
  removed: ResourceDiff[]
  updated: ResourceDiff[]
  replaced: ResourceDiff[]
  unchanged: string[]
  summary: {
    totalChanges: number
    requiresReplacement: boolean
    dangerousChanges: string[]
  }
}

/**
 * Analyze differences between two CloudFormation templates
*/
export function analyzeStackDiff(
  oldTemplate: CloudFormationTemplate,
  newTemplate: CloudFormationTemplate,
): StackDiff {
  const added: ResourceDiff[] = []
  const removed: ResourceDiff[] = []
  const updated: ResourceDiff[] = []
  const replaced: ResourceDiff[] = []
  const unchanged: string[] = []

  const oldResources = oldTemplate.Resources || {}
  const newResources = newTemplate.Resources || {}

  const allLogicalIds = new Set([
    ...Object.keys(oldResources),
    ...Object.keys(newResources),
  ])

  for (const logicalId of allLogicalIds) {
    const oldResource = oldResources[logicalId]
    const newResource = newResources[logicalId]

    if (!oldResource && newResource) {
      // Resource added
      added.push({
        logicalId,
        action: 'add',
        resourceType: newResource.Type,
      })
    }
    else if (oldResource && !newResource) {
      // Resource removed
      removed.push({
        logicalId,
        action: 'remove',
        resourceType: oldResource.Type,
      })
    }
    else if (oldResource && newResource) {
      // Resource exists in both - check for changes
      if (oldResource.Type !== newResource.Type) {
        // Type changed - this is a replacement
        replaced.push({
          logicalId,
          action: 'replace',
          resourceType: newResource.Type,
          reason: `Type changed from ${oldResource.Type} to ${newResource.Type}`,
        })
      }
      else {
        const changes = compareProperties(
          oldResource.Properties || {},
          newResource.Properties || {},
        )

        if (changes.length > 0) {
          const requiresReplacement = checkIfReplacementRequired(
            oldResource.Type,
            changes,
          )

          if (requiresReplacement) {
            replaced.push({
              logicalId,
              action: 'replace',
              resourceType: newResource.Type,
              changes,
              reason: 'Property changes require replacement',
            })
          }
          else {
            updated.push({
              logicalId,
              action: 'update',
              resourceType: newResource.Type,
              changes,
            })
          }
        }
        else {
          unchanged.push(logicalId)
        }
      }
    }
  }

  const dangerousChanges = identifyDangerousChanges([
    ...removed,
    ...replaced,
    ...updated,
  ])

  return {
    added,
    removed,
    updated,
    replaced,
    unchanged,
    summary: {
      totalChanges: added.length + removed.length + updated.length + replaced.length,
      requiresReplacement: replaced.length > 0,
      dangerousChanges,
    },
  }
}

/**
 * Compare properties of two resources
*/
function compareProperties(
  oldProps: Record<string, any>,
  newProps: Record<string, any>,
  path = '',
): PropertyChange[] {
  const changes: PropertyChange[] = []
  const allKeys = new Set([...Object.keys(oldProps), ...Object.keys(newProps)])

  for (const key of allKeys) {
    const currentPath = path ? `${path}.${key}` : key
    const oldValue = oldProps[key]
    const newValue = newProps[key]

    if (oldValue === undefined && newValue !== undefined) {
      changes.push({
        path: currentPath,
        oldValue: undefined,
        newValue,
      })
    }
    else if (oldValue !== undefined && newValue === undefined) {
      changes.push({
        path: currentPath,
        oldValue,
        newValue: undefined,
      })
    }
    else if (typeof oldValue !== typeof newValue) {
      changes.push({
        path: currentPath,
        oldValue,
        newValue,
      })
    }
    else if (typeof oldValue === 'object' && oldValue !== null) {
      if (Array.isArray(oldValue) && Array.isArray(newValue)) {
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
          changes.push({
            path: currentPath,
            oldValue,
            newValue,
          })
        }
      }
      else if (!Array.isArray(oldValue) && !Array.isArray(newValue)) {
        const nestedChanges = compareProperties(oldValue, newValue, currentPath)
        changes.push(...nestedChanges)
      }
      else {
        changes.push({
          path: currentPath,
          oldValue,
          newValue,
        })
      }
    }
    else if (oldValue !== newValue) {
      changes.push({
        path: currentPath,
        oldValue,
        newValue,
      })
    }
  }

  return changes
}

/**
 * Check if property changes require resource replacement
 * Based on CloudFormation resource specifications
*/
function checkIfReplacementRequired(
  resourceType: string,
  changes: PropertyChange[],
): boolean {
  // Map of resource types to properties that require replacement
  const replacementProperties: Record<string, Set<string>> = {
    'AWS::S3::Bucket': new Set(['BucketName']),
    'AWS::DynamoDB::Table': new Set(['TableName', 'KeySchema']),
    'AWS::RDS::DBInstance': new Set(['DBInstanceIdentifier', 'DBName', 'Engine']),
    'AWS::Lambda::Function': new Set(['FunctionName']), // Changed in some cases
    'AWS::EC2::Instance': new Set(['ImageId', 'InstanceType', 'KeyName']),
    'AWS::ECS::TaskDefinition': new Set(['Family', 'ContainerDefinitions']),
    'AWS::ElastiCache::CacheCluster': new Set(['CacheNodeType', 'Engine']),
    'AWS::CloudFront::Distribution': new Set([]), // Most properties can be updated
    'AWS::Route53::HostedZone': new Set(['Name']),
    'AWS::IAM::Role': new Set(['RoleName', 'Path']),
    'AWS::KMS::Key': new Set(['KeyPolicy']), // Some properties require replacement
    'AWS::Cognito::UserPool': new Set(['UserPoolName']),
    'AWS::OpenSearchService::Domain': new Set(['DomainName']),
  }

  const replaceProps = replacementProperties[resourceType]
  if (!replaceProps) {
    // Unknown resource type - assume updates might require replacement
    return false
  }

  for (const change of changes) {
    const topLevelProp = change.path.split('.')[0]
    if (replaceProps.has(topLevelProp)) {
      return true
    }
  }

  return false
}

/**
 * Identify potentially dangerous changes
*/
function identifyDangerousChanges(diffs: ResourceDiff[]): string[] {
  const dangerous: string[] = []

  for (const diff of diffs) {
    // Removing databases is dangerous
    if (diff.action === 'remove' && (
      diff.resourceType === 'AWS::RDS::DBInstance'
      || diff.resourceType === 'AWS::DynamoDB::Table'
      || diff.resourceType === 'AWS::ElastiCache::CacheCluster'
    )) {
      dangerous.push(`Removing ${diff.resourceType} ${diff.logicalId} - data loss risk!`)
    }

    // Replacing databases is dangerous
    if (diff.action === 'replace' && (
      diff.resourceType === 'AWS::RDS::DBInstance'
      || diff.resourceType === 'AWS::DynamoDB::Table'
    )) {
      dangerous.push(`Replacing ${diff.resourceType} ${diff.logicalId} - data loss risk!`)
    }

    // Removing/replacing S3 buckets
    if ((diff.action === 'remove' || diff.action === 'replace')
      && diff.resourceType === 'AWS::S3::Bucket') {
      dangerous.push(`${diff.action === 'remove' ? 'Removing' : 'Replacing'} S3 bucket ${diff.logicalId} - data loss risk!`)
    }

    // Replacing EC2 instances
    if (diff.action === 'replace' && diff.resourceType === 'AWS::EC2::Instance') {
      dangerous.push(`Replacing EC2 instance ${diff.logicalId} - downtime expected`)
    }

    // Security group changes
    if (diff.action === 'update' && diff.resourceType === 'AWS::EC2::SecurityGroup') {
      dangerous.push(`Updating security group ${diff.logicalId} - may affect connectivity`)
    }

    // IAM role/policy changes
    if ((diff.action === 'update' || diff.action === 'replace') && (
      diff.resourceType === 'AWS::IAM::Role'
      || diff.resourceType === 'AWS::IAM::Policy'
    )) {
      dangerous.push(`Modifying IAM ${diff.resourceType.split('::')[2]} ${diff.logicalId} - may affect permissions`)
    }
  }

  return dangerous
}

/**
 * Format diff for display
*/
export function formatDiff(diff: StackDiff): string {
  const lines: string[] = []

  lines.push('=== Stack Update Analysis ===\n')

  if (diff.summary.totalChanges === 0) {
    lines.push('No changes detected.\n')
    return lines.join('\n')
  }

  lines.push(`Total changes: ${diff.summary.totalChanges}`)
  lines.push(`Requires replacement: ${diff.summary.requiresReplacement ? 'Yes' : 'No'}\n`)

  if (diff.summary.dangerousChanges.length > 0) {
    lines.push('⚠️  DANGEROUS CHANGES DETECTED:')
    for (const warning of diff.summary.dangerousChanges) {
      lines.push(`  • ${warning}`)
    }
    lines.push('')
  }

  if (diff.added.length > 0) {
    lines.push(`✅ Resources to Add (${diff.added.length}):`)
    for (const resource of diff.added) {
      lines.push(`  + ${resource.logicalId} (${resource.resourceType})`)
    }
    lines.push('')
  }

  if (diff.removed.length > 0) {
    lines.push(`❌ Resources to Remove (${diff.removed.length}):`)
    for (const resource of diff.removed) {
      lines.push(`  - ${resource.logicalId} (${resource.resourceType})`)
    }
    lines.push('')
  }

  if (diff.replaced.length > 0) {
    lines.push(`🔄 Resources to Replace (${diff.replaced.length}):`)
    for (const resource of diff.replaced) {
      lines.push(`  ~ ${resource.logicalId} (${resource.resourceType})`)
      if (resource.reason) {
        lines.push(`    Reason: ${resource.reason}`)
      }
      if (resource.changes) {
        for (const change of resource.changes.slice(0, 3)) {
          lines.push(`    • ${change.path}: ${JSON.stringify(change.oldValue)} → ${JSON.stringify(change.newValue)}`)
        }
        if (resource.changes.length > 3) {
          lines.push(`    ... and ${resource.changes.length - 3} more changes`)
        }
      }
    }
    lines.push('')
  }

  if (diff.updated.length > 0) {
    lines.push(`📝 Resources to Update (${diff.updated.length}):`)
    for (const resource of diff.updated) {
      lines.push(`  ~ ${resource.logicalId} (${resource.resourceType})`)
      if (resource.changes) {
        for (const change of resource.changes.slice(0, 3)) {
          lines.push(`    • ${change.path}: ${JSON.stringify(change.oldValue)} → ${JSON.stringify(change.newValue)}`)
        }
        if (resource.changes.length > 3) {
          lines.push(`    ... and ${resource.changes.length - 3} more changes`)
        }
      }
    }
    lines.push('')
  }

  if (diff.unchanged.length > 0) {
    lines.push(`⚪ Unchanged Resources (${diff.unchanged.length})`)
  }

  return lines.join('\n')
}
