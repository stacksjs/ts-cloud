import { describe, expect, it, beforeEach } from 'bun:test'
import {
  XRayManager,
  xrayManager,
  MetricsManager,
  metricsManager,
  LogsManager,
  logsManager,
  SyntheticsManager,
  syntheticsManager,
} from '.'

describe('X-Ray Manager', () => {
  let manager: XRayManager

  beforeEach(() => {
    manager = new XRayManager()
  })

  describe('Configuration Creation', () => {
    it('should create Lambda X-Ray configuration', () => {
      const config = manager.createLambdaConfig({
        functionName: 'my-function',
        samplingRate: 0.2,
      })

      expect(config.id).toContain('xray-config')
      expect(config.name).toBe('my-function-xray')
      expect(config.serviceName).toBe('my-function')
      expect(config.samplingRate).toBe(0.2)
      expect(config.enableActiveTracing).toBe(true)
    })

    it('should use default sampling rate for Lambda', () => {
      const config = manager.createLambdaConfig({
        functionName: 'my-function',
      })

      expect(config.samplingRate).toBe(0.1)
    })

    it('should create ECS X-Ray configuration', () => {
      const config = manager.createECSConfig({
        serviceName: 'web-service',
        clusterName: 'production',
        samplingRate: 0.15,
      })

      expect(config.serviceName).toBe('production/web-service')
      expect(config.samplingRate).toBe(0.15)
    })

    it('should create API Gateway X-Ray configuration', () => {
      const config = manager.createAPIGatewayConfig({
        apiName: 'my-api',
        stage: 'prod',
      })

      expect(config.serviceName).toBe('my-api/prod')
      expect(config.samplingRate).toBe(0.05)
    })
  })

  describe('Sampling Rules', () => {
    it('should create high-priority sampling rule', () => {
      const rule = manager.createHighPrioritySamplingRule({
        ruleName: 'critical-endpoints',
        serviceName: 'api',
        urlPath: '/api/critical/*',
      })

      expect(rule.id).toContain('sampling-rule')
      expect(rule.priority).toBe(100)
      expect(rule.fixedRate).toBe(1.0)
      expect(rule.reservoirSize).toBe(100)
      expect(rule.urlPath).toBe('/api/critical/*')
    })

    it('should create error sampling rule', () => {
      const rule = manager.createErrorSamplingRule('my-service')

      expect(rule.ruleName).toBe('my-service-errors')
      expect(rule.priority).toBe(200)
      expect(rule.fixedRate).toBe(1.0)
      expect(rule.urlPath).toBe('/error/*')
    })

    it('should create default sampling rule', () => {
      const rule = manager.createDefaultSamplingRule('my-service', 0.1)

      expect(rule.ruleName).toBe('my-service-default')
      expect(rule.priority).toBe(1000)
      expect(rule.fixedRate).toBe(0.1)
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate Lambda X-Ray CloudFormation', () => {
      const config = manager.createLambdaConfig({
        functionName: 'my-function',
      })

      const cf = manager.generateLambdaXRayCF(config)

      expect(cf.TracingConfig.Mode).toBe('Active')
    })

    it('should generate API Gateway X-Ray CloudFormation', () => {
      const config = manager.createAPIGatewayConfig({
        apiName: 'my-api',
        stage: 'prod',
      })

      const cf = manager.generateAPIGatewayXRayCF(config)

      expect(cf.TracingEnabled).toBe(true)
    })

    it('should generate ECS X-Ray sidecar CloudFormation', () => {
      const cf = manager.generateECSXRaySidecarCF()

      expect(cf.Name).toBe('xray-daemon')
      expect(cf.Image).toContain('xray')
      expect(cf.PortMappings).toHaveLength(1)
      expect(cf.PortMappings[0].ContainerPort).toBe(2000)
    })

    it('should generate sampling rule CloudFormation', () => {
      const rule = manager.createHighPrioritySamplingRule({
        ruleName: 'test-rule',
        serviceName: 'api',
        urlPath: '/test/*',
      })

      const cf = manager.generateSamplingRuleCF(rule)

      expect(cf.Type).toBe('AWS::XRay::SamplingRule')
      expect(cf.Properties.SamplingRule.RuleName).toBe('test-rule')
      expect(cf.Properties.SamplingRule.Priority).toBe(100)
    })
  })

  describe('Data Management', () => {
    it('should retrieve config by id', () => {
      const config = manager.createLambdaConfig({
        functionName: 'my-function',
      })

      const retrieved = manager.getConfig(config.id)

      expect(retrieved).toEqual(config)
    })

    it('should list all configs', () => {
      manager.createLambdaConfig({ functionName: 'func1' })
      manager.createECSConfig({ serviceName: 'svc1', clusterName: 'cluster1' })

      const configs = manager.listConfigs()

      expect(configs).toHaveLength(2)
    })

    it('should clear all data', () => {
      manager.createLambdaConfig({ functionName: 'func1' })
      manager.createHighPrioritySamplingRule({
        ruleName: 'rule1',
        serviceName: 'svc1',
        urlPath: '/test',
      })

      manager.clear()

      expect(manager.listConfigs()).toHaveLength(0)
      expect(manager.listSamplingRules()).toHaveLength(0)
    })
  })

  it('should use global instance', () => {
    expect(xrayManager).toBeInstanceOf(XRayManager)
  })
})

describe('Metrics Manager', () => {
  let manager: MetricsManager

  beforeEach(() => {
    manager = new MetricsManager()
  })

  describe('Metric Creation', () => {
    it('should create business metric', () => {
      const metric = manager.createBusinessMetric({
        name: 'OrdersPlaced',
        namespace: 'MyApp/Business',
        unit: 'Count',
      })

      expect(metric.id).toContain('metric')
      expect(metric.name).toBe('OrdersPlaced')
      expect(metric.unit).toBe('Count')
      expect(metric.dimensions).toHaveLength(2)
      expect(metric.dimensions?.[0].name).toBe('Environment')
      expect(metric.dimensions?.[1].value).toBe('Business')
    })

    it('should create application metric', () => {
      const metric = manager.createApplicationMetric({
        name: 'CacheHits',
        namespace: 'MyApp/Application',
        unit: 'Count',
        serviceName: 'api',
      })

      expect(metric.dimensions?.[0].value).toBe('api')
      expect(metric.dimensions?.[1].value).toBe('Application')
    })

    it('should create performance metric', () => {
      const metric = manager.createPerformanceMetric({
        name: 'DatabaseQueryTime',
        namespace: 'MyApp/Performance',
        operation: 'getUserById',
      })

      expect(metric.unit).toBe('Milliseconds')
      expect(metric.dimensions?.[0].value).toBe('getUserById')
    })

    it('should create error metric', () => {
      const metric = manager.createErrorMetric({
        name: 'ValidationErrors',
        namespace: 'MyApp/Errors',
        errorType: 'ValidationError',
      })

      expect(metric.unit).toBe('Count')
      expect(metric.dimensions?.[0].value).toBe('ValidationError')
    })
  })

  describe('Alarm Creation', () => {
    it('should create error rate alarm', () => {
      const metric = manager.createErrorMetric({
        name: 'Errors',
        namespace: 'MyApp',
        errorType: 'All',
      })

      const alarm = manager.createErrorRateAlarm({
        metricId: metric.id,
        name: 'HighErrorRate',
        threshold: 10,
        snsTopicArn: 'arn:aws:sns:us-east-1:123456789012:alerts',
      })

      expect(alarm.id).toContain('alarm')
      expect(alarm.name).toBe('HighErrorRate')
      expect(alarm.threshold).toBe(10)
      expect(alarm.comparisonOperator).toBe('GreaterThanThreshold')
      expect(alarm.statistic).toBe('Sum')
      expect(alarm.alarmActions).toContain('arn:aws:sns:us-east-1:123456789012:alerts')
    })

    it('should create latency alarm', () => {
      const metric = manager.createPerformanceMetric({
        name: 'ResponseTime',
        namespace: 'MyApp',
        operation: 'apiCall',
      })

      const alarm = manager.createLatencyAlarm({
        metricId: metric.id,
        name: 'HighLatency',
        thresholdMs: 1000,
      })

      expect(alarm.threshold).toBe(1000)
      expect(alarm.statistic).toBe('Average')
    })

    it('should create throughput alarm', () => {
      const metric = manager.createBusinessMetric({
        name: 'Requests',
        namespace: 'MyApp',
        unit: 'Count',
      })

      const alarm = manager.createThroughputAlarm({
        metricId: metric.id,
        name: 'LowThroughput',
        minimumThreshold: 100,
      })

      expect(alarm.comparisonOperator).toBe('LessThanThreshold')
      expect(alarm.threshold).toBe(100)
    })

    it('should throw error for non-existent metric', () => {
      expect(() => {
        manager.createAlarm('non-existent', {
          name: 'Test',
          comparisonOperator: 'GreaterThanThreshold',
          evaluationPeriods: 1,
          threshold: 10,
          period: 60,
          statistic: 'Average',
        })
      }).toThrow('Metric not found')
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate alarm CloudFormation', () => {
      const metric = manager.createBusinessMetric({
        name: 'Orders',
        namespace: 'MyApp',
        unit: 'Count',
      })

      const alarm = manager.createErrorRateAlarm({
        metricId: metric.id,
        name: 'HighOrders',
        threshold: 100,
      })

      const cf = manager.generateAlarmCF(metric, alarm)

      expect(cf.Type).toBe('AWS::CloudWatch::Alarm')
      expect(cf.Properties.AlarmName).toBe('HighOrders')
      expect(cf.Properties.MetricName).toBe('Orders')
      expect(cf.Properties.Namespace).toBe('MyApp')
      expect(cf.Properties.Threshold).toBe(100)
    })

    it('should generate composite alarm CloudFormation', () => {
      const alarm = manager.createCompositeAlarm({
        name: 'CriticalIssues',
        description: 'Multiple critical conditions',
        alarmRule: 'ALARM(HighErrors) OR ALARM(HighLatency)',
      })

      const cf = manager.generateCompositeAlarmCF(alarm)

      expect(cf.Type).toBe('AWS::CloudWatch::CompositeAlarm')
      expect(cf.Properties.AlarmRule).toContain('ALARM(HighErrors)')
    })

    it('should generate dashboard widget', () => {
      const metric = manager.createBusinessMetric({
        name: 'Revenue',
        namespace: 'MyApp/Business',
        unit: 'Count',
      })

      const widget = manager.generateDashboardWidget(metric)

      expect(widget.type).toBe('metric')
      expect(widget.properties.metrics[0]).toContain('Revenue')
      expect(widget.properties.title).toBe('Revenue')
    })
  })

  it('should use global instance', () => {
    expect(metricsManager).toBeInstanceOf(MetricsManager)
  })
})

describe('Logs Manager', () => {
  let manager: LogsManager

  beforeEach(() => {
    manager = new LogsManager()
  })

  describe('Log Group Creation', () => {
    it('should create Lambda log group', () => {
      const group = manager.createLambdaLogGroup('my-function', 14)

      expect(group.id).toContain('log-group')
      expect(group.name).toBe('/aws/lambda/my-function')
      expect(group.retentionDays).toBe(14)
    })

    it('should use default retention for Lambda', () => {
      const group = manager.createLambdaLogGroup('my-function')

      expect(group.retentionDays).toBe(7)
    })

    it('should create ECS log group', () => {
      const group = manager.createECSLogGroup({
        clusterName: 'production',
        serviceName: 'web',
        retentionDays: 30,
      })

      expect(group.name).toBe('/ecs/production/web')
      expect(group.retentionDays).toBe(30)
    })

    it('should create API Gateway log group', () => {
      const group = manager.createAPIGatewayLogGroup('my-api', 'prod', 30)

      expect(group.name).toBe('/aws/apigateway/my-api/prod')
      expect(group.retentionDays).toBe(30)
    })

    it('should create application log group', () => {
      const group = manager.createApplicationLogGroup({
        appName: 'myapp',
        environment: 'production',
        retentionDays: 90,
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/12345',
      })

      expect(group.name).toBe('/application/myapp/production')
      expect(group.kmsKeyId).toBe('arn:aws:kms:us-east-1:123456789012:key/12345')
    })
  })

  describe('Metric Filters', () => {
    it('should create error count filter', () => {
      const group = manager.createLambdaLogGroup('my-function')
      const filter = manager.createErrorCountFilter(group.id, 'MyApp')

      expect(filter.id).toContain('filter')
      expect(filter.name).toBe('ErrorCount')
      expect(filter.filterPattern).toContain('ERROR')
      expect(filter.metricTransformations[0].metricName).toBe('ErrorCount')
      expect(filter.metricTransformations[0].metricNamespace).toBe('MyApp')
    })

    it('should create latency filter', () => {
      const group = manager.createLambdaLogGroup('my-function')
      const filter = manager.createLatencyFilter(group.id, 'MyApp')

      expect(filter.name).toBe('Latency')
      expect(filter.metricTransformations[0].metricName).toBe('ResponseTime')
      expect(filter.metricTransformations[0].unit).toBe('Milliseconds')
    })

    it('should create custom pattern filter', () => {
      const group = manager.createLambdaLogGroup('my-function')
      const filter = manager.createCustomPatternFilter({
        logGroupId: group.id,
        name: 'CustomMetric',
        pattern: '[time, request_id, event_type = CUSTOM, ...]',
        metricName: 'CustomEvents',
        namespace: 'MyApp',
      })

      expect(filter.name).toBe('CustomMetric')
      expect(filter.filterPattern).toContain('CUSTOM')
    })

    it('should throw error for non-existent log group', () => {
      expect(() => {
        manager.createMetricFilter('non-existent', {
          name: 'Test',
          filterPattern: 'ERROR',
          metricTransformations: [],
        })
      }).toThrow('Log group not found')
    })
  })

  describe('Subscription Filters', () => {
    it('should create Kinesis subscription', () => {
      const group = manager.createLambdaLogGroup('my-function')
      const subscription = manager.createKinesisSubscription({
        logGroupId: group.id,
        kinesisStreamArn: 'arn:aws:kinesis:us-east-1:123456789012:stream/logs',
        roleArn: 'arn:aws:iam::123456789012:role/LogsToKinesis',
        filterPattern: '[level = ERROR, ...]',
      })

      expect(subscription.id).toContain('subscription')
      expect(subscription.name).toBe('KinesisSubscription')
      expect(subscription.destinationArn).toContain('kinesis')
      expect(subscription.filterPattern).toBe('[level = ERROR, ...]')
      expect(subscription.distribution).toBe('Random')
    })

    it('should create Lambda subscription', () => {
      const group = manager.createLambdaLogGroup('my-function')
      const subscription = manager.createLambdaSubscription({
        logGroupId: group.id,
        lambdaFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:process-logs',
      })

      expect(subscription.name).toBe('LambdaSubscription')
      expect(subscription.destinationArn).toContain('lambda')
      expect(subscription.distribution).toBe('ByLogStream')
    })
  })

  describe('Log Insights Queries', () => {
    it('should create error analysis query', () => {
      const query = manager.createErrorAnalysisQuery(['/aws/lambda/my-function'])

      expect(query.id).toContain('query')
      expect(query.name).toBe('Error Analysis')
      expect(query.query).toContain('ERROR')
      expect(query.query).toContain('stats count()')
    })

    it('should create latency analysis query', () => {
      const query = manager.createLatencyAnalysisQuery(['/aws/lambda/my-function'])

      expect(query.name).toBe('Latency Analysis')
      expect(query.query).toContain('@duration')
      expect(query.query).toContain('avg(@duration)')
    })

    it('should create top errors query', () => {
      const query = manager.createTopErrorsQuery(['/aws/lambda/my-function'])

      expect(query.name).toBe('Top Errors')
      expect(query.query).toContain('limit 20')
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate log group CloudFormation', () => {
      const group = manager.createLambdaLogGroup('my-function', 30)
      const cf = manager.generateLogGroupCF(group)

      expect(cf.Type).toBe('AWS::Logs::LogGroup')
      expect(cf.Properties.LogGroupName).toBe('/aws/lambda/my-function')
      expect(cf.Properties.RetentionInDays).toBe(30)
    })

    it('should generate metric filter CloudFormation', () => {
      const group = manager.createLambdaLogGroup('my-function')
      const filter = manager.createErrorCountFilter(group.id, 'MyApp')
      const cf = manager.generateMetricFilterCF(group, filter)

      expect(cf.Type).toBe('AWS::Logs::MetricFilter')
      expect(cf.Properties.FilterName).toBe('ErrorCount')
      expect(cf.Properties.LogGroupName).toBe('/aws/lambda/my-function')
    })

    it('should generate subscription filter CloudFormation', () => {
      const group = manager.createLambdaLogGroup('my-function')
      const subscription = manager.createKinesisSubscription({
        logGroupId: group.id,
        kinesisStreamArn: 'arn:aws:kinesis:us-east-1:123456789012:stream/logs',
        roleArn: 'arn:aws:iam::123456789012:role/LogsToKinesis',
      })
      const cf = manager.generateSubscriptionFilterCF(subscription)

      expect(cf.Type).toBe('AWS::Logs::SubscriptionFilter')
      expect(cf.Properties.DestinationArn).toContain('kinesis')
    })

    it('should generate query definition CloudFormation', () => {
      const query = manager.createErrorAnalysisQuery(['/aws/lambda/my-function'])
      const cf = manager.generateQueryDefinitionCF(query)

      expect(cf.Type).toBe('AWS::Logs::QueryDefinition')
      expect(cf.Properties.Name).toBe('Error Analysis')
    })
  })

  it('should use global instance', () => {
    expect(logsManager).toBeInstanceOf(LogsManager)
  })
})

describe('Synthetics Manager', () => {
  let manager: SyntheticsManager

  beforeEach(() => {
    manager = new SyntheticsManager()
  })

  describe('Runtime Versions', () => {
    it('should have latest runtime versions', () => {
      expect(SyntheticsManager.RuntimeVersions.NODEJS_PUPPETEER_4_0).toBe('syn-nodejs-puppeteer-4.0')
      expect(SyntheticsManager.RuntimeVersions.PYTHON_SELENIUM_1_3).toBe('syn-python-selenium-1.3')
    })
  })

  describe('Canary Creation', () => {
    it('should create heartbeat canary', () => {
      const canary = manager.createHeartbeatCanary({
        name: 'website-heartbeat',
        url: 'https://example.com',
        interval: 5,
        s3Bucket: 'canary-artifacts',
      })

      expect(canary.id).toContain('canary')
      expect(canary.name).toBe('website-heartbeat')
      expect(canary.description).toContain('https://example.com')
      expect(canary.schedule.expression).toBe('rate(5 minutes)')
      expect(canary.code.type).toBe('script')
      expect(canary.code.script).toContain('heartbeat')
      expect(canary.artifactS3Location).toContain('s3://canary-artifacts')
    })

    it('should create API monitoring canary', () => {
      const canary = manager.createAPICanary({
        name: 'api-monitor',
        baseUrl: 'https://api.example.com',
        endpoints: [
          { path: '/health', method: 'GET', expectedStatus: 200 },
          { path: '/users', method: 'GET', expectedStatus: 200 },
        ],
        interval: 10,
        s3Bucket: 'canary-artifacts',
      })

      expect(canary.name).toBe('api-monitor')
      expect(canary.code.script).toContain('/health')
      expect(canary.code.script).toContain('/users')
      expect(canary.runConfig?.timeoutInSeconds).toBe(120)
    })

    it('should create visual regression canary', () => {
      const canary = manager.createVisualRegressionCanary({
        name: 'homepage-visual',
        url: 'https://example.com',
        screenshotName: 'homepage',
        interval: 60,
        s3Bucket: 'canary-artifacts',
      })

      expect(canary.name).toBe('homepage-visual')
      expect(canary.code.script).toContain('screenshot')
      expect(canary.code.script).toContain('homepage.png')
      expect(canary.runConfig?.memoryInMB).toBe(1024)
    })

    it('should create workflow canary', () => {
      const canary = manager.createWorkflowCanary({
        name: 'user-login-flow',
        description: 'Test user login workflow',
        steps: [
          {
            description: 'Navigate to login page',
            url: 'https://example.com/login',
          },
          {
            description: 'Submit login form',
            url: 'https://example.com/login',
            actions: [
              { type: 'type', selector: '#username', value: 'testuser' },
              { type: 'type', selector: '#password', value: 'testpass' },
              { type: 'click', selector: '#submit' },
            ],
          },
        ],
        interval: 15,
        s3Bucket: 'canary-artifacts',
      })

      expect(canary.name).toBe('user-login-flow')
      expect(canary.code.script).toContain('Navigate to login page')
      expect(canary.code.script).toContain('page.type')
      expect(canary.code.script).toContain('page.click')
      expect(canary.runConfig?.timeoutInSeconds).toBe(180)
    })
  })

  describe('Alarm Creation', () => {
    it('should create canary alarm', () => {
      const canary = manager.createHeartbeatCanary({
        name: 'test',
        url: 'https://example.com',
        interval: 5,
        s3Bucket: 'bucket',
      })

      const alarm = manager.createAlarm(canary.id, {
        name: 'CanaryFailure',
        metric: 'SuccessPercent',
        threshold: 90,
        evaluationPeriods: 2,
        snsTopicArn: 'arn:aws:sns:us-east-1:123456789012:alerts',
      })

      expect(alarm.id).toContain('alarm')
      expect(alarm.name).toBe('CanaryFailure')
      expect(alarm.metric).toBe('SuccessPercent')
      expect(canary.alarms).toHaveLength(1)
    })

    it('should throw error for non-existent canary', () => {
      expect(() => {
        manager.createAlarm('non-existent', {
          name: 'Test',
          metric: 'SuccessPercent',
          threshold: 90,
          evaluationPeriods: 2,
        })
      }).toThrow('Canary not found')
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate canary CloudFormation with script', () => {
      const canary = manager.createHeartbeatCanary({
        name: 'test',
        url: 'https://example.com',
        interval: 5,
        s3Bucket: 'bucket',
      })

      const cf = manager.generateCanaryCF(canary)

      expect(cf.Type).toBe('AWS::Synthetics::Canary')
      expect(cf.Properties.Name).toBe('test')
      expect(cf.Properties.Code.Handler).toBe('index.handler')
      expect(cf.Properties.Code.Script).toBeDefined()
      expect(cf.Properties.Schedule.Expression).toBe('rate(5 minutes)')
      expect(cf.Properties.StartCanaryAfterCreation).toBe(true)
    })

    it('should generate canary execution role CloudFormation', () => {
      const cf = manager.generateCanaryRoleCF()

      expect(cf.Type).toBe('AWS::IAM::Role')
      expect(cf.Properties.ManagedPolicyArns).toContain(
        'arn:aws:iam::aws:policy/CloudWatchSyntheticsFullAccess'
      )
      expect(cf.Properties.Policies[0].PolicyName).toBe('CanaryS3Policy')
    })
  })

  describe('Data Management', () => {
    it('should retrieve canary by id', () => {
      const canary = manager.createHeartbeatCanary({
        name: 'test',
        url: 'https://example.com',
        interval: 5,
        s3Bucket: 'bucket',
      })

      const retrieved = manager.getCanary(canary.id)

      expect(retrieved).toEqual(canary)
    })

    it('should list all canaries', () => {
      manager.createHeartbeatCanary({
        name: 'test1',
        url: 'https://example.com',
        interval: 5,
        s3Bucket: 'bucket',
      })
      manager.createAPICanary({
        name: 'test2',
        baseUrl: 'https://api.example.com',
        endpoints: [{ path: '/health', method: 'GET', expectedStatus: 200 }],
        interval: 10,
        s3Bucket: 'bucket',
      })

      const canaries = manager.listCanaries()

      expect(canaries).toHaveLength(2)
    })

    it('should clear all data', () => {
      manager.createHeartbeatCanary({
        name: 'test',
        url: 'https://example.com',
        interval: 5,
        s3Bucket: 'bucket',
      })

      manager.clear()

      expect(manager.listCanaries()).toHaveLength(0)
    })
  })

  it('should use global instance', () => {
    expect(syntheticsManager).toBeInstanceOf(SyntheticsManager)
  })
})
