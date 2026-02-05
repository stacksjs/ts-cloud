/**
 * AWS Application Auto Scaling Client
 * Supports auto-scaling for ECS services, DynamoDB tables, and other AWS resources
 * Direct API calls without AWS CLI dependency
 */

import { AWSClient } from './client'

export type ScalableDimension =
  | 'ecs:service:DesiredCount'
  | 'dynamodb:table:ReadCapacityUnits'
  | 'dynamodb:table:WriteCapacityUnits'
  | 'dynamodb:index:ReadCapacityUnits'
  | 'dynamodb:index:WriteCapacityUnits'
  | 'rds:cluster:ReadReplicaCount'
  | 'lambda:function:ProvisionedConcurrency'
  | 'elasticache:replication-group:NodeGroups'
  | 'elasticache:replication-group:Replicas'

export type ServiceNamespace =
  | 'ecs'
  | 'dynamodb'
  | 'rds'
  | 'lambda'
  | 'elasticache'
  | 'custom-resource'
  | 'comprehend'
  | 'kafka'
  | 'sagemaker'

export type MetricType =
  | 'ECSServiceAverageCPUUtilization'
  | 'ECSServiceAverageMemoryUtilization'
  | 'ALBRequestCountPerTarget'
  | 'DynamoDBReadCapacityUtilization'
  | 'DynamoDBWriteCapacityUtilization'
  | 'RDSReaderAverageCPUUtilization'
  | 'RDSReaderAverageDatabaseConnections'
  | 'EC2SpotFleetRequestAverageCPUUtilization'
  | 'EC2SpotFleetRequestAverageNetworkIn'
  | 'EC2SpotFleetRequestAverageNetworkOut'
  | 'SageMakerVariantInvocationsPerInstance'
  | 'SageMakerVariantProvisionedConcurrencyUtilization'
  | 'ElastiCachePrimaryEngineCPUUtilization'
  | 'ElastiCacheReplicaEngineCPUUtilization'
  | 'ElastiCacheDatabaseMemoryUsageCountedForEvictPercentage'
  | 'LambdaProvisionedConcurrencyUtilization'
  | 'CassandraReadCapacityUtilization'
  | 'CassandraWriteCapacityUtilization'

export interface ScalableTarget {
  ServiceNamespace: ServiceNamespace
  ResourceId: string
  ScalableDimension: ScalableDimension
  MinCapacity: number
  MaxCapacity: number
  RoleARN?: string
  CreationTime?: string
  SuspendedState?: {
    DynamicScalingInSuspended?: boolean
    DynamicScalingOutSuspended?: boolean
    ScheduledScalingSuspended?: boolean
  }
}

export interface ScalingPolicy {
  PolicyARN?: string
  PolicyName: string
  ServiceNamespace: ServiceNamespace
  ResourceId: string
  ScalableDimension: ScalableDimension
  PolicyType: 'TargetTrackingScaling' | 'StepScaling'
  StepScalingPolicyConfiguration?: StepScalingPolicyConfiguration
  TargetTrackingScalingPolicyConfiguration?: TargetTrackingScalingPolicyConfiguration
  Alarms?: Array<{
    AlarmName: string
    AlarmARN: string
  }>
  CreationTime?: string
}

export interface StepScalingPolicyConfiguration {
  AdjustmentType: 'ChangeInCapacity' | 'PercentChangeInCapacity' | 'ExactCapacity'
  StepAdjustments: Array<{
    MetricIntervalLowerBound?: number
    MetricIntervalUpperBound?: number
    ScalingAdjustment: number
  }>
  MinAdjustmentMagnitude?: number
  Cooldown?: number
  MetricAggregationType?: 'Average' | 'Minimum' | 'Maximum'
}

export interface TargetTrackingScalingPolicyConfiguration {
  TargetValue: number
  PredefinedMetricSpecification?: {
    PredefinedMetricType: MetricType
    ResourceLabel?: string
  }
  CustomizedMetricSpecification?: {
    MetricName: string
    Namespace: string
    Statistic: 'Average' | 'Minimum' | 'Maximum' | 'SampleCount' | 'Sum'
    Unit?: string
    Dimensions?: Array<{
      Name: string
      Value: string
    }>
  }
  ScaleOutCooldown?: number
  ScaleInCooldown?: number
  DisableScaleIn?: boolean
}

export interface ScheduledAction {
  ScheduledActionName: string
  ScheduledActionARN?: string
  ServiceNamespace: ServiceNamespace
  Schedule: string
  Timezone?: string
  ResourceId: string
  ScalableDimension: ScalableDimension
  StartTime?: string
  EndTime?: string
  ScalableTargetAction?: {
    MinCapacity?: number
    MaxCapacity?: number
  }
  CreationTime?: string
}

/**
 * Application Auto Scaling client for ECS, DynamoDB, and other services
 */
export class ApplicationAutoScalingClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Register a scalable target
   * This must be done before creating scaling policies
   */
  async registerScalableTarget(options: {
    serviceNamespace: ServiceNamespace
    resourceId: string
    scalableDimension: ScalableDimension
    minCapacity: number
    maxCapacity: number
    roleARN?: string
    suspendedState?: {
      dynamicScalingInSuspended?: boolean
      dynamicScalingOutSuspended?: boolean
      scheduledScalingSuspended?: boolean
    }
  }): Promise<void> {
    const params: Record<string, any> = {
      ServiceNamespace: options.serviceNamespace,
      ResourceId: options.resourceId,
      ScalableDimension: options.scalableDimension,
      MinCapacity: options.minCapacity,
      MaxCapacity: options.maxCapacity,
    }

    if (options.roleARN) {
      params.RoleARN = options.roleARN
    }

    if (options.suspendedState) {
      params.SuspendedState = {
        DynamicScalingInSuspended: options.suspendedState.dynamicScalingInSuspended,
        DynamicScalingOutSuspended: options.suspendedState.dynamicScalingOutSuspended,
        ScheduledScalingSuspended: options.suspendedState.scheduledScalingSuspended,
      }
    }

    await this.client.request({
      service: 'application-autoscaling',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AnyScaleFrontendService.RegisterScalableTarget',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Describe scalable targets
   */
  async describeScalableTargets(options: {
    serviceNamespace: ServiceNamespace
    resourceIds?: string[]
    scalableDimension?: ScalableDimension
    maxResults?: number
    nextToken?: string
  }): Promise<{ ScalableTargets: ScalableTarget[], NextToken?: string }> {
    const params: Record<string, any> = {
      ServiceNamespace: options.serviceNamespace,
    }

    if (options.resourceIds && options.resourceIds.length > 0) {
      params.ResourceIds = options.resourceIds
    }

    if (options.scalableDimension) {
      params.ScalableDimension = options.scalableDimension
    }

    if (options.maxResults) {
      params.MaxResults = options.maxResults
    }

    if (options.nextToken) {
      params.NextToken = options.nextToken
    }

    const result = await this.client.request({
      service: 'application-autoscaling',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AnyScaleFrontendService.DescribeScalableTargets',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      ScalableTargets: result.ScalableTargets || [],
      NextToken: result.NextToken,
    }
  }

  /**
   * Deregister a scalable target
   */
  async deregisterScalableTarget(options: {
    serviceNamespace: ServiceNamespace
    resourceId: string
    scalableDimension: ScalableDimension
  }): Promise<void> {
    const params = {
      ServiceNamespace: options.serviceNamespace,
      ResourceId: options.resourceId,
      ScalableDimension: options.scalableDimension,
    }

    await this.client.request({
      service: 'application-autoscaling',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AnyScaleFrontendService.DeregisterScalableTarget',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Put a scaling policy (create or update)
   */
  async putScalingPolicy(options: {
    policyName: string
    serviceNamespace: ServiceNamespace
    resourceId: string
    scalableDimension: ScalableDimension
    policyType: 'TargetTrackingScaling' | 'StepScaling'
    targetTrackingScalingPolicyConfiguration?: TargetTrackingScalingPolicyConfiguration
    stepScalingPolicyConfiguration?: StepScalingPolicyConfiguration
  }): Promise<{ PolicyARN: string, Alarms: Array<{ AlarmName: string, AlarmARN: string }> }> {
    const params: Record<string, any> = {
      PolicyName: options.policyName,
      ServiceNamespace: options.serviceNamespace,
      ResourceId: options.resourceId,
      ScalableDimension: options.scalableDimension,
      PolicyType: options.policyType,
    }

    if (options.targetTrackingScalingPolicyConfiguration) {
      params.TargetTrackingScalingPolicyConfiguration = options.targetTrackingScalingPolicyConfiguration
    }

    if (options.stepScalingPolicyConfiguration) {
      params.StepScalingPolicyConfiguration = options.stepScalingPolicyConfiguration
    }

    const result = await this.client.request({
      service: 'application-autoscaling',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AnyScaleFrontendService.PutScalingPolicy',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      PolicyARN: result.PolicyARN || '',
      Alarms: result.Alarms || [],
    }
  }

  /**
   * Describe scaling policies
   */
  async describeScalingPolicies(options: {
    serviceNamespace: ServiceNamespace
    policyNames?: string[]
    resourceId?: string
    scalableDimension?: ScalableDimension
    maxResults?: number
    nextToken?: string
  }): Promise<{ ScalingPolicies: ScalingPolicy[], NextToken?: string }> {
    const params: Record<string, any> = {
      ServiceNamespace: options.serviceNamespace,
    }

    if (options.policyNames && options.policyNames.length > 0) {
      params.PolicyNames = options.policyNames
    }

    if (options.resourceId) {
      params.ResourceId = options.resourceId
    }

    if (options.scalableDimension) {
      params.ScalableDimension = options.scalableDimension
    }

    if (options.maxResults) {
      params.MaxResults = options.maxResults
    }

    if (options.nextToken) {
      params.NextToken = options.nextToken
    }

    const result = await this.client.request({
      service: 'application-autoscaling',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AnyScaleFrontendService.DescribeScalingPolicies',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      ScalingPolicies: result.ScalingPolicies || [],
      NextToken: result.NextToken,
    }
  }

  /**
   * Delete a scaling policy
   */
  async deleteScalingPolicy(options: {
    policyName: string
    serviceNamespace: ServiceNamespace
    resourceId: string
    scalableDimension: ScalableDimension
  }): Promise<void> {
    const params = {
      PolicyName: options.policyName,
      ServiceNamespace: options.serviceNamespace,
      ResourceId: options.resourceId,
      ScalableDimension: options.scalableDimension,
    }

    await this.client.request({
      service: 'application-autoscaling',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AnyScaleFrontendService.DeleteScalingPolicy',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Put a scheduled action
   */
  async putScheduledAction(options: {
    scheduledActionName: string
    serviceNamespace: ServiceNamespace
    resourceId: string
    scalableDimension: ScalableDimension
    schedule: string
    timezone?: string
    startTime?: Date
    endTime?: Date
    scalableTargetAction?: {
      minCapacity?: number
      maxCapacity?: number
    }
  }): Promise<void> {
    const params: Record<string, any> = {
      ScheduledActionName: options.scheduledActionName,
      ServiceNamespace: options.serviceNamespace,
      ResourceId: options.resourceId,
      ScalableDimension: options.scalableDimension,
      Schedule: options.schedule,
    }

    if (options.timezone) {
      params.Timezone = options.timezone
    }

    if (options.startTime) {
      params.StartTime = options.startTime.toISOString()
    }

    if (options.endTime) {
      params.EndTime = options.endTime.toISOString()
    }

    if (options.scalableTargetAction) {
      params.ScalableTargetAction = options.scalableTargetAction
    }

    await this.client.request({
      service: 'application-autoscaling',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AnyScaleFrontendService.PutScheduledAction',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Describe scheduled actions
   */
  async describeScheduledActions(options: {
    serviceNamespace: ServiceNamespace
    scheduledActionNames?: string[]
    resourceId?: string
    scalableDimension?: ScalableDimension
    maxResults?: number
    nextToken?: string
  }): Promise<{ ScheduledActions: ScheduledAction[], NextToken?: string }> {
    const params: Record<string, any> = {
      ServiceNamespace: options.serviceNamespace,
    }

    if (options.scheduledActionNames && options.scheduledActionNames.length > 0) {
      params.ScheduledActionNames = options.scheduledActionNames
    }

    if (options.resourceId) {
      params.ResourceId = options.resourceId
    }

    if (options.scalableDimension) {
      params.ScalableDimension = options.scalableDimension
    }

    if (options.maxResults) {
      params.MaxResults = options.maxResults
    }

    if (options.nextToken) {
      params.NextToken = options.nextToken
    }

    const result = await this.client.request({
      service: 'application-autoscaling',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AnyScaleFrontendService.DescribeScheduledActions',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      ScheduledActions: result.ScheduledActions || [],
      NextToken: result.NextToken,
    }
  }

  /**
   * Delete a scheduled action
   */
  async deleteScheduledAction(options: {
    scheduledActionName: string
    serviceNamespace: ServiceNamespace
    resourceId: string
    scalableDimension: ScalableDimension
  }): Promise<void> {
    const params = {
      ScheduledActionName: options.scheduledActionName,
      ServiceNamespace: options.serviceNamespace,
      ResourceId: options.resourceId,
      ScalableDimension: options.scalableDimension,
    }

    await this.client.request({
      service: 'application-autoscaling',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AnyScaleFrontendService.DeleteScheduledAction',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Describe scaling activities
   */
  async describeScalingActivities(options: {
    serviceNamespace: ServiceNamespace
    resourceId?: string
    scalableDimension?: ScalableDimension
    maxResults?: number
    nextToken?: string
    includeNotScaledActivities?: boolean
  }): Promise<{
    ScalingActivities: Array<{
      ActivityId: string
      ServiceNamespace: string
      ResourceId: string
      ScalableDimension: string
      Description: string
      Cause: string
      StartTime: string
      EndTime?: string
      StatusCode: 'Pending' | 'InProgress' | 'Successful' | 'Overridden' | 'Unfulfilled' | 'Failed'
      StatusMessage?: string
      Details?: string
      NotScaledReasons?: Array<{
        Code: string
        MaxCapacity?: number
        MinCapacity?: number
        CurrentCapacity?: number
      }>
    }>
    NextToken?: string
  }> {
    const params: Record<string, any> = {
      ServiceNamespace: options.serviceNamespace,
    }

    if (options.resourceId) {
      params.ResourceId = options.resourceId
    }

    if (options.scalableDimension) {
      params.ScalableDimension = options.scalableDimension
    }

    if (options.maxResults) {
      params.MaxResults = options.maxResults
    }

    if (options.nextToken) {
      params.NextToken = options.nextToken
    }

    if (options.includeNotScaledActivities !== undefined) {
      params.IncludeNotScaledActivities = options.includeNotScaledActivities
    }

    const result = await this.client.request({
      service: 'application-autoscaling',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AnyScaleFrontendService.DescribeScalingActivities',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      ScalingActivities: result.ScalingActivities || [],
      NextToken: result.NextToken,
    }
  }

  // ============================================
  // ECS-Specific Helper Methods
  // ============================================

  /**
   * Helper: Get the resource ID format for an ECS service
   */
  getECSServiceResourceId(clusterName: string, serviceName: string): string {
    return `service/${clusterName}/${serviceName}`
  }

  /**
   * Helper: Register an ECS service for auto-scaling
   */
  async registerECSServiceScaling(options: {
    clusterName: string
    serviceName: string
    minCapacity: number
    maxCapacity: number
  }): Promise<void> {
    const resourceId = this.getECSServiceResourceId(options.clusterName, options.serviceName)

    await this.registerScalableTarget({
      serviceNamespace: 'ecs',
      resourceId,
      scalableDimension: 'ecs:service:DesiredCount',
      minCapacity: options.minCapacity,
      maxCapacity: options.maxCapacity,
    })
  }

  /**
   * Helper: Create a CPU-based scaling policy for an ECS service
   */
  async createECSCPUScalingPolicy(options: {
    clusterName: string
    serviceName: string
    policyName: string
    targetCPUPercent: number
    scaleOutCooldown?: number
    scaleInCooldown?: number
    disableScaleIn?: boolean
  }): Promise<{ PolicyARN: string, Alarms: Array<{ AlarmName: string, AlarmARN: string }> }> {
    const resourceId = this.getECSServiceResourceId(options.clusterName, options.serviceName)

    return this.putScalingPolicy({
      policyName: options.policyName,
      serviceNamespace: 'ecs',
      resourceId,
      scalableDimension: 'ecs:service:DesiredCount',
      policyType: 'TargetTrackingScaling',
      targetTrackingScalingPolicyConfiguration: {
        TargetValue: options.targetCPUPercent,
        PredefinedMetricSpecification: {
          PredefinedMetricType: 'ECSServiceAverageCPUUtilization',
        },
        ScaleOutCooldown: options.scaleOutCooldown ?? 300,
        ScaleInCooldown: options.scaleInCooldown ?? 300,
        DisableScaleIn: options.disableScaleIn ?? false,
      },
    })
  }

  /**
   * Helper: Create a memory-based scaling policy for an ECS service
   */
  async createECSMemoryScalingPolicy(options: {
    clusterName: string
    serviceName: string
    policyName: string
    targetMemoryPercent: number
    scaleOutCooldown?: number
    scaleInCooldown?: number
    disableScaleIn?: boolean
  }): Promise<{ PolicyARN: string, Alarms: Array<{ AlarmName: string, AlarmARN: string }> }> {
    const resourceId = this.getECSServiceResourceId(options.clusterName, options.serviceName)

    return this.putScalingPolicy({
      policyName: options.policyName,
      serviceNamespace: 'ecs',
      resourceId,
      scalableDimension: 'ecs:service:DesiredCount',
      policyType: 'TargetTrackingScaling',
      targetTrackingScalingPolicyConfiguration: {
        TargetValue: options.targetMemoryPercent,
        PredefinedMetricSpecification: {
          PredefinedMetricType: 'ECSServiceAverageMemoryUtilization',
        },
        ScaleOutCooldown: options.scaleOutCooldown ?? 300,
        ScaleInCooldown: options.scaleInCooldown ?? 300,
        DisableScaleIn: options.disableScaleIn ?? false,
      },
    })
  }

  /**
   * Helper: Create an ALB request count scaling policy for an ECS service
   */
  async createECSRequestCountScalingPolicy(options: {
    clusterName: string
    serviceName: string
    policyName: string
    targetRequestsPerTarget: number
    targetGroupArn: string
    loadBalancerArn: string
    scaleOutCooldown?: number
    scaleInCooldown?: number
    disableScaleIn?: boolean
  }): Promise<{ PolicyARN: string, Alarms: Array<{ AlarmName: string, AlarmARN: string }> }> {
    const resourceId = this.getECSServiceResourceId(options.clusterName, options.serviceName)

    // Extract the suffix from ARN for resource label
    // Format: app/load-balancer-name/xxx/targetgroup/target-group-name/yyy
    const tgArnParts = options.targetGroupArn.split(':').pop() || ''
    const lbArnParts = options.loadBalancerArn.split(':').pop() || ''
    const tgSuffix = tgArnParts.replace('targetgroup/', '')
    const lbSuffix = lbArnParts.replace('loadbalancer/', '')
    const resourceLabel = `${lbSuffix}/${tgSuffix}`

    return this.putScalingPolicy({
      policyName: options.policyName,
      serviceNamespace: 'ecs',
      resourceId,
      scalableDimension: 'ecs:service:DesiredCount',
      policyType: 'TargetTrackingScaling',
      targetTrackingScalingPolicyConfiguration: {
        TargetValue: options.targetRequestsPerTarget,
        PredefinedMetricSpecification: {
          PredefinedMetricType: 'ALBRequestCountPerTarget',
          ResourceLabel: resourceLabel,
        },
        ScaleOutCooldown: options.scaleOutCooldown ?? 300,
        ScaleInCooldown: options.scaleInCooldown ?? 300,
        DisableScaleIn: options.disableScaleIn ?? false,
      },
    })
  }

  /**
   * Helper: Get all scaling policies for an ECS service
   */
  async getECSServiceScalingPolicies(clusterName: string, serviceName: string): Promise<ScalingPolicy[]> {
    const resourceId = this.getECSServiceResourceId(clusterName, serviceName)

    const result = await this.describeScalingPolicies({
      serviceNamespace: 'ecs',
      resourceId,
      scalableDimension: 'ecs:service:DesiredCount',
    })

    return result.ScalingPolicies
  }

  /**
   * Helper: Remove all auto-scaling from an ECS service
   */
  async removeECSServiceScaling(clusterName: string, serviceName: string): Promise<void> {
    const resourceId = this.getECSServiceResourceId(clusterName, serviceName)

    // First, delete all scaling policies
    const policies = await this.getECSServiceScalingPolicies(clusterName, serviceName)
    for (const policy of policies) {
      await this.deleteScalingPolicy({
        policyName: policy.PolicyName,
        serviceNamespace: 'ecs',
        resourceId,
        scalableDimension: 'ecs:service:DesiredCount',
      })
    }

    // Then deregister the scalable target
    await this.deregisterScalableTarget({
      serviceNamespace: 'ecs',
      resourceId,
      scalableDimension: 'ecs:service:DesiredCount',
    })
  }

  /**
   * Helper: Create a scheduled scaling action for an ECS service
   * Example schedule: "cron(0 9 * * ? *)" for 9 AM daily
   */
  async createECSScheduledScaling(options: {
    clusterName: string
    serviceName: string
    actionName: string
    schedule: string
    timezone?: string
    minCapacity?: number
    maxCapacity?: number
  }): Promise<void> {
    const resourceId = this.getECSServiceResourceId(options.clusterName, options.serviceName)

    await this.putScheduledAction({
      scheduledActionName: options.actionName,
      serviceNamespace: 'ecs',
      resourceId,
      scalableDimension: 'ecs:service:DesiredCount',
      schedule: options.schedule,
      timezone: options.timezone,
      scalableTargetAction: {
        minCapacity: options.minCapacity,
        maxCapacity: options.maxCapacity,
      },
    })
  }

  /**
   * Helper: Get scaling activity history for an ECS service
   */
  async getECSScalingActivities(clusterName: string, serviceName: string, maxResults = 20): Promise<Array<{
    ActivityId: string
    Description: string
    Cause: string
    StartTime: string
    EndTime?: string
    StatusCode: string
    StatusMessage?: string
  }>> {
    const resourceId = this.getECSServiceResourceId(clusterName, serviceName)

    const result = await this.describeScalingActivities({
      serviceNamespace: 'ecs',
      resourceId,
      scalableDimension: 'ecs:service:DesiredCount',
      maxResults,
    })

    return result.ScalingActivities.map(activity => ({
      ActivityId: activity.ActivityId,
      Description: activity.Description,
      Cause: activity.Cause,
      StartTime: activity.StartTime,
      EndTime: activity.EndTime,
      StatusCode: activity.StatusCode,
      StatusMessage: activity.StatusMessage,
    }))
  }
}
