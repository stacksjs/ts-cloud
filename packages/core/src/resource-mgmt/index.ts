/**
 * Resource Management - Tagging strategies, cost allocation, resource groups
 */

export interface TaggingStrategy { id: string; tags: Record<string, string>; resources: string[] }
export interface CostAllocation { id: string; tagKey: string; allocations: Array<{ tagValue: string; cost: number }> }
export interface ResourceGroup { id: string; name: string; query: { resourceTypeFilters: string[]; tagFilters: Array<{ key: string; values: string[] }> } }

export class ResourceManagementManager {
  private strategies = new Map<string, TaggingStrategy>()
  private allocations = new Map<string, CostAllocation>()
  private groups = new Map<string, ResourceGroup>()
  private counter = 0

  createTaggingStrategy(tags: Record<string, string>, resources: string[]): TaggingStrategy {
    const id = `tagging-${Date.now()}-${this.counter++}`
    const strategy = { id, tags, resources }
    this.strategies.set(id, strategy)
    return strategy
  }

  createCostAllocation(tagKey: string, allocations: Array<{ tagValue: string; cost: number }>): CostAllocation {
    const id = `cost-${Date.now()}-${this.counter++}`
    const allocation = { id, tagKey, allocations }
    this.allocations.set(id, allocation)
    return allocation
  }

  createResourceGroup(name: string, resourceTypeFilters: string[], tagFilters: Array<{ key: string; values: string[] }>): ResourceGroup {
    const id = `group-${Date.now()}-${this.counter++}`
    const group = { id, name, query: { resourceTypeFilters, tagFilters } }
    this.groups.set(id, group)
    return group
  }

  clear() { this.strategies.clear(); this.allocations.clear(); this.groups.clear() }
}

export const resourceManagementManager = new ResourceManagementManager()
