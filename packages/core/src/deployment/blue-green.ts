/**
 * Blue/Green Deployment Strategy
 * Zero-downtime deployments with instant rollback capability
*/

export interface BlueGreenDeployment {
  id: string
  name: string
  blueEnvironment: Environment
  greenEnvironment: Environment
  activeEnvironment: 'blue' | 'green'
  routingConfig: RoutingConfig
  autoPromote?: boolean
  autoRollback?: boolean
  healthCheckConfig?: HealthCheckConfig
}

export interface Environment {
  name: string
  targetGroupArn: string
  autoScalingGroupName?: string
  taskDefinitionArn?: string // For ECS
  functionVersionArn?: string // For Lambda
  instanceIds?: string[] // For EC2
  weight?: number
}

export interface RoutingConfig {
  type: 'alb' | 'route53' | 'cloudfront' | 'api-gateway'
  listenerArn?: string // For ALB
  hostedZoneId?: string // For Route53
  distributionId?: string // For CloudFront
  apiId?: string // For API Gateway
  switchoverTimeSeconds?: number
}

export interface HealthCheckConfig {
  healthyThreshold: number
  unhealthyThreshold: number
  interval: number
  timeout: number
  path?: string
  port?: number
}

export interface DeploymentResult {
  success: boolean
  deploymentId: string
  startTime: Date
  endTime?: Date
  switchedAt?: Date
  rolledBackAt?: Date
  healthChecksPassed: boolean
  errors?: string[]
}

/**
 * Blue/Green deployment manager
*/
export class BlueGreenManager {
  private deployments: Map<string, BlueGreenDeployment> = new Map()
  private deploymentHistory: Map<string, DeploymentResult[]> = new Map()
  private deploymentCounter = 0
  private resultCounter = 0

  /**
   * Create blue/green deployment configuration
  */
  createDeployment(deployment: Omit<BlueGreenDeployment, 'id'>): BlueGreenDeployment {
    const id = `bg-deployment-${Date.now()}-${this.deploymentCounter++}`

    const blueGreenDeployment: BlueGreenDeployment = {
      id,
      ...deployment,
    }

    this.deployments.set(id, blueGreenDeployment)

    return blueGreenDeployment
  }

  /**
   * Create ALB-based blue/green deployment
  */
  createALBDeployment(options: {
    name: string
    listenerArn: string
    blueTargetGroupArn: string
    greenTargetGroupArn: string
    autoPromote?: boolean
    healthCheckConfig?: HealthCheckConfig
  }): BlueGreenDeployment {
    return this.createDeployment({
      name: options.name,
      blueEnvironment: {
        name: 'blue',
        targetGroupArn: options.blueTargetGroupArn,
        weight: 100,
      },
      greenEnvironment: {
        name: 'green',
        targetGroupArn: options.greenTargetGroupArn,
        weight: 0,
      },
      activeEnvironment: 'blue',
      routingConfig: {
        type: 'alb',
        listenerArn: options.listenerArn,
        switchoverTimeSeconds: 0,
      },
      autoPromote: options.autoPromote,
      healthCheckConfig: options.healthCheckConfig,
    })
  }

  /**
   * Create Route53-based blue/green deployment
  */
  createRoute53Deployment(options: {
    name: string
    hostedZoneId: string
    blueTargetGroupArn: string
    greenTargetGroupArn: string
    switchoverTimeSeconds?: number
  }): BlueGreenDeployment {
    return this.createDeployment({
      name: options.name,
      blueEnvironment: {
        name: 'blue',
        targetGroupArn: options.blueTargetGroupArn,
        weight: 100,
      },
      greenEnvironment: {
        name: 'green',
        targetGroupArn: options.greenTargetGroupArn,
        weight: 0,
      },
      activeEnvironment: 'blue',
      routingConfig: {
        type: 'route53',
        hostedZoneId: options.hostedZoneId,
        switchoverTimeSeconds: options.switchoverTimeSeconds || 60,
      },
    })
  }

  /**
   * Create ECS blue/green deployment
  */
  createECSDeployment(options: {
    name: string
    listenerArn: string
    blueTargetGroupArn: string
    greenTargetGroupArn: string
    blueTaskDefinitionArn: string
    greenTaskDefinitionArn: string
    autoRollback?: boolean
  }): BlueGreenDeployment {
    return this.createDeployment({
      name: options.name,
      blueEnvironment: {
        name: 'blue',
        targetGroupArn: options.blueTargetGroupArn,
        taskDefinitionArn: options.blueTaskDefinitionArn,
        weight: 100,
      },
      greenEnvironment: {
        name: 'green',
        targetGroupArn: options.greenTargetGroupArn,
        taskDefinitionArn: options.greenTaskDefinitionArn,
        weight: 0,
      },
      activeEnvironment: 'blue',
      routingConfig: {
        type: 'alb',
        listenerArn: options.listenerArn,
      },
      autoRollback: options.autoRollback ?? true,
    })
  }

  /**
   * Execute blue/green deployment
  */
  async executeDeployment(deploymentId: string, dryRun: boolean = false): Promise<DeploymentResult> {
    const deployment = this.deployments.get(deploymentId)

    if (!deployment) {
      throw new Error(`Deployment not found: ${deploymentId}`)
    }

    const result: DeploymentResult = {
      success: false,
      deploymentId: `result-${Date.now()}-${this.resultCounter++}`,
      startTime: new Date(),
      healthChecksPassed: false,
      errors: [],
    }

    console.log(`${dryRun ? '[DRY RUN] ' : ''}Starting blue/green deployment: ${deployment.name}`)
    console.log(`  Active environment: ${deployment.activeEnvironment}`)
    console.log(`  Routing type: ${deployment.routingConfig.type}`)

    // Determine target environment
    const targetEnv = deployment.activeEnvironment === 'blue' ? 'green' : 'blue'
    console.log(`  Switching to: ${targetEnv}`)

    // Step 1: Deploy to inactive environment
    console.log(`\\n1. Deploying to ${targetEnv} environment`)
    if (!dryRun) {
      // Simulate deployment
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    // Step 2: Run health checks
    console.log(`\\n2. Running health checks on ${targetEnv} environment`)
    if (deployment.healthCheckConfig) {
      const passed = await this.runHealthChecks(deployment, targetEnv, dryRun)
      result.healthChecksPassed = passed

      if (!passed) {
        result.errors?.push('Health checks failed')
        result.endTime = new Date()

        if (deployment.autoRollback) {
          console.log('  Auto-rollback enabled - keeping current environment active')
          result.rolledBackAt = new Date()
        }

        this.recordDeployment(deploymentId, result)
        return result
      }
    }
    else {
      result.healthChecksPassed = true
    }

    // Step 3: Switch traffic
    console.log(`\\n3. Switching traffic to ${targetEnv} environment`)
    if (!dryRun) {
      deployment.activeEnvironment = targetEnv
      result.switchedAt = new Date()
    }

    // Step 4: Monitor
    console.log(`\\n4. Monitoring ${targetEnv} environment`)
    if (!dryRun) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    result.success = true
    result.endTime = new Date()

    console.log(`\\n✓ Deployment completed successfully`)

    this.recordDeployment(deploymentId, result)

    return result
  }

  /**
   * Rollback deployment
  */
  async rollback(deploymentId: string): Promise<DeploymentResult> {
    const deployment = this.deployments.get(deploymentId)

    if (!deployment) {
      throw new Error(`Deployment not found: ${deploymentId}`)
    }

    const result: DeploymentResult = {
      success: false,
      deploymentId: `result-${Date.now()}-${this.resultCounter++}`,
      startTime: new Date(),
      healthChecksPassed: true,
      errors: [],
    }

    console.log(`Rolling back deployment: ${deployment.name}`)

    const previousEnv = deployment.activeEnvironment === 'blue' ? 'green' : 'blue'
    deployment.activeEnvironment = previousEnv

    result.success = true
    result.rolledBackAt = new Date()
    result.endTime = new Date()

    console.log(`  Switched back to: ${previousEnv}`)

    this.recordDeployment(deploymentId, result)

    return result
  }

  /**
   * Run health checks
  */
  private async runHealthChecks(
    deployment: BlueGreenDeployment,
    environment: 'blue' | 'green',
    dryRun: boolean,
  ): Promise<boolean> {
    const config = deployment.healthCheckConfig!

    console.log(`  Health check path: ${config.path || '/'}`)
    console.log(`  Healthy threshold: ${config.healthyThreshold}`)
    console.log(`  Interval: ${config.interval}s`)

    if (dryRun) {
      console.log('  [SKIPPED - DRY RUN]')
      return true
    }

    // Simulate health checks
    let consecutiveSuccesses = 0
    const maxAttempts = config.healthyThreshold + 2

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 50))

      const healthy = Math.random() > 0.1 // 90% success rate

      if (healthy) {
        consecutiveSuccesses++
        console.log(`  Check ${i + 1}: ✓ Healthy (${consecutiveSuccesses}/${config.healthyThreshold})`)

        if (consecutiveSuccesses >= config.healthyThreshold) {
          return true
        }
      }
      else {
        consecutiveSuccesses = 0
        console.log(`  Check ${i + 1}: ✗ Unhealthy`)
      }
    }

    return false
  }

  /**
   * Record deployment result
  */
  private recordDeployment(deploymentId: string, result: DeploymentResult): void {
    if (!this.deploymentHistory.has(deploymentId)) {
      this.deploymentHistory.set(deploymentId, [])
    }

    this.deploymentHistory.get(deploymentId)!.push(result)
  }

  /**
   * Get deployment
  */
  getDeployment(id: string): BlueGreenDeployment | undefined {
    return this.deployments.get(id)
  }

  /**
   * List deployments
  */
  listDeployments(): BlueGreenDeployment[] {
    return Array.from(this.deployments.values())
  }

  /**
   * Get deployment history
  */
  getDeploymentHistory(deploymentId: string): DeploymentResult[] {
    return this.deploymentHistory.get(deploymentId) || []
  }

  /**
   * Generate CloudFormation for ALB target group switching
  */
  generateALBListenerCF(deployment: BlueGreenDeployment): any {
    const activeEnv
      = deployment.activeEnvironment === 'blue' ? deployment.blueEnvironment : deployment.greenEnvironment

    return {
      Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
      Properties: {
        ListenerArn: deployment.routingConfig.listenerArn,
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
            TargetGroupArn: activeEnv.targetGroupArn,
          },
        ],
      },
    }
  }

  /**
   * Generate CloudFormation for Route53 weighted routing
  */
  generateRoute53RecordSetCF(deployment: BlueGreenDeployment, recordName: string): any[] {
    return [
      {
        Type: 'AWS::Route53::RecordSet',
        Properties: {
          HostedZoneId: deployment.routingConfig.hostedZoneId,
          Name: recordName,
          Type: 'A',
          SetIdentifier: 'blue',
          Weight: deployment.activeEnvironment === 'blue' ? 100 : 0,
          AliasTarget: {
            HostedZoneId: deployment.routingConfig.hostedZoneId,
            DNSName: deployment.blueEnvironment.targetGroupArn,
            EvaluateTargetHealth: true,
          },
        },
      },
      {
        Type: 'AWS::Route53::RecordSet',
        Properties: {
          HostedZoneId: deployment.routingConfig.hostedZoneId,
          Name: recordName,
          Type: 'A',
          SetIdentifier: 'green',
          Weight: deployment.activeEnvironment === 'green' ? 100 : 0,
          AliasTarget: {
            HostedZoneId: deployment.routingConfig.hostedZoneId,
            DNSName: deployment.greenEnvironment.targetGroupArn,
            EvaluateTargetHealth: true,
          },
        },
      },
    ]
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
 * Global blue/green manager instance
*/
export const blueGreenManager: BlueGreenManager = new BlueGreenManager()
