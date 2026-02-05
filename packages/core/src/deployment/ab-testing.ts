/**
 * A/B Testing Infrastructure
 * Traffic splitting based on user attributes, headers, or cookies
*/

export interface ABTest {
  id: string
  name: string
  description?: string
  variants: ABVariant[]
  routingStrategy: RoutingStrategy
  startTime: Date
  endTime?: Date
  status: 'draft' | 'active' | 'paused' | 'completed'
  metrics?: ABMetrics
  winner?: string
}

export interface ABVariant {
  id: string
  name: string
  description?: string
  trafficPercentage: number
  targetGroupArn?: string
  functionVersionArn?: string
  originId?: string // For CloudFront
  weight: number
}

export interface RoutingStrategy {
  type: 'random' | 'cookie' | 'header' | 'geo' | 'device' | 'user-attribute'
  cookieName?: string
  headerName?: string
  attributeName?: string
  stickySession?: boolean
  sessionDuration?: number // minutes
}

export interface ABMetrics {
  variants: Record<string, VariantMetrics>
  totalRequests: number
  startTime: Date
  lastUpdated: Date
}

export interface VariantMetrics {
  requests: number
  conversions: number
  conversionRate: number
  averageLatency: number
  errorRate: number
  revenue?: number
  customMetrics?: Record<string, number>
}

export interface ABTestResult {
  testId: string
  winningVariant: string
  confidence: number // 0-100%
  improvement: number // Percentage improvement over control
  statisticalSignificance: boolean
  metrics: ABMetrics
  recommendation: string
}

/**
 * A/B testing manager
*/
export class ABTestManager {
  private tests: Map<string, ABTest> = new Map()
  private testCounter = 0

  /**
   * Create A/B test
  */
  createTest(test: Omit<ABTest, 'id'>): ABTest {
    const id = `abtest-${Date.now()}-${this.testCounter++}`

    const abTest: ABTest = {
      id,
      ...test,
    }

    this.tests.set(id, abTest)

    return abTest
  }

  /**
   * Create simple A/B test (control vs variant)
  */
  createSimpleABTest(options: {
    name: string
    description?: string
    controlTargetGroupArn: string
    variantTargetGroupArn: string
    variantTrafficPercentage?: number
    stickySession?: boolean
  }): ABTest {
    const variantPercentage = options.variantTrafficPercentage || 50

    return this.createTest({
      name: options.name,
      description: options.description,
      variants: [
        {
          id: 'control',
          name: 'Control',
          description: 'Original version',
          trafficPercentage: 100 - variantPercentage,
          targetGroupArn: options.controlTargetGroupArn,
          weight: 100 - variantPercentage,
        },
        {
          id: 'variant-a',
          name: 'Variant A',
          description: 'Test version',
          trafficPercentage: variantPercentage,
          targetGroupArn: options.variantTargetGroupArn,
          weight: variantPercentage,
        },
      ],
      routingStrategy: {
        type: options.stickySession ? 'cookie' : 'random',
        cookieName: options.stickySession ? 'ab_variant' : undefined,
        stickySession: options.stickySession ?? false,
        sessionDuration: 1440, // 24 hours
      },
      startTime: new Date(),
      status: 'draft',
    })
  }

  /**
   * Create multivariate test
  */
  createMultivariateTest(options: {
    name: string
    description?: string
    variants: Array<{
      name: string
      description?: string
      targetGroupArn: string
      trafficPercentage: number
    }>
    routingStrategy?: RoutingStrategy
  }): ABTest {
    // Validate percentages sum to 100
    const totalPercentage = options.variants.reduce((sum, v) => sum + v.trafficPercentage, 0)
    if (totalPercentage !== 100) {
      throw new Error(`Traffic percentages must sum to 100, got ${totalPercentage}`)
    }

    return this.createTest({
      name: options.name,
      description: options.description,
      variants: options.variants.map((v, index) => ({
        id: `variant-${index}`,
        name: v.name,
        description: v.description,
        trafficPercentage: v.trafficPercentage,
        targetGroupArn: v.targetGroupArn,
        weight: v.trafficPercentage,
      })),
      routingStrategy: options.routingStrategy || {
        type: 'random',
        stickySession: false,
      },
      startTime: new Date(),
      status: 'draft',
    })
  }

  /**
   * Create header-based A/B test
  */
  createHeaderBasedTest(options: {
    name: string
    controlTargetGroupArn: string
    variantTargetGroupArn: string
    headerName: string
    headerValue: string
  }): ABTest {
    return this.createTest({
      name: options.name,
      description: `Route based on ${options.headerName} header`,
      variants: [
        {
          id: 'control',
          name: 'Control',
          trafficPercentage: 50,
          targetGroupArn: options.controlTargetGroupArn,
          weight: 50,
        },
        {
          id: 'variant-a',
          name: 'Variant A',
          trafficPercentage: 50,
          targetGroupArn: options.variantTargetGroupArn,
          weight: 50,
        },
      ],
      routingStrategy: {
        type: 'header',
        headerName: options.headerName,
        stickySession: false,
      },
      startTime: new Date(),
      status: 'draft',
    })
  }

  /**
   * Create geo-based A/B test
  */
  createGeoBasedTest(options: {
    name: string
    controlTargetGroupArn: string
    variantTargetGroupArn: string
    regions: string[] // For variant (e.g., ['US', 'CA'])
  }): ABTest {
    return this.createTest({
      name: options.name,
      description: `Route based on geographic location`,
      variants: [
        {
          id: 'control',
          name: 'Control (Rest of World)',
          trafficPercentage: 50,
          targetGroupArn: options.controlTargetGroupArn,
          weight: 50,
        },
        {
          id: 'variant-a',
          name: `Variant A (${options.regions.join(', ')})`,
          trafficPercentage: 50,
          targetGroupArn: options.variantTargetGroupArn,
          weight: 50,
        },
      ],
      routingStrategy: {
        type: 'geo',
        stickySession: true,
        sessionDuration: 1440,
      },
      startTime: new Date(),
      status: 'draft',
    })
  }

  /**
   * Start A/B test
  */
  startTest(testId: string): void {
    const test = this.tests.get(testId)

    if (!test) {
      throw new Error(`Test not found: ${testId}`)
    }

    if (test.status !== 'draft' && test.status !== 'paused') {
      throw new Error(`Cannot start test in ${test.status} status`)
    }

    test.status = 'active'
    test.startTime = new Date()

    console.log(`Started A/B test: ${test.name}`)
    console.log(`  Variants: ${test.variants.length}`)
    test.variants.forEach((v) => {
      console.log(`    - ${v.name}: ${v.trafficPercentage}%`)
    })
  }

  /**
   * Pause A/B test
  */
  pauseTest(testId: string): void {
    const test = this.tests.get(testId)

    if (!test) {
      throw new Error(`Test not found: ${testId}`)
    }

    test.status = 'paused'
    console.log(`Paused A/B test: ${test.name}`)
  }

  /**
   * Update traffic split
  */
  updateTrafficSplit(testId: string, variantId: string, newPercentage: number): void {
    const test = this.tests.get(testId)

    if (!test) {
      throw new Error(`Test not found: ${testId}`)
    }

    const variant = test.variants.find(v => v.id === variantId)

    if (!variant) {
      throw new Error(`Variant not found: ${variantId}`)
    }

    const oldPercentage = variant.trafficPercentage
    variant.trafficPercentage = newPercentage
    variant.weight = newPercentage

    console.log(`Updated ${variant.name} traffic: ${oldPercentage}% → ${newPercentage}%`)
  }

  /**
   * Analyze test results
  */
  analyzeResults(testId: string): ABTestResult {
    const test = this.tests.get(testId)

    if (!test) {
      throw new Error(`Test not found: ${testId}`)
    }

    if (!test.metrics) {
      // Simulate metrics collection
      test.metrics = this.collectMetrics(test)
    }

    // Find winning variant (highest conversion rate)
    let winningVariant = test.variants[0]
    let highestConversionRate = 0

    for (const variant of test.variants) {
      const metrics = test.metrics.variants[variant.id]
      if (metrics && metrics.conversionRate > highestConversionRate) {
        highestConversionRate = metrics.conversionRate
        winningVariant = variant
      }
    }

    const controlMetrics = test.metrics.variants['control'] || test.metrics.variants[test.variants[0].id]
    const winnerMetrics = test.metrics.variants[winningVariant.id]

    const improvement
      = ((winnerMetrics.conversionRate - controlMetrics.conversionRate) / controlMetrics.conversionRate) * 100

    // Simple statistical significance check (would use proper chi-square test in production)
    const minSampleSize = 100
    const statisticalSignificance
      = winnerMetrics.requests > minSampleSize && controlMetrics.requests > minSampleSize && Math.abs(improvement) > 10

    return {
      testId,
      winningVariant: winningVariant.name,
      confidence: statisticalSignificance ? 95 : 75,
      improvement,
      statisticalSignificance,
      metrics: test.metrics,
      recommendation: this.generateRecommendation(improvement, statisticalSignificance, winningVariant.name),
    }
  }

  /**
   * Declare winner and route all traffic
  */
  declareWinner(testId: string, variantId: string): void {
    const test = this.tests.get(testId)

    if (!test) {
      throw new Error(`Test not found: ${testId}`)
    }

    const winner = test.variants.find(v => v.id === variantId)

    if (!winner) {
      throw new Error(`Variant not found: ${variantId}`)
    }

    // Route all traffic to winner
    test.variants.forEach((v) => {
      if (v.id === variantId) {
        v.trafficPercentage = 100
        v.weight = 100
      }
      else {
        v.trafficPercentage = 0
        v.weight = 0
      }
    })

    test.status = 'completed'
    test.endTime = new Date()
    test.winner = variantId

    console.log(`Declared winner: ${winner.name}`)
    console.log(`  All traffic now routed to ${winner.name}`)
  }

  /**
   * Collect metrics for test
  */
  private collectMetrics(test: ABTest): ABMetrics {
    const variantMetrics: Record<string, VariantMetrics> = {}

    // Simulate metric collection
    let totalRequests = 0

    for (const variant of test.variants) {
      const requests = Math.floor(Math.random() * 1000) + 500
      const conversions = Math.floor(requests * (Math.random() * 0.1 + 0.05)) // 5-15% conversion
      const conversionRate = (conversions / requests) * 100

      variantMetrics[variant.id] = {
        requests,
        conversions,
        conversionRate,
        averageLatency: 150 + Math.random() * 100,
        errorRate: Math.random() * 0.5,
        revenue: conversions * (Math.random() * 50 + 100), // $100-150 per conversion
      }

      totalRequests += requests
    }

    return {
      variants: variantMetrics,
      totalRequests,
      startTime: test.startTime,
      lastUpdated: new Date(),
    }
  }

  /**
   * Generate recommendation
  */
  private generateRecommendation(
    improvement: number,
    significant: boolean,
    winnerName: string,
  ): string {
    if (!significant) {
      return 'Continue test - sample size too small or no significant difference detected'
    }

    if (improvement > 20) {
      return `Strong winner detected - ${winnerName} shows ${improvement.toFixed(1)}% improvement. Recommend deploying to all traffic.`
    }

    if (improvement > 10) {
      return `Moderate improvement - ${winnerName} shows ${improvement.toFixed(1)}% improvement. Consider deploying.`
    }

    if (improvement > 0) {
      return `Minor improvement - ${winnerName} shows ${improvement.toFixed(1)}% improvement. May not be worth the complexity.`
    }

    return `No improvement detected - consider reverting to control variant`
  }

  /**
   * Get test
  */
  getTest(id: string): ABTest | undefined {
    return this.tests.get(id)
  }

  /**
   * List tests
  */
  listTests(): ABTest[] {
    return Array.from(this.tests.values())
  }

  /**
   * Generate CloudFormation for ALB weighted routing
  */
  generateALBListenerRuleCF(test: ABTest): any {
    return {
      Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
      Properties: {
        ListenerArn: { Ref: 'LoadBalancerListener' },
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
            ForwardConfig: {
              TargetGroups: test.variants.map(variant => ({
                TargetGroupArn: variant.targetGroupArn,
                Weight: variant.weight,
              })),
              TargetGroupStickinessConfig: {
                Enabled: test.routingStrategy.stickySession || false,
                DurationSeconds: test.routingStrategy.sessionDuration
                  ? test.routingStrategy.sessionDuration * 60
                  : undefined,
              },
            },
          },
        ],
      },
    }
  }

  /**
   * Generate Lambda@Edge function for A/B testing
  */
  generateLambdaEdgeFunction(test: ABTest): string {
    return `'use strict';

exports.handler = (event, context, callback) => {
  const request = event.Records[0].cf.request;
  const headers = request.headers;

  // Check for existing variant cookie
  let variant = null;
  if (headers.cookie) {
    const cookies = headers.cookie[0].value.split(';');
    for (const cookie of cookies) {
      const [key, value] = cookie.trim().split('=');
      if (key === '${test.routingStrategy.cookieName || 'ab_variant'}') {
        variant = value;
        break;
      }
    }
  }

  // Assign variant if not already assigned
  if (!variant) {
    const random = Math.random() * 100;
    let cumulative = 0;

    ${test.variants
      .map((v, i) => {
        return `if (random < ${v.trafficPercentage + (i > 0 ? test.variants.slice(0, i).reduce((sum, v) => sum + v.trafficPercentage, 0) : 0)}) {
      variant = '${v.id}';
    }`
      })
      .join(' else ')}
  }

  // Set variant cookie
  const response = {
    status: '200',
    statusDescription: 'OK',
    headers: {
      'set-cookie': [{
        key: 'Set-Cookie',
        value: \`${test.routingStrategy.cookieName || 'ab_variant'}=\${variant}; Path=/; Max-Age=${(test.routingStrategy.sessionDuration || 1440) * 60}\`
      }]
    }
  };

  // Route to appropriate origin based on variant
  ${test.variants
    .map(
      v => `if (variant === '${v.id}') {
    request.origin.custom.domainName = '${v.originId}';
  }`,
    )
    .join(' else ')}

  callback(null, request);
};`
  }

  /**
   * Clear all data
  */
  clear(): void {
    this.tests.clear()
    this.testCounter = 0
  }
}

/**
 * Global A/B testing manager instance
*/
export const abTestManager: ABTestManager = new ABTestManager()
