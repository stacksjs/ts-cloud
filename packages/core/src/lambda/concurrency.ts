/**
 * Lambda Concurrency Management
 * Reserved and provisioned concurrency configuration
 */

export interface ConcurrencyConfig {
  id: string
  functionName: string
  reservedConcurrency?: number
  provisionedConcurrency?: ProvisionedConcurrencyConfig[]
}

export interface ProvisionedConcurrencyConfig {
  id: string
  functionName: string
  qualifier: string // version or alias
  provisionedConcurrentExecutions: number
  status: 'pending' | 'ready' | 'in_progress' | 'failed'
  allocatedConcurrency?: number
  availableConcurrency?: number
  lastModified?: Date
}

export interface ConcurrencySchedule {
  id: string
  name: string
  functionName: string
  qualifier: string
  schedule: ScheduleRule[]
}

export interface ScheduleRule {
  name: string
  cronExpression: string
  targetConcurrency: number
  minCapacity?: number
  maxCapacity?: number
}

export interface AutoScalingConfig {
  id: string
  functionName: string
  qualifier: string
  minCapacity: number
  maxCapacity: number
  targetUtilization: number // 0-1
  scaleInCooldown?: number // seconds
  scaleOutCooldown?: number // seconds
}

/**
 * Lambda concurrency manager
 */
export class LambdaConcurrencyManager {
  private configs: Map<string, ConcurrencyConfig> = new Map()
  private provisionedConfigs: Map<string, ProvisionedConcurrencyConfig> = new Map()
  private schedules: Map<string, ConcurrencySchedule> = new Map()
  private autoScalingConfigs: Map<string, AutoScalingConfig> = new Map()
  private configCounter = 0
  private provisionedCounter = 0
  private scheduleCounter = 0
  private autoScalingCounter = 0

  /**
   * Set reserved concurrency
   */
  setReservedConcurrency(options: {
    functionName: string
    reservedConcurrency: number
  }): ConcurrencyConfig {
    const id = `concurrency-${Date.now()}-${this.configCounter++}`

    const config: ConcurrencyConfig = {
      id,
      functionName: options.functionName,
      reservedConcurrency: options.reservedConcurrency,
    }

    this.configs.set(id, config)

    return config
  }

  /**
   * Set provisioned concurrency
   */
  setProvisionedConcurrency(options: {
    functionName: string
    qualifier: string
    provisionedConcurrentExecutions: number
  }): ProvisionedConcurrencyConfig {
    const id = `provisioned-${Date.now()}-${this.provisionedCounter++}`

    const config: ProvisionedConcurrencyConfig = {
      id,
      functionName: options.functionName,
      qualifier: options.qualifier,
      provisionedConcurrentExecutions: options.provisionedConcurrentExecutions,
      status: 'pending',
      lastModified: new Date(),
    }

    this.provisionedConfigs.set(id, config)

    // Simulate provisioning
    setTimeout(() => {
      config.status = 'ready'
      config.allocatedConcurrency = options.provisionedConcurrentExecutions
      config.availableConcurrency = options.provisionedConcurrentExecutions
    }, 100)

    return config
  }

  /**
   * Configure warm pool
   */
  configureWarmPool(options: {
    functionName: string
    alias: string
    minInstances: number
  }): ProvisionedConcurrencyConfig {
    return this.setProvisionedConcurrency({
      functionName: options.functionName,
      qualifier: options.alias,
      provisionedConcurrentExecutions: options.minInstances,
    })
  }

  /**
   * Create concurrency schedule
   */
  createSchedule(schedule: Omit<ConcurrencySchedule, 'id'>): ConcurrencySchedule {
    const id = `schedule-${Date.now()}-${this.scheduleCounter++}`

    const concurrencySchedule: ConcurrencySchedule = {
      id,
      ...schedule,
    }

    this.schedules.set(id, concurrencySchedule)

    return concurrencySchedule
  }

  /**
   * Create business hours schedule
   */
  createBusinessHoursSchedule(options: {
    functionName: string
    qualifier: string
    businessHoursConcurrency: number
    offHoursConcurrency: number
  }): ConcurrencySchedule {
    return this.createSchedule({
      name: `${options.functionName}-business-hours`,
      functionName: options.functionName,
      qualifier: options.qualifier,
      schedule: [
        {
          name: 'business-hours',
          cronExpression: '0 8 * * MON-FRI', // 8 AM weekdays
          targetConcurrency: options.businessHoursConcurrency,
        },
        {
          name: 'off-hours',
          cronExpression: '0 18 * * MON-FRI', // 6 PM weekdays
          targetConcurrency: options.offHoursConcurrency,
        },
        {
          name: 'weekend',
          cronExpression: '0 0 * * SAT', // Midnight Saturday
          targetConcurrency: options.offHoursConcurrency,
        },
      ],
    })
  }

  /**
   * Configure auto-scaling
   */
  configureAutoScaling(config: Omit<AutoScalingConfig, 'id'>): AutoScalingConfig {
    const id = `autoscaling-${Date.now()}-${this.autoScalingCounter++}`

    const autoScalingConfig: AutoScalingConfig = {
      id,
      ...config,
    }

    this.autoScalingConfigs.set(id, autoScalingConfig)

    return autoScalingConfig
  }

  /**
   * Configure predictive auto-scaling
   */
  configurePredictiveScaling(options: {
    functionName: string
    qualifier: string
    baselineCapacity: number
    peakCapacity: number
  }): AutoScalingConfig {
    return this.configureAutoScaling({
      functionName: options.functionName,
      qualifier: options.qualifier,
      minCapacity: options.baselineCapacity,
      maxCapacity: options.peakCapacity,
      targetUtilization: 0.7,
      scaleInCooldown: 300,
      scaleOutCooldown: 60,
    })
  }

  /**
   * Get concurrency config
   */
  getConfig(id: string): ConcurrencyConfig | undefined {
    return this.configs.get(id)
  }

  /**
   * List concurrency configs
   */
  listConfigs(): ConcurrencyConfig[] {
    return Array.from(this.configs.values())
  }

  /**
   * Get provisioned config
   */
  getProvisionedConfig(id: string): ProvisionedConcurrencyConfig | undefined {
    return this.provisionedConfigs.get(id)
  }

  /**
   * List provisioned configs
   */
  listProvisionedConfigs(): ProvisionedConcurrencyConfig[] {
    return Array.from(this.provisionedConfigs.values())
  }

  /**
   * Generate CloudFormation for reserved concurrency
   */
  generateReservedConcurrencyCF(config: ConcurrencyConfig): any {
    return {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: config.functionName,
        ReservedConcurrentExecutions: config.reservedConcurrency,
      },
    }
  }

  /**
   * Generate CloudFormation for provisioned concurrency
   */
  generateProvisionedConcurrencyCF(config: ProvisionedConcurrencyConfig): any {
    return {
      Type: 'AWS::Lambda::Alias',
      Properties: {
        FunctionName: config.functionName,
        Name: config.qualifier,
        ProvisionedConcurrencyConfig: {
          ProvisionedConcurrentExecutions: config.provisionedConcurrentExecutions,
        },
      },
    }
  }

  /**
   * Generate CloudFormation for auto-scaling target
   */
  generateAutoScalingTargetCF(config: AutoScalingConfig): any {
    return {
      Type: 'AWS::ApplicationAutoScaling::ScalableTarget',
      Properties: {
        ServiceNamespace: 'lambda',
        ResourceId: `function:${config.functionName}:${config.qualifier}`,
        ScalableDimension: 'lambda:function:ProvisionedConcurrentExecutions',
        MinCapacity: config.minCapacity,
        MaxCapacity: config.maxCapacity,
      },
    }
  }

  /**
   * Generate CloudFormation for auto-scaling policy
   */
  generateAutoScalingPolicyCF(config: AutoScalingConfig): any {
    return {
      Type: 'AWS::ApplicationAutoScaling::ScalingPolicy',
      Properties: {
        PolicyName: `${config.functionName}-autoscaling`,
        PolicyType: 'TargetTrackingScaling',
        ScalingTargetId: {
          Ref: `${config.functionName}AutoScalingTarget`,
        },
        TargetTrackingScalingPolicyConfiguration: {
          TargetValue: config.targetUtilization * 100,
          PredefinedMetricSpecification: {
            PredefinedMetricType: 'LambdaProvisionedConcurrencyUtilization',
          },
          ScaleInCooldown: config.scaleInCooldown || 300,
          ScaleOutCooldown: config.scaleOutCooldown || 60,
        },
      },
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.configs.clear()
    this.provisionedConfigs.clear()
    this.schedules.clear()
    this.autoScalingConfigs.clear()
    this.configCounter = 0
    this.provisionedCounter = 0
    this.scheduleCounter = 0
    this.autoScalingCounter = 0
  }
}

/**
 * Global Lambda concurrency manager instance
 */
export const lambdaConcurrencyManager = new LambdaConcurrencyManager()
