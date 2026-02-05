/**
 * A/B Testing for SMS Content
 *
 * Provides A/B testing capabilities for SMS campaigns
*/

export interface AbTest {
  id: string
  name: string
  status: 'draft' | 'running' | 'completed' | 'cancelled'
  variants: AbVariant[]
  trafficSplit: number[] // Percentage for each variant
  winningCriteria: 'delivery_rate' | 'click_rate' | 'reply_rate' | 'conversion_rate'
  sampleSize: number
  currentSample: number
  winner?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
}

export interface AbVariant {
  id: string
  name: string
  message: string
  stats: VariantStats
}

export interface VariantStats {
  sent: number
  delivered: number
  clicked: number
  replied: number
  converted: number
  deliveryRate: number
  clickRate: number
  replyRate: number
  conversionRate: number
}

/**
 * A/B Testing Module
*/
export class AbTesting {
  /**
   * Lambda code for A/B test management
  */
  static AbTestManagerCode = `
const { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');

const dynamodb = new DynamoDBClient({});
const AB_TESTS_TABLE = process.env.AB_TESTS_TABLE;

exports.handler = async (event) => {
  console.log('A/B test manager event:', JSON.stringify(event, null, 2));

  const { httpMethod, body, pathParameters } = event;
  const testId = pathParameters?.id;

  try {
    switch (httpMethod) {
      case 'POST':
        return await createTest(JSON.parse(body || '{}'));
      case 'GET':
        if (testId) {
          return await getTest(testId);
        }
        return await listTests();
      case 'PUT':
        return await updateTest(testId, JSON.parse(body || '{}'));
      case 'DELETE':
        return await cancelTest(testId);
      default:
        return { statusCode: 405, body: 'Method not allowed' };
    }
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

async function createTest(data) {
  const id = 'ab-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  const now = new Date().toISOString();

  const variants = (data.variants || []).map((v, i) => ({
    id: 'var-' + i,
    name: v.name || 'Variant ' + String.fromCharCode(65 + i),
    message: v.message,
    stats: { sent: 0, delivered: 0, clicked: 0, replied: 0, converted: 0 },
  }));

  const trafficSplit = data.trafficSplit || variants.map(() => 100 / variants.length);

  const test = {
    id: { S: id },
    name: { S: data.name },
    status: { S: 'draft' },
    variants: { S: JSON.stringify(variants) },
    trafficSplit: { S: JSON.stringify(trafficSplit) },
    winningCriteria: { S: data.winningCriteria || 'delivery_rate' },
    sampleSize: { N: String(data.sampleSize || 1000) },
    currentSample: { N: '0' },
    createdAt: { S: now },
  };

  await dynamodb.send(new PutItemCommand({
    TableName: AB_TESTS_TABLE,
    Item: test,
  }));

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, status: 'draft', variants, createdAt: now }),
  };
}

async function getTest(id) {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: AB_TESTS_TABLE,
    Key: { id: { S: id } },
  }));

  if (!result.Item) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Test not found' }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(unmarshallTest(result.Item)),
  };
}

async function listTests() {
  const result = await dynamodb.send(new ScanCommand({
    TableName: AB_TESTS_TABLE,
  }));

  const tests = (result.Items || []).map(unmarshallTest);
  tests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tests),
  };
}

async function updateTest(id, data) {
  const now = new Date().toISOString();
  const updates = [];
  const values = {};

  if (data.status) {
    updates.push('#status = :status');
    values[':status'] = { S: data.status };
    if (data.status === 'running') {
      updates.push('startedAt = :startedAt');
      values[':startedAt'] = { S: now };
    }
    if (data.status === 'completed') {
      updates.push('completedAt = :completedAt');
      values[':completedAt'] = { S: now };
    }
  }

  if (data.variants) {
    updates.push('variants = :variants');
    values[':variants'] = { S: JSON.stringify(data.variants) };
  }

  if (data.winner) {
    updates.push('winner = :winner');
    values[':winner'] = { S: data.winner };
  }

  if (data.currentSample !== undefined) {
    updates.push('currentSample = :sample');
    values[':sample'] = { N: String(data.currentSample) };
  }

  await dynamodb.send(new UpdateItemCommand({
    TableName: AB_TESTS_TABLE,
    Key: { id: { S: id } },
    UpdateExpression: 'SET ' + updates.join(', '),
    ExpressionAttributeNames: data.status ? { '#status': 'status' } : undefined,
    ExpressionAttributeValues: values,
  }));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, updated: true }),
  };
}

async function cancelTest(id) {
  await dynamodb.send(new UpdateItemCommand({
    TableName: AB_TESTS_TABLE,
    Key: { id: { S: id } },
    UpdateExpression: 'SET #status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': { S: 'cancelled' } },
  }));

  return { statusCode: 200, body: JSON.stringify({ id, status: 'cancelled' }) };
}

function unmarshallTest(item) {
  const test = {
    id: item.id.S,
    name: item.name.S,
    status: item.status.S,
    variants: JSON.parse(item.variants?.S || '[]'),
    trafficSplit: JSON.parse(item.trafficSplit?.S || '[]'),
    winningCriteria: item.winningCriteria?.S || 'delivery_rate',
    sampleSize: parseInt(item.sampleSize?.N || '1000'),
    currentSample: parseInt(item.currentSample?.N || '0'),
    winner: item.winner?.S,
    createdAt: item.createdAt.S,
    startedAt: item.startedAt?.S,
    completedAt: item.completedAt?.S,
  };

  // Calculate rates for each variant
  test.variants = test.variants.map(v => ({
    ...v,
    stats: {
      ...v.stats,
      deliveryRate: v.stats.sent > 0 ? (v.stats.delivered / v.stats.sent) * 100 : 0,
      clickRate: v.stats.delivered > 0 ? (v.stats.clicked / v.stats.delivered) * 100 : 0,
      replyRate: v.stats.delivered > 0 ? (v.stats.replied / v.stats.delivered) * 100 : 0,
      conversionRate: v.stats.delivered > 0 ? (v.stats.converted / v.stats.delivered) * 100 : 0,
    },
  }));

  return test;
}
`

  /**
   * Create A/B tests DynamoDB table
  */
  static createAbTestsTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}AbTestsTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-ab-tests`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'id', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'id', KeyType: 'HASH' },
          ],
        },
      },
    }
  }

  /**
   * Create A/B test manager Lambda
  */
  static createAbTestManagerLambda(config: {
    slug: string
    roleArn: string
    abTestsTable: string
  }): Record<string, any> {
    return {
      [`${config.slug}AbTestManagerLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-ab-test-manager`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 30,
          MemorySize: 256,
          Code: {
            ZipFile: AbTesting.AbTestManagerCode,
          },
          Environment: {
            Variables: {
              AB_TESTS_TABLE: config.abTestsTable,
            },
          },
        },
      },
    }
  }

  /**
   * Select variant for a recipient
  */
  static selectVariant(test: AbTest, recipientId: string): AbVariant {
    // Use consistent hashing for deterministic variant selection
    const hash = AbTesting.hashString(recipientId + test.id)
    const percentage = hash % 100

    let cumulative = 0
    for (let i = 0; i < test.variants.length; i++) {
      cumulative += test.trafficSplit[i]
      if (percentage < cumulative) {
        return test.variants[i]
      }
    }

    return test.variants[test.variants.length - 1]
  }

  /**
   * Determine winner based on criteria
  */
  static determineWinner(test: AbTest): AbVariant | null {
    if (test.variants.length === 0) return null

    const criteria = test.winningCriteria
    let bestVariant = test.variants[0]
    let bestValue = AbTesting.getMetricValue(bestVariant, criteria)

    for (const variant of test.variants.slice(1)) {
      const value = AbTesting.getMetricValue(variant, criteria)
      if (value > bestValue) {
        bestValue = value
        bestVariant = variant
      }
    }

    return bestVariant
  }

  /**
   * Calculate statistical significance
  */
  static calculateSignificance(variantA: AbVariant, variantB: AbVariant, criteria: string): number {
    const nA = variantA.stats.sent
    const nB = variantB.stats.sent

    if (nA < 30 || nB < 30) return 0 // Not enough samples

    const pA = AbTesting.getMetricValue(variantA, criteria) / 100
    const pB = AbTesting.getMetricValue(variantB, criteria) / 100

    const pooledP = (pA * nA + pB * nB) / (nA + nB)
    const se = Math.sqrt(pooledP * (1 - pooledP) * (1 / nA + 1 / nB))

    if (se === 0) return 0

    const z = Math.abs(pA - pB) / se

    // Convert z-score to confidence level (simplified)
    if (z >= 2.576) return 99
    if (z >= 1.96) return 95
    if (z >= 1.645) return 90
    if (z >= 1.28) return 80

    return Math.round(z * 30) // Rough approximation
  }

  private static getMetricValue(variant: AbVariant, criteria: string): number {
    switch (criteria) {
      case 'delivery_rate':
        return variant.stats.deliveryRate
      case 'click_rate':
        return variant.stats.clickRate
      case 'reply_rate':
        return variant.stats.replyRate
      case 'conversion_rate':
        return variant.stats.conversionRate
      default:
        return variant.stats.deliveryRate
    }
  }

  private static hashString(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash)
  }
}

export default AbTesting
