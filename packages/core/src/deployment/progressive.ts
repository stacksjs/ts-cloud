/**
 * Progressive Rollouts, Feature Flags, and Deployment Gates
*/

export interface ProgressiveRollout {
  id: string
  name: string
  stages: Array<{ percentage: number; durationMinutes: number }>
  currentStage: number
}

export interface FeatureFlag {
  id: string
  name: string
  enabled: boolean
  rolloutPercentage: number
  targetingRules: Array<{ attribute: string; operator: string; value: any }>
}

export interface DeploymentGate {
  id: string
  name: string
  type: 'manual' | 'automated'
  approvers?: string[]
  conditions?: Array<{ metric: string; threshold: number }>
}

export class ProgressiveDeploymentManager {
  private rollouts = new Map<string, ProgressiveRollout>()
  private flags = new Map<string, FeatureFlag>()
  private gates = new Map<string, DeploymentGate>()
  private counter = 0

  createProgressiveRollout(name: string, stages: Array<{ percentage: number; durationMinutes: number }>): ProgressiveRollout {
    const id = `rollout-${Date.now()}-${this.counter++}`
    const rollout = { id, name, stages, currentStage: 0 }
    this.rollouts.set(id, rollout)
    return rollout
  }

  createFeatureFlag(name: string, rolloutPercentage = 0): FeatureFlag {
    const id = `flag-${Date.now()}-${this.counter++}`
    const flag = { id, name, enabled: false, rolloutPercentage, targetingRules: [] }
    this.flags.set(id, flag)
    return flag
  }

  createDeploymentGate(name: string, type: 'manual' | 'automated', approvers?: string[], conditions?: Array<{ metric: string; threshold: number }>): DeploymentGate {
    const id = `gate-${Date.now()}-${this.counter++}`
    const gate = { id, name, type, approvers, conditions }
    this.gates.set(id, gate)
    return gate
  }

  clear(): void {
    this.rollouts.clear()
    this.flags.clear()
    this.gates.clear()
  }
}

export const progressiveDeploymentManager: ProgressiveDeploymentManager = new ProgressiveDeploymentManager()
