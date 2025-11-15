import { describe, expect, it } from 'bun:test'
import { ApiGateway } from '../src/modules/api'
import { TemplateBuilder } from '../src/template-builder'

describe('API Gateway Module', () => {
  describe('createRestApi', () => {
    it('should create REST API with default settings', () => {
      const { restApi, logicalId } = ApiGateway.createRestApi({
        slug: 'my-app',
        environment: 'production',
      })

      expect(restApi.Type).toBe('AWS::ApiGateway::RestApi')
      expect(restApi.Properties.Name).toBeDefined()
      expect(restApi.Properties.EndpointConfiguration?.Types).toEqual(['REGIONAL'])
      expect(restApi.Properties.Tags).toHaveLength(2)
      expect(logicalId).toBeDefined()
    })

    it('should support custom API name', () => {
      const { restApi } = ApiGateway.createRestApi({
        slug: 'my-app',
        environment: 'production',
        name: 'CustomAPI',
      })

      expect(restApi.Properties.Name).toBe('CustomAPI')
    })

    it('should support edge endpoint type', () => {
      const { restApi } = ApiGateway.createRestApi({
        slug: 'my-app',
        environment: 'production',
        endpointType: 'EDGE',
      })

      expect(restApi.Properties.EndpointConfiguration?.Types).toEqual(['EDGE'])
    })

    it('should support private endpoint type', () => {
      const { restApi } = ApiGateway.createRestApi({
        slug: 'my-app',
        environment: 'production',
        endpointType: 'PRIVATE',
      })

      expect(restApi.Properties.EndpointConfiguration?.Types).toEqual(['PRIVATE'])
    })

    it('should support binary media types', () => {
      const { restApi } = ApiGateway.createRestApi({
        slug: 'my-app',
        environment: 'production',
        binaryMediaTypes: ['image/png', 'image/jpeg'],
      })

      expect(restApi.Properties.BinaryMediaTypes).toEqual(['image/png', 'image/jpeg'])
    })

    it('should support compression', () => {
      const { restApi } = ApiGateway.createRestApi({
        slug: 'my-app',
        environment: 'production',
        compressionSize: 1024,
      })

      expect(restApi.Properties.MinimumCompressionSize).toBe(1024)
    })

    it('should support description', () => {
      const { restApi } = ApiGateway.createRestApi({
        slug: 'my-app',
        environment: 'production',
        description: 'My REST API',
      })

      expect(restApi.Properties.Description).toBe('My REST API')
    })
  })

  describe('createHttpApi', () => {
    it('should create HTTP API with default settings', () => {
      const { httpApi, logicalId } = ApiGateway.createHttpApi({
        slug: 'my-app',
        environment: 'production',
      })

      expect(httpApi.Type).toBe('AWS::ApiGatewayV2::Api')
      expect(httpApi.Properties.ProtocolType).toBe('HTTP')
      expect(httpApi.Properties.CorsConfiguration).toBeDefined()
      expect(httpApi.Properties.CorsConfiguration?.AllowOrigins).toEqual(['*'])
      expect(httpApi.Properties.Tags?.Name).toBeDefined()
      expect(logicalId).toBeDefined()
    })

    it('should support custom CORS configuration', () => {
      const { httpApi } = ApiGateway.createHttpApi({
        slug: 'my-app',
        environment: 'production',
        corsOrigins: ['https://example.com'],
        corsMethods: ['GET', 'POST'],
        corsHeaders: ['Content-Type', 'Authorization'],
        corsMaxAge: 3600,
        corsAllowCredentials: true,
      })

      expect(httpApi.Properties.CorsConfiguration?.AllowOrigins).toEqual(['https://example.com'])
      expect(httpApi.Properties.CorsConfiguration?.AllowMethods).toEqual(['GET', 'POST'])
      expect(httpApi.Properties.CorsConfiguration?.AllowHeaders).toEqual(['Content-Type', 'Authorization'])
      expect(httpApi.Properties.CorsConfiguration?.MaxAge).toBe(3600)
      expect(httpApi.Properties.CorsConfiguration?.AllowCredentials).toBe(true)
    })

    it('should support disabling CORS', () => {
      const { httpApi } = ApiGateway.createHttpApi({
        slug: 'my-app',
        environment: 'production',
        corsEnabled: false,
      })

      expect(httpApi.Properties.CorsConfiguration).toBeUndefined()
    })

    it('should support custom name and description', () => {
      const { httpApi } = ApiGateway.createHttpApi({
        slug: 'my-app',
        environment: 'production',
        name: 'CustomHTTPAPI',
        description: 'My HTTP API',
      })

      expect(httpApi.Properties.Name).toBe('CustomHTTPAPI')
      expect(httpApi.Properties.Description).toBe('My HTTP API')
    })
  })

  describe('createWebSocketApi', () => {
    it('should create WebSocket API', () => {
      const { webSocketApi, logicalId } = ApiGateway.createWebSocketApi({
        slug: 'my-app',
        environment: 'production',
      })

      expect(webSocketApi.Type).toBe('AWS::ApiGatewayV2::Api')
      expect(webSocketApi.Properties.ProtocolType).toBe('WEBSOCKET')
      expect(webSocketApi.Properties.Tags?.Name).toBeDefined()
      expect(logicalId).toBeDefined()
    })

    it('should support custom name and description', () => {
      const { webSocketApi } = ApiGateway.createWebSocketApi({
        slug: 'my-app',
        environment: 'production',
        name: 'CustomWebSocketAPI',
        description: 'My WebSocket API',
      })

      expect(webSocketApi.Properties.Name).toBe('CustomWebSocketAPI')
      expect(webSocketApi.Properties.Description).toBe('My WebSocket API')
    })
  })

  describe('createDeployment', () => {
    it('should create deployment for REST API', () => {
      const { deployment, logicalId } = ApiGateway.createDeployment('rest-api-id', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(deployment.Type).toBe('AWS::ApiGateway::Deployment')
      expect(deployment.Properties.RestApiId).toMatchObject({ Ref: 'rest-api-id' })
      expect(logicalId).toBeDefined()
    })

    it('should support custom description', () => {
      const { deployment } = ApiGateway.createDeployment('rest-api-id', {
        slug: 'my-app',
        environment: 'production',
        description: 'Production deployment',
      })

      expect(deployment.Properties.Description).toBe('Production deployment')
    })
  })

  describe('createStage', () => {
    it('should create stage with default settings', () => {
      const { stage, logicalId } = ApiGateway.createStage('rest-api-id', 'deployment-id', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(stage.Type).toBe('AWS::ApiGateway::Stage')
      expect(stage.Properties.StageName).toBe('production')
      expect(stage.Properties.RestApiId).toMatchObject({ Ref: 'rest-api-id' })
      expect(stage.Properties.DeploymentId).toMatchObject({ Ref: 'deployment-id' })
      expect(stage.Properties.CacheClusterEnabled).toBe(false)
      expect(logicalId).toBeDefined()
    })

    it('should support custom stage name', () => {
      const { stage } = ApiGateway.createStage('rest-api-id', 'deployment-id', {
        slug: 'my-app',
        environment: 'production',
        stageName: 'v1',
      })

      expect(stage.Properties.StageName).toBe('v1')
    })

    it('should support caching', () => {
      const { stage } = ApiGateway.createStage('rest-api-id', 'deployment-id', {
        slug: 'my-app',
        environment: 'production',
        cacheEnabled: true,
        cacheSize: '1.6',
      })

      expect(stage.Properties.CacheClusterEnabled).toBe(true)
      expect(stage.Properties.CacheClusterSize).toBe('1.6')
    })

    it('should support stage variables', () => {
      const { stage } = ApiGateway.createStage('rest-api-id', 'deployment-id', {
        slug: 'my-app',
        environment: 'production',
        variables: {
          lambdaAlias: 'prod',
          dbEndpoint: 'prod.db.example.com',
        },
      })

      expect(stage.Properties.Variables).toEqual({
        lambdaAlias: 'prod',
        dbEndpoint: 'prod.db.example.com',
      })
    })

    it('should support throttling', () => {
      const { stage } = ApiGateway.createStage('rest-api-id', 'deployment-id', {
        slug: 'my-app',
        environment: 'production',
        throttling: {
          burstLimit: 1000,
          rateLimit: 500,
        },
      })

      expect(stage.Properties.MethodSettings).toHaveLength(1)
      expect(stage.Properties.MethodSettings![0].ThrottlingBurstLimit).toBe(1000)
      expect(stage.Properties.MethodSettings![0].ThrottlingRateLimit).toBe(500)
    })
  })

  describe('createAuthorizer', () => {
    it('should create Lambda TOKEN authorizer', () => {
      const { authorizer, logicalId } = ApiGateway.createAuthorizer('rest-api-id', {
        slug: 'my-app',
        environment: 'production',
        type: 'TOKEN',
        functionArn: 'arn:aws:lambda:us-east-1:123456789:function:authorizer',
      })

      expect(authorizer.Type).toBe('AWS::ApiGateway::Authorizer')
      expect(authorizer.Properties.Type).toBe('TOKEN')
      expect(authorizer.Properties.AuthorizerUri).toBe('arn:aws:lambda:us-east-1:123456789:function:authorizer')
      expect(authorizer.Properties.IdentitySource).toBe('method.request.header.Authorization')
      expect(authorizer.Properties.AuthorizerResultTtlInSeconds).toBe(300)
      expect(logicalId).toBeDefined()
    })

    it('should create Lambda REQUEST authorizer', () => {
      const { authorizer } = ApiGateway.createAuthorizer('rest-api-id', {
        slug: 'my-app',
        environment: 'production',
        type: 'REQUEST',
        functionArn: 'arn:aws:lambda:us-east-1:123456789:function:authorizer',
        identitySource: 'method.request.header.CustomHeader',
      })

      expect(authorizer.Properties.Type).toBe('REQUEST')
      expect(authorizer.Properties.IdentitySource).toBe('method.request.header.CustomHeader')
    })

    it('should create Cognito authorizer', () => {
      const { authorizer } = ApiGateway.createAuthorizer('rest-api-id', {
        slug: 'my-app',
        environment: 'production',
        type: 'COGNITO_USER_POOLS',
        userPoolArns: ['arn:aws:cognito-idp:us-east-1:123456789:userpool/us-east-1_ABC123'],
      })

      expect(authorizer.Properties.Type).toBe('COGNITO_USER_POOLS')
      expect(authorizer.Properties.ProviderARNs).toEqual(['arn:aws:cognito-idp:us-east-1:123456789:userpool/us-east-1_ABC123'])
    })

    it('should support custom TTL', () => {
      const { authorizer } = ApiGateway.createAuthorizer('rest-api-id', {
        slug: 'my-app',
        environment: 'production',
        type: 'TOKEN',
        functionArn: 'arn:aws:lambda:us-east-1:123456789:function:authorizer',
        ttl: 600,
      })

      expect(authorizer.Properties.AuthorizerResultTtlInSeconds).toBe(600)
    })

    it('should throw error when Lambda authorizer missing functionArn', () => {
      expect(() => {
        ApiGateway.createAuthorizer('rest-api-id', {
          slug: 'my-app',
          environment: 'production',
          type: 'TOKEN',
        })
      }).toThrow('Lambda authorizer requires functionArn')
    })

    it('should throw error when Cognito authorizer missing userPoolArns', () => {
      expect(() => {
        ApiGateway.createAuthorizer('rest-api-id', {
          slug: 'my-app',
          environment: 'production',
          type: 'COGNITO_USER_POOLS',
        })
      }).toThrow('Cognito authorizer requires userPoolArns')
    })
  })

  describe('setCors', () => {
    it('should set CORS on HTTP API', () => {
      const { httpApi } = ApiGateway.createHttpApi({
        slug: 'my-app',
        environment: 'production',
        corsEnabled: false,
      })

      ApiGateway.setCors(httpApi, {
        origins: ['https://example.com'],
        methods: ['GET', 'POST'],
        headers: ['Content-Type'],
      })

      expect(httpApi.Properties.CorsConfiguration?.AllowOrigins).toEqual(['https://example.com'])
      expect(httpApi.Properties.CorsConfiguration?.AllowMethods).toEqual(['GET', 'POST'])
      expect(httpApi.Properties.CorsConfiguration?.AllowHeaders).toEqual(['Content-Type'])
    })
  })

  describe('addThrottling', () => {
    it('should add throttling to stage', () => {
      const { stage } = ApiGateway.createStage('rest-api-id', 'deployment-id', {
        slug: 'my-app',
        environment: 'production',
      })

      ApiGateway.addThrottling(stage, 100, 50)

      expect(stage.Properties.MethodSettings).toHaveLength(1)
      expect(stage.Properties.MethodSettings![0].ThrottlingBurstLimit).toBe(100)
      expect(stage.Properties.MethodSettings![0].ThrottlingRateLimit).toBe(50)
    })
  })

  describe('enableCaching', () => {
    it('should enable caching on stage', () => {
      const { stage } = ApiGateway.createStage('rest-api-id', 'deployment-id', {
        slug: 'my-app',
        environment: 'production',
      })

      ApiGateway.enableCaching(stage, '1.6', 600)

      expect(stage.Properties.CacheClusterEnabled).toBe(true)
      expect(stage.Properties.CacheClusterSize).toBe('1.6')
      expect(stage.Properties.MethodSettings).toHaveLength(1)
      expect(stage.Properties.MethodSettings![0].CachingEnabled).toBe(true)
      expect(stage.Properties.MethodSettings![0].CacheTtlInSeconds).toBe(600)
    })
  })

  describe('CacheSizes', () => {
    it('should provide cache size constants', () => {
      expect(ApiGateway.CacheSizes.Small).toBe('0.5')
      expect(ApiGateway.CacheSizes.Medium).toBe('1.6')
      expect(ApiGateway.CacheSizes.Large).toBe('6.1')
      expect(ApiGateway.CacheSizes.Massive).toBe('237')
    })
  })

  describe('ThrottlingPresets', () => {
    it('should provide throttling presets', () => {
      expect(ApiGateway.ThrottlingPresets.Light).toEqual({ burstLimit: 100, rateLimit: 50 })
      expect(ApiGateway.ThrottlingPresets.Medium).toEqual({ burstLimit: 500, rateLimit: 250 })
      expect(ApiGateway.ThrottlingPresets.Heavy).toEqual({ burstLimit: 2000, rateLimit: 1000 })
      expect(ApiGateway.ThrottlingPresets.Default).toEqual({ burstLimit: 5000, rateLimit: 10000 })
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should create complete REST API infrastructure', () => {
      const template = new TemplateBuilder('REST API Infrastructure')

      // Create REST API
      const { restApi, logicalId: apiId } = ApiGateway.createRestApi({
        slug: 'my-app',
        environment: 'production',
      })

      // Create deployment
      const { deployment, logicalId: deploymentId } = ApiGateway.createDeployment(apiId, {
        slug: 'my-app',
        environment: 'production',
      })

      // Create stage
      const { stage, logicalId: stageId } = ApiGateway.createStage(apiId, deploymentId, {
        slug: 'my-app',
        environment: 'production',
        cacheEnabled: true,
        throttling: ApiGateway.ThrottlingPresets.Medium,
      })

      template.addResource(apiId, restApi)
      template.addResource(deploymentId, deployment)
      template.addResource(stageId, stage)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(3)
      expect(result.Resources[apiId].Type).toBe('AWS::ApiGateway::RestApi')
      expect(result.Resources[deploymentId].Type).toBe('AWS::ApiGateway::Deployment')
      expect(result.Resources[stageId].Type).toBe('AWS::ApiGateway::Stage')
    })

    it('should create HTTP API with CORS', () => {
      const template = new TemplateBuilder('HTTP API')

      const { httpApi, logicalId } = ApiGateway.createHttpApi({
        slug: 'my-app',
        environment: 'production',
        corsOrigins: ['https://example.com', 'https://app.example.com'],
        corsMethods: ['GET', 'POST', 'PUT', 'DELETE'],
      })

      template.addResource(logicalId, httpApi)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(1)
      expect(result.Resources[logicalId].Properties.CorsConfiguration.AllowOrigins).toHaveLength(2)
    })

    it('should create WebSocket API', () => {
      const template = new TemplateBuilder('WebSocket API')

      const { webSocketApi, logicalId } = ApiGateway.createWebSocketApi({
        slug: 'chat-app',
        environment: 'production',
      })

      template.addResource(logicalId, webSocketApi)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(1)
      expect(result.Resources[logicalId].Properties.ProtocolType).toBe('WEBSOCKET')
    })

    it('should create REST API with authorizer', () => {
      const template = new TemplateBuilder('REST API with Auth')

      const { restApi, logicalId: apiId } = ApiGateway.createRestApi({
        slug: 'my-app',
        environment: 'production',
      })

      const { authorizer, logicalId: authId } = ApiGateway.createAuthorizer(apiId, {
        slug: 'my-app',
        environment: 'production',
        type: 'TOKEN',
        functionArn: 'arn:aws:lambda:us-east-1:123456789:function:authorizer',
      })

      template.addResource(apiId, restApi)
      template.addResource(authId, authorizer)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(2)
      expect(result.Resources[authId].Properties.Type).toBe('TOKEN')
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('API Test')

      const { httpApi, logicalId } = ApiGateway.createHttpApi({
        slug: 'test',
        environment: 'development',
      })

      template.addResource(logicalId, httpApi)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::ApiGatewayV2::Api')
      expect(parsed.Resources[logicalId].Properties.ProtocolType).toBe('HTTP')
    })
  })
})
