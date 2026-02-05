import type { CloudFormationBuilder } from '../builder'
import { Fn } from '../types'

export interface ApiGatewayConfig {
  type: 'http' | 'rest' | 'websocket'
  customDomain?: {
    domain: string
    certificateArn: string
  }
  cors?: {
    allowOrigins: string[]
    allowMethods: string[]
    allowHeaders?: string[]
    maxAge?: number
  }
  throttling?: {
    rateLimit: number
    burstLimit: number
  }
  routes?: any
  authorizer?: {
    type: 'jwt' | 'lambda' | 'cognito'
    identitySource?: string
    authorizerUri?: string
    issuer?: string
    audience?: string[]
  }
}

/**
 * Add API Gateway resources to CloudFormation template
*/
export function addApiGatewayResources(
  builder: CloudFormationBuilder,
  config: ApiGatewayConfig,
): void {
  if (config.type === 'http') {
    addHttpApi(builder, config)
  }
  else if (config.type === 'rest') {
    addRestApi(builder, config)
  }
  else if (config.type === 'websocket') {
    addWebSocketApi(builder, config)
  }
}

/**
 * Add HTTP API (API Gateway v2)
*/
function addHttpApi(
  builder: CloudFormationBuilder,
  config: ApiGatewayConfig,
): void {
  // HTTP API
  const apiProperties: any = {
    Name: Fn.sub('${AWS::StackName}-http-api'),
    ProtocolType: 'HTTP',
  }

  // CORS configuration
  if (config.cors) {
    apiProperties.CorsConfiguration = {
      AllowOrigins: config.cors.allowOrigins,
      AllowMethods: config.cors.allowMethods,
      AllowHeaders: config.cors.allowHeaders || ['*'],
      MaxAge: config.cors.maxAge || 300,
    }
  }

  builder.addResource('HttpApi', 'AWS::ApiGatewayV2::Api', apiProperties)

  // Default stage
  builder.addResource('HttpApiStage', 'AWS::ApiGatewayV2::Stage', {
    ApiId: Fn.ref('HttpApi'),
    StageName: '$default',
    AutoDeploy: true,
    DefaultRouteSettings: config.throttling ? {
      ThrottlingBurstLimit: config.throttling.burstLimit,
      ThrottlingRateLimit: config.throttling.rateLimit,
    } : undefined,
    AccessLogSettings: {
      DestinationArn: Fn.getAtt('ApiLogGroup', 'Arn'),
      Format: '$context.requestId $context.error.message $context.error.messageString',
    },
  }, {
    dependsOn: ['HttpApi', 'ApiLogGroup'],
  })

  // CloudWatch Logs for API Gateway
  builder.addResource('ApiLogGroup', 'AWS::Logs::LogGroup', {
    LogGroupName: Fn.sub('/aws/apigateway/${AWS::StackName}-http-api'),
    RetentionInDays: 14,
  })

  // Authorizer (if configured)
  if (config.authorizer) {
    addAuthorizer(builder, 'HttpApi', config.authorizer)
  }

  // Custom domain
  if (config.customDomain) {
    addApiCustomDomain(builder, 'HttpApi', config.customDomain, 'HTTP')
  }

  // Outputs
  builder.addOutputs({
    HttpApiId: {
      Description: 'HTTP API ID',
      Value: Fn.ref('HttpApi'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-http-api-id'),
      },
    },
    HttpApiEndpoint: {
      Description: 'HTTP API endpoint',
      Value: Fn.getAtt('HttpApi', 'ApiEndpoint'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-http-api-endpoint'),
      },
    },
  })
}

/**
 * Add REST API (API Gateway v1)
*/
function addRestApi(
  builder: CloudFormationBuilder,
  config: ApiGatewayConfig,
): void {
  // REST API
  builder.addResource('RestApi', 'AWS::ApiGateway::RestApi', {
    Name: Fn.sub('${AWS::StackName}-rest-api'),
    Description: Fn.sub('REST API for ${AWS::StackName}'),
    EndpointConfiguration: {
      Types: ['REGIONAL'],
    },
  })

  // API Gateway Account (for CloudWatch logging)
  builder.addResource('ApiGatewayAccount', 'AWS::ApiGateway::Account', {
    CloudWatchRoleArn: Fn.getAtt('ApiGatewayCloudWatchRole', 'Arn'),
  }, {
    dependsOn: 'ApiGatewayCloudWatchRole',
  })

  // IAM Role for API Gateway CloudWatch logging
  builder.addResource('ApiGatewayCloudWatchRole', 'AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { Service: 'apigateway.amazonaws.com' },
        Action: 'sts:AssumeRole',
      }],
    },
    ManagedPolicyArns: [
      'arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
    ],
  })

  // Deployment
  builder.addResource('RestApiDeployment', 'AWS::ApiGateway::Deployment', {
    RestApiId: Fn.ref('RestApi'),
    Description: 'Initial deployment',
  }, {
    dependsOn: 'RestApi',
  })

  // Stage
  const stageProperties: any = {
    RestApiId: Fn.ref('RestApi'),
    DeploymentId: Fn.ref('RestApiDeployment'),
    StageName: 'prod',
    Description: 'Production stage',
    MethodSettings: [{
      ResourcePath: '/*',
      HttpMethod: '*',
      LoggingLevel: 'INFO',
      DataTraceEnabled: true,
      MetricsEnabled: true,
    }],
  }

  if (config.throttling) {
    stageProperties.MethodSettings[0].ThrottlingBurstLimit = config.throttling.burstLimit
    stageProperties.MethodSettings[0].ThrottlingRateLimit = config.throttling.rateLimit
  }

  builder.addResource('RestApiStage', 'AWS::ApiGateway::Stage', stageProperties, {
    dependsOn: ['RestApi', 'RestApiDeployment'],
  })

  // Custom domain
  if (config.customDomain) {
    addApiCustomDomain(builder, 'RestApi', config.customDomain, 'REST')
  }

  // Outputs
  builder.addOutputs({
    RestApiId: {
      Description: 'REST API ID',
      Value: Fn.ref('RestApi'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-rest-api-id'),
      },
    },
    RestApiEndpoint: {
      Description: 'REST API endpoint',
      Value: Fn.sub('https://${RestApi}.execute-api.${AWS::Region}.amazonaws.com/prod'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-rest-api-endpoint'),
      },
    },
  })
}

/**
 * Add WebSocket API
*/
function addWebSocketApi(
  builder: CloudFormationBuilder,
  config: ApiGatewayConfig,
): void {
  // WebSocket API
  builder.addResource('WebSocketApi', 'AWS::ApiGatewayV2::Api', {
    Name: Fn.sub('${AWS::StackName}-websocket-api'),
    ProtocolType: 'WEBSOCKET',
    RouteSelectionExpression: '$request.body.action',
  })

  // Routes (connect, disconnect, default, custom)
  if (config.routes) {
    // Connect route
    if (config.routes.connect) {
      addWebSocketRoute(builder, '$connect', config.routes.connect.functionName)
    }

    // Disconnect route
    if (config.routes.disconnect) {
      addWebSocketRoute(builder, '$disconnect', config.routes.disconnect.functionName)
    }

    // Default route
    if (config.routes.default) {
      addWebSocketRoute(builder, '$default', config.routes.default.functionName)
    }

    // Custom routes
    if (config.routes.custom) {
      config.routes.custom.forEach((route: any) => {
        addWebSocketRoute(builder, route.routeKey, route.functionName)
      })
    }
  }

  // Stage
  builder.addResource('WebSocketApiStage', 'AWS::ApiGatewayV2::Stage', {
    ApiId: Fn.ref('WebSocketApi'),
    StageName: 'prod',
    AutoDeploy: true,
    DefaultRouteSettings: config.throttling ? {
      ThrottlingBurstLimit: config.throttling.burstLimit,
      ThrottlingRateLimit: config.throttling.rateLimit,
    } : undefined,
  }, {
    dependsOn: 'WebSocketApi',
  })

  // Custom domain
  if (config.customDomain) {
    addApiCustomDomain(builder, 'WebSocketApi', config.customDomain, 'WEBSOCKET')
  }

  // Outputs
  builder.addOutputs({
    WebSocketApiId: {
      Description: 'WebSocket API ID',
      Value: Fn.ref('WebSocketApi'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-websocket-api-id'),
      },
    },
    WebSocketApiEndpoint: {
      Description: 'WebSocket API endpoint',
      Value: Fn.getAtt('WebSocketApi', 'ApiEndpoint'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-websocket-api-endpoint'),
      },
    },
  })
}

/**
 * Add WebSocket route
*/
function addWebSocketRoute(
  builder: CloudFormationBuilder,
  routeKey: string,
  functionName: string,
): void {
  const routeId = builder.toLogicalId(`websocket-route-${routeKey}`)
  const integrationId = builder.toLogicalId(`websocket-integration-${routeKey}`)
  const functionLogicalId = builder.toLogicalId(`${functionName}-function`)

  // Integration
  builder.addResource(integrationId, 'AWS::ApiGatewayV2::Integration', {
    ApiId: Fn.ref('WebSocketApi'),
    IntegrationType: 'AWS_PROXY',
    IntegrationUri: Fn.sub(
      `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${${functionLogicalId}.Arn}/invocations`,
    ),
  }, {
    dependsOn: ['WebSocketApi', functionLogicalId],
  })

  // Route
  builder.addResource(routeId, 'AWS::ApiGatewayV2::Route', {
    ApiId: Fn.ref('WebSocketApi'),
    RouteKey: routeKey,
    Target: Fn.join('/', ['integrations', Fn.ref(integrationId)]),
  }, {
    dependsOn: ['WebSocketApi', integrationId],
  })

  // Lambda permission
  builder.addResource(`${routeId}Permission`, 'AWS::Lambda::Permission', {
    FunctionName: Fn.ref(functionLogicalId),
    Action: 'lambda:InvokeFunction',
    Principal: 'apigateway.amazonaws.com',
    SourceArn: Fn.sub(`arn:aws:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${WebSocketApi}/*`),
  }, {
    dependsOn: [functionLogicalId, 'WebSocketApi'],
  })
}

/**
 * Add API Gateway custom domain
*/
function addApiCustomDomain(
  builder: CloudFormationBuilder,
  apiLogicalId: string,
  customDomain: { domain: string, certificateArn: string },
  apiType: 'HTTP' | 'REST' | 'WEBSOCKET',
): void {
  // Domain name
  const domainProperties: any = {
    DomainName: customDomain.domain,
  }

  if (apiType === 'REST') {
    domainProperties.CertificateArn = customDomain.certificateArn
    domainProperties.EndpointConfiguration = {
      Types: ['REGIONAL'],
    }

    builder.addResource('ApiCustomDomain', 'AWS::ApiGateway::DomainName', domainProperties)

    // Base path mapping
    builder.addResource('ApiBasePathMapping', 'AWS::ApiGateway::BasePathMapping', {
      DomainName: Fn.ref('ApiCustomDomain'),
      RestApiId: Fn.ref(apiLogicalId),
      Stage: Fn.ref('RestApiStage'),
    }, {
      dependsOn: ['ApiCustomDomain', apiLogicalId, 'RestApiStage'],
    })
  }
  else {
    // HTTP or WebSocket API
    domainProperties.DomainNameConfigurations = [{
      CertificateArn: customDomain.certificateArn,
      EndpointType: 'REGIONAL',
    }]

    builder.addResource('ApiCustomDomain', 'AWS::ApiGatewayV2::DomainName', domainProperties)

    // API mapping
    builder.addResource('ApiMapping', 'AWS::ApiGatewayV2::ApiMapping', {
      ApiId: Fn.ref(apiLogicalId),
      DomainName: Fn.ref('ApiCustomDomain'),
      Stage: apiType === 'HTTP' ? Fn.ref('HttpApiStage') : Fn.ref('WebSocketApiStage'),
    }, {
      dependsOn: ['ApiCustomDomain', apiLogicalId],
    })
  }

  // Route53 DNS record
  builder.addResource('ApiDNSRecord', 'AWS::Route53::RecordSet', {
    HostedZoneName: Fn.sub(`${extractRootDomain(customDomain.domain)}.`),
    Name: customDomain.domain,
    Type: 'A',
    AliasTarget: {
      HostedZoneId: Fn.getAtt('ApiCustomDomain', 'RegionalHostedZoneId'),
      DNSName: Fn.getAtt('ApiCustomDomain', 'RegionalDomainName'),
      EvaluateTargetHealth: false,
    },
  }, {
    dependsOn: 'ApiCustomDomain',
  })
}

/**
 * Add API Gateway authorizer
*/
function addAuthorizer(
  builder: CloudFormationBuilder,
  apiLogicalId: string,
  config: ApiGatewayConfig['authorizer'],
): void {
  if (!config) return

  if (config.type === 'jwt') {
    builder.addResource('ApiAuthorizer', 'AWS::ApiGatewayV2::Authorizer', {
      ApiId: Fn.ref(apiLogicalId),
      AuthorizerType: 'JWT',
      IdentitySource: [config.identitySource || '$request.header.Authorization'],
      JwtConfiguration: {
        Issuer: config.issuer,
        Audience: config.audience,
      },
      Name: 'JWTAuthorizer',
    }, {
      dependsOn: apiLogicalId,
    })
  }
  else if (config.type === 'lambda') {
    builder.addResource('ApiAuthorizer', 'AWS::ApiGatewayV2::Authorizer', {
      ApiId: Fn.ref(apiLogicalId),
      AuthorizerType: 'REQUEST',
      AuthorizerUri: config.authorizerUri,
      IdentitySource: [config.identitySource || '$request.header.Authorization'],
      Name: 'LambdaAuthorizer',
    }, {
      dependsOn: apiLogicalId,
    })
  }
}

/**
 * Extract root domain from subdomain
*/
function extractRootDomain(domain: string): string {
  const parts = domain.split('.')
  if (parts.length >= 2) {
    return parts.slice(-2).join('.')
  }
  return domain
}
