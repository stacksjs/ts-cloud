/**
 * AWS AppSync Types
 * CloudFormation resource types for AWS AppSync (GraphQL)
*/

import type { Tag } from './common'

export interface GraphQLApi {
  Type: 'AWS::AppSync::GraphQLApi'
  Properties: {
    Name: string
    AuthenticationType: 'API_KEY' | 'AWS_IAM' | 'AMAZON_COGNITO_USER_POOLS' | 'OPENID_CONNECT' | 'AWS_LAMBDA'

    // Optional authentication providers
    AdditionalAuthenticationProviders?: Array<{
      AuthenticationType: 'API_KEY' | 'AWS_IAM' | 'AMAZON_COGNITO_USER_POOLS' | 'OPENID_CONNECT' | 'AWS_LAMBDA'
      UserPoolConfig?: {
        UserPoolId: string | { Ref: string }
        AwsRegion?: string
        AppIdClientRegex?: string
      }
      OpenIDConnectConfig?: {
        Issuer: string
        ClientId?: string
        IatTTL?: number
        AuthTTL?: number
      }
      LambdaAuthorizerConfig?: {
        AuthorizerUri: string | { Ref: string }
        AuthorizerResultTtlInSeconds?: number
        IdentityValidationExpression?: string
      }
    }>

    // Cognito User Pool config (if using AMAZON_COGNITO_USER_POOLS)
    UserPoolConfig?: {
      UserPoolId: string | { Ref: string }
      AwsRegion?: string
      DefaultAction: 'ALLOW' | 'DENY'
      AppIdClientRegex?: string
    }

    // OpenID Connect config (if using OPENID_CONNECT)
    OpenIDConnectConfig?: {
      Issuer: string
      ClientId?: string
      IatTTL?: number
      AuthTTL?: number
    }

    // Lambda authorizer config (if using AWS_LAMBDA)
    LambdaAuthorizerConfig?: {
      AuthorizerUri: string | { Ref: string }
      AuthorizerResultTtlInSeconds?: number
      IdentityValidationExpression?: string
    }

    // Logging
    LogConfig?: {
      CloudWatchLogsRoleArn: string | { Ref: string }
      FieldLogLevel: 'NONE' | 'ERROR' | 'ALL'
      ExcludeVerboseContent?: boolean
    }

    // X-Ray tracing
    XrayEnabled?: boolean

    Tags?: Tag[]
  }
  DeletionPolicy?: 'Delete' | 'Retain'
  UpdateReplacePolicy?: 'Delete' | 'Retain'
}

export interface GraphQLSchema {
  Type: 'AWS::AppSync::GraphQLSchema'
  Properties: {
    ApiId: string | { Ref: string }
    Definition?: string
    DefinitionS3Location?: string
  }
  DependsOn?: string | string[]
}

export interface DataSource {
  Type: 'AWS::AppSync::DataSource'
  Properties: {
    ApiId: string | { Ref: string }
    Name: string
    Type: 'AWS_LAMBDA' | 'AMAZON_DYNAMODB' | 'AMAZON_ELASTICSEARCH' | 'AMAZON_OPENSEARCH_SERVICE' | 'HTTP' | 'RELATIONAL_DATABASE' | 'NONE'
    ServiceRoleArn?: string | { Ref: string }

    // Lambda config (if Type = AWS_LAMBDA)
    LambdaConfig?: {
      LambdaFunctionArn: string | { Ref: string }
    }

    // DynamoDB config (if Type = AMAZON_DYNAMODB)
    DynamoDBConfig?: {
      TableName: string | { Ref: string }
      AwsRegion: string
      UseCallerCredentials?: boolean
      DeltaSyncConfig?: {
        BaseTableTTL: number
        DeltaSyncTableName: string | { Ref: string }
        DeltaSyncTableTTL: number
      }
      Versioned?: boolean
    }

    // OpenSearch config (if Type = AMAZON_OPENSEARCH_SERVICE)
    OpenSearchServiceConfig?: {
      AwsRegion: string
      Endpoint: string | { 'Fn::GetAtt': [string, string] }
    }

    // HTTP config (if Type = HTTP)
    HttpConfig?: {
      Endpoint: string
      AuthorizationConfig?: {
        AuthorizationType: 'AWS_IAM'
        AwsIamConfig?: {
          SigningRegion?: string
          SigningServiceName?: string
        }
      }
    }

    // RDS config (if Type = RELATIONAL_DATABASE)
    RelationalDatabaseConfig?: {
      RelationalDatabaseSourceType: 'RDS_HTTP_ENDPOINT'
      RdsHttpEndpointConfig?: {
        AwsRegion: string
        DbClusterIdentifier: string | { Ref: string }
        DatabaseName?: string
        Schema?: string
        AwsSecretStoreArn: string | { Ref: string }
      }
    }

    Description?: string
  }
  DependsOn?: string | string[]
}

export interface Resolver {
  Type: 'AWS::AppSync::Resolver'
  Properties: {
    ApiId: string | { Ref: string }
    TypeName: string // e.g., 'Query', 'Mutation', 'Subscription'
    FieldName: string
    DataSourceName?: string | { Ref: string }

    // Request/Response mapping templates (VTL)
    RequestMappingTemplate?: string
    ResponseMappingTemplate?: string

    // Or use S3 location
    RequestMappingTemplateS3Location?: string
    ResponseMappingTemplateS3Location?: string

    // Pipeline resolvers
    Kind?: 'UNIT' | 'PIPELINE'
    PipelineConfig?: {
      Functions?: Array<string | { Ref: string }>
    }

    // Caching
    CachingConfig?: {
      CachingKeys?: string[]
      Ttl?: number
    }

    // Sync config (for subscriptions)
    SyncConfig?: {
      ConflictDetection: 'VERSION' | 'NONE'
      ConflictHandler?: 'OPTIMISTIC_CONCURRENCY' | 'LAMBDA' | 'AUTOMERGE'
      LambdaConflictHandlerConfig?: {
        LambdaConflictHandlerArn: string | { Ref: string }
      }
    }

    // Code (for JavaScript resolvers)
    Code?: string
    CodeS3Location?: string
    Runtime?: {
      Name: 'APPSYNC_JS'
      RuntimeVersion: string
    }
  }
  DependsOn?: string | string[]
}

export interface FunctionConfiguration {
  Type: 'AWS::AppSync::FunctionConfiguration'
  Properties: {
    ApiId: string | { Ref: string }
    Name: string
    DataSourceName: string | { Ref: string }
    FunctionVersion?: string

    // Request/Response mapping templates
    RequestMappingTemplate?: string
    ResponseMappingTemplate?: string
    RequestMappingTemplateS3Location?: string
    ResponseMappingTemplateS3Location?: string

    // Code (for JavaScript functions)
    Code?: string
    CodeS3Location?: string
    Runtime?: {
      Name: 'APPSYNC_JS'
      RuntimeVersion: string
    }

    Description?: string
  }
  DependsOn?: string | string[]
}

export interface ApiKey {
  Type: 'AWS::AppSync::ApiKey'
  Properties: {
    ApiId: string | { Ref: string }
    Description?: string
    Expires?: number // Unix timestamp
  }
  DependsOn?: string | string[]
}

export interface DomainName {
  Type: 'AWS::AppSync::DomainName'
  Properties: {
    DomainName: string
    CertificateArn: string | { Ref: string }
    Description?: string
  }
}

export interface DomainNameApiAssociation {
  Type: 'AWS::AppSync::DomainNameApiAssociation'
  Properties: {
    DomainName: string | { Ref: string }
    ApiId: string | { Ref: string }
  }
  DependsOn?: string | string[]
}
