import type { CloudFormationResource } from './index'

export interface ApiGatewayRestApi extends CloudFormationResource {
  Type: 'AWS::ApiGateway::RestApi'
  Properties: {
    Name: string
    Description?: string
    EndpointConfiguration?: {
      Types: ('EDGE' | 'REGIONAL' | 'PRIVATE')[]
    }
    Policy?: unknown
    BinaryMediaTypes?: string[]
    MinimumCompressionSize?: number
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface ApiGatewayHttpApi extends CloudFormationResource {
  Type: 'AWS::ApiGatewayV2::Api'
  Properties: {
    Name: string
    Description?: string
    ProtocolType: 'HTTP' | 'WEBSOCKET'
    CorsConfiguration?: {
      AllowOrigins?: string[]
      AllowMethods?: string[]
      AllowHeaders?: string[]
      ExposeHeaders?: string[]
      MaxAge?: number
      AllowCredentials?: boolean
    }
    Tags?: Record<string, string>
  }
}

export interface ApiGatewayStage extends CloudFormationResource {
  Type: 'AWS::ApiGateway::Stage'
  Properties: {
    StageName: string
    RestApiId: string | { Ref: string }
    DeploymentId: string | { Ref: string }
    Description?: string
    CacheClusterEnabled?: boolean
    CacheClusterSize?: string
    Variables?: Record<string, string>
    MethodSettings?: Array<{
      HttpMethod: string
      ResourcePath: string
      CachingEnabled?: boolean
      CacheTtlInSeconds?: number
      ThrottlingBurstLimit?: number
      ThrottlingRateLimit?: number
    }>
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface ApiGatewayDeployment extends CloudFormationResource {
  Type: 'AWS::ApiGateway::Deployment'
  Properties: {
    RestApiId: string | { Ref: string }
    Description?: string
    StageName?: string
  }
}

export interface ApiGatewayAuthorizer extends CloudFormationResource {
  Type: 'AWS::ApiGateway::Authorizer'
  Properties: {
    Name: string
    Type: 'TOKEN' | 'REQUEST' | 'COGNITO_USER_POOLS'
    RestApiId: string | { Ref: string }
    AuthorizerUri?: string
    AuthorizerCredentials?: string
    IdentitySource?: string
    ProviderARNs?: string[]
    AuthorizerResultTtlInSeconds?: number
  }
}
