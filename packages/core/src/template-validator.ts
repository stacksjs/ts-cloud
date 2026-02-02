/**
 * CloudFormation Template Validator
 * Validates CloudFormation templates for correctness and best practices
 */

import type { CloudFormationTemplate, CloudFormationResource } from '@stacksjs/ts-cloud-aws-types'

export interface ValidationError {
  path: string
  message: string
  severity: 'error' | 'warning' | 'info'
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationError[]
  info: ValidationError[]
}

/**
 * Validate a CloudFormation template
 */
export function validateTemplate(template: CloudFormationTemplate): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationError[] = []
  const info: ValidationError[] = []

  // 1. Validate template structure
  validateTemplateStructure(template, errors)

  // 2. Validate resources
  if (template.Resources) {
    validateResources(template.Resources, errors, warnings)
  }
  else {
    errors.push({
      path: 'Resources',
      message: 'Template must contain at least one resource',
      severity: 'error',
    })
  }

  // 3. Validate parameters
  if (template.Parameters) {
    validateParameters(template.Parameters, errors, warnings)
  }

  // 4. Validate outputs
  if (template.Outputs) {
    validateOutputs(template.Outputs, errors)
  }

  // 5. Validate references (Ref, GetAtt, etc.)
  validateReferences(template, errors)

  // 6. Check for circular dependencies
  const circularDeps = detectCircularDependencies(template)
  if (circularDeps.length > 0) {
    for (const cycle of circularDeps) {
      errors.push({
        path: 'Resources',
        message: `Circular dependency detected: ${cycle.join(' → ')}`,
        severity: 'error',
      })
    }
  }

  // 7. Check for best practices
  checkBestPractices(template, warnings, info)

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info,
  }
}

/**
 * Validate template structure
 */
function validateTemplateStructure(
  template: CloudFormationTemplate,
  errors: ValidationError[],
): void {
  if (!template.AWSTemplateFormatVersion) {
    errors.push({
      path: 'AWSTemplateFormatVersion',
      message: 'Template should specify AWSTemplateFormatVersion',
      severity: 'error',
    })
  }
  else if (template.AWSTemplateFormatVersion !== '2010-09-09') {
    errors.push({
      path: 'AWSTemplateFormatVersion',
      message: 'AWSTemplateFormatVersion must be "2010-09-09"',
      severity: 'error',
    })
  }
}

/**
 * Validate resources
 */
function validateResources(
  resources: Record<string, CloudFormationResource>,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  const logicalIds = Object.keys(resources)

  if (logicalIds.length === 0) {
    errors.push({
      path: 'Resources',
      message: 'Template must contain at least one resource',
      severity: 'error',
    })
    return
  }

  if (logicalIds.length > 500) {
    warnings.push({
      path: 'Resources',
      message: `Template contains ${logicalIds.length} resources (limit is 500)`,
      severity: 'warning',
    })
  }

  for (const logicalId of logicalIds) {
    const resource = resources[logicalId]

    // Validate logical ID format
    if (!/^[a-zA-Z0-9]+$/.test(logicalId)) {
      errors.push({
        path: `Resources.${logicalId}`,
        message: 'Logical ID must contain only alphanumeric characters',
        severity: 'error',
      })
    }

    // Validate Type
    if (!resource.Type) {
      errors.push({
        path: `Resources.${logicalId}.Type`,
        message: 'Resource Type is required',
        severity: 'error',
      })
    }
    else if (!resource.Type.startsWith('AWS::') && !resource.Type.startsWith('Custom::')) {
      errors.push({
        path: `Resources.${logicalId}.Type`,
        message: 'Resource Type must start with "AWS::" or "Custom::"',
        severity: 'error',
      })
    }

    // Validate DeletionPolicy
    if (resource.DeletionPolicy
      && !['Delete', 'Retain', 'Snapshot'].includes(resource.DeletionPolicy)) {
      errors.push({
        path: `Resources.${logicalId}.DeletionPolicy`,
        message: 'DeletionPolicy must be "Delete", "Retain", or "Snapshot"',
        severity: 'error',
      })
    }

    // Warn about resources without DeletionPolicy (data services)
    if (!resource.DeletionPolicy && isDataResource(resource.Type)) {
      warnings.push({
        path: `Resources.${logicalId}.DeletionPolicy`,
        message: `${resource.Type} should specify DeletionPolicy to prevent accidental data loss`,
        severity: 'warning',
      })
    }
  }
}

/**
 * Validate parameters
 */
function validateParameters(
  parameters: Record<string, any>,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  const paramNames = Object.keys(parameters)

  if (paramNames.length > 200) {
    warnings.push({
      path: 'Parameters',
      message: `Template contains ${paramNames.length} parameters (limit is 200)`,
      severity: 'warning',
    })
  }

  for (const paramName of paramNames) {
    const param = parameters[paramName]

    if (!param.Type) {
      errors.push({
        path: `Parameters.${paramName}.Type`,
        message: 'Parameter Type is required',
        severity: 'error',
      })
    }

    const validTypes = ['String', 'Number', 'List<Number>', 'CommaDelimitedList',
      'AWS::EC2::AvailabilityZone::Name', 'AWS::EC2::Image::Id',
      'AWS::EC2::Instance::Id', 'AWS::EC2::KeyPair::KeyName',
      'AWS::EC2::SecurityGroup::GroupName', 'AWS::EC2::SecurityGroup::Id',
      'AWS::EC2::Subnet::Id', 'AWS::EC2::Volume::Id', 'AWS::EC2::VPC::Id',
      'AWS::Route53::HostedZone::Id', 'List<AWS::EC2::AvailabilityZone::Name>',
      'List<AWS::EC2::Image::Id>', 'List<AWS::EC2::Instance::Id>',
      'List<AWS::EC2::SecurityGroup::GroupName>', 'List<AWS::EC2::SecurityGroup::Id>',
      'List<AWS::EC2::Subnet::Id>', 'List<AWS::EC2::Volume::Id>',
      'List<AWS::EC2::VPC::Id>', 'List<AWS::Route53::HostedZone::Id>',
      'AWS::SSM::Parameter::Name', 'AWS::SSM::Parameter::Value<String>',
      'AWS::SSM::Parameter::Value<List<String>>',
      'AWS::SSM::Parameter::Value<CommaDelimitedList>',
    ]

    if (param.Type && !validTypes.includes(param.Type)) {
      errors.push({
        path: `Parameters.${paramName}.Type`,
        message: `Invalid parameter type: ${param.Type}`,
        severity: 'error',
      })
    }
  }
}

/**
 * Validate outputs
 */
function validateOutputs(
  outputs: Record<string, any>,
  errors: ValidationError[],
): void {
  const outputNames = Object.keys(outputs)

  for (const outputName of outputNames) {
    const output = outputs[outputName]

    if (!output.Value) {
      errors.push({
        path: `Outputs.${outputName}.Value`,
        message: 'Output Value is required',
        severity: 'error',
      })
    }
  }
}

/**
 * Validate references between resources
 */
function validateReferences(
  template: CloudFormationTemplate,
  errors: ValidationError[],
): void {
  const resources = template.Resources || {}
  const parameters = template.Parameters || {}
  const resourceIds = new Set(Object.keys(resources))
  const parameterNames = new Set(Object.keys(parameters))

  function checkReferences(obj: any, path: string): void {
    if (typeof obj !== 'object' || obj === null)
      return

    if (obj.Ref) {
      const ref = obj.Ref
      if (!resourceIds.has(ref) && !parameterNames.has(ref) && ref !== 'AWS::Region' && ref !== 'AWS::AccountId' && ref !== 'AWS::StackName' && ref !== 'AWS::StackId' && ref !== 'AWS::URLSuffix' && ref !== 'AWS::Partition' && ref !== 'AWS::NoValue') {
        errors.push({
          path,
          message: `Reference to non-existent resource or parameter: ${ref}`,
          severity: 'error',
        })
      }
    }

    if (obj['Fn::GetAtt']) {
      const getAtt = obj['Fn::GetAtt']
      if (Array.isArray(getAtt) && getAtt.length >= 1) {
        const resourceId = getAtt[0]
        if (!resourceIds.has(resourceId)) {
          errors.push({
            path,
            message: `GetAtt references non-existent resource: ${resourceId}`,
            severity: 'error',
          })
        }
      }
    }

    // Recurse into object properties
    for (const key in obj) {
      checkReferences(obj[key], `${path}.${key}`)
    }
  }

  // Check all resources
  for (const logicalId in resources) {
    checkReferences(resources[logicalId], `Resources.${logicalId}`)
  }

  // Check outputs
  if (template.Outputs) {
    for (const outputName in template.Outputs) {
      checkReferences(template.Outputs[outputName], `Outputs.${outputName}`)
    }
  }
}

/**
 * Detect circular dependencies in the template
 */
function detectCircularDependencies(template: CloudFormationTemplate): string[][] {
  const resources = template.Resources || {}
  const graph = new Map<string, Set<string>>()

  // Build dependency graph
  for (const logicalId in resources) {
    const deps = new Set<string>()

    // Check DependsOn
    const resource = resources[logicalId]
    if (resource.DependsOn) {
      if (Array.isArray(resource.DependsOn)) {
        resource.DependsOn.forEach(dep => deps.add(dep))
      }
      else {
        deps.add(resource.DependsOn)
      }
    }

    // Check Ref and GetAtt
    const refDeps = extractDependencies(resource)
    refDeps.forEach(dep => deps.add(dep))

    graph.set(logicalId, deps)
  }

  // Detect cycles using DFS
  const cycles: string[][] = []
  const visited = new Set<string>()
  const recursionStack = new Set<string>()

  function dfs(node: string, path: string[]): void {
    visited.add(node)
    recursionStack.add(node)
    path.push(node)

    const deps = graph.get(node) || new Set()
    for (const dep of deps) {
      if (!visited.has(dep)) {
        dfs(dep, [...path])
      }
      else if (recursionStack.has(dep)) {
        // Cycle detected
        const cycleStart = path.indexOf(dep)
        const cycle = [...path.slice(cycleStart), dep]
        cycles.push(cycle)
      }
    }

    recursionStack.delete(node)
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node, [])
    }
  }

  return cycles
}

/**
 * Extract dependencies from a resource
 */
function extractDependencies(obj: any): Set<string> {
  const deps = new Set<string>()

  function traverse(value: any): void {
    if (typeof value !== 'object' || value === null)
      return

    if (value.Ref && typeof value.Ref === 'string') {
      // Skip pseudo-parameters
      if (!value.Ref.startsWith('AWS::')) {
        deps.add(value.Ref)
      }
    }

    if (value['Fn::GetAtt'] && Array.isArray(value['Fn::GetAtt'])) {
      deps.add(value['Fn::GetAtt'][0])
    }

    // Recurse
    for (const key in value) {
      traverse(value[key])
    }
  }

  traverse(obj)
  return deps
}

/**
 * Check if a resource type stores data
 */
function isDataResource(type: string): boolean {
  const dataResourceTypes = [
    'AWS::S3::Bucket',
    'AWS::DynamoDB::Table',
    'AWS::RDS::DBInstance',
    'AWS::RDS::DBCluster',
    'AWS::ElastiCache::CacheCluster',
    'AWS::ElastiCache::ReplicationGroup',
    'AWS::EFS::FileSystem',
    'AWS::OpenSearchService::Domain',
  ]
  return dataResourceTypes.includes(type)
}

/**
 * Check for best practices
 */
function checkBestPractices(
  template: CloudFormationTemplate,
  warnings: ValidationError[],
  info: ValidationError[],
): void {
  const resources = template.Resources || {}

  // Check for description
  if (!template.Description) {
    info.push({
      path: 'Description',
      message: 'Consider adding a Description to the template',
      severity: 'info',
    })
  }

  // Check for tags
  for (const logicalId in resources) {
    const resource = resources[logicalId]
    const props = resource.Properties as any

    if (props && !props.Tags && supportsTagging(resource.Type)) {
      info.push({
        path: `Resources.${logicalId}`,
        message: `Consider adding Tags to ${resource.Type}`,
        severity: 'info',
      })
    }

    // Check for encryption on data resources
    if (isDataResource(resource.Type)) {
      if (resource.Type === 'AWS::S3::Bucket' && !props?.BucketEncryption) {
        warnings.push({
          path: `Resources.${logicalId}`,
          message: 'S3 bucket should enable encryption',
          severity: 'warning',
        })
      }

      if (resource.Type === 'AWS::RDS::DBInstance' && !props?.StorageEncrypted) {
        warnings.push({
          path: `Resources.${logicalId}`,
          message: 'RDS instance should enable storage encryption',
          severity: 'warning',
        })
      }
    }
  }
}

/**
 * Check if resource type supports tagging
 */
function supportsTagging(type: string): boolean {
  // Most AWS resources support tagging
  const noTagSupport = [
    'AWS::CloudFormation::Stack',
    'AWS::CloudFormation::WaitCondition',
    'AWS::CloudFormation::WaitConditionHandle',
  ]
  return !noTagSupport.includes(type)
}

/**
 * Validate template size
 */
export function validateTemplateSize(templateJson: string): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationError[] = []
  const info: ValidationError[] = []

  const sizeInBytes = Buffer.byteLength(templateJson, 'utf8')
  const sizeInKB = sizeInBytes / 1024

  // CloudFormation limits
  const maxSize = 51200 // 51,200 bytes (50 KB) for direct upload
  const s3MaxSize = 460800 // 460,800 bytes (450 KB) for S3 upload

  if (sizeInBytes > s3MaxSize) {
    errors.push({
      path: 'Template',
      message: `Template size (${sizeInKB.toFixed(2)} KB) exceeds maximum size of 450 KB`,
      severity: 'error',
    })
  }
  else if (sizeInBytes > maxSize) {
    warnings.push({
      path: 'Template',
      message: `Template size (${sizeInKB.toFixed(2)} KB) exceeds 50 KB. Must use S3 for deployment.`,
      severity: 'warning',
    })
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info,
  }
}

/**
 * Validate resource limits
 */
export function validateResourceLimits(template: CloudFormationTemplate): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationError[] = []
  const info: ValidationError[] = []

  const resources = template.Resources || {}
  const parameters = template.Parameters || {}
  const outputs = template.Outputs || {}

  // CloudFormation limits
  if (Object.keys(resources).length > 500) {
    errors.push({
      path: 'Resources',
      message: `Template has ${Object.keys(resources).length} resources (limit is 500)`,
      severity: 'error',
    })
  }

  if (Object.keys(parameters).length > 200) {
    errors.push({
      path: 'Parameters',
      message: `Template has ${Object.keys(parameters).length} parameters (limit is 200)`,
      severity: 'error',
    })
  }

  if (Object.keys(outputs).length > 200) {
    errors.push({
      path: 'Outputs',
      message: `Template has ${Object.keys(outputs).length} outputs (limit is 200)`,
      severity: 'error',
    })
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info,
  }
}
