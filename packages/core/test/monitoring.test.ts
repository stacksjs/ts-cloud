import { describe, expect, test } from 'bun:test'
import { Monitoring } from '../src/modules/monitoring'
import { TemplateBuilder } from '../src/template-builder'
import type { EnvironmentType } from 'ts-cloud-types'

const slug = 'test-app'
const environment: EnvironmentType = 'development'

describe('monitoring Module - Alarms', () => {
  test('should create a basic CloudWatch alarm', () => {
    const { alarm, logicalId } = Monitoring.createAlarm({
      slug,
      environment,
      metricName: 'CPUUtilization',
      namespace: 'AWS/EC2',
      threshold: 80,
      comparisonOperator: 'GreaterThanThreshold',
    })

    expect(alarm.Type).toBe('AWS::CloudWatch::Alarm')
    expect(alarm.Properties?.AlarmName).toContain('test-app')
    expect(alarm.Properties?.MetricName).toBe('CPUUtilization')
    expect(alarm.Properties?.Namespace).toBe('AWS/EC2')
    expect(alarm.Properties?.Threshold).toBe(80)
    expect(alarm.Properties?.ComparisonOperator).toBe('GreaterThanThreshold')
    expect(alarm.Properties?.Statistic).toBe('Average')
    expect(alarm.Properties?.Period).toBe(300)
    expect(alarm.Properties?.EvaluationPeriods).toBe(1)
    expect(logicalId).toBeTruthy()
  })

  test('should create an alarm with custom configuration', () => {
    const { alarm } = Monitoring.createAlarm({
      slug,
      environment,
      alarmName: 'custom-alarm',
      metricName: 'RequestCount',
      namespace: 'AWS/ApplicationELB',
      statistic: 'Sum',
      period: 60,
      evaluationPeriods: 3,
      threshold: 1000,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      treatMissingData: 'breaching',
      datapointsToAlarm: 2,
    })

    expect(alarm.Properties?.AlarmName).toBe('custom-alarm')
    expect(alarm.Properties?.Statistic).toBe('Sum')
    expect(alarm.Properties?.Period).toBe(60)
    expect(alarm.Properties?.EvaluationPeriods).toBe(3)
    expect(alarm.Properties?.TreatMissingData).toBe('breaching')
    expect(alarm.Properties?.DatapointsToAlarm).toBe(2)
  })

  test('should create an alarm with SNS actions', () => {
    const snsTopicArn = 'arn:aws:sns:us-east-1:123456789012:my-topic'

    const { alarm } = Monitoring.createAlarm({
      slug,
      environment,
      metricName: 'Errors',
      namespace: 'AWS/Lambda',
      threshold: 5,
      comparisonOperator: 'GreaterThanThreshold',
      alarmActions: [snsTopicArn],
      okActions: [snsTopicArn],
    })

    expect(alarm.Properties?.AlarmActions).toEqual([snsTopicArn])
    expect(alarm.Properties?.OKActions).toEqual([snsTopicArn])
  })

  test('should create an alarm with dimensions', () => {
    const { alarm } = Monitoring.createAlarm({
      slug,
      environment,
      metricName: 'CPUUtilization',
      namespace: 'AWS/EC2',
      threshold: 80,
      comparisonOperator: 'GreaterThanThreshold',
      dimensions: {
        InstanceId: 'i-1234567890abcdef0',
        AutoScalingGroupName: 'my-asg',
      },
    })

    expect(alarm.Properties?.Dimensions).toHaveLength(2)
    expect(alarm.Properties?.Dimensions?.[0]).toEqual({
      Name: 'InstanceId',
      Value: 'i-1234567890abcdef0',
    })
    expect(alarm.Properties?.Dimensions?.[1]).toEqual({
      Name: 'AutoScalingGroupName',
      Value: 'my-asg',
    })
  })

  test('should create a composite alarm', () => {
    const { alarm, logicalId } = Monitoring.createCompositeAlarm({
      slug,
      environment,
      alarmRule: 'ALARM(Alarm1) OR ALARM(Alarm2)',
      alarmActions: ['arn:aws:sns:us-east-1:123456789012:my-topic'],
    })

    expect(alarm.Type).toBe('AWS::CloudWatch::CompositeAlarm')
    expect(alarm.Properties?.AlarmName).toContain('test-app')
    expect(alarm.Properties?.AlarmRule).toBe('ALARM(Alarm1) OR ALARM(Alarm2)')
    expect(alarm.Properties?.AlarmActions).toHaveLength(1)
    expect(logicalId).toBeTruthy()
  })
})

describe('monitoring Module - Common Alarm Types', () => {
  test('should create high CPU alarm', () => {
    const alarmConfig = Monitoring.AlarmTypes.highCpu(
      slug,
      environment,
      'i-1234567890abcdef0',
      90,
    )

    expect(alarmConfig.metricName).toBe('CPUUtilization')
    expect(alarmConfig.namespace).toBe('AWS/EC2')
    expect(alarmConfig.threshold).toBe(90)
    expect(alarmConfig.dimensions?.InstanceId).toBe('i-1234567890abcdef0')
  })

  test('should create Lambda errors alarm', () => {
    const alarmConfig = Monitoring.AlarmTypes.lambdaErrors(
      slug,
      environment,
      'my-function',
      10,
      'arn:aws:sns:us-east-1:123456789012:alerts',
    )

    expect(alarmConfig.metricName).toBe('Errors')
    expect(alarmConfig.namespace).toBe('AWS/Lambda')
    expect(alarmConfig.threshold).toBe(10)
    expect(alarmConfig.dimensions?.FunctionName).toBe('my-function')
    expect(alarmConfig.alarmActions).toContain('arn:aws:sns:us-east-1:123456789012:alerts')
  })

  test('should create API Gateway 5xx errors alarm', () => {
    const alarmConfig = Monitoring.AlarmTypes.apiGateway5xxErrors(
      slug,
      environment,
      'my-api',
      5,
    )

    expect(alarmConfig.metricName).toBe('5XXError')
    expect(alarmConfig.namespace).toBe('AWS/ApiGateway')
    expect(alarmConfig.threshold).toBe(5)
  })

  test('should create DynamoDB throttles alarm', () => {
    const alarmConfig = Monitoring.AlarmTypes.dynamoDBThrottles(
      slug,
      environment,
      'my-table',
      3,
    )

    expect(alarmConfig.metricName).toBe('UserErrors')
    expect(alarmConfig.namespace).toBe('AWS/DynamoDB')
    expect(alarmConfig.threshold).toBe(3)
    expect(alarmConfig.dimensions?.TableName).toBe('my-table')
  })

  test('should create RDS CPU alarm', () => {
    const alarmConfig = Monitoring.AlarmTypes.rdsCpu(
      slug,
      environment,
      'my-db-instance',
      75,
    )

    expect(alarmConfig.metricName).toBe('CPUUtilization')
    expect(alarmConfig.namespace).toBe('AWS/RDS')
    expect(alarmConfig.threshold).toBe(75)
    expect(alarmConfig.dimensions?.DBInstanceIdentifier).toBe('my-db-instance')
  })

  test('should create SQS queue depth alarm', () => {
    const alarmConfig = Monitoring.AlarmTypes.sqsQueueDepth(
      slug,
      environment,
      'my-queue',
      200,
    )

    expect(alarmConfig.metricName).toBe('ApproximateNumberOfMessagesVisible')
    expect(alarmConfig.namespace).toBe('AWS/SQS')
    expect(alarmConfig.threshold).toBe(200)
    expect(alarmConfig.dimensions?.QueueName).toBe('my-queue')
  })
})

describe('monitoring Module - Dashboards', () => {
  test('should create a CloudWatch dashboard', () => {
    const widgets = [
      Monitoring.DashboardWidgets.metric(
        0,
        0,
        12,
        6,
        [
          ['AWS/EC2', 'CPUUtilization', { InstanceId: 'i-1234567890abcdef0' }],
        ],
        'CPU Utilization',
      ),
      Monitoring.DashboardWidgets.text(
        12,
        0,
        12,
        6,
        '# Dashboard Title\nThis is a test dashboard',
      ),
    ]

    const { dashboard, logicalId } = Monitoring.createDashboard({
      slug,
      environment,
      widgets,
    })

    expect(dashboard.Type).toBe('AWS::CloudWatch::Dashboard')
    expect(dashboard.Properties?.DashboardName).toContain('test-app')
    expect(dashboard.Properties?.DashboardBody).toBeTruthy()
    expect(logicalId).toBeTruthy()

    const dashboardBody = JSON.parse(dashboard.Properties!.DashboardBody)
    expect(dashboardBody.widgets).toHaveLength(2)
    expect(dashboardBody.widgets[0].type).toBe('metric')
    expect(dashboardBody.widgets[1].type).toBe('text')
  })

  test('should create metric widget', () => {
    const widget = Monitoring.DashboardWidgets.metric(
      0,
      0,
      12,
      6,
      [
        ['AWS/Lambda', 'Invocations', { FunctionName: 'my-function' }],
        ['AWS/Lambda', 'Errors', { FunctionName: 'my-function' }],
      ],
      'Lambda Metrics',
    )

    expect(widget.type).toBe('metric')
    expect(widget.x).toBe(0)
    expect(widget.y).toBe(0)
    expect(widget.width).toBe(12)
    expect(widget.height).toBe(6)
    expect(widget.properties.title).toBe('Lambda Metrics')
    expect(widget.properties.metrics).toHaveLength(2)
  })

  test('should create text widget', () => {
    const widget = Monitoring.DashboardWidgets.text(
      0,
      0,
      24,
      2,
      '# Production Dashboard',
    )

    expect(widget.type).toBe('text')
    expect(widget.properties.markdown).toBe('# Production Dashboard')
  })

  test('should create log widget', () => {
    const widget = Monitoring.DashboardWidgets.log(
      0,
      0,
      24,
      6,
      ['/aws/lambda/my-function', '/aws/lambda/another-function'],
      'Recent Logs',
    )

    expect(widget.type).toBe('log')
    expect(widget.properties.title).toBe('Recent Logs')
    expect(widget.properties.query).toContain('/aws/lambda/my-function')
  })
})

describe('monitoring Module - Log Groups', () => {
  test('should create a CloudWatch log group', () => {
    const { logGroup, logicalId } = Monitoring.createLogGroup({
      slug,
      environment,
    })

    expect(logGroup.Type).toBe('AWS::Logs::LogGroup')
    expect(logGroup.Properties?.LogGroupName).toContain('test-app')
    expect(logicalId).toBeTruthy()
  })

  test('should create a log group with retention', () => {
    const { logGroup } = Monitoring.createLogGroup({
      slug,
      environment,
      retentionInDays: Monitoring.RetentionPeriods.ONE_WEEK,
    })

    expect(logGroup.Properties?.RetentionInDays).toBe(7)
  })

  test('should create a log group with KMS encryption', () => {
    const kmsKeyId = 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012'

    const { logGroup } = Monitoring.createLogGroup({
      slug,
      environment,
      kmsKeyId,
    })

    expect(logGroup.Properties?.KmsKeyId).toBe(kmsKeyId)
  })

  test('should create a log group with custom name', () => {
    const { logGroup } = Monitoring.createLogGroup({
      slug,
      environment,
      logGroupName: '/aws/lambda/custom-function',
      retentionInDays: Monitoring.RetentionPeriods.ONE_MONTH,
    })

    expect(logGroup.Properties?.LogGroupName).toBe('/aws/lambda/custom-function')
    expect(logGroup.Properties?.RetentionInDays).toBe(30)
  })
})

describe('monitoring Module - Log Streams', () => {
  test('should create a CloudWatch log stream', () => {
    const { logGroup, logicalId: logGroupId } = Monitoring.createLogGroup({
      slug,
      environment,
    })

    const { logStream, logicalId } = Monitoring.createLogStream(logGroupId, {
      slug,
      environment,
    })

    expect(logStream.Type).toBe('AWS::Logs::LogStream')
    expect(logStream.Properties?.LogStreamName).toContain('test-app')
    expect(logicalId).toBeTruthy()
  })

  test('should create a log stream with custom name', () => {
    const { logicalId: logGroupId } = Monitoring.createLogGroup({
      slug,
      environment,
    })

    const { logStream } = Monitoring.createLogStream(logGroupId, {
      slug,
      environment,
      logStreamName: 'custom-stream',
    })

    expect(logStream.Properties?.LogStreamName).toBe('custom-stream')
  })
})

describe('monitoring Module - Metric Filters', () => {
  test('should create a metric filter', () => {
    const { logicalId: logGroupId } = Monitoring.createLogGroup({
      slug,
      environment,
    })

    const { metricFilter, logicalId } = Monitoring.createMetricFilter(logGroupId, {
      slug,
      environment,
      filterPattern: Monitoring.FilterPatterns.errors,
      metricTransformations: [
        {
          metricName: 'ErrorCount',
          metricNamespace: 'MyApp',
          metricValue: '1',
        },
      ],
    })

    expect(metricFilter.Type).toBe('AWS::Logs::MetricFilter')
    expect(metricFilter.Properties?.FilterPattern).toBe(Monitoring.FilterPatterns.errors)
    expect(metricFilter.Properties?.MetricTransformations).toHaveLength(1)
    expect(metricFilter.Properties?.MetricTransformations?.[0].MetricName).toBe('ErrorCount')
    expect(logicalId).toBeTruthy()
  })

  test('should create a metric filter with custom pattern', () => {
    const { logicalId: logGroupId } = Monitoring.createLogGroup({
      slug,
      environment,
    })

    const { metricFilter } = Monitoring.createMetricFilter(logGroupId, {
      slug,
      environment,
      filterPattern: Monitoring.FilterPatterns.http5xx,
      metricTransformations: [
        {
          metricName: '5xxErrors',
          metricNamespace: 'API',
          metricValue: '1',
          defaultValue: 0,
        },
      ],
    })

    expect(metricFilter.Properties?.FilterPattern).toBe(Monitoring.FilterPatterns.http5xx)
    expect(metricFilter.Properties?.MetricTransformations?.[0].DefaultValue).toBe(0)
  })

  test('should create a metric filter with multiple transformations', () => {
    const { logicalId: logGroupId } = Monitoring.createLogGroup({
      slug,
      environment,
    })

    const { metricFilter } = Monitoring.createMetricFilter(logGroupId, {
      slug,
      environment,
      filterPattern: Monitoring.FilterPatterns.all,
      metricTransformations: [
        {
          metricName: 'TotalRequests',
          metricNamespace: 'API',
          metricValue: '1',
        },
        {
          metricName: 'ResponseTime',
          metricNamespace: 'API',
          metricValue: '$.duration',
          unit: 'Milliseconds',
        },
      ],
    })

    expect(metricFilter.Properties?.MetricTransformations).toHaveLength(2)
  })
})

describe('monitoring Module - Filter Patterns', () => {
  test('should have predefined filter patterns', () => {
    expect(Monitoring.FilterPatterns.errors).toBe('[time, request_id, event_type = ERROR*, ...]')
    expect(Monitoring.FilterPatterns.all).toBe('')
    expect(Monitoring.FilterPatterns.http4xx).toBe('[..., status_code = 4*, ...]')
    expect(Monitoring.FilterPatterns.http5xx).toBe('[..., status_code = 5*, ...]')
  })

  test('should create JSON field filter pattern', () => {
    const pattern = Monitoring.FilterPatterns.jsonField('level', 'ERROR')
    expect(pattern).toBe('{ $.level = "ERROR" }')
  })

  test('should create HTTP status filter pattern', () => {
    const pattern = Monitoring.FilterPatterns.httpStatus(404)
    expect(pattern).toBe('[..., status_code = 404, ...]')
  })
})

describe('monitoring Module - Retention Periods', () => {
  test('should have common retention periods', () => {
    expect(Monitoring.RetentionPeriods.ONE_DAY).toBe(1)
    expect(Monitoring.RetentionPeriods.ONE_WEEK).toBe(7)
    expect(Monitoring.RetentionPeriods.ONE_MONTH).toBe(30)
    expect(Monitoring.RetentionPeriods.ONE_YEAR).toBe(365)
    expect(Monitoring.RetentionPeriods.NEVER_EXPIRE).toBeUndefined()
  })
})

describe('monitoring Module - Integration with TemplateBuilder', () => {
  test('should add alarm to template', () => {
    const builder = new TemplateBuilder()

    const { alarm, logicalId } = Monitoring.createAlarm({
      slug,
      environment,
      metricName: 'CPUUtilization',
      namespace: 'AWS/EC2',
      threshold: 80,
      comparisonOperator: 'GreaterThanThreshold',
    })

    builder.addResource(logicalId, alarm)

    const template = builder.build()

    expect(template.Resources[logicalId]).toBeDefined()
    expect(template.Resources[logicalId].Type).toBe('AWS::CloudWatch::Alarm')
  })

  test('should add dashboard to template', () => {
    const builder = new TemplateBuilder()

    const { dashboard, logicalId } = Monitoring.createDashboard({
      slug,
      environment,
      widgets: [
        Monitoring.DashboardWidgets.metric(
          0,
          0,
          12,
          6,
          [['AWS/EC2', 'CPUUtilization']],
        ),
      ],
    })

    builder.addResource(logicalId, dashboard)

    const template = builder.build()

    expect(template.Resources[logicalId]).toBeDefined()
    expect(template.Resources[logicalId].Type).toBe('AWS::CloudWatch::Dashboard')
  })

  test('should add log group and metric filter to template', () => {
    const builder = new TemplateBuilder()

    const { logGroup, logicalId: logGroupId } = Monitoring.createLogGroup({
      slug,
      environment,
      retentionInDays: Monitoring.RetentionPeriods.ONE_WEEK,
    })

    const { metricFilter, logicalId: filterId } = Monitoring.createMetricFilter(logGroupId, {
      slug,
      environment,
      filterPattern: Monitoring.FilterPatterns.errors,
      metricTransformations: [
        {
          metricName: 'ErrorCount',
          metricNamespace: 'MyApp',
          metricValue: '1',
        },
      ],
    })

    builder.addResource(logGroupId, logGroup)
    builder.addResource(filterId, metricFilter)

    const template = builder.build()

    expect(template.Resources[logGroupId]).toBeDefined()
    expect(template.Resources[logGroupId].Type).toBe('AWS::Logs::LogGroup')
    expect(template.Resources[filterId]).toBeDefined()
    expect(template.Resources[filterId].Type).toBe('AWS::Logs::MetricFilter')
  })

  test('should create complete monitoring stack', () => {
    const builder = new TemplateBuilder()

    // Create log group
    const { logGroup, logicalId: logGroupId } = Monitoring.createLogGroup({
      slug,
      environment,
      logGroupName: '/aws/lambda/my-function',
      retentionInDays: Monitoring.RetentionPeriods.ONE_MONTH,
    })

    // Create metric filter
    const { metricFilter, logicalId: filterId } = Monitoring.createMetricFilter(logGroupId, {
      slug,
      environment,
      filterPattern: Monitoring.FilterPatterns.errors,
      metricTransformations: [
        {
          metricName: 'ErrorCount',
          metricNamespace: 'MyApp/Lambda',
          metricValue: '1',
        },
      ],
    })

    // Create alarm from metric filter
    const { alarm, logicalId: alarmId } = Monitoring.createAlarm({
      slug,
      environment,
      alarmName: 'lambda-errors',
      metricName: 'ErrorCount',
      namespace: 'MyApp/Lambda',
      threshold: 5,
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 2,
    })

    // Create dashboard
    const { dashboard, logicalId: dashboardId } = Monitoring.createDashboard({
      slug,
      environment,
      widgets: [
        Monitoring.DashboardWidgets.metric(
          0,
          0,
          12,
          6,
          [['MyApp/Lambda', 'ErrorCount']],
          'Lambda Errors',
        ),
        Monitoring.DashboardWidgets.log(
          0,
          6,
          12,
          6,
          ['/aws/lambda/my-function'],
          'Recent Errors',
        ),
      ],
    })

    builder.addResource(logGroupId, logGroup)
    builder.addResource(filterId, metricFilter)
    builder.addResource(alarmId, alarm)
    builder.addResource(dashboardId, dashboard)

    const template = builder.build()

    expect(Object.keys(template.Resources)).toHaveLength(4)
    expect(template.Resources[logGroupId].Type).toBe('AWS::Logs::LogGroup')
    expect(template.Resources[filterId].Type).toBe('AWS::Logs::MetricFilter')
    expect(template.Resources[alarmId].Type).toBe('AWS::CloudWatch::Alarm')
    expect(template.Resources[dashboardId].Type).toBe('AWS::CloudWatch::Dashboard')
  })
})
