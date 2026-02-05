/**
 * CloudFormation Template Validation
 * Validates templates before deployment
*/

import type { CloudFormationTemplate } from '@stacksjs/ts-cloud-aws-types'

export interface ValidationError {
  path: string
  message: string
  severity: 'error' | 'warning'
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationError[]
}

/**
 * Validate a CloudFormation template
*/
export function validateTemplate(template: CloudFormationTemplate): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationError[] = []

  // Check required fields
  if (!template.AWSTemplateFormatVersion) {
    errors.push({
      path: 'AWSTemplateFormatVersion',
      message: 'AWSTemplateFormatVersion is required',
      severity: 'error',
    })
  }
  else if (template.AWSTemplateFormatVersion !== '2010-09-09') {
    warnings.push({
      path: 'AWSTemplateFormatVersion',
      message: 'AWSTemplateFormatVersion should be "2010-09-09"',
      severity: 'warning',
    })
  }

  // Check Resources section
  if (!template.Resources || Object.keys(template.Resources).length === 0) {
    errors.push({
      path: 'Resources',
      message: 'At least one resource is required',
      severity: 'error',
    })
  }
  else {
    // Validate each resource
    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      validateResource(logicalId, resource, errors, warnings)
    }
  }

  // Check for circular dependencies
  if (template.Resources) {
    const circularDeps = findCircularDependencies(template.Resources)
    if (circularDeps.length > 0) {
      errors.push({
        path: 'Resources',
        message: `Circular dependencies detected: ${circularDeps.join(' -> ')}`,
        severity: 'error',
      })
    }
  }

  // Validate Parameters if present
  if (template.Parameters) {
    for (const [paramName, param] of Object.entries(template.Parameters)) {
      validateParameter(paramName, param, errors, warnings)
    }
  }

  // Validate Outputs if present
  if (template.Outputs) {
    for (const [outputName, output] of Object.entries(template.Outputs)) {
      validateOutput(outputName, output, errors, warnings)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Validate a single resource
*/
function validateResource(
  logicalId: string,
  resource: any,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  // Check required fields
  if (!resource.Type) {
    errors.push({
      path: `Resources.${logicalId}.Type`,
      message: 'Resource Type is required',
      severity: 'error',
    })
  }

  // Check logical ID format
  if (!/^[a-zA-Z0-9]+$/.test(logicalId)) {
    warnings.push({
      path: `Resources.${logicalId}`,
      message: 'Logical ID should only contain alphanumeric characters',
      severity: 'warning',
    })
  }

  // Validate resource type format
  if (resource.Type && !resource.Type.startsWith('AWS::') && !resource.Type.startsWith('Custom::')) {
    errors.push({
      path: `Resources.${logicalId}.Type`,
      message: 'Resource Type must start with "AWS::" or "Custom::"',
      severity: 'error',
    })
  }

  // Check for common mistakes
  if (resource.Properties) {
    // Check for undefined or null values
    for (const [propName, propValue] of Object.entries(resource.Properties)) {
      if (propValue === undefined || propValue === null) {
        warnings.push({
          path: `Resources.${logicalId}.Properties.${propName}`,
          message: 'Property has undefined or null value',
          severity: 'warning',
        })
      }
    }
  }

  // Validate DependsOn
  if (resource.DependsOn) {
    if (typeof resource.DependsOn === 'string') {
      if (resource.DependsOn === logicalId) {
        errors.push({
          path: `Resources.${logicalId}.DependsOn`,
          message: 'Resource cannot depend on itself',
          severity: 'error',
        })
      }
    }
    else if (Array.isArray(resource.DependsOn)) {
      if (resource.DependsOn.includes(logicalId)) {
        errors.push({
          path: `Resources.${logicalId}.DependsOn`,
          message: 'Resource cannot depend on itself',
          severity: 'error',
        })
      }
    }
  }
}

/**
 * Validate a parameter
*/
function validateParameter(
  paramName: string,
  param: any,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  if (!param.Type) {
    errors.push({
      path: `Parameters.${paramName}.Type`,
      message: 'Parameter Type is required',
      severity: 'error',
    })
  }

  const validTypes = ['String', 'Number', 'List<Number>', 'CommaDelimitedList', 'AWS::SSM::Parameter::Value<String>']
  if (param.Type && !validTypes.includes(param.Type) && !param.Type.startsWith('AWS::')) {
    warnings.push({
      path: `Parameters.${paramName}.Type`,
      message: `Uncommon parameter type: ${param.Type}`,
      severity: 'warning',
    })
  }

  // Check for default value with NoEcho
  if (param.NoEcho && param.Default) {
    warnings.push({
      path: `Parameters.${paramName}`,
      message: 'NoEcho parameters should not have default values',
      severity: 'warning',
    })
  }
}

/**
 * Validate an output
*/
function validateOutput(
  outputName: string,
  output: any,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  if (!output.Value) {
    errors.push({
      path: `Outputs.${outputName}.Value`,
      message: 'Output Value is required',
      severity: 'error',
    })
  }
}

/**
 * Find circular dependencies in resources
*/
function findCircularDependencies(resources: Record<string, any>): string[] {
  const graph: Record<string, string[]> = {}

  // Build dependency graph
  for (const [logicalId, resource] of Object.entries(resources)) {
    graph[logicalId] = []

    // Explicit dependencies (DependsOn)
    if (resource.DependsOn) {
      if (typeof resource.DependsOn === 'string') {
        graph[logicalId].push(resource.DependsOn)
      }
      else if (Array.isArray(resource.DependsOn)) {
        graph[logicalId].push(...resource.DependsOn)
      }
    }

    // Implicit dependencies (Ref, GetAtt)
    const deps = extractDependencies(resource)
    graph[logicalId].push(...deps)
  }

  // Detect cycles using DFS
  const visited = new Set<string>()
  const recursionStack = new Set<string>()
  const cycle: string[] = []

  function dfs(node: string, path: string[]): boolean {
    visited.add(node)
    recursionStack.add(node)
    path.push(node)

    const neighbors = graph[node] || []
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor, path)) {
          return true
        }
      }
      else if (recursionStack.has(neighbor)) {
        // Cycle detected
        const cycleStart = path.indexOf(neighbor)
        cycle.push(...path.slice(cycleStart), neighbor)
        return true
      }
    }

    path.pop()
    recursionStack.delete(node)
    return false
  }

  for (const node of Object.keys(graph)) {
    if (!visited.has(node)) {
      if (dfs(node, [])) {
        return cycle
      }
    }
  }

  return []
}

/**
 * Extract dependencies from a resource (Ref, GetAtt, etc.)
*/
function extractDependencies(obj: any, deps: string[] = []): string[] {
  if (typeof obj !== 'object' || obj === null) {
    return deps
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractDependencies(item, deps)
    }
    return deps
  }

  // Check for Ref
  if (obj.Ref && typeof obj.Ref === 'string' && !obj.Ref.startsWith('AWS::')) {
    deps.push(obj.Ref)
  }

  // Check for GetAtt
  if (obj['Fn::GetAtt']) {
    const getAtt = obj['Fn::GetAtt']
    if (Array.isArray(getAtt) && getAtt.length > 0) {
      deps.push(getAtt[0])
    }
  }

  // Recurse into object properties
  for (const value of Object.values(obj)) {
    extractDependencies(value, deps)
  }

  return deps
}

/**
 * Validate template size
*/
export function validateTemplateSize(templateBody: string): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationError[] = []

  const sizeInBytes = new TextEncoder().encode(templateBody).length

  // CloudFormation limits
  const maxBodySize = 51200 // 51,200 bytes (50 KB)
  const maxS3Size = 460800 // 460,800 bytes (450 KB)

  if (sizeInBytes > maxBodySize) {
    if (sizeInBytes > maxS3Size) {
      errors.push({
        path: 'template',
        message: `Template size (${sizeInBytes} bytes) exceeds maximum allowed size of ${maxS3Size} bytes`,
        severity: 'error',
      })
    }
    else {
      warnings.push({
        path: 'template',
        message: `Template size (${sizeInBytes} bytes) exceeds direct upload limit (${maxBodySize} bytes). You must upload to S3 first.`,
        severity: 'warning',
      })
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Validate template resource limits
*/
export function validateResourceLimits(template: CloudFormationTemplate): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationError[] = []

  const resourceCount = template.Resources ? Object.keys(template.Resources).length : 0
  const parameterCount = template.Parameters ? Object.keys(template.Parameters).length : 0
  const outputCount = template.Outputs ? Object.keys(template.Outputs).length : 0

  // CloudFormation limits
  if (resourceCount > 500) {
    errors.push({
      path: 'Resources',
      message: `Template has ${resourceCount} resources, exceeding the limit of 500`,
      severity: 'error',
    })
  }
  else if (resourceCount > 200) {
    warnings.push({
      path: 'Resources',
      message: `Template has ${resourceCount} resources. Consider using nested stacks for better organization.`,
      severity: 'warning',
    })
  }

  if (parameterCount > 200) {
    errors.push({
      path: 'Parameters',
      message: `Template has ${parameterCount} parameters, exceeding the limit of 200`,
      severity: 'error',
    })
  }

  if (outputCount > 200) {
    errors.push({
      path: 'Outputs',
      message: `Template has ${outputCount} outputs, exceeding the limit of 200`,
      severity: 'error',
    })
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}
