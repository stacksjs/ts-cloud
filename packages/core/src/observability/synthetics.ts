/**
 * Synthetic Monitoring
 * CloudWatch Synthetics Canaries for proactive monitoring
*/

export interface SyntheticCanary {
  id: string
  name: string
  description?: string
  runtimeVersion: string
  handler: string
  code: CanaryCode
  schedule: CanarySchedule
  runConfig?: CanaryRunConfig
  vpcConfig?: VpcConfig
  artifactS3Location: string
  successRetentionPeriod?: number
  failureRetentionPeriod?: number
  alarms?: CanaryAlarm[]
}

export interface CanaryCode {
  type: 'script' | 's3'
  script?: string
  s3Bucket?: string
  s3Key?: string
  s3Version?: string
}

export interface CanarySchedule {
  expression: string // rate() or cron()
  durationInSeconds?: number
}

export interface CanaryRunConfig {
  timeoutInSeconds: number
  memoryInMB: number
  environmentVariables?: Record<string, string>
  activeTracing?: boolean
}

export interface VpcConfig {
  subnetIds: string[]
  securityGroupIds: string[]
}

export interface CanaryAlarm {
  id: string
  name: string
  metric: 'SuccessPercent' | 'Duration' | 'Failed'
  threshold: number
  evaluationPeriods: number
  snsTopicArn?: string
}

export interface HeartbeatMonitor {
  id: string
  name: string
  url: string
  interval: number // minutes
  timeout: number // seconds
  expectedStatus?: number
}

export interface ApiMonitor {
  id: string
  name: string
  baseUrl: string
  endpoints: ApiEndpoint[]
  headers?: Record<string, string>
  interval: number
}

export interface ApiEndpoint {
  path: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  expectedStatus: number
  body?: any
  assertions?: ApiAssertion[]
}

export interface ApiAssertion {
  type: 'status' | 'header' | 'body' | 'latency'
  field?: string
  operator: 'equals' | 'contains' | 'lessThan' | 'greaterThan'
  value: any
}

/**
 * Synthetics manager
*/
export class SyntheticsManager {
  private canaries: Map<string, SyntheticCanary> = new Map()
  private heartbeats: Map<string, HeartbeatMonitor> = new Map()
  private apiMonitors: Map<string, ApiMonitor> = new Map()
  private canaryCounter = 0
  private heartbeatCounter = 0
  private apiMonitorCounter = 0
  private alarmCounter = 0

  /**
   * Latest runtime versions
  */
  static readonly RuntimeVersions = {
    NODEJS_PUPPETEER_3_9: 'syn-nodejs-puppeteer-3.9',
    NODEJS_PUPPETEER_4_0: 'syn-nodejs-puppeteer-4.0',
    PYTHON_SELENIUM_1_3: 'syn-python-selenium-1.3',
  }

  /**
   * Create synthetic canary
  */
  createCanary(canary: Omit<SyntheticCanary, 'id'>): SyntheticCanary {
    const id = `canary-${Date.now()}-${this.canaryCounter++}`

    const syntheticCanary: SyntheticCanary = {
      id,
      ...canary,
    }

    this.canaries.set(id, syntheticCanary)

    return syntheticCanary
  }

  /**
   * Create heartbeat canary
  */
  createHeartbeatCanary(options: {
    name: string
    url: string
    interval: number // minutes
    s3Bucket: string
  }): SyntheticCanary {
    const script = `
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

const heartbeat = async function () {
  const url = '${options.url}';

  const page = await synthetics.getPage();
  const response = await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 30000});

  if (response.status() !== 200) {
    throw new Error(\`Failed with status \${response.status()}\`);
  }

  log.info('Heartbeat check passed');
};

exports.handler = async () => {
  return await heartbeat();
};
`

    return this.createCanary({
      name: options.name,
      description: `Heartbeat monitor for ${options.url}`,
      runtimeVersion: SyntheticsManager.RuntimeVersions.NODEJS_PUPPETEER_4_0,
      handler: 'index.handler',
      code: {
        type: 'script',
        script,
      },
      schedule: {
        expression: `rate(${options.interval} minutes)`,
      },
      runConfig: {
        timeoutInSeconds: 60,
        memoryInMB: 960,
        activeTracing: true,
      },
      artifactS3Location: `s3://${options.s3Bucket}/canary-artifacts/${options.name}/`,
      successRetentionPeriod: 31,
      failureRetentionPeriod: 31,
    })
  }

  /**
   * Create API monitoring canary
  */
  createAPICanary(options: {
    name: string
    baseUrl: string
    endpoints: ApiEndpoint[]
    interval: number
    s3Bucket: string
  }): SyntheticCanary {
    const endpointChecks = options.endpoints
      .map(
        (ep, i) => `
  // Endpoint ${i + 1}: ${ep.method} ${ep.path}
  response = await page.goto('${options.baseUrl}${ep.path}', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  if (response.status() !== ${ep.expectedStatus}) {
    throw new Error('Endpoint ${ep.path} failed: expected ${ep.expectedStatus}, got ' + response.status());
  }

  log.info('Endpoint ${ep.path} check passed');
`,
      )
      .join('\n')

    const script = `
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

const apiCheck = async function () {
  const page = await synthetics.getPage();
  let response;

  ${endpointChecks}

  log.info('All API checks passed');
};

exports.handler = async () => {
  return await apiCheck();
};
`

    return this.createCanary({
      name: options.name,
      description: `API monitor for ${options.baseUrl}`,
      runtimeVersion: SyntheticsManager.RuntimeVersions.NODEJS_PUPPETEER_4_0,
      handler: 'index.handler',
      code: {
        type: 'script',
        script,
      },
      schedule: {
        expression: `rate(${options.interval} minutes)`,
      },
      runConfig: {
        timeoutInSeconds: 120,
        memoryInMB: 960,
        activeTracing: true,
      },
      artifactS3Location: `s3://${options.s3Bucket}/canary-artifacts/${options.name}/`,
      successRetentionPeriod: 31,
      failureRetentionPeriod: 31,
    })
  }

  /**
   * Create visual regression canary
  */
  createVisualRegressionCanary(options: {
    name: string
    url: string
    screenshotName: string
    interval: number
    s3Bucket: string
  }): SyntheticCanary {
    const script = `
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

const visualCheck = async function () {
  const page = await synthetics.getPage();

  await page.goto('${options.url}', {waitUntil: 'networkidle0', timeout: 30000});

  await page.screenshot({
    path: '/tmp/${options.screenshotName}.png',
    fullPage: true
  });

  log.info('Visual regression check completed');
};

exports.handler = async () => {
  return await visualCheck();
};
`

    return this.createCanary({
      name: options.name,
      description: `Visual regression monitor for ${options.url}`,
      runtimeVersion: SyntheticsManager.RuntimeVersions.NODEJS_PUPPETEER_4_0,
      handler: 'index.handler',
      code: {
        type: 'script',
        script,
      },
      schedule: {
        expression: `rate(${options.interval} minutes)`,
      },
      runConfig: {
        timeoutInSeconds: 120,
        memoryInMB: 1024,
        activeTracing: true,
      },
      artifactS3Location: `s3://${options.s3Bucket}/canary-artifacts/${options.name}/`,
      successRetentionPeriod: 31,
      failureRetentionPeriod: 31,
    })
  }

  /**
   * Create workflow canary (multi-step user journey)
  */
  createWorkflowCanary(options: {
    name: string
    description: string
    steps: WorkflowStep[]
    interval: number
    s3Bucket: string
  }): SyntheticCanary {
    const stepScripts = options.steps
      .map(
        (step, i) => `
  // Step ${i + 1}: ${step.description}
  await page.goto('${step.url}', {waitUntil: 'domcontentloaded', timeout: 30000});
  ${step.actions?.map(action => this.generateActionScript(action)).join('\n  ') || ''}
  log.info('Step ${i + 1} completed: ${step.description}');
`,
      )
      .join('\n')

    const script = `
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

const workflowCheck = async function () {
  const page = await synthetics.getPage();

  ${stepScripts}

  log.info('Workflow completed successfully');
};

exports.handler = async () => {
  return await workflowCheck();
};
`

    return this.createCanary({
      name: options.name,
      description: options.description,
      runtimeVersion: SyntheticsManager.RuntimeVersions.NODEJS_PUPPETEER_4_0,
      handler: 'index.handler',
      code: {
        type: 'script',
        script,
      },
      schedule: {
        expression: `rate(${options.interval} minutes)`,
      },
      runConfig: {
        timeoutInSeconds: 180,
        memoryInMB: 1024,
        activeTracing: true,
      },
      artifactS3Location: `s3://${options.s3Bucket}/canary-artifacts/${options.name}/`,
      successRetentionPeriod: 31,
      failureRetentionPeriod: 31,
    })
  }

  /**
   * Generate action script for workflow steps
  */
  private generateActionScript(action: WorkflowAction): string {
    switch (action.type) {
      case 'click':
        return `await page.click('${action.selector}');`
      case 'type':
        return `await page.type('${action.selector}', '${action.value}');`
      case 'wait':
        return `await page.waitForTimeout(${action.duration});`
      case 'waitForSelector':
        return `await page.waitForSelector('${action.selector}');`
      default:
        return ''
    }
  }

  /**
   * Create canary alarm
  */
  createAlarm(canaryId: string, alarm: Omit<CanaryAlarm, 'id'>): CanaryAlarm {
    const canary = this.canaries.get(canaryId)

    if (!canary) {
      throw new Error(`Canary not found: ${canaryId}`)
    }

    const id = `alarm-${Date.now()}-${this.alarmCounter++}`

    const canaryAlarm: CanaryAlarm = {
      id,
      ...alarm,
    }

    if (!canary.alarms) {
      canary.alarms = []
    }

    canary.alarms.push(canaryAlarm)

    return canaryAlarm
  }

  /**
   * Get canary
  */
  getCanary(id: string): SyntheticCanary | undefined {
    return this.canaries.get(id)
  }

  /**
   * List canaries
  */
  listCanaries(): SyntheticCanary[] {
    return Array.from(this.canaries.values())
  }

  /**
   * Generate CloudFormation for canary
  */
  generateCanaryCF(canary: SyntheticCanary): any {
    const cf: any = {
      Type: 'AWS::Synthetics::Canary',
      Properties: {
        Name: canary.name,
        RuntimeVersion: canary.runtimeVersion,
        ExecutionRoleArn: { 'Fn::GetAtt': ['CanaryExecutionRole', 'Arn'] },
        Schedule: {
          Expression: canary.schedule.expression,
          ...(canary.schedule.durationInSeconds && {
            DurationInSeconds: canary.schedule.durationInSeconds,
          }),
        },
        ArtifactS3Location: canary.artifactS3Location,
        StartCanaryAfterCreation: true,
      },
    }

    if (canary.code.type === 'script') {
      cf.Properties.Code = {
        Handler: canary.handler,
        Script: canary.code.script,
      }
    }
    else {
      cf.Properties.Code = {
        Handler: canary.handler,
        S3Bucket: canary.code.s3Bucket,
        S3Key: canary.code.s3Key,
        ...(canary.code.s3Version && { S3ObjectVersion: canary.code.s3Version }),
      }
    }

    if (canary.runConfig) {
      cf.Properties.RunConfig = {
        TimeoutInSeconds: canary.runConfig.timeoutInSeconds,
        MemoryInMB: canary.runConfig.memoryInMB,
        ...(canary.runConfig.environmentVariables && {
          EnvironmentVariables: canary.runConfig.environmentVariables,
        }),
        ...(canary.runConfig.activeTracing !== undefined && {
          ActiveTracing: canary.runConfig.activeTracing,
        }),
      }
    }

    if (canary.vpcConfig) {
      cf.Properties.VPCConfig = {
        SubnetIds: canary.vpcConfig.subnetIds,
        SecurityGroupIds: canary.vpcConfig.securityGroupIds,
      }
    }

    if (canary.successRetentionPeriod) {
      cf.Properties.SuccessRetentionPeriod = canary.successRetentionPeriod
    }

    if (canary.failureRetentionPeriod) {
      cf.Properties.FailureRetentionPeriod = canary.failureRetentionPeriod
    }

    return cf
  }

  /**
   * Generate CloudFormation for canary execution role
  */
  generateCanaryRoleCF(): any {
    return {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Service: 'lambda.amazonaws.com',
              },
              Action: 'sts:AssumeRole',
            },
          ],
        },
        ManagedPolicyArns: [
          'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          'arn:aws:iam::aws:policy/CloudWatchSyntheticsFullAccess',
        ],
        Policies: [
          {
            PolicyName: 'CanaryS3Policy',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Action: ['s3:PutObject', 's3:GetBucketLocation'],
                  Resource: ['arn:aws:s3:::*/*'],
                },
              ],
            },
          },
        ],
      },
    }
  }

  /**
   * Clear all data
  */
  clear(): void {
    this.canaries.clear()
    this.heartbeats.clear()
    this.apiMonitors.clear()
    this.canaryCounter = 0
    this.heartbeatCounter = 0
    this.apiMonitorCounter = 0
    this.alarmCounter = 0
  }
}

/**
 * Workflow step interface
*/
export interface WorkflowStep {
  description: string
  url: string
  actions?: WorkflowAction[]
}

/**
 * Workflow action interface
*/
export interface WorkflowAction {
  type: 'click' | 'type' | 'wait' | 'waitForSelector'
  selector?: string
  value?: string
  duration?: number
}

/**
 * Global synthetics manager instance
*/
export const syntheticsManager: SyntheticsManager = new SyntheticsManager()
