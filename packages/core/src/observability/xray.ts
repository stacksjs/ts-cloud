/**
 * AWS X-Ray Integration
 * Distributed tracing for microservices and serverless applications
 */

export interface XRayConfig {
  id: string
  name: string
  serviceName: string
  samplingRate: number // 0-1 (e.g., 0.1 = 10%)
  enableActiveTracing: boolean
  segmentDocuments?: SegmentDocument[]
}

export interface SegmentDocument {
  id: string
  name: string
  startTime: number
  endTime?: number
  subsegments?: SubSegment[]
  annotations?: Record<string, string | number | boolean>
  metadata?: Record<string, any>
  http?: HttpData
  aws?: AWSData
  error?: boolean
  fault?: boolean
  throttle?: boolean
}

export interface SubSegment {
  id: string
  name: string
  startTime: number
  endTime?: number
  namespace?: 'aws' | 'remote'
  http?: HttpData
  sql?: SqlData
  annotations?: Record<string, string | number | boolean>
  metadata?: Record<string, any>
}

export interface HttpData {
  request?: {
    method?: string
    url?: string
    userAgent?: string
    clientIp?: string
  }
  response?: {
    status?: number
    contentLength?: number
  }
}

export interface AWSData {
  accountId?: string
  operation?: string
  region?: string
  requestId?: string
  queueUrl?: string
  tableName?: string
}

export interface SqlData {
  url?: string
  preparation?: 'statement' | 'call'
  databaseType?: string
  databaseVersion?: string
  driverVersion?: string
  user?: string
  sanitizedQuery?: string
}

export interface SamplingRule {
  id: string
  ruleName: string
  priority: number
  fixedRate: number
  reservoirSize: number
  serviceName: string
  serviceType: string
  host: string
  httpMethod: string
  urlPath: string
  version: number
}

/**
 * X-Ray manager
 */
export class XRayManager {
  private configs: Map<string, XRayConfig> = new Map()
  private samplingRules: Map<string, SamplingRule> = new Map()
  private configCounter = 0
  private ruleCounter = 0

  /**
   * Create X-Ray configuration
   */
  createConfig(config: Omit<XRayConfig, 'id'>): XRayConfig {
    const id = `xray-config-${Date.now()}-${this.configCounter++}`

    const xrayConfig: XRayConfig = {
      id,
      ...config,
    }

    this.configs.set(id, xrayConfig)

    return xrayConfig
  }

  /**
   * Create Lambda X-Ray configuration
   */
  createLambdaConfig(options: {
    functionName: string
    samplingRate?: number
  }): XRayConfig {
    return this.createConfig({
      name: `${options.functionName}-xray`,
      serviceName: options.functionName,
      samplingRate: options.samplingRate || 0.1,
      enableActiveTracing: true,
    })
  }

  /**
   * Create ECS X-Ray configuration
   */
  createECSConfig(options: {
    serviceName: string
    clusterName: string
    samplingRate?: number
  }): XRayConfig {
    return this.createConfig({
      name: `${options.serviceName}-xray`,
      serviceName: `${options.clusterName}/${options.serviceName}`,
      samplingRate: options.samplingRate || 0.05,
      enableActiveTracing: true,
    })
  }

  /**
   * Create API Gateway X-Ray configuration
   */
  createAPIGatewayConfig(options: {
    apiName: string
    stage: string
    samplingRate?: number
  }): XRayConfig {
    return this.createConfig({
      name: `${options.apiName}-${options.stage}-xray`,
      serviceName: `${options.apiName}/${options.stage}`,
      samplingRate: options.samplingRate || 0.05,
      enableActiveTracing: true,
    })
  }

  /**
   * Create sampling rule
   */
  createSamplingRule(rule: Omit<SamplingRule, 'id'>): SamplingRule {
    const id = `sampling-rule-${Date.now()}-${this.ruleCounter++}`

    const samplingRule: SamplingRule = {
      id,
      ...rule,
    }

    this.samplingRules.set(id, samplingRule)

    return samplingRule
  }

  /**
   * Create high-priority sampling rule (always trace)
   */
  createHighPrioritySamplingRule(options: {
    ruleName: string
    serviceName: string
    urlPath: string
  }): SamplingRule {
    return this.createSamplingRule({
      ruleName: options.ruleName,
      priority: 100,
      fixedRate: 1.0, // 100% sampling
      reservoirSize: 100,
      serviceName: options.serviceName,
      serviceType: '*',
      host: '*',
      httpMethod: '*',
      urlPath: options.urlPath,
      version: 1,
    })
  }

  /**
   * Create error sampling rule (trace all errors)
   */
  createErrorSamplingRule(serviceName: string): SamplingRule {
    return this.createSamplingRule({
      ruleName: `${serviceName}-errors`,
      priority: 200,
      fixedRate: 1.0,
      reservoirSize: 50,
      serviceName,
      serviceType: '*',
      host: '*',
      httpMethod: '*',
      urlPath: '/error/*',
      version: 1,
    })
  }

  /**
   * Create default sampling rule
   */
  createDefaultSamplingRule(serviceName: string, samplingRate: number = 0.05): SamplingRule {
    return this.createSamplingRule({
      ruleName: `${serviceName}-default`,
      priority: 1000,
      fixedRate: samplingRate,
      reservoirSize: 10,
      serviceName,
      serviceType: '*',
      host: '*',
      httpMethod: '*',
      urlPath: '*',
      version: 1,
    })
  }

  /**
   * Get config
   */
  getConfig(id: string): XRayConfig | undefined {
    return this.configs.get(id)
  }

  /**
   * List configs
   */
  listConfigs(): XRayConfig[] {
    return Array.from(this.configs.values())
  }

  /**
   * Get sampling rule
   */
  getSamplingRule(id: string): SamplingRule | undefined {
    return this.samplingRules.get(id)
  }

  /**
   * List sampling rules
   */
  listSamplingRules(): SamplingRule[] {
    return Array.from(this.samplingRules.values())
  }

  /**
   * Generate CloudFormation for Lambda X-Ray
   */
  generateLambdaXRayCF(config: XRayConfig): any {
    return {
      TracingConfig: {
        Mode: config.enableActiveTracing ? 'Active' : 'PassThrough',
      },
    }
  }

  /**
   * Generate CloudFormation for API Gateway X-Ray
   */
  generateAPIGatewayXRayCF(config: XRayConfig): any {
    return {
      TracingEnabled: config.enableActiveTracing,
    }
  }

  /**
   * Generate ECS task definition with X-Ray sidecar
   */
  generateECSXRaySidecarCF(): any {
    return {
      Name: 'xray-daemon',
      Image: 'public.ecr.aws/xray/aws-xray-daemon:latest',
      Cpu: 32,
      MemoryReservation: 256,
      PortMappings: [
        {
          ContainerPort: 2000,
          Protocol: 'udp',
        },
      ],
    }
  }

  /**
   * Generate sampling rules CloudFormation
   */
  generateSamplingRuleCF(rule: SamplingRule): any {
    return {
      Type: 'AWS::XRay::SamplingRule',
      Properties: {
        SamplingRule: {
          RuleName: rule.ruleName,
          Priority: rule.priority,
          FixedRate: rule.fixedRate,
          ReservoirSize: rule.reservoirSize,
          ServiceName: rule.serviceName,
          ServiceType: rule.serviceType,
          Host: rule.host,
          HTTPMethod: rule.httpMethod,
          URLPath: rule.urlPath,
          Version: rule.version,
          ResourceARN: '*',
        },
      },
    }
  }

  /**
   * Create a distributed trace
   */
  createTrace(
    traceId: string,
    spans: Array<{ spanId: string; name: string; duration: number; tags: Record<string, any> }>
  ): {
    id: string
    traceId: string
    spans: Array<{ spanId: string; name: string; duration: number; tags: Record<string, any> }>
  } {
    const id = `trace-${Date.now()}-${this.configCounter++}`
    const trace = {
      id,
      traceId,
      spans,
    }
    return trace
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.configs.clear()
    this.samplingRules.clear()
    this.configCounter = 0
    this.ruleCounter = 0
  }
}

/**
 * Global X-Ray manager instance
 */
export const xrayManager: XRayManager = new XRayManager()
