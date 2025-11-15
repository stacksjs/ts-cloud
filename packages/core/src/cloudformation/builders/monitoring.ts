import type { CloudFormationBuilder } from '../builder'
import { Fn } from '../types'

export interface MonitoringConfig {
  dashboard?: {
    name: string
    widgets?: Array<{
      type: 'metric' | 'log' | 'text'
      metrics?: string[] | Array<{ service?: string, metric: string }>
      logGroup?: string
      text?: string
      width?: number
      height?: number
    }>
  }
  alarms?: Array<{
    name?: string
    metric: string
    threshold: number
    evaluationPeriods?: number
    comparisonOperator?: 'GreaterThanThreshold' | 'LessThanThreshold' | 'GreaterThanOrEqualToThreshold' | 'LessThanOrEqualToThreshold'
    statistic?: 'Average' | 'Sum' | 'Minimum' | 'Maximum' | 'SampleCount'
    period?: number
    treatMissingData?: 'breaching' | 'notBreaching' | 'ignore' | 'missing'
    service?: string
    namespace?: string
    dimensions?: Record<string, string>
  }>
  logs?: {
    retention?: number
    groups?: string[]
  }
}

/**
 * Add CloudWatch monitoring resources to CloudFormation template
 */
export function addMonitoringResources(
  builder: CloudFormationBuilder,
  config: MonitoringConfig,
): void {
  // SNS Topic for alarms
  if (config.alarms && config.alarms.length > 0) {
    builder.addResource('AlarmTopic', 'AWS::SNS::Topic', {
      TopicName: Fn.sub('${AWS::StackName}-alarms'),
      DisplayName: 'CloudWatch Alarms',
      Tags: [
        { Key: 'Name', Value: Fn.sub('${AWS::StackName}-alarms') },
      ],
    })

    // Add alarms
    config.alarms.forEach((alarm, index) => {
      addCloudWatchAlarm(builder, alarm, index)
    })
  }

  // CloudWatch Dashboard
  if (config.dashboard) {
    addCloudWatchDashboard(builder, config.dashboard)
  }

  // Log Groups
  if (config.logs?.groups) {
    config.logs.groups.forEach(group => {
      addLogGroup(builder, group, config.logs.retention)
    })
  }
}

/**
 * Add CloudWatch alarm
 */
function addCloudWatchAlarm(
  builder: CloudFormationBuilder,
  config: MonitoringConfig['alarms'][0],
  index: number,
): void {
  const alarmId = builder.toLogicalId(`alarm-${config.name || config.metric}-${index}`)

  const alarmProperties: Record<string, any> = {
    AlarmName: config.name || Fn.sub(`\${AWS::StackName}-${config.metric}`),
    AlarmDescription: `Alarm for ${config.metric}`,
    MetricName: config.metric,
    Namespace: config.namespace || getNamespaceForMetric(config.metric, config.service),
    Statistic: config.statistic || 'Average',
    Period: config.period || 300,
    EvaluationPeriods: config.evaluationPeriods || 1,
    Threshold: config.threshold,
    ComparisonOperator: config.comparisonOperator || 'GreaterThanThreshold',
    TreatMissingData: config.treatMissingData || 'notBreaching',
    AlarmActions: [Fn.ref('AlarmTopic')],
    OKActions: [Fn.ref('AlarmTopic')],
  }

  // Dimensions
  if (config.dimensions) {
    alarmProperties.Dimensions = Object.entries(config.dimensions).map(([name, value]) => ({
      Name: name,
      Value: value,
    }))
  }
  else if (config.service) {
    // Auto-generate dimensions based on service
    alarmProperties.Dimensions = generateDimensionsForService(config.service)
  }

  builder.addResource(alarmId, 'AWS::CloudWatch::Alarm', alarmProperties, {
    dependsOn: 'AlarmTopic',
  })
}

/**
 * Add CloudWatch Dashboard
 */
function addCloudWatchDashboard(
  builder: CloudFormationBuilder,
  config: MonitoringConfig['dashboard'],
): void {
  if (!config) return

  const widgets: any[] = []
  let x = 0
  let y = 0

  // Build dashboard widgets
  config.widgets?.forEach(widget => {
    const width = widget.width || 12
    const height = widget.height || 6

    if (widget.type === 'metric' && widget.metrics) {
      const metrics = widget.metrics.map(metric => {
        if (typeof metric === 'string') {
          // Simple metric name - infer namespace
          const namespace = getNamespaceForMetric(metric)
          return [namespace, metric]
        }
        else {
          // Metric with service specified
          const namespace = getNamespaceForMetric(metric.metric, metric.service)
          return [namespace, metric.metric]
        }
      })

      widgets.push({
        type: 'metric',
        x,
        y,
        width,
        height,
        properties: {
          metrics,
          period: 300,
          stat: 'Average',
          region: Fn.ref('AWS::Region'),
          title: widget.metrics.length > 1
            ? 'Multiple Metrics'
            : typeof widget.metrics[0] === 'string'
              ? widget.metrics[0]
              : widget.metrics[0].metric,
        },
      })
    }
    else if (widget.type === 'log' && widget.logGroup) {
      widgets.push({
        type: 'log',
        x,
        y,
        width,
        height,
        properties: {
          query: `SOURCE '${widget.logGroup}'\n| fields @timestamp, @message\n| sort @timestamp desc\n| limit 20`,
          region: Fn.ref('AWS::Region'),
          title: `Logs: ${widget.logGroup}`,
        },
      })
    }
    else if (widget.type === 'text' && widget.text) {
      widgets.push({
        type: 'text',
        x,
        y,
        width,
        height,
        properties: {
          markdown: widget.text,
        },
      })
    }

    // Update position for next widget
    x += width
    if (x >= 24) {
      x = 0
      y += height
    }
  })

  builder.addResource('CloudWatchDashboard', 'AWS::CloudWatch::Dashboard', {
    DashboardName: Fn.sub(`\${AWS::StackName}-${config.name}`),
    DashboardBody: JSON.stringify({ widgets }),
  })

  // Output
  builder.template.Outputs = {
    ...builder.template.Outputs,
    DashboardURL: {
      Description: 'CloudWatch Dashboard URL',
      Value: Fn.sub(
        `https://console.aws.amazon.com/cloudwatch/home?region=\${AWS::Region}#dashboards:name=\${CloudWatchDashboard}`,
      ),
    },
  }
}

/**
 * Add CloudWatch Log Group
 */
function addLogGroup(
  builder: CloudFormationBuilder,
  groupName: string,
  retention?: number,
): void {
  const logicalId = builder.toLogicalId(`${groupName}-log-group`)

  builder.addResource(logicalId, 'AWS::Logs::LogGroup', {
    LogGroupName: Fn.sub(`/aws/\${AWS::StackName}/${groupName}`),
    RetentionInDays: retention || 14,
    Tags: [
      { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-${groupName}`) },
    ],
  })
}

/**
 * Get AWS namespace for a metric
 */
function getNamespaceForMetric(metric: string, service?: string): string {
  if (service) {
    const namespaceMap: Record<string, string> = {
      'ec2': 'AWS/EC2',
      'ecs': 'AWS/ECS',
      'lambda': 'AWS/Lambda',
      'rds': 'AWS/RDS',
      'dynamodb': 'AWS/DynamoDB',
      's3': 'AWS/S3',
      'cloudfront': 'AWS/CloudFront',
      'alb': 'AWS/ApplicationELB',
      'nlb': 'AWS/NetworkELB',
      'apigateway': 'AWS/ApiGateway',
      'sqs': 'AWS/SQS',
      'sns': 'AWS/SNS',
      'kinesis': 'AWS/Kinesis',
      'elasticache': 'AWS/ElastiCache',
    }
    return namespaceMap[service.toLowerCase()] || 'AWS/CloudWatch'
  }

  // Infer namespace from metric name
  const metricLower = metric.toLowerCase()

  if (metricLower.includes('cpu') || metricLower.includes('memory') || metricLower.includes('network')) {
    return 'AWS/EC2'
  }
  if (metricLower.includes('lambda') || metricLower.includes('invocation') || metricLower.includes('duration')) {
    return 'AWS/Lambda'
  }
  if (metricLower.includes('request') || metricLower.includes('latency') || metricLower.includes('target')) {
    return 'AWS/ApplicationELB'
  }
  if (metricLower.includes('database') || metricLower.includes('connection')) {
    return 'AWS/RDS'
  }
  if (metricLower.includes('read') || metricLower.includes('write') || metricLower.includes('consumed')) {
    return 'AWS/DynamoDB'
  }

  return 'AWS/CloudWatch'
}

/**
 * Generate dimensions for a service
 */
function generateDimensionsForService(service: string): any[] {
  const dimensionMap: Record<string, any[]> = {
    'ec2': [{ Name: 'InstanceId', Value: Fn.ref('EC2Instance') }],
    'ecs': [
      { Name: 'ClusterName', Value: Fn.ref('ECSCluster') },
      { Name: 'ServiceName', Value: Fn.getAtt('ECSService', 'Name') },
    ],
    'lambda': [{ Name: 'FunctionName', Value: Fn.ref('LambdaFunction') }],
    'rds': [{ Name: 'DBInstanceIdentifier', Value: Fn.ref('Database') }],
    'dynamodb': [{ Name: 'TableName', Value: Fn.ref('DynamoDBTable') }],
    'alb': [{ Name: 'LoadBalancer', Value: Fn.getAtt('LoadBalancer', 'LoadBalancerFullName') }],
    'apigateway': [{ Name: 'ApiName', Value: Fn.ref('HttpApi') }],
  }

  return dimensionMap[service.toLowerCase()] || []
}
