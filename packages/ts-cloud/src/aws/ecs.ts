/**
 * AWS ECS Operations
 * Direct API calls without AWS CLI dependency
 */

import { AWSClient } from './client'

export interface Service {
  serviceArn?: string
  serviceName?: string
  clusterArn?: string
  status?: string
  desiredCount?: number
  runningCount?: number
  pendingCount?: number
  launchType?: string
  taskDefinition?: string
  deployments?: Deployment[]
  events?: ServiceEvent[]
}

export interface Deployment {
  id?: string
  status?: string
  taskDefinition?: string
  desiredCount?: number
  runningCount?: number
  pendingCount?: number
  createdAt?: string
  updatedAt?: string
}

export interface ServiceEvent {
  id?: string
  createdAt?: string
  message?: string
}

export interface DescribeServicesOptions {
  cluster: string
  services: string[]
}

export interface Task {
  taskArn?: string
  taskDefinitionArn?: string
  clusterArn?: string
  lastStatus?: string
  desiredStatus?: string
  containers?: Container[]
  createdAt?: string
  startedAt?: string
  stoppedAt?: string
}

export interface Container {
  containerArn?: string
  name?: string
  lastStatus?: string
  exitCode?: number
  reason?: string
}

/**
 * ECS service management using direct API calls
 */
export class ECSClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1', profile?: string) {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Describe ECS services
   */
  async describeServices(options: DescribeServicesOptions): Promise<{ services?: Service[], failures?: any[] }> {
    const params: Record<string, any> = {
      cluster: options.cluster,
      services: options.services,
    }

    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.DescribeServices',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  /**
   * List ECS services in a cluster
   */
  async listServices(cluster: string): Promise<{ serviceArns?: string[] }> {
    const params: Record<string, any> = {
      cluster,
    }

    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.ListServices',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  /**
   * List tasks in a cluster
   */
  async listTasks(cluster: string, serviceName?: string): Promise<{ taskArns?: string[] }> {
    const params: Record<string, any> = {
      cluster,
    }

    if (serviceName) {
      params.serviceName = serviceName
    }

    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.ListTasks',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  /**
   * Describe ECS tasks
   */
  async describeTasks(cluster: string, tasks: string[]): Promise<{ tasks?: Task[], failures?: any[] }> {
    const params: Record<string, any> = {
      cluster,
      tasks,
    }

    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.DescribeTasks',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  /**
   * Update ECS service (e.g., force new deployment)
   */
  async updateService(options: {
    cluster: string
    service: string
    forceNewDeployment?: boolean
    desiredCount?: number
    taskDefinition?: string
  }): Promise<{ service?: Service }> {
    const params: Record<string, any> = {
      cluster: options.cluster,
      service: options.service,
    }

    if (options.forceNewDeployment !== undefined) {
      params.forceNewDeployment = options.forceNewDeployment
    }

    if (options.desiredCount !== undefined) {
      params.desiredCount = options.desiredCount
    }

    if (options.taskDefinition) {
      params.taskDefinition = options.taskDefinition
    }

    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.UpdateService',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  /**
   * Create a new ECS service
   */
  async createService(options: {
    cluster: string
    serviceName: string
    taskDefinition: string
    desiredCount: number
    launchType?: 'EC2' | 'FARGATE' | 'EXTERNAL'
    networkConfiguration?: {
      awsvpcConfiguration: {
        subnets: string[]
        securityGroups?: string[]
        assignPublicIp?: 'ENABLED' | 'DISABLED'
      }
    }
    loadBalancers?: Array<{
      targetGroupArn: string
      containerName: string
      containerPort: number
    }>
    healthCheckGracePeriodSeconds?: number
    deploymentConfiguration?: {
      minimumHealthyPercent?: number
      maximumPercent?: number
    }
  }): Promise<{ service?: Service }> {
    const params: Record<string, any> = {
      cluster: options.cluster,
      serviceName: options.serviceName,
      taskDefinition: options.taskDefinition,
      desiredCount: options.desiredCount,
    }

    if (options.launchType) {
      params.launchType = options.launchType
    }

    if (options.networkConfiguration) {
      params.networkConfiguration = options.networkConfiguration
    }

    if (options.loadBalancers) {
      params.loadBalancers = options.loadBalancers
    }

    if (options.healthCheckGracePeriodSeconds !== undefined) {
      params.healthCheckGracePeriodSeconds = options.healthCheckGracePeriodSeconds
    }

    if (options.deploymentConfiguration) {
      params.deploymentConfiguration = options.deploymentConfiguration
    }

    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.CreateService',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  /**
   * Delete an ECS service
   */
  async deleteService(options: {
    cluster: string
    service: string
    force?: boolean
  }): Promise<{ service?: Service }> {
    const params: Record<string, any> = {
      cluster: options.cluster,
      service: options.service,
    }

    if (options.force !== undefined) {
      params.force = options.force
    }

    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.DeleteService',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  /**
   * List ECS clusters
   */
  async listClusters(): Promise<{ clusterArns?: string[] }> {
    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.ListClusters',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify({}),
    })

    return result
  }

  /**
   * Describe ECS clusters
   */
  async describeClusters(clusters: string[]): Promise<{ clusters?: any[], failures?: any[] }> {
    const params = {
      clusters,
      include: ['ATTACHMENTS', 'CONFIGURATIONS', 'SETTINGS', 'STATISTICS', 'TAGS'],
    }

    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.DescribeClusters',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  /**
   * Stop a running task
   */
  async stopTask(options: {
    cluster: string
    task: string
    reason?: string
  }): Promise<{ task?: Task }> {
    const params: Record<string, any> = {
      cluster: options.cluster,
      task: options.task,
    }

    if (options.reason) {
      params.reason = options.reason
    }

    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.StopTask',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  /**
   * Run a one-off task
   */
  async runTask(options: {
    cluster: string
    taskDefinition: string
    count?: number
    launchType?: 'EC2' | 'FARGATE' | 'EXTERNAL'
    networkConfiguration?: {
      awsvpcConfiguration: {
        subnets: string[]
        securityGroups?: string[]
        assignPublicIp?: 'ENABLED' | 'DISABLED'
      }
    }
    overrides?: {
      containerOverrides?: Array<{
        name: string
        command?: string[]
        environment?: Array<{ name: string, value: string }>
      }>
    }
  }): Promise<{ tasks?: Task[], failures?: any[] }> {
    const params: Record<string, any> = {
      cluster: options.cluster,
      taskDefinition: options.taskDefinition,
    }

    if (options.count !== undefined) {
      params.count = options.count
    }

    if (options.launchType) {
      params.launchType = options.launchType
    }

    if (options.networkConfiguration) {
      params.networkConfiguration = options.networkConfiguration
    }

    if (options.overrides) {
      params.overrides = options.overrides
    }

    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.RunTask',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  /**
   * Register a new task definition
   */
  async registerTaskDefinition(options: {
    family: string
    containerDefinitions: Array<{
      name: string
      image: string
      memory?: number
      cpu?: number
      essential?: boolean
      portMappings?: Array<{
        containerPort: number
        hostPort?: number
        protocol?: 'tcp' | 'udp'
      }>
      environment?: Array<{ name: string, value: string }>
      secrets?: Array<{ name: string, valueFrom: string }>
      logConfiguration?: {
        logDriver: string
        options?: Record<string, string>
      }
    }>
    cpu?: string
    memory?: string
    networkMode?: 'bridge' | 'host' | 'awsvpc' | 'none'
    requiresCompatibilities?: Array<'EC2' | 'FARGATE' | 'EXTERNAL'>
    executionRoleArn?: string
    taskRoleArn?: string
  }): Promise<{ taskDefinition?: any }> {
    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.RegisterTaskDefinition',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(options),
    })

    return result
  }

  /**
   * Deregister a task definition
   */
  async deregisterTaskDefinition(taskDefinition: string): Promise<{ taskDefinition?: any }> {
    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.DeregisterTaskDefinition',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify({ taskDefinition }),
    })

    return result
  }

  /**
   * Describe task definitions
   */
  async describeTaskDefinition(taskDefinition: string): Promise<{ taskDefinition?: any, tags?: any[] }> {
    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.DescribeTaskDefinition',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify({ taskDefinition, include: ['TAGS'] }),
    })

    return result
  }

  /**
   * List task definition families
   */
  async listTaskDefinitionFamilies(options?: {
    familyPrefix?: string
    status?: 'ACTIVE' | 'INACTIVE' | 'ALL'
  }): Promise<{ families?: string[] }> {
    const params: Record<string, any> = {}

    if (options?.familyPrefix) {
      params.familyPrefix = options.familyPrefix
    }

    if (options?.status) {
      params.status = options.status
    }

    const result = await this.client.request({
      service: 'ecs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonEC2ContainerServiceV20141113.ListTaskDefinitionFamilies',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  /**
   * Wait for service to become stable
   */
  async waitForServiceStable(cluster: string, service: string, maxAttempts = 40, delayMs = 15000): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      const result = await this.describeServices({
        cluster,
        services: [service],
      })

      const svc = result.services?.[0]
      if (svc) {
        // Check if all deployments are completed
        const primaryDeployment = svc.deployments?.find((d: Deployment) => d.status === 'PRIMARY')
        if (primaryDeployment &&
            primaryDeployment.runningCount === primaryDeployment.desiredCount &&
            svc.deployments?.length === 1) {
          return true
        }
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }

    return false
  }

  /**
   * Helper: Force new deployment
   */
  async forceNewDeployment(cluster: string, service: string): Promise<{ service?: Service }> {
    return this.updateService({
      cluster,
      service,
      forceNewDeployment: true,
    })
  }

  /**
   * Helper: Scale service
   */
  async scaleService(cluster: string, service: string, desiredCount: number): Promise<{ service?: Service }> {
    return this.updateService({
      cluster,
      service,
      desiredCount,
    })
  }
}
