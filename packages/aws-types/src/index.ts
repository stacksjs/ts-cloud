/**
 * AWS CloudFormation Resource Type Definitions
 * These types are lightweight definitions without AWS SDK dependencies
*/

// CloudFormation Template Structure
export interface CloudFormationTemplate {
  AWSTemplateFormatVersion?: '2010-09-09'
  Description?: string
  Parameters?: Record<string, CloudFormationParameter>
  Mappings?: Record<string, unknown>
  Conditions?: Record<string, unknown>
  Resources: Record<string, CloudFormationResource>
  Outputs?: Record<string, CloudFormationOutput>
}

export interface CloudFormationParameter {
  Type: 'String' | 'Number' | 'List<Number>' | 'CommaDelimitedList'
  Default?: unknown
  Description?: string
  AllowedValues?: unknown[]
  AllowedPattern?: string
  MinLength?: number
  MaxLength?: number
  MinValue?: number
  MaxValue?: number
}

export interface CloudFormationResource {
  Type: string
  Properties?: Record<string, unknown>
  DependsOn?: string | string[]
  Condition?: string
  DeletionPolicy?: 'Delete' | 'Retain' | 'Snapshot'
  UpdateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot'
}

export interface CloudFormationOutput {
  Description?: string
  Value: unknown
  Export?: {
    Name: string
  }
}

// CloudFormation Intrinsic Functions
export interface IntrinsicFunctions {
  Ref: (logicalName: string) => { Ref: string }
  GetAtt: (logicalName: string, attributeName: string) => { 'Fn::GetAtt': [string, string] }
  Sub: (template: string, variables?: Record<string, unknown>) => { 'Fn::Sub': string | [string, Record<string, unknown>] }
  Join: (delimiter: string, values: unknown[]) => { 'Fn::Join': [string, unknown[]] }
  Select: (index: number, list: unknown[]) => { 'Fn::Select': [number, unknown[]] }
  Split: (delimiter: string, source: string) => { 'Fn::Split': [string, string] }
  GetAZs: (region?: string) => { 'Fn::GetAZs': string }
  ImportValue: (name: string) => { 'Fn::ImportValue': string }
  If: (condition: string, trueValue: unknown, falseValue: unknown) => { 'Fn::If': [string, unknown, unknown] }
}

// S3 Types
export interface S3Bucket extends CloudFormationResource {
  Type: 'AWS::S3::Bucket'
  Properties?: {
    BucketName?: string
    AccessControl?: 'Private' | 'PublicRead' | 'PublicReadWrite' | 'AuthenticatedRead'
    BucketEncryption?: {
      ServerSideEncryptionConfiguration: Array<{
        ServerSideEncryptionByDefault: {
          SSEAlgorithm: 'AES256' | 'aws:kms'
          KMSMasterKeyID?: string
        }
      }>
    }
    VersioningConfiguration?: {
      Status: 'Enabled' | 'Suspended'
    }
    WebsiteConfiguration?: {
      IndexDocument?: string
      ErrorDocument?: string
      RedirectAllRequestsTo?: {
        HostName: string
        Protocol?: string
      }
    }
    Tags?: Array<{
      Key: string
      Value: string
    }>
    LifecycleConfiguration?: {
      Rules: Array<{
        Id: string
        Status: 'Enabled' | 'Disabled'
        ExpirationInDays?: number
        Transitions?: Array<{
          TransitionInDays: number
          StorageClass: string
        }>
      }>
    }
    PublicAccessBlockConfiguration?: {
      BlockPublicAcls?: boolean
      BlockPublicPolicy?: boolean
      IgnorePublicAcls?: boolean
      RestrictPublicBuckets?: boolean
    }
    CorsConfiguration?: {
      CorsRules: Array<{
        AllowedOrigins: string[]
        AllowedMethods: string[]
        AllowedHeaders?: string[]
        MaxAge?: number
      }>
    }
    NotificationConfiguration?: {
      LambdaConfigurations?: Array<{
        Event: string
        Function: string
        Filter?: {
          S3Key?: {
            Rules?: Array<{
              Name: string
              Value: string
            }>
          }
        }
      }>
    }
  }
}

export interface S3BucketPolicy extends CloudFormationResource {
  Type: 'AWS::S3::BucketPolicy'
  Properties: {
    Bucket: string | { Ref: string }
    PolicyDocument: {
      Version: '2012-10-17'
      Statement: Array<{
        Sid?: string
        Effect: 'Allow' | 'Deny'
        Principal: unknown
        Action: string | string[]
        Resource: string | string[]
        Condition?: unknown
      }>
    }
  }
}

// CloudFront Cache Behavior Type
export interface CloudFrontCacheBehavior {
  TargetOriginId: string
  ViewerProtocolPolicy: 'allow-all' | 'https-only' | 'redirect-to-https'
  AllowedMethods?: string[]
  CachedMethods?: string[]
  CachePolicyId?: string
  Compress?: boolean
  LambdaFunctionAssociations?: Array<{
    EventType: 'origin-request' | 'origin-response' | 'viewer-request' | 'viewer-response'
    LambdaFunctionARN: string
  }>
  // TTL settings
  DefaultTTL?: number
  MaxTTL?: number
  MinTTL?: number
  // Forwarded values (legacy, but still used)
  ForwardedValues?: {
    QueryString?: boolean
    Headers?: string[]
    Cookies?: {
      Forward: string
      WhitelistedNames?: string[]
    }
  }
  // Path pattern for cache behaviors
  PathPattern?: string
}

// CloudFront Origin Type
export interface CloudFrontOrigin {
  Id: string
  DomainName: string
  OriginPath?: string
  S3OriginConfig?: {
    OriginAccessIdentity?: string
  }
  CustomOriginConfig?: {
    HTTPPort?: number
    HTTPSPort?: number
    OriginProtocolPolicy: 'http-only' | 'https-only' | 'match-viewer'
    OriginSSLProtocols?: string[]
    OriginReadTimeout?: number
    OriginKeepaliveTimeout?: number
  }
  OriginAccessControlId?: string
  OriginCustomHeaders?: Array<{
    HeaderName: string
    HeaderValue: string
  }>
}

// CloudFront Types
export interface CloudFrontDistribution extends CloudFormationResource {
  Type: 'AWS::CloudFront::Distribution'
  Properties: {
    DistributionConfig: {
      Enabled: boolean
      Comment?: string
      DefaultRootObject?: string
      Origins: CloudFrontOrigin[]
      DefaultCacheBehavior: CloudFrontCacheBehavior
      CacheBehaviors?: CloudFrontCacheBehavior[]
      PriceClass?: string
      ViewerCertificate?: {
        AcmCertificateArn?: string
        CloudFrontDefaultCertificate?: boolean
        MinimumProtocolVersion?: string
        SslSupportMethod?: string
      }
      Aliases?: string[]
      CustomErrorResponses?: Array<{
        ErrorCode: number
        ResponseCode?: number
        ResponsePagePath?: string
      }>
      HttpVersion?: 'http1.1' | 'http2' | 'http2and3' | 'http3'
    }
  }
}

export interface CloudFrontOriginAccessControl extends CloudFormationResource {
  Type: 'AWS::CloudFront::OriginAccessControl'
  Properties: {
    OriginAccessControlConfig: {
      Name: string
      Description?: string
      OriginAccessControlOriginType: 's3' | 'mediastore'
      SigningBehavior: 'always' | 'never' | 'no-override'
      SigningProtocol: 'sigv4'
    }
  }
}

export interface CloudFrontFunction extends CloudFormationResource {
  Type: 'AWS::CloudFront::Function'
  Properties: {
    Name: string
    FunctionCode: string
    FunctionConfig: {
      Comment?: string
      Runtime: 'cloudfront-js-1.0' | 'cloudfront-js-2.0'
      KeyValueStoreAssociations?: Array<{
        KeyValueStoreARN: string
      }>
    }
    AutoPublish?: boolean
  }
}

// Step Functions Types
export interface StepFunctionsStateMachine extends CloudFormationResource {
  Type: 'AWS::StepFunctions::StateMachine'
  Properties: {
    StateMachineName?: string
    StateMachineType?: 'STANDARD' | 'EXPRESS'
    Definition?: Record<string, unknown>
    DefinitionString?: string
    DefinitionS3Location?: {
      Bucket: string
      Key: string
      Version?: string
    }
    DefinitionSubstitutions?: Record<string, string>
    RoleArn: string | { 'Fn::GetAtt': [string, string] } | { Ref: string }
    LoggingConfiguration?: {
      Destinations?: Array<{
        CloudWatchLogsLogGroup?: {
          LogGroupArn: string | { 'Fn::GetAtt': [string, string] }
        }
      }>
      IncludeExecutionData?: boolean
      Level?: 'ALL' | 'ERROR' | 'FATAL' | 'OFF'
    }
    TracingConfiguration?: {
      Enabled?: boolean
    }
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

// Export all AWS CloudFormation resource types
export * from './route53'
export * from './ec2'
export * from './iam'
export * from './lambda'
export * from './ecs'
export * from './ecr'
export * from './alb'
export * from './rds'
export * from './dynamodb'
export * from './apigateway'
export * from './sns'
export * from './ses'
export * from './sqs'
export * from './eventbridge'
export * from './cloudwatch'
export * from './kms'
export * from './acm'
export * from './efs'
export * from './waf'
export * from './elasticache'
export * from './secrets-manager'
export * from './autoscaling'
export * from './ssm'
export * from './backup'
export * from './opensearch'
export * from './rds-proxy'
export * from './globalaccelerator'
export * from './appsync'
export * from './athena'
export * from './kinesis'
export * from './glue'
export * from './connect'
export * from './pinpoint'
export * from './common'
export * from './cognito'
export * from './codedeploy'
