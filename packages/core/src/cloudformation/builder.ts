import type { CloudConfig } from 'ts-cloud-types'
import type { CloudFormationTemplate, CloudFormationResource } from './types'
import { Fn } from './types'
import { addNetworkResources } from './builders/network'
import { addStorageResources } from './builders/storage'
import { addComputeResources } from './builders/compute'
import { addDatabaseResources } from './builders/database'
import { addFunctionResources } from './builders/functions'
import { addCacheResources } from './builders/cache'
import { addQueueResources } from './builders/queue'
import { addMessagingResources } from './builders/messaging'
import { addCDNResources } from './builders/cdn'
import { addApiGatewayResources } from './builders/api-gateway'
import { addMonitoringResources } from './builders/monitoring'
import { addSecurityResources } from './builders/security'

/**
 * CloudFormation Template Builder
 * Converts-cloudConfig to CloudFormation templates
 */
export class CloudFormationBuilder {
  protected template: CloudFormationTemplate
  private config: CloudConfig
  private resourceDependencies: Map<string, Set<string>>

  constructor(config: CloudConfig) {
    this.config = config
    this.resourceDependencies = new Map()
    this.template = {
      AWSTemplateFormatVersion: '2010-09-09',
      Description: `Infrastructure for ${config.project.name} (${config.project.slug})`,
      Resources: {},
    }
  }

  /**
   * Build the complete CloudFormation template
   */
  build(): CloudFormationTemplate {
    this.addParameters()
    this.addMappings()
    this.addConditions()
    this.addResources()
    this.initializeOutputs()
    this.resolveDependencies()

    return this.template
  }

  /**
   * Add parameters to the template
   */
  private addParameters(): void {
    this.template.Parameters = {
      Environment: {
        Type: 'String',
        Default: 'production',
        AllowedValues: ['development', 'staging', 'production'],
        Description: 'Environment name',
      },
    }
  }

  /**
   * Add mappings to the template
   */
  private addMappings(): void {
    // Region-specific AMI mappings
    this.template.Mappings = {
      RegionMap: {
        'us-east-1': { AMI: 'ami-0c55b159cbfafe1f0' },
        'us-west-2': { AMI: 'ami-0d1cd67c26f5fca19' },
        'eu-west-1': { AMI: 'ami-0bbc25e23a7640b9b' },
        // Add more regions as needed
      },
    }
  }

  /**
   * Add conditions to the template
   */
  private addConditions(): void {
    this.template.Conditions = {
      IsProduction: Fn.equals(Fn.ref('Environment'), 'production'),
      HasDomain: Fn.not([Fn.equals(this.config.environments?.production?.domain || '', '')]),
    }
  }

  /**
   * Add all resources to the template
   */
  private addResources(): void {
    const { infrastructure } = this.config

    if (!infrastructure) {
      return
    }

    // Network resources
    if (infrastructure.network) {
      this.addNetworkResources(infrastructure.network)
    }

    // Storage resources
    if (infrastructure.storage) {
      this.addStorageResources(infrastructure.storage)
    }

    // Compute resources
    if (infrastructure.compute) {
      this.addComputeResources(infrastructure.compute)
    }

    // Database resources
    if (infrastructure.databases) {
      this.addDatabaseResources(infrastructure.databases)
    }

    // Cache resources
    if (infrastructure.cache) {
      this.addCacheResources(infrastructure.cache)
    }

    // CDN resources
    if (infrastructure.cdn) {
      this.addCDNResources(infrastructure.cdn)
    }

    // API Gateway resources
    if (infrastructure.apiGateway) {
      this.addApiGatewayResources(infrastructure.apiGateway)
    }

    // Lambda functions
    if (infrastructure.functions) {
      this.addFunctionResources(infrastructure.functions)
    }

    // Queue resources
    if (infrastructure.queues) {
      this.addQueueResources(infrastructure.queues)
    }

    // Messaging resources
    if (infrastructure.messaging) {
      this.addMessagingResources(infrastructure.messaging)
    }

    // Monitoring resources
    if (infrastructure.monitoring) {
      this.addMonitoringResources(infrastructure.monitoring)
    }

    // Security resources
    if (infrastructure.security) {
      this.addSecurityResources(infrastructure.security)
    }
  }

  /**
   * Initialize default outputs in the template
   */
  private initializeOutputs(): void {
    this.template.Outputs = {
      StackName: {
        Description: 'Stack name',
        Value: Fn.ref('AWS::StackName'),
        Export: {
          Name: Fn.sub('${AWS::StackName}-Name'),
        },
      },
      Region: {
        Description: 'AWS Region',
        Value: Fn.ref('AWS::Region'),
        Export: {
          Name: Fn.sub('${AWS::StackName}-Region'),
        },
      },
    }

    // Add domain output if configured
    if (this.config.environments?.production?.domain) {
      this.template.Outputs.Domain = {
        Description: 'Production domain',
        Value: this.config.environments.production.domain,
        Condition: 'HasDomain',
      }
    }
  }

  /**
   * Add a resource to the template
   */
  addResource(
    logicalId: string,
    type: string,
    properties: Record<string, any>,
    options?: {
      dependsOn?: string | string[]
      condition?: string
      deletionPolicy?: 'Delete' | 'Retain' | 'Snapshot'
      updateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot'
    },
  ): void {
    const resource: CloudFormationResource = {
      Type: type,
      Properties: properties,
    }

    if (options?.dependsOn) {
      resource.DependsOn = options.dependsOn
      this.trackDependency(logicalId, options.dependsOn)
    }

    if (options?.condition) {
      resource.Condition = options.condition
    }

    if (options?.deletionPolicy) {
      resource.DeletionPolicy = options.deletionPolicy
    }

    if (options?.updateReplacePolicy) {
      resource.UpdateReplacePolicy = options.updateReplacePolicy
    }

    this.template.Resources[logicalId] = resource
  }

  /**
   * Add or merge outputs to the template
   */
  addOutputs(outputs: Record<string, any>): void {
    this.template.Outputs = {
      ...this.template.Outputs,
      ...outputs,
    }
  }

  /**
   * Get the current outputs
   */
  getOutputs(): Record<string, any> {
    return this.template.Outputs || {}
  }

  /**
   * Check if a resource exists in the template
   */
  hasResource(logicalId: string): boolean {
    return logicalId in this.template.Resources
  }

  /**
   * Get a resource from the template
   */
  getResource(logicalId: string): CloudFormationResource | undefined {
    return this.template.Resources[logicalId]
  }

  /**
   * Track resource dependencies for cycle detection
   */
  private trackDependency(resource: string, dependencies: string | string[]): void {
    if (!this.resourceDependencies.has(resource)) {
      this.resourceDependencies.set(resource, new Set())
    }

    const deps = Array.isArray(dependencies) ? dependencies : [dependencies]
    deps.forEach(dep => this.resourceDependencies.get(resource)!.add(dep))
  }

  /**
   * Resolve and validate resource dependencies
   * Detects circular dependencies and reorders if needed
   */
  private resolveDependencies(): void {
    // Topological sort to detect cycles
    const visited = new Set<string>()
    const recursionStack = new Set<string>()

    const visit = (resource: string): boolean => {
      if (recursionStack.has(resource)) {
        throw new Error(`Circular dependency detected involving resource: ${resource}`)
      }

      if (visited.has(resource)) {
        return true
      }

      visited.add(resource)
      recursionStack.add(resource)

      const deps = this.resourceDependencies.get(resource)
      if (deps) {
        for (const dep of deps) {
          visit(dep)
        }
      }

      recursionStack.delete(resource)
      return true
    }

    for (const resource of this.resourceDependencies.keys()) {
      visit(resource)
    }
  }

  /**
   * Generate a logical ID from a name
   */
  toLogicalId(name: string): string {
    return name
      .split(/[-_\s]/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join('')
  }

  /**
   * Call resource builder functions
   */
  private addNetworkResources(network: any): void {
    addNetworkResources(this as any, network)
  }

  private addStorageResources(storage: any): void {
    addStorageResources(this as any, storage)
  }

  private addComputeResources(compute: any): void {
    addComputeResources(this as any, compute)
  }

  private addDatabaseResources(database: any): void {
    addDatabaseResources(this as any, database)
  }

  private addFunctionResources(functions: any): void {
    addFunctionResources(this as any, functions)
  }

  private addCacheResources(cache: any): void {
    addCacheResources(this as any, cache)
  }

  private addQueueResources(queue: any): void {
    addQueueResources(this as any, queue)
  }

  private addMessagingResources(messaging: any): void {
    addMessagingResources(this as any, messaging)
  }

  private addCDNResources(cdn: any): void {
    addCDNResources(this as any, cdn)
  }

  private addApiGatewayResources(apiGateway: any): void {
    addApiGatewayResources(this as any, apiGateway)
  }

  private addMonitoringResources(monitoring: any): void {
    addMonitoringResources(this as any, monitoring)
  }

  private addSecurityResources(security: any): void {
    addSecurityResources(this as any, security)
  }
}

/**
 * Main function to convert CloudConfig to CloudFormation template
 */
export function buildCloudFormationTemplate(config: CloudConfig): CloudFormationTemplate {
  const builder = new CloudFormationBuilder(config)
  return builder.build()
}
