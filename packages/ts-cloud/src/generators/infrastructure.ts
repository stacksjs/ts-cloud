/**
 * Infrastructure Generator
 * Generates CloudFormation templates from cloud.config.ts using all Phase 2 modules
 */

import type { CloudConfig } from '@ts-cloud/types'
import {
  Storage,
  CDN,
  DNS,
  Security,
  Compute,
  Network,
  FileSystem,
  Email,
  Queue,
  AI,
  Database,
  Cache,
  Permissions,
  ApiGateway,
  Messaging,
  Workflow,
  Monitoring,
  Auth,
  Deployment,
  TemplateBuilder,
} from '@ts-cloud/core'

export interface GenerationOptions {
  config: CloudConfig
  environment: 'production' | 'staging' | 'development'
  modules?: string[]
}

export class InfrastructureGenerator {
  private builder: TemplateBuilder
  private config: CloudConfig
  private environment: 'production' | 'staging' | 'development'
  private mergedConfig: CloudConfig

  constructor(options: GenerationOptions) {
    this.config = options.config
    this.environment = options.environment
    this.builder = new TemplateBuilder(
      `${this.config.project.name} - ${this.environment}`,
    )

    // Merge environment-specific infrastructure overrides
    this.mergedConfig = this.mergeEnvironmentConfig()
  }

  /**
   * Merge base config with environment-specific overrides
   */
  private mergeEnvironmentConfig(): CloudConfig {
    const envConfig = this.config.environments[this.environment]
    const envInfra = envConfig?.infrastructure

    if (!envInfra) {
      return this.config
    }

    return {
      ...this.config,
      infrastructure: {
        ...this.config.infrastructure,
        ...envInfra,
        // Deep merge for nested objects
        storage: { ...this.config.infrastructure?.storage, ...envInfra.storage },
        functions: { ...this.config.infrastructure?.functions, ...envInfra.functions },
        servers: { ...this.config.infrastructure?.servers, ...envInfra.servers },
        databases: { ...this.config.infrastructure?.databases, ...envInfra.databases },
        cdn: { ...this.config.infrastructure?.cdn, ...envInfra.cdn },
        queues: { ...this.config.infrastructure?.queues, ...envInfra.queues },
      },
    }
  }

  /**
   * Check if a resource should be deployed based on conditions
   */
  private shouldDeploy(resource: any): boolean {
    // Check environment conditions
    if (resource.environments && !resource.environments.includes(this.environment)) {
      return false
    }

    // Check feature flag requirements
    if (resource.requiresFeatures) {
      const features = this.config.features || {}
      const hasRequiredFeatures = resource.requiresFeatures.every(
        (feature: string) => features[feature] === true
      )
      if (!hasRequiredFeatures) {
        return false
      }
    }

    // Check region conditions
    if (resource.regions) {
      const currentRegion = this.config.environments[this.environment]?.region || this.config.project.region
      if (!resource.regions.includes(currentRegion)) {
        return false
      }
    }

    // Check custom condition function
    if (resource.condition && typeof resource.condition === 'function') {
      return resource.condition(this.config, this.environment)
    }

    return true
  }

  /**
   * Generate complete infrastructure
   * Auto-detects what to generate based on configuration
   */
  generate(): this {
    const slug = this.mergedConfig.project.slug
    const env = this.environment

    // Auto-detect and generate based on what's configured (using merged config)
    // If functions or API are defined, generate serverless resources
    const hasServerlessConfig = !!(
      this.mergedConfig.infrastructure?.functions
      || this.mergedConfig.infrastructure?.api
    )

    // If servers are defined, generate server resources
    const hasServerConfig = !!(
      this.mergedConfig.infrastructure?.servers
    )

    if (hasServerlessConfig) {
      this.generateServerless(slug, env)
    }

    if (hasServerConfig) {
      this.generateServer(slug, env)
    }

    // Always generate shared infrastructure (storage, CDN, databases, etc.)
    this.generateSharedInfrastructure(slug, env)

    // Apply global tags if specified
    if (this.config.tags) {
      this.applyGlobalTags(this.config.tags)
    }

    return this
  }

  /**
   * Apply global tags to all resources
   */
  private applyGlobalTags(tags: Record<string, string>): void {
    // This would iterate through all resources in the builder and add tags
    // Implementation depends on TemplateBuilder structure
  }

  /**
   * Generate serverless infrastructure (Lambda, ECS Fargate)
   */
  private generateServerless(slug: string, env: typeof this.environment): void {
    // Example: Lambda function
    if (this.mergedConfig.infrastructure?.functions) {
      for (const [name, fnConfig] of Object.entries(this.mergedConfig.infrastructure.functions)) {
        // Check if this function should be deployed
        if (!this.shouldDeploy(fnConfig)) {
          continue
        }
        // Create Lambda execution role
        const { role, logicalId: roleLogicalId } = Permissions.createRole({
          slug,
          environment: env,
          roleName: `${slug}-${env}-${name}-role`,
          servicePrincipal: 'lambda.amazonaws.com',
          managedPolicyArns: [
            'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
        })

        this.builder.addResource(roleLogicalId, role)

        const { lambdaFunction, logicalId } = Compute.createLambdaFunction({
          slug,
          environment: env,
          functionName: `${slug}-${env}-${name}`,
          handler: fnConfig.handler || 'index.handler',
          runtime: fnConfig.runtime || 'nodejs20.x',
          code: {
            zipFile: fnConfig.code || 'export const handler = async () => ({ statusCode: 200 });',
          },
          role: roleLogicalId,
          timeout: fnConfig.timeout,
          memorySize: fnConfig.memorySize,
        })

        this.builder.addResource(logicalId, lambdaFunction)
      }
    }

    // Example: API Gateway
    if (this.config.infrastructure?.api) {
      const { restApi, logicalId } = ApiGateway.createRestApi({
        slug,
        environment: env,
        apiName: `${slug}-${env}-api`,
      })

      this.builder.addResource(logicalId, restApi)
    }
  }

  /**
   * Generate server infrastructure (EC2)
   */
  private generateServer(slug: string, env: typeof this.environment): void {
    // Example: EC2 instance
    if (this.config.infrastructure?.servers) {
      for (const [name, serverConfig] of Object.entries(this.config.infrastructure.servers)) {
        const { instance, logicalId } = Compute.createServer({
          slug,
          environment: env,
          instanceType: serverConfig.instanceType || 't3.micro',
          imageId: serverConfig.ami || 'ami-0c55b159cbfafe1f0',
          userData: serverConfig.userData,
        })

        this.builder.addResource(logicalId, instance)
      }
    }
  }

  /**
   * Generate shared infrastructure (storage, database, etc.)
   */
  private generateSharedInfrastructure(slug: string, env: typeof this.environment): void {
    // Storage buckets
    if (this.config.infrastructure?.storage) {
      for (const [name, storageConfig] of Object.entries(this.config.infrastructure.storage)) {
        const { bucket, logicalId } = Storage.createBucket({
          slug,
          environment: env,
          bucketName: `${slug}-${env}-${name}`,
          versioning: storageConfig.versioning,
          encryption: storageConfig.encryption,
        })

        this.builder.addResource(logicalId, bucket)

        // Enable website hosting if configured
        if (storageConfig.website) {
          const enhanced = Storage.enableWebsiteHosting(
            bucket,
            storageConfig.website.indexDocument || 'index.html',
            storageConfig.website.errorDocument,
          )
          this.builder.addResource(logicalId, enhanced)
        }
      }
    }

    // Databases
    if (this.config.infrastructure?.databases) {
      for (const [name, dbConfig] of Object.entries(this.config.infrastructure.databases)) {
        if (dbConfig.engine === 'dynamodb') {
          const { table, logicalId } = Database.createTable({
            slug,
            environment: env,
            tableName: `${slug}-${env}-${name}`,
            partitionKey: dbConfig.partitionKey || { name: 'id', type: 'S' },
            sortKey: dbConfig.sortKey,
          })

          this.builder.addResource(logicalId, table)
        }
        else if (dbConfig.engine === 'postgres') {
          const { dbInstance, logicalId } = Database.createPostgres({
            slug,
            environment: env,
            dbInstanceIdentifier: `${slug}-${env}-${name}`,
            masterUsername: dbConfig.username || 'admin',
            masterUserPassword: dbConfig.password || 'changeme123',
            allocatedStorage: dbConfig.storage || 20,
            dbInstanceClass: dbConfig.instanceClass || 'db.t3.micro',
          })

          this.builder.addResource(logicalId, dbInstance)
        }
        else if (dbConfig.engine === 'mysql') {
          const { dbInstance, logicalId } = Database.createMysql({
            slug,
            environment: env,
            dbInstanceIdentifier: `${slug}-${env}-${name}`,
            masterUsername: dbConfig.username || 'admin',
            masterUserPassword: dbConfig.password || 'changeme123',
            allocatedStorage: dbConfig.storage || 20,
            dbInstanceClass: dbConfig.instanceClass || 'db.t3.micro',
          })

          this.builder.addResource(logicalId, dbInstance)
        }
      }
    }

    // CDN
    if (this.config.infrastructure?.cdn) {
      for (const [name, cdnConfig] of Object.entries(this.config.infrastructure.cdn)) {
        const { distribution, logicalId } = CDN.createDistribution({
          slug,
          environment: env,
          origin: {
            domainName: cdnConfig.origin,
            originId: `${slug}-origin`,
          },
        })

        this.builder.addResource(logicalId, distribution)
      }
    }

    // Queues (SQS)
    if (this.mergedConfig.infrastructure?.queues) {
      for (const [name, queueConfig] of Object.entries(this.mergedConfig.infrastructure.queues)) {
        // Check if this queue should be deployed
        if (!this.shouldDeploy(queueConfig)) {
          continue
        }

        // Create the main queue
        const { queue, logicalId } = Queue.createQueue({
          slug,
          environment: env,
          name: `${slug}-${env}-${name}`,
          fifo: queueConfig.fifo,
          visibilityTimeout: queueConfig.visibilityTimeout,
          messageRetentionPeriod: queueConfig.messageRetentionPeriod,
          delaySeconds: queueConfig.delaySeconds,
          maxMessageSize: queueConfig.maxMessageSize,
          receiveMessageWaitTime: queueConfig.receiveMessageWaitTime,
          contentBasedDeduplication: queueConfig.contentBasedDeduplication,
          encrypted: queueConfig.encrypted,
          kmsKeyId: queueConfig.kmsKeyId,
        })

        this.builder.addResource(logicalId, queue)

        // Create dead letter queue if enabled
        let dlqLogicalId: string | undefined
        if (queueConfig.deadLetterQueue) {
          const {
            deadLetterQueue,
            updatedSourceQueue,
            deadLetterLogicalId,
          } = Queue.createDeadLetterQueue(logicalId, {
            slug,
            environment: env,
            maxReceiveCount: queueConfig.maxReceiveCount,
          })

          dlqLogicalId = deadLetterLogicalId
          this.builder.addResource(deadLetterLogicalId, deadLetterQueue)

          // Update the main queue with redrive policy
          const resources = this.builder.getResources()
          const existingQueue = resources[logicalId]
          if (existingQueue?.Properties) {
            existingQueue.Properties.RedrivePolicy = updatedSourceQueue.Properties?.RedrivePolicy
          }
        }

        // Lambda trigger (Event Source Mapping)
        if (queueConfig.trigger) {
          const triggerConfig = queueConfig.trigger
          const functionLogicalId = `${slug}${env}${triggerConfig.functionName}`.replace(/[^a-zA-Z0-9]/g, '')

          const eventSourceMapping = {
            Type: 'AWS::Lambda::EventSourceMapping',
            Properties: {
              EventSourceArn: { 'Fn::GetAtt': [logicalId, 'Arn'] },
              FunctionName: { Ref: functionLogicalId },
              BatchSize: triggerConfig.batchSize || 10,
              MaximumBatchingWindowInSeconds: triggerConfig.batchWindow || 0,
              Enabled: true,
              ...(triggerConfig.reportBatchItemFailures !== false && {
                FunctionResponseTypes: ['ReportBatchItemFailures'],
              }),
              ...(triggerConfig.maxConcurrency && {
                ScalingConfig: {
                  MaximumConcurrency: triggerConfig.maxConcurrency,
                },
              }),
              ...(triggerConfig.filterPattern && {
                FilterCriteria: {
                  Filters: [{ Pattern: JSON.stringify(triggerConfig.filterPattern) }],
                },
              }),
            },
            DependsOn: [logicalId, functionLogicalId],
          }

          this.builder.addResource(`${logicalId}Trigger`, eventSourceMapping as any)
        }

        // CloudWatch Alarms
        if (queueConfig.alarms?.enabled) {
          const alarmsConfig = queueConfig.alarms

          // Create SNS topic for notifications if emails are provided
          let alarmTopicArn = alarmsConfig.notificationTopicArn
          if (!alarmTopicArn && alarmsConfig.notificationEmails?.length) {
            const topicLogicalId = `${logicalId}AlarmTopic`
            this.builder.addResource(topicLogicalId, {
              Type: 'AWS::SNS::Topic',
              Properties: {
                TopicName: `${slug}-${env}-${name}-alarms`,
                DisplayName: `${name} Queue Alarms`,
              },
            } as any)

            // Add email subscriptions
            alarmsConfig.notificationEmails.forEach((email, idx) => {
              this.builder.addResource(`${topicLogicalId}Sub${idx}`, {
                Type: 'AWS::SNS::Subscription',
                Properties: {
                  TopicArn: { Ref: topicLogicalId },
                  Protocol: 'email',
                  Endpoint: email,
                },
              } as any)
            })

            alarmTopicArn = { Ref: topicLogicalId } as any
          }

          // Queue depth alarm
          const depthThreshold = alarmsConfig.queueDepthThreshold || 1000
          this.builder.addResource(`${logicalId}DepthAlarm`, {
            Type: 'AWS::CloudWatch::Alarm',
            Properties: {
              AlarmName: `${slug}-${env}-${name}-queue-depth`,
              AlarmDescription: `Queue ${name} depth exceeds ${depthThreshold} messages`,
              MetricName: 'ApproximateNumberOfMessagesVisible',
              Namespace: 'AWS/SQS',
              Statistic: 'Average',
              Period: 300,
              EvaluationPeriods: 2,
              Threshold: depthThreshold,
              ComparisonOperator: 'GreaterThanThreshold',
              Dimensions: [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [logicalId, 'QueueName'] } }],
              ...(alarmTopicArn && { AlarmActions: [alarmTopicArn], OKActions: [alarmTopicArn] }),
            },
          } as any)

          // Message age alarm
          const ageThreshold = alarmsConfig.messageAgeThreshold || 3600
          this.builder.addResource(`${logicalId}AgeAlarm`, {
            Type: 'AWS::CloudWatch::Alarm',
            Properties: {
              AlarmName: `${slug}-${env}-${name}-message-age`,
              AlarmDescription: `Queue ${name} oldest message exceeds ${ageThreshold} seconds`,
              MetricName: 'ApproximateAgeOfOldestMessage',
              Namespace: 'AWS/SQS',
              Statistic: 'Maximum',
              Period: 300,
              EvaluationPeriods: 2,
              Threshold: ageThreshold,
              ComparisonOperator: 'GreaterThanThreshold',
              Dimensions: [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [logicalId, 'QueueName'] } }],
              ...(alarmTopicArn && { AlarmActions: [alarmTopicArn], OKActions: [alarmTopicArn] }),
            },
          } as any)

          // DLQ alarm (if DLQ is enabled)
          if (dlqLogicalId && alarmsConfig.dlqAlarm !== false) {
            this.builder.addResource(`${dlqLogicalId}Alarm`, {
              Type: 'AWS::CloudWatch::Alarm',
              Properties: {
                AlarmName: `${slug}-${env}-${name}-dlq-messages`,
                AlarmDescription: `Dead letter queue for ${name} has messages`,
                MetricName: 'ApproximateNumberOfMessagesVisible',
                Namespace: 'AWS/SQS',
                Statistic: 'Sum',
                Period: 300,
                EvaluationPeriods: 1,
                Threshold: 0,
                ComparisonOperator: 'GreaterThanThreshold',
                Dimensions: [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [dlqLogicalId, 'QueueName'] } }],
                ...(alarmTopicArn && { AlarmActions: [alarmTopicArn] }),
              },
            } as any)
          }
        }

        // SNS Subscription
        if (queueConfig.subscribe) {
          const subConfig = queueConfig.subscribe

          // Determine topic ARN
          let topicArn = subConfig.topicArn
          if (!topicArn && subConfig.topicName) {
            // Reference existing topic in the stack
            topicArn = { Ref: subConfig.topicName } as any
          }

          if (topicArn) {
            // Queue policy to allow SNS to send messages
            this.builder.addResource(`${logicalId}SnsPolicy`, {
              Type: 'AWS::SQS::QueuePolicy',
              Properties: {
                Queues: [{ Ref: logicalId }],
                PolicyDocument: {
                  Version: '2012-10-17',
                  Statement: [{
                    Effect: 'Allow',
                    Principal: { Service: 'sns.amazonaws.com' },
                    Action: 'sqs:SendMessage',
                    Resource: { 'Fn::GetAtt': [logicalId, 'Arn'] },
                    Condition: {
                      ArnEquals: { 'aws:SourceArn': topicArn },
                    },
                  }],
                },
              },
            } as any)

            // SNS Subscription
            const subscriptionProps: Record<string, any> = {
              TopicArn: topicArn,
              Protocol: 'sqs',
              Endpoint: { 'Fn::GetAtt': [logicalId, 'Arn'] },
              RawMessageDelivery: subConfig.rawMessageDelivery || false,
            }

            if (subConfig.filterPolicy) {
              subscriptionProps.FilterPolicy = subConfig.filterPolicy
              subscriptionProps.FilterPolicyScope = subConfig.filterPolicyScope || 'MessageAttributes'
            }

            this.builder.addResource(`${logicalId}SnsSub`, {
              Type: 'AWS::SNS::Subscription',
              Properties: subscriptionProps,
              DependsOn: `${logicalId}SnsPolicy`,
            } as any)
          }
        }
      }
    }

    // Monitoring
    if (this.config.infrastructure?.monitoring?.alarms) {
      for (const [name, alarmConfig] of Object.entries(this.config.infrastructure.monitoring.alarms)) {
        const { alarm, logicalId } = Monitoring.createAlarm({
          slug,
          environment: env,
          alarmName: `${slug}-${env}-${name}`,
          metricName: alarmConfig.metricName,
          namespace: alarmConfig.namespace,
          threshold: alarmConfig.threshold,
          comparisonOperator: alarmConfig.comparisonOperator,
        })

        this.builder.addResource(logicalId, alarm)
      }
    }
  }

  /**
   * Generate YAML output
   */
  toYAML(): string {
    return this.builder.toYAML()
  }

  /**
   * Generate JSON output
   */
  toJSON(): string {
    return this.builder.toJSON()
  }

  /**
   * Get the template builder
   */
  getBuilder(): TemplateBuilder {
    return this.builder
  }
}
