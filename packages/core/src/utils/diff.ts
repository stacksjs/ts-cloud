/**
 * Template diff utilities for incremental deployments
 * Detect changes between CloudFormation templates to optimize deployments
*/

import type { CloudFormationTemplate } from '../cloudformation/types'

export interface TemplateDiff {
  added: string[] // Resource logical IDs
  modified: string[] // Resource logical IDs
  deleted: string[] // Resource logical IDs
  unchanged: string[] // Resource logical IDs
  parametersChanged: boolean
  outputsChanged: boolean
  hasChanges: boolean
}

/**
 * Compare two CloudFormation templates
*/
export function diffTemplates(
  oldTemplate: CloudFormationTemplate,
  newTemplate: CloudFormationTemplate,
): TemplateDiff {
  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  const unchanged: string[] = []

  const oldResources = oldTemplate.Resources || {}
  const newResources = newTemplate.Resources || {}

  const oldResourceIds = new Set(Object.keys(oldResources))
  const newResourceIds = new Set(Object.keys(newResources))

  // Find added resources
  for (const id of newResourceIds) {
    if (!oldResourceIds.has(id)) {
      added.push(id)
    }
  }

  // Find deleted resources
  for (const id of oldResourceIds) {
    if (!newResourceIds.has(id)) {
      deleted.push(id)
    }
  }

  // Find modified resources
  for (const id of newResourceIds) {
    if (oldResourceIds.has(id)) {
      const oldResource = oldResources[id]
      const newResource = newResources[id]

      if (JSON.stringify(oldResource) !== JSON.stringify(newResource)) {
        modified.push(id)
      }
      else {
        unchanged.push(id)
      }
    }
  }

  // Check if parameters changed
  const parametersChanged = JSON.stringify(oldTemplate.Parameters || {})
    !== JSON.stringify(newTemplate.Parameters || {})

  // Check if outputs changed
  const outputsChanged = JSON.stringify(oldTemplate.Outputs || {})
    !== JSON.stringify(newTemplate.Outputs || {})

  return {
    added,
    modified,
    deleted,
    unchanged,
    parametersChanged,
    outputsChanged,
    hasChanges: added.length > 0 || modified.length > 0 || deleted.length > 0 || parametersChanged || outputsChanged,
  }
}

/**
 * Get diff summary string
*/
export function getDiffSummary(diff: TemplateDiff): string {
  const lines: string[] = []

  if (!diff.hasChanges) {
    return 'No changes detected'
  }

  if (diff.added.length > 0) {
    lines.push(`Added resources (${diff.added.length}):`)
    for (const id of diff.added) {
      lines.push(`  + ${id}`)
    }
  }

  if (diff.modified.length > 0) {
    lines.push(`Modified resources (${diff.modified.length}):`)
    for (const id of diff.modified) {
      lines.push(`  ~ ${id}`)
    }
  }

  if (diff.deleted.length > 0) {
    lines.push(`Deleted resources (${diff.deleted.length}):`)
    for (const id of diff.deleted) {
      lines.push(`  - ${id}`)
    }
  }

  if (diff.parametersChanged) {
    lines.push('Parameters changed')
  }

  if (diff.outputsChanged) {
    lines.push('Outputs changed')
  }

  return lines.join('\n')
}

/**
 * Check if diff requires replacement (destructive changes)
*/
export function requiresReplacement(
  diff: TemplateDiff,
  oldTemplate: CloudFormationTemplate,
  newTemplate: CloudFormationTemplate,
): boolean {
  // If any resources are deleted, it requires replacement
  if (diff.deleted.length > 0) {
    return true
  }

  // Check modified resources for replacement-requiring changes
  for (const id of diff.modified) {
    const oldResource = oldTemplate.Resources[id]
    const newResource = newTemplate.Resources[id]

    // If resource type changed, it requires replacement
    if (oldResource.Type !== newResource.Type) {
      return true
    }

    // Check if properties that require replacement changed
    // This is a simplified check - in reality, each resource type has specific properties
    const replacementProperties = getReplacementProperties(newResource.Type)

    for (const prop of replacementProperties) {
      const oldValue = oldResource.Properties?.[prop]
      const newValue = newResource.Properties?.[prop]

      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        return true
      }
    }
  }

  return false
}

/**
 * Get properties that require replacement when changed
 * This is a simplified version - production code should use CloudFormation property docs
*/
function getReplacementProperties(resourceType: string): string[] {
  const replacementProps: Record<string, string[]> = {
    'AWS::S3::Bucket': ['BucketName'],
    'AWS::EC2::Instance': ['ImageId', 'InstanceType', 'KeyName'],
    'AWS::RDS::DBInstance': ['DBInstanceIdentifier', 'Engine'],
    'AWS::DynamoDB::Table': ['TableName', 'KeySchema'],
    'AWS::Lambda::Function': ['FunctionName'],
    'AWS::ECS::Service': ['ServiceName'],
    'AWS::ElasticLoadBalancingV2::LoadBalancer': ['Name', 'Type'],
  }

  return replacementProps[resourceType] || []
}

/**
 * Categorize changes by risk level
*/
export function categorizeChanges(diff: TemplateDiff): {
  safe: string[]
  caution: string[]
  dangerous: string[]
} {
  const safe: string[] = []
  const caution: string[] = []
  const dangerous: string[] = []

  // Additions are generally safe
  safe.push(...diff.added)

  // Modifications need to be categorized
  // This is simplified - real implementation would analyze specific property changes
  for (const id of diff.modified) {
    // For now, mark all modifications as caution
    caution.push(id)
  }

  // Deletions are dangerous
  dangerous.push(...diff.deleted)

  return { safe, caution, dangerous }
}

/**
 * Get deployment strategy based on diff
*/
export function getDeploymentStrategy(diff: TemplateDiff): {
  strategy: 'create' | 'update' | 'replace' | 'skip'
  reason: string
} {
  if (!diff.hasChanges) {
    return {
      strategy: 'skip',
      reason: 'No changes detected',
    }
  }

  if (diff.deleted.length > 0) {
    return {
      strategy: 'replace',
      reason: 'Resources will be deleted',
    }
  }

  if (diff.added.length > 0 && diff.modified.length === 0) {
    return {
      strategy: 'update',
      reason: 'Only new resources added',
    }
  }

  return {
    strategy: 'update',
    reason: 'Resources will be updated',
  }
}

/**
 * Calculate diff statistics
*/
export function getDiffStats(diff: TemplateDiff): {
  total: number
  added: number
  modified: number
  deleted: number
  unchanged: number
  changePercentage: number
} {
  const total = diff.added.length + diff.modified.length + diff.deleted.length + diff.unchanged.length
  const changes = diff.added.length + diff.modified.length + diff.deleted.length
  const changePercentage = total > 0 ? (changes / total) * 100 : 0

  return {
    total,
    added: diff.added.length,
    modified: diff.modified.length,
    deleted: diff.deleted.length,
    unchanged: diff.unchanged.length,
    changePercentage,
  }
}
