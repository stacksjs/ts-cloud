/**
 * Canary Deployment Strategy
 * Gradual rollout with automatic rollback based on metrics
 */

export interface CanaryDeployment {
  id: string
  name: string
  baselineVersion: DeploymentVersion
  canaryVersion: DeploymentVersion
  stages: CanaryStage[]
  currentStage: number
  status: 'pending' | 'in_progress' | 'completed' | 'rolled_back' | 'failed'
  metrics?: CanaryMetrics
  autoPromote?: boolean
  autoRollback?: boolean
}

export interface DeploymentVersion {
  version: string
  targetGroupArn?: string
  taskDefinitionArn?: string
  functionVersionArn?: string
  weight: number
}

export interface CanaryStage {
  name: string
  trafficPercentage: number
  durationMinutes: number
  alarmThresholds?: AlarmThresholds
}

export interface AlarmThresholds {
  errorRate?: number // Percentage (e.g., 1 = 1%)
  latencyP99?: number // Milliseconds
  latencyP95?: number // Milliseconds
  httpErrorRate?: number // Percentage
  customMetrics?: CustomMetric[]
}

export interface CustomMetric {
  name: string
  namespace: string
  threshold: number
  comparisonOperator: 'GreaterThanThreshold' | 'LessThanThreshold' | 'GreaterThanOrEqualToThreshold' | 'LessThanOrEqualToThreshold'
}

export interface CanaryMetrics {
  baselineErrorRate: number
  canaryErrorRate: number
  baselineLatencyP99: number
  canaryLatencyP99: number
  baselineRequestCount: number
  canaryRequestCount: number
}

export interface CanaryResult {
  success: boolean
  deploymentId: string
  startTime: Date
  endTime?: Date
  completedStages: number
  rolledBack: boolean
  reason?: string
  metricsAtCompletion?: CanaryMetrics
}

/**
 * Canary deployment manager
 */
export class CanaryManager {
  private deployments: Map<string, CanaryDeployment> = new Map()
  private deploymentHistory: Map<string, CanaryResult[]> = new Map()
  private deploymentCounter = 0
  private resultCounter = 0

  /**
   * Predefined canary strategies
   */
  static readonly Strategies = {
    /**
     * Conservative: 10% -> 25% -> 50% -> 100%
     */
    CONSERVATIVE: [
      { name: 'Initial Canary', trafficPercentage: 10, durationMinutes: 10 },
      { name: 'Quarter Traffic', trafficPercentage: 25, durationMinutes: 10 },
      { name: 'Half Traffic', trafficPercentage: 50, durationMinutes: 15 },
      { name: 'Full Traffic', trafficPercentage: 100, durationMinutes: 5 },
    ] as CanaryStage[],

    /**
     * Balanced: 20% -> 50% -> 100%
     */
    BALANCED: [
      { name: 'Initial Canary', trafficPercentage: 20, durationMinutes: 5 },
      { name: 'Half Traffic', trafficPercentage: 50, durationMinutes: 10 },
      { name: 'Full Traffic', trafficPercentage: 100, durationMinutes: 5 },
    ] as CanaryStage[],

    /**
     * Aggressive: 50% -> 100%
     */
    AGGRESSIVE: [
      { name: 'Half Traffic', trafficPercentage: 50, durationMinutes: 5 },
      { name: 'Full Traffic', trafficPercentage: 100, durationMinutes: 5 },
    ] as CanaryStage[],

    /**
     * Linear 10%: Incremental 10% steps
     */
    LINEAR_10: [
      { name: 'Canary 10%', trafficPercentage: 10, durationMinutes: 5 },
      { name: 'Canary 20%', trafficPercentage: 20, durationMinutes: 5 },
      { name: 'Canary 30%', trafficPercentage: 30, durationMinutes: 5 },
      { name: 'Canary 40%', trafficPercentage: 40, durationMinutes: 5 },
      { name: 'Canary 50%', trafficPercentage: 50, durationMinutes: 5 },
      { name: 'Canary 60%', trafficPercentage: 60, durationMinutes: 5 },
      { name: 'Canary 70%', trafficPercentage: 70, durationMinutes: 5 },
      { name: 'Canary 80%', trafficPercentage: 80, durationMinutes: 5 },
      { name: 'Canary 90%', trafficPercentage: 90, durationMinutes: 5 },
      { name: 'Full Traffic', trafficPercentage: 100, durationMinutes: 5 },
    ] as CanaryStage[],
  }

  /**
   * Create canary deployment
   */
  createDeployment(deployment: Omit<CanaryDeployment, 'id'>): CanaryDeployment {
    const id = `canary-${Date.now()}-${this.deploymentCounter++}`

    const canaryDeployment: CanaryDeployment = {
      id,
      ...deployment,
    }

    this.deployments.set(id, canaryDeployment)

    return canaryDeployment
  }

  /**
   * Create Lambda canary deployment
   */
  createLambdaCanaryDeployment(options: {
    name: string
    baselineVersionArn: string
    canaryVersionArn: string
    strategy?: keyof typeof CanaryManager.Strategies
    autoPromote?: boolean
    errorRateThreshold?: number
    latencyThreshold?: number
  }): CanaryDeployment {
    const strategy = options.strategy || 'BALANCED'
    const stages = CanaryManager.Strategies[strategy].map(stage => ({
      ...stage,
      alarmThresholds: {
        errorRate: options.errorRateThreshold || 1,
        latencyP99: options.latencyThreshold || 1000,
      },
    }))

    return this.createDeployment({
      name: options.name,
      baselineVersion: {
        version: 'baseline',
        functionVersionArn: options.baselineVersionArn,
        weight: 100,
      },
      canaryVersion: {
        version: 'canary',
        functionVersionArn: options.canaryVersionArn,
        weight: 0,
      },
      stages,
      currentStage: 0,
      status: 'pending',
      autoPromote: options.autoPromote ?? true,
      autoRollback: true,
    })
  }

  /**
   * Create ECS canary deployment
   */
  createECSCanaryDeployment(options: {
    name: string
    baselineTaskDefinitionArn: string
    canaryTaskDefinitionArn: string
    baselineTargetGroupArn: string
    canaryTargetGroupArn: string
    strategy?: keyof typeof CanaryManager.Strategies
  }): CanaryDeployment {
    const strategy = options.strategy || 'CONSERVATIVE'
    const stages = CanaryManager.Strategies[strategy]

    return this.createDeployment({
      name: options.name,
      baselineVersion: {
        version: 'baseline',
        taskDefinitionArn: options.baselineTaskDefinitionArn,
        targetGroupArn: options.baselineTargetGroupArn,
        weight: 100,
      },
      canaryVersion: {
        version: 'canary',
        taskDefinitionArn: options.canaryTaskDefinitionArn,
        targetGroupArn: options.canaryTargetGroupArn,
        weight: 0,
      },
      stages,
      currentStage: 0,
      status: 'pending',
      autoRollback: true,
    })
  }

  /**
   * Execute canary deployment
   */
  async executeDeployment(deploymentId: string, dryRun: boolean = false): Promise<CanaryResult> {
    const deployment = this.deployments.get(deploymentId)

    if (!deployment) {
      throw new Error(`Deployment not found: ${deploymentId}`)
    }

    const result: CanaryResult = {
      success: false,
      deploymentId: `result-${Date.now()}-${this.resultCounter++}`,
      startTime: new Date(),
      completedStages: 0,
      rolledBack: false,
    }

    console.log(`${dryRun ? '[DRY RUN] ' : ''}Starting canary deployment: ${deployment.name}`)
    console.log(`  Strategy: ${deployment.stages.length} stages`)
    console.log(`  Auto-promote: ${deployment.autoPromote}`)
    console.log(`  Auto-rollback: ${deployment.autoRollback}`)
    console.log('')

    deployment.status = 'in_progress'

    // Execute each canary stage
    for (let i = 0; i < deployment.stages.length; i++) {
      const stage = deployment.stages[i]
      deployment.currentStage = i

      console.log(`Stage ${i + 1}/${deployment.stages.length}: ${stage.name}`)
      console.log(`  Traffic: ${stage.trafficPercentage}% canary, ${100 - stage.trafficPercentage}% baseline`)
      console.log(`  Duration: ${stage.durationMinutes} minutes`)

      // Update traffic weights
      if (!dryRun) {
        deployment.baselineVersion.weight = 100 - stage.trafficPercentage
        deployment.canaryVersion.weight = stage.trafficPercentage
      }

      // Monitor stage
      const stageSuccessful = await this.monitorStage(deployment, stage, dryRun)

      if (!stageSuccessful) {
        console.log(`  ✗ Stage failed - metrics exceeded thresholds`)

        if (deployment.autoRollback) {
          console.log(`\\n  Rolling back deployment...`)
          await this.rollback(deploymentId, dryRun)
          result.rolledBack = true
          result.reason = 'Metrics exceeded thresholds'
        }

        result.endTime = new Date()
        deployment.status = 'rolled_back'

        this.recordDeployment(deploymentId, result)
        return result
      }

      console.log(`  ✓ Stage completed successfully`)
      result.completedStages++

      console.log('')
    }

    // All stages completed
    deployment.status = 'completed'
    result.success = true
    result.endTime = new Date()

    console.log(`✓ Canary deployment completed successfully`)

    this.recordDeployment(deploymentId, result)

    return result
  }

  /**
   * Monitor canary stage
   */
  private async monitorStage(
    deployment: CanaryDeployment,
    stage: CanaryStage,
    dryRun: boolean,
  ): Promise<boolean> {
    console.log(`  Monitoring metrics...`)

    if (dryRun) {
      console.log(`  [SKIPPED - DRY RUN]`)
      return true
    }

    // Simulate metric collection
    await new Promise(resolve => setTimeout(resolve, 100))

    // Simulate metrics (in real implementation, would query CloudWatch)
    const metrics: CanaryMetrics = {
      baselineErrorRate: Math.random() * 0.5, // 0-0.5%
      canaryErrorRate: Math.random() * 0.8, // 0-0.8%
      baselineLatencyP99: 200 + Math.random() * 100,
      canaryLatencyP99: 180 + Math.random() * 150,
      baselineRequestCount: Math.floor(Math.random() * 1000) + 500,
      canaryRequestCount: Math.floor((Math.random() * 1000 + 500) * stage.trafficPercentage / 100),
    }

    deployment.metrics = metrics

    console.log(`    Baseline: ${metrics.baselineErrorRate.toFixed(2)}% errors, ${metrics.baselineLatencyP99.toFixed(0)}ms P99`)
    console.log(`    Canary:   ${metrics.canaryErrorRate.toFixed(2)}% errors, ${metrics.canaryLatencyP99.toFixed(0)}ms P99`)

    // Check alarm thresholds
    if (stage.alarmThresholds) {
      const { errorRate, latencyP99 } = stage.alarmThresholds

      if (errorRate && metrics.canaryErrorRate > errorRate) {
        console.log(`    ⚠ Error rate exceeded threshold: ${metrics.canaryErrorRate.toFixed(2)}% > ${errorRate}%`)
        return false
      }

      if (latencyP99 && metrics.canaryLatencyP99 > latencyP99) {
        console.log(`    ⚠ Latency P99 exceeded threshold: ${metrics.canaryLatencyP99.toFixed(0)}ms > ${latencyP99}ms`)
        return false
      }
    }

    return true
  }

  /**
   * Rollback canary deployment
   */
  async rollback(deploymentId: string, dryRun: boolean = false): Promise<void> {
    const deployment = this.deployments.get(deploymentId)

    if (!deployment) {
      throw new Error(`Deployment not found: ${deploymentId}`)
    }

    console.log(`${dryRun ? '[DRY RUN] ' : ''}Rolling back canary deployment: ${deployment.name}`)

    if (!dryRun) {
      deployment.baselineVersion.weight = 100
      deployment.canaryVersion.weight = 0
      deployment.status = 'rolled_back'
    }

    console.log(`  Traffic restored to baseline: 100%`)
  }

  /**
   * Promote canary to baseline
   */
  promoteCanary(deploymentId: string): void {
    const deployment = this.deployments.get(deploymentId)

    if (!deployment) {
      throw new Error(`Deployment not found: ${deploymentId}`)
    }

    console.log(`Promoting canary to baseline: ${deployment.name}`)

    // Swap versions
    const temp = deployment.baselineVersion
    deployment.baselineVersion = deployment.canaryVersion
    deployment.canaryVersion = temp

    deployment.baselineVersion.weight = 100
    deployment.canaryVersion.weight = 0
    deployment.status = 'completed'

    console.log(`  Canary promoted successfully`)
  }

  /**
   * Record deployment result
   */
  private recordDeployment(deploymentId: string, result: CanaryResult): void {
    if (!this.deploymentHistory.has(deploymentId)) {
      this.deploymentHistory.set(deploymentId, [])
    }

    this.deploymentHistory.get(deploymentId)!.push(result)
  }

  /**
   * Get deployment
   */
  getDeployment(id: string): CanaryDeployment | undefined {
    return this.deployments.get(id)
  }

  /**
   * List deployments
   */
  listDeployments(): CanaryDeployment[] {
    return Array.from(this.deployments.values())
  }

  /**
   * Get deployment history
   */
  getDeploymentHistory(deploymentId: string): CanaryResult[] {
    return this.deploymentHistory.get(deploymentId) || []
  }

  /**
   * Generate CloudFormation for Lambda canary
   */
  generateLambdaAliasCF(deployment: CanaryDeployment, aliasName: string): any {
    return {
      Type: 'AWS::Lambda::Alias',
      Properties: {
        FunctionName: { Ref: 'LambdaFunction' },
        Name: aliasName,
        FunctionVersion: deployment.canaryVersion.version,
        RoutingConfig: {
          AdditionalVersionWeights: [
            {
              FunctionVersion: deployment.baselineVersion.version,
              FunctionWeight: deployment.baselineVersion.weight / 100,
            },
          ],
        },
      },
    }
  }

  /**
   * Generate CloudFormation for ALB weighted target groups
   */
  generateALBListenerRuleCF(deployment: CanaryDeployment): any {
    return {
      Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
      Properties: {
        ListenerArn: { Ref: 'LoadBalancerListener' },
        Priority: 1,
        Conditions: [
          {
            Field: 'path-pattern',
            Values: ['/*'],
          },
        ],
        Actions: [
          {
            Type: 'forward',
            ForwardConfig: {
              TargetGroups: [
                {
                  TargetGroupArn: deployment.baselineVersion.targetGroupArn,
                  Weight: deployment.baselineVersion.weight,
                },
                {
                  TargetGroupArn: deployment.canaryVersion.targetGroupArn,
                  Weight: deployment.canaryVersion.weight,
                },
              ],
              TargetGroupStickinessConfig: {
                Enabled: false,
              },
            },
          },
        ],
      },
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.deployments.clear()
    this.deploymentHistory.clear()
    this.deploymentCounter = 0
    this.resultCounter = 0
  }
}

/**
 * Global canary manager instance
 */
export const canaryManager: CanaryManager = new CanaryManager()
