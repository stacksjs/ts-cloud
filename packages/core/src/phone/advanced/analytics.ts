/**
 * Call Analytics and Reporting
 *
 * Provides call metrics, reporting, and insights
 */

export interface CallMetrics {
  period: string
  totalCalls: number
  answeredCalls: number
  missedCalls: number
  abandonedCalls: number
  voicemails: number
  averageWaitTime: number
  averageHandleTime: number
  averageTalkTime: number
  serviceLevel: number
  abandonRate: number
  answerRate: number
}

export interface AgentMetrics {
  agentId: string
  agentName: string
  callsHandled: number
  averageHandleTime: number
  averageTalkTime: number
  averageHoldTime: number
  occupancy: number
  availability: number
}

export interface QueueMetrics {
  queueId: string
  queueName: string
  callsInQueue: number
  oldestCallWaitTime: number
  averageWaitTime: number
  agentsAvailable: number
  agentsOnCall: number
}

export interface CallInsight {
  callId: string
  sentiment: 'positive' | 'neutral' | 'negative'
  topics: string[]
  keywords: string[]
  issues: string[]
  resolution: boolean
  customerSatisfaction?: number
}

/**
 * Call Analytics Module
 */
export class CallAnalytics {
  /**
   * Lambda code for aggregating call metrics
   */
  static MetricsAggregatorCode = `
const { DynamoDBClient, QueryCommand, PutItemCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');

const dynamodb = new DynamoDBClient({});
const CALL_LOG_TABLE = process.env.CALL_LOG_TABLE;
const METRICS_TABLE = process.env.METRICS_TABLE;

exports.handler = async (event) => {
  console.log('Metrics aggregator event:', JSON.stringify(event, null, 2));

  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  try {
    // Get calls from the last hour
    const hourlyResult = await dynamodb.send(new ScanCommand({
      TableName: CALL_LOG_TABLE,
      FilterExpression: 'startTime >= :hourAgo',
      ExpressionAttributeValues: {
        ':hourAgo': { S: hourAgo.toISOString() },
      },
    }));

    const hourlyCalls = hourlyResult.Items || [];
    const hourlyMetrics = calculateMetrics(hourlyCalls, 'hourly');

    // Save hourly metrics
    await dynamodb.send(new PutItemCommand({
      TableName: METRICS_TABLE,
      Item: {
        period: { S: \`hourly-\${now.toISOString().slice(0, 13)}\` },
        type: { S: 'hourly' },
        timestamp: { S: now.toISOString() },
        metrics: { S: JSON.stringify(hourlyMetrics) },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60) },
      },
    }));

    // Get calls from the last day for daily metrics
    const dailyResult = await dynamodb.send(new ScanCommand({
      TableName: CALL_LOG_TABLE,
      FilterExpression: 'startTime >= :dayAgo',
      ExpressionAttributeValues: {
        ':dayAgo': { S: dayAgo.toISOString() },
      },
    }));

    const dailyCalls = dailyResult.Items || [];
    const dailyMetrics = calculateMetrics(dailyCalls, 'daily');

    // Save daily metrics
    await dynamodb.send(new PutItemCommand({
      TableName: METRICS_TABLE,
      Item: {
        period: { S: \`daily-\${now.toISOString().slice(0, 10)}\` },
        type: { S: 'daily' },
        timestamp: { S: now.toISOString() },
        metrics: { S: JSON.stringify(dailyMetrics) },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60) },
      },
    }));

    console.log('Metrics aggregated successfully');
    return { statusCode: 200 };
  } catch (error) {
    console.error('Error aggregating metrics:', error);
    return { statusCode: 500, error: error.message };
  }
};

function calculateMetrics(calls, period) {
  const totalCalls = calls.length;
  const answeredCalls = calls.filter(c => c.status?.S === 'answered').length;
  const missedCalls = calls.filter(c => c.status?.S === 'missed').length;
  const abandonedCalls = calls.filter(c => c.status?.S === 'abandoned').length;
  const voicemails = calls.filter(c => c.hasVoicemail?.BOOL).length;

  const waitTimes = calls
    .filter(c => c.waitTime?.N)
    .map(c => parseFloat(c.waitTime.N));
  const handleTimes = calls
    .filter(c => c.handleTime?.N)
    .map(c => parseFloat(c.handleTime.N));
  const talkTimes = calls
    .filter(c => c.talkTime?.N)
    .map(c => parseFloat(c.talkTime.N));

  const averageWaitTime = waitTimes.length > 0
    ? waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length
    : 0;
  const averageHandleTime = handleTimes.length > 0
    ? handleTimes.reduce((a, b) => a + b, 0) / handleTimes.length
    : 0;
  const averageTalkTime = talkTimes.length > 0
    ? talkTimes.reduce((a, b) => a + b, 0) / talkTimes.length
    : 0;

  // Service level: % of calls answered within 20 seconds
  const answeredWithin20s = calls.filter(c =>
    c.status?.S === 'answered' && parseFloat(c.waitTime?.N || 999) <= 20
  ).length;
  const serviceLevel = totalCalls > 0 ? (answeredWithin20s / totalCalls) * 100 : 100;

  return {
    period,
    totalCalls,
    answeredCalls,
    missedCalls,
    abandonedCalls,
    voicemails,
    averageWaitTime: Math.round(averageWaitTime),
    averageHandleTime: Math.round(averageHandleTime),
    averageTalkTime: Math.round(averageTalkTime),
    serviceLevel: Math.round(serviceLevel * 10) / 10,
    abandonRate: totalCalls > 0 ? Math.round((abandonedCalls / totalCalls) * 1000) / 10 : 0,
    answerRate: totalCalls > 0 ? Math.round((answeredCalls / totalCalls) * 1000) / 10 : 0,
  };
}
`

  /**
   * Lambda code for real-time queue metrics
   */
  static QueueMetricsCode = `
const { ConnectClient, GetCurrentMetricDataCommand, ListQueuesCommand } = require('@aws-sdk/client-connect');

const connect = new ConnectClient({});
const INSTANCE_ID = process.env.CONNECT_INSTANCE_ID;

exports.handler = async (event) => {
  console.log('Queue metrics request:', JSON.stringify(event, null, 2));

  try {
    // List queues
    const queuesResult = await connect.send(new ListQueuesCommand({
      InstanceId: INSTANCE_ID,
      QueueTypes: ['STANDARD'],
    }));

    const queues = queuesResult.QueueSummaryList || [];
    const metrics = [];

    for (const queue of queues) {
      // Get current metrics for queue
      const metricsResult = await connect.send(new GetCurrentMetricDataCommand({
        InstanceId: INSTANCE_ID,
        Filters: {
          Queues: [queue.Id],
          Channels: ['VOICE'],
        },
        CurrentMetrics: [
          { Name: 'AGENTS_AVAILABLE', Unit: 'COUNT' },
          { Name: 'AGENTS_ON_CALL', Unit: 'COUNT' },
          { Name: 'CONTACTS_IN_QUEUE', Unit: 'COUNT' },
          { Name: 'OLDEST_CONTACT_AGE', Unit: 'SECONDS' },
        ],
      }));

      const metricData = metricsResult.MetricResults?.[0]?.Collections || [];
      const queueMetrics = {
        queueId: queue.Id,
        queueName: queue.Name,
        callsInQueue: 0,
        oldestCallWaitTime: 0,
        agentsAvailable: 0,
        agentsOnCall: 0,
      };

      for (const metric of metricData) {
        switch (metric.Metric?.Name) {
          case 'CONTACTS_IN_QUEUE':
            queueMetrics.callsInQueue = metric.Value || 0;
            break;
          case 'OLDEST_CONTACT_AGE':
            queueMetrics.oldestCallWaitTime = metric.Value || 0;
            break;
          case 'AGENTS_AVAILABLE':
            queueMetrics.agentsAvailable = metric.Value || 0;
            break;
          case 'AGENTS_ON_CALL':
            queueMetrics.agentsOnCall = metric.Value || 0;
            break;
        }
      }

      metrics.push(queueMetrics);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metrics),
    };
  } catch (error) {
    console.error('Error getting queue metrics:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
`

  /**
   * Create metrics DynamoDB table
   */
  static createMetricsTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}CallMetricsTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-call-metrics`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'period', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'period', KeyType: 'HASH' },
          ],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
        },
      },
    }
  }

  /**
   * Create metrics aggregator Lambda
   */
  static createMetricsAggregatorLambda(config: {
    slug: string
    roleArn: string
    callLogTable: string
    metricsTable: string
  }): Record<string, any> {
    return {
      [`${config.slug}CallMetricsAggregatorLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-call-metrics-aggregator`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 60,
          MemorySize: 256,
          Code: {
            ZipFile: CallAnalytics.MetricsAggregatorCode,
          },
          Environment: {
            Variables: {
              CALL_LOG_TABLE: config.callLogTable,
              METRICS_TABLE: config.metricsTable,
            },
          },
        },
      },
    }
  }

  /**
   * Create EventBridge rule for hourly metrics
   */
  static createMetricsSchedule(config: {
    slug: string
    lambdaArn: string
  }): Record<string, any> {
    return {
      [`${config.slug}CallMetricsSchedule`]: {
        Type: 'AWS::Events::Rule',
        Properties: {
          Name: `${config.slug}-call-metrics-schedule`,
          Description: 'Aggregate call metrics hourly',
          ScheduleExpression: 'rate(1 hour)',
          State: 'ENABLED',
          Targets: [
            {
              Id: 'MetricsAggregatorTarget',
              Arn: config.lambdaArn,
            },
          ],
        },
      },
    }
  }
}

export default CallAnalytics
