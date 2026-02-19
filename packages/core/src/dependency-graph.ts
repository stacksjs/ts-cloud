import type { CloudFormationResource } from 'ts-cloud-aws-types'

export interface ResourceNode {
  logicalId: string
  resource: CloudFormationResource
  dependencies: Set<string>
}

/**
 * Dependency Graph for CloudFormation resources
 * Ensures resources are created in the correct order
 */
export class DependencyGraph {
  private nodes: Map<string, ResourceNode> = new Map()

  /**
   * Add a resource to the dependency graph
   */
  addResource(logicalId: string, resource: CloudFormationResource): void {
    const dependencies = this.extractDependencies(resource)

    this.nodes.set(logicalId, {
      logicalId,
      resource,
      dependencies,
    })
  }

  /**
   * Extract dependencies from a resource
   */
  private extractDependencies(resource: CloudFormationResource): Set<string> {
    const dependencies = new Set<string>()

    // Add explicit DependsOn
    if (resource.DependsOn) {
      if (Array.isArray(resource.DependsOn)) {
        resource.DependsOn.forEach(dep => dependencies.add(dep))
      }
      else {
        dependencies.add(resource.DependsOn)
      }
    }

    // Extract Ref dependencies
    this.findReferences(resource.Properties || {}, dependencies)

    return dependencies
  }

  /**
   * Find all Ref references in an object
   */
  private findReferences(obj: any, dependencies: Set<string>): void {
    if (!obj || typeof obj !== 'object')
      return

    if ('Ref' in obj && typeof obj.Ref === 'string') {
      // Ignore pseudo parameters
      if (!obj.Ref.startsWith('AWS::')) {
        dependencies.add(obj.Ref)
      }
    }

    if ('Fn::GetAtt' in obj && Array.isArray(obj['Fn::GetAtt'])) {
      dependencies.add(obj['Fn::GetAtt'][0])
    }

    // Recursively search
    for (const value of Object.values(obj)) {
      if (typeof value === 'object') {
        this.findReferences(value, dependencies)
      }
    }
  }

  /**
   * Perform topological sort to determine resource creation order
   */
  topologicalSort(): string[] {
    const sorted: string[] = []
    const visited = new Set<string>()
    const visiting = new Set<string>()

    const visit = (nodeId: string): void => {
      if (visited.has(nodeId))
        return

      if (visiting.has(nodeId)) {
        throw new Error(`Circular dependency detected: ${nodeId}`)
      }

      visiting.add(nodeId)

      const node = this.nodes.get(nodeId)
      if (node) {
        for (const dep of node.dependencies) {
          visit(dep)
        }
      }

      visiting.delete(nodeId)
      visited.add(nodeId)
      sorted.push(nodeId)
    }

    for (const nodeId of this.nodes.keys()) {
      visit(nodeId)
    }

    return sorted
  }

  /**
   * Validate that all dependencies exist
   */
  validate(): void {
    for (const [nodeId, node] of this.nodes.entries()) {
      for (const dep of node.dependencies) {
        if (!this.nodes.has(dep)) {
          throw new Error(
            `Resource "${nodeId}" depends on "${dep}" which does not exist`,
          )
        }
      }
    }
  }

  /**
   * Get resources that depend on a given resource
   */
  getDependents(logicalId: string): string[] {
    const dependents: string[] = []

    for (const [nodeId, node] of this.nodes.entries()) {
      if (node.dependencies.has(logicalId)) {
        dependents.push(nodeId)
      }
    }

    return dependents
  }
}
