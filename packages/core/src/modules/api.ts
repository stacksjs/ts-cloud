import type {
  ApiGatewayAuthorizer,
  ApiGatewayDeployment,
  ApiGatewayHttpApi,
  ApiGatewayRestApi,
  ApiGatewayStage,
} from 'ts-cloud-aws-types'
import type { EnvironmentType } from 'ts-cloud-types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface RestApiOptions {
  slug: string
  environment: EnvironmentType
  name?: string
  apiName?: string // Alias for name
  description?: string
  endpointType?: 'EDGE' | 'REGIONAL' | 'PRIVATE'
  binaryMediaTypes?: string[]
  compressionSize?: number
}

export interface HttpApiOptions {
  slug: string
  environment: EnvironmentType
  name?: string
  description?: string
  corsEnabled?: boolean
  corsOrigins?: string[]
  corsMethods?: string[]
  corsHeaders?: string[]
  corsMaxAge?: number
  corsAllowCredentials?: boolean
}

export interface WebSocketApiOptions {
  slug: string
  environment: EnvironmentType
  name?: string
  description?: string
}

export interface StageOptions {
  slug: string
  environment: EnvironmentType
  stageName?: string
  description?: string
  cacheEnabled?: boolean
  cacheSize?: '0.5' | '1.6' | '6.1' | '13.5' | '28.4' | '58.2' | '118' | '237'
  variables?: Record<string, string>
  throttling?: {
    burstLimit?: number
    rateLimit?: number
  }
}

export interface AuthorizerOptions {
  slug: string
  environment: EnvironmentType
  name?: string
  type: 'TOKEN' | 'REQUEST' | 'COGNITO_USER_POOLS'
  functionArn?: string
  identitySource?: string
  userPoolArns?: string[]
  ttl?: number
}

/**
 * API Gateway Module - REST, HTTP, and WebSocket APIs
 * Provides clean API for creating and configuring API Gateway resources
 */
export class ApiGateway {
  /**
   * Create a REST API
   */
  static createRestApi(options: RestApiOptions): {
    restApi: ApiGatewayRestApi
    logicalId: string
  } {
    const {
      slug,
      environment,
      name,
      description,
      endpointType = 'REGIONAL',
      binaryMediaTypes,
      compressionSize,
    } = options

    const resourceName = name || generateResourceName({
      slug,
      environment,
      resourceType: 'rest-api',
    })

    const logicalId = generateLogicalId(resourceName)

    const restApi: ApiGatewayRestApi = {
      Type: 'AWS::ApiGateway::RestApi',
      Properties: {
        Name: resourceName,
        Description: description || `REST API for ${slug} ${environment}`,
        EndpointConfiguration: {
          Types: [endpointType],
        },
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (binaryMediaTypes && binaryMediaTypes.length > 0) {
      restApi.Properties.BinaryMediaTypes = binaryMediaTypes
    }

    if (compressionSize !== undefined) {
      restApi.Properties.MinimumCompressionSize = compressionSize
    }

    return { restApi, logicalId }
  }

  /**
   * Create an HTTP API (cheaper and simpler than REST API)
   */
  static createHttpApi(options: HttpApiOptions): {
    httpApi: ApiGatewayHttpApi
    logicalId: string
  } {
    const {
      slug,
      environment,
      name,
      description,
      corsEnabled = true,
      corsOrigins = ['*'],
      corsMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      corsHeaders = ['*'],
      corsMaxAge = 86400,
      corsAllowCredentials = false,
    } = options

    const resourceName = name || generateResourceName({
      slug,
      environment,
      resourceType: 'http-api',
    })

    const logicalId = generateLogicalId(resourceName)

    const httpApi: ApiGatewayHttpApi = {
      Type: 'AWS::ApiGatewayV2::Api',
      Properties: {
        Name: resourceName,
        Description: description || `HTTP API for ${slug} ${environment}`,
        ProtocolType: 'HTTP',
        Tags: {
          Name: resourceName,
          Environment: environment,
        },
      },
    }

    if (corsEnabled) {
      httpApi.Properties.CorsConfiguration = {
        AllowOrigins: corsOrigins,
        AllowMethods: corsMethods,
        AllowHeaders: corsHeaders,
        MaxAge: corsMaxAge,
        AllowCredentials: corsAllowCredentials,
      }
    }

    return { httpApi, logicalId }
  }

  /**
   * Create a WebSocket API
   */
  static createWebSocketApi(options: WebSocketApiOptions): {
    webSocketApi: ApiGatewayHttpApi
    logicalId: string
  } {
    const {
      slug,
      environment,
      name,
      description,
    } = options

    const resourceName = name || generateResourceName({
      slug,
      environment,
      resourceType: 'ws-api',
    })

    const logicalId = generateLogicalId(resourceName)

    const webSocketApi: ApiGatewayHttpApi = {
      Type: 'AWS::ApiGatewayV2::Api',
      Properties: {
        Name: resourceName,
        Description: description || `WebSocket API for ${slug} ${environment}`,
        ProtocolType: 'WEBSOCKET',
        Tags: {
          Name: resourceName,
          Environment: environment,
        },
      },
    }

    return { webSocketApi, logicalId }
  }

  /**
   * Create a deployment for REST API
   */
  static createDeployment(
    restApiLogicalId: string,
    options: {
      slug: string
      environment: EnvironmentType
      description?: string
    },
  ): {
      deployment: ApiGatewayDeployment
      logicalId: string
    } {
    const { slug, environment, description } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'api-deployment',
    })

    const logicalId = generateLogicalId(resourceName)

    const deployment: ApiGatewayDeployment = {
      Type: 'AWS::ApiGateway::Deployment',
      Properties: {
        RestApiId: Fn.Ref(restApiLogicalId) as unknown as string,
        Description: description || `Deployment for ${resourceName}`,
      },
    }

    return { deployment, logicalId }
  }

  /**
   * Create a stage for REST API
   */
  static createStage(
    restApiLogicalId: string,
    deploymentLogicalId: string,
    options: StageOptions,
  ): {
      stage: ApiGatewayStage
      logicalId: string
    } {
    const {
      slug,
      environment,
      stageName,
      description,
      cacheEnabled = false,
      cacheSize = '0.5',
      variables,
      throttling,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'api-stage',
    })

    const logicalId = generateLogicalId(resourceName)

    const stage: ApiGatewayStage = {
      Type: 'AWS::ApiGateway::Stage',
      Properties: {
        StageName: stageName || environment,
        RestApiId: Fn.Ref(restApiLogicalId) as unknown as string,
        DeploymentId: Fn.Ref(deploymentLogicalId) as unknown as string,
        Description: description,
        CacheClusterEnabled: cacheEnabled,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (cacheEnabled) {
      stage.Properties.CacheClusterSize = cacheSize
    }

    if (variables) {
      stage.Properties.Variables = variables
    }

    if (throttling) {
      stage.Properties.MethodSettings = [
        {
          HttpMethod: '*',
          ResourcePath: '/*',
          ThrottlingBurstLimit: throttling.burstLimit,
          ThrottlingRateLimit: throttling.rateLimit,
        },
      ]
    }

    return { stage, logicalId }
  }

  /**
   * Create an authorizer for REST API
   */
  static createAuthorizer(
    restApiLogicalId: string,
    options: AuthorizerOptions,
  ): {
      authorizer: ApiGatewayAuthorizer
      logicalId: string
    } {
    const {
      slug,
      environment,
      name,
      type,
      functionArn,
      identitySource,
      userPoolArns,
      ttl = 300,
    } = options

    const resourceName = name || generateResourceName({
      slug,
      environment,
      resourceType: 'api-authorizer',
    })

    const logicalId = generateLogicalId(resourceName)

    const authorizer: ApiGatewayAuthorizer = {
      Type: 'AWS::ApiGateway::Authorizer',
      Properties: {
        Name: resourceName,
        Type: type,
        RestApiId: Fn.Ref(restApiLogicalId) as unknown as string,
        AuthorizerResultTtlInSeconds: ttl,
      },
    }

    if (type === 'TOKEN' || type === 'REQUEST') {
      if (!functionArn) {
        throw new Error('Lambda authorizer requires functionArn')
      }
      authorizer.Properties.AuthorizerUri = functionArn
      authorizer.Properties.IdentitySource = identitySource || 'method.request.header.Authorization'
    }

    if (type === 'COGNITO_USER_POOLS') {
      if (!userPoolArns || userPoolArns.length === 0) {
        throw new Error('Cognito authorizer requires userPoolArns')
      }
      authorizer.Properties.ProviderARNs = userPoolArns
      authorizer.Properties.IdentitySource = identitySource || 'method.request.header.Authorization'
    }

    return { authorizer, logicalId }
  }

  /**
   * Enable CORS on HTTP API
   */
  static setCors(
    httpApi: ApiGatewayHttpApi,
    options: {
      origins?: string[]
      methods?: string[]
      headers?: string[]
      maxAge?: number
      allowCredentials?: boolean
    } = {},
  ): ApiGatewayHttpApi {
    const {
      origins = ['*'],
      methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      headers = ['*'],
      maxAge = 86400,
      allowCredentials = false,
    } = options

    httpApi.Properties.CorsConfiguration = {
      AllowOrigins: origins,
      AllowMethods: methods,
      AllowHeaders: headers,
      MaxAge: maxAge,
      AllowCredentials: allowCredentials,
    }

    return httpApi
  }

  /**
   * Add throttling to stage
   */
  static addThrottling(
    stage: ApiGatewayStage,
    burstLimit: number = 5000,
    rateLimit: number = 10000,
  ): ApiGatewayStage {
    if (!stage.Properties.MethodSettings) {
      stage.Properties.MethodSettings = []
    }

    stage.Properties.MethodSettings.push({
      HttpMethod: '*',
      ResourcePath: '/*',
      ThrottlingBurstLimit: burstLimit,
      ThrottlingRateLimit: rateLimit,
    })

    return stage
  }

  /**
   * Enable caching on stage
   */
  static enableCaching(
    stage: ApiGatewayStage,
    cacheSize: '0.5' | '1.6' | '6.1' | '13.5' | '28.4' | '58.2' | '118' | '237' = '0.5',
    ttl: number = 300,
  ): ApiGatewayStage {
    stage.Properties.CacheClusterEnabled = true
    stage.Properties.CacheClusterSize = cacheSize

    if (!stage.Properties.MethodSettings) {
      stage.Properties.MethodSettings = []
    }

    stage.Properties.MethodSettings.push({
      HttpMethod: '*',
      ResourcePath: '/*',
      CachingEnabled: true,
      CacheTtlInSeconds: ttl,
    })

    return stage
  }

  /**
   * Common cache sizes (in GB)
   */
  static readonly CacheSizes = {
    Small: '0.5',
    Medium: '1.6',
    Large: '6.1',
    XLarge: '13.5',
    XXLarge: '28.4',
    XXXLarge: '58.2',
    Huge: '118',
    Massive: '237',
  } as const

  /**
   * Common throttling presets
   */
  static readonly ThrottlingPresets = {
    Light: { burstLimit: 100, rateLimit: 50 },
    Medium: { burstLimit: 500, rateLimit: 250 },
    Heavy: { burstLimit: 2000, rateLimit: 1000 },
    Default: { burstLimit: 5000, rateLimit: 10000 },
  } as const
}
