export const API_VERSION = '1.0.0'

export function openApiDocument(): Record<string, unknown> {
  const error = {
    type: 'object',
    required: ['error'],
    properties: { error: { type: 'object', required: ['code', 'message', 'requestId'], properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string', format: 'uuid' }, details: {} } } },
  }
  const page = (schema: Record<string, unknown>) => ({
    type: 'object', required: ['data', 'page', 'requestId'], properties: { data: { type: 'array', items: schema }, page: { type: 'object', required: ['hasMore'], properties: { nextCursor: { type: 'string' }, hasMore: { type: 'boolean' } } }, requestId: { type: 'string', format: 'uuid' } },
  })
  const listResponses = (schema: Record<string, unknown>) => ({ '200': { description: 'A stable cursor page.', content: { 'application/json': { schema: page(schema) } } }, default: { $ref: '#/components/responses/Error' } })
  return {
    openapi: '3.1.0',
    info: { title: 'ts-cloud API', version: API_VERSION, description: 'Additive changes are released within v1. Breaking request or response changes require a new URL version.' },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/v1/projects': { get: { operationId: 'listProjects', parameters: [{ $ref: '#/components/parameters/Limit' }, { $ref: '#/components/parameters/Cursor' }], responses: listResponses({ $ref: '#/components/schemas/Project' }) } },
      '/api/v1/projects/{projectId}/environments': { get: { operationId: 'listEnvironments', parameters: [{ $ref: '#/components/parameters/ProjectId' }, { $ref: '#/components/parameters/Limit' }, { $ref: '#/components/parameters/Cursor' }], responses: listResponses({ $ref: '#/components/schemas/Environment' }) } },
      '/api/v1/services': { get: { operationId: 'listServices', parameters: [{ name: 'projectId', in: 'query', required: true, schema: { type: 'string' } }, { name: 'environmentId', in: 'query', schema: { type: 'string' } }, { $ref: '#/components/parameters/Limit' }, { $ref: '#/components/parameters/Cursor' }], responses: listResponses({ $ref: '#/components/schemas/Service' }) } },
      '/api/v1/deployments': { post: { operationId: 'createDeployment', parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/DeploymentRequest' } } } }, responses: { '202': { description: 'Queued operation.', content: { 'application/json': { schema: { $ref: '#/components/schemas/OperationResponse' } } } }, default: { $ref: '#/components/responses/Error' } } } },
      '/api/v1/operations': { get: { operationId: 'listOperations', parameters: [{ name: 'projectId', in: 'query', schema: { type: 'string' } }, { $ref: '#/components/parameters/Limit' }, { $ref: '#/components/parameters/Cursor' }], responses: listResponses({ $ref: '#/components/schemas/Operation' }) } },
      '/api/v1/events': { get: { operationId: 'listEvents', parameters: [{ name: 'projectId', in: 'query', schema: { type: 'string' } }, { name: 'after', in: 'query', schema: { type: 'integer', minimum: 0 } }, { $ref: '#/components/parameters/Limit' }], responses: listResponses({ $ref: '#/components/schemas/Event' }) } },
      '/api/v1/events/stream': { get: { operationId: 'streamEvents', responses: { '200': { description: 'Authenticated server-sent event stream.', content: { 'text/event-stream': { schema: { type: 'string' } } } }, default: { $ref: '#/components/responses/Error' } } } },
      '/api/v1/openapi.json': { get: { operationId: 'getOpenApi', security: [], responses: { '200': { description: 'OpenAPI 3.1 contract.' } } } },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'tsc_v1' } },
      parameters: {
        Limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
        Cursor: { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ProjectId: { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
      },
      responses: { Error: { description: 'Stable error envelope.', content: { 'application/json': { schema: error } } } },
      schemas: {
        Project: { type: 'object', required: ['id', 'slug', 'name'], properties: { id: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } } },
        Environment: { type: 'object', required: ['id', 'projectId', 'slug', 'name', 'kind'], properties: { id: { type: 'string' }, projectId: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string' }, region: { type: 'string' } } },
        Service: { type: 'object', required: ['id', 'projectId', 'kind', 'slug', 'name'], properties: { id: { type: 'string' }, projectId: { type: 'string' }, environmentId: { type: 'string' }, kind: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string' }, metadata: { type: 'object', additionalProperties: true } } },
        DeploymentRequest: { type: 'object', additionalProperties: false, required: ['projectId', 'environmentId'], properties: { projectId: { type: 'string' }, environmentId: { type: 'string' }, serviceId: { type: 'string' }, action: { type: 'string', enum: ['deploy', 'rollback'], default: 'deploy' }, revision: { type: 'string' } } },
        Operation: { type: 'object', required: ['id', 'state', 'kind', 'correlationId', 'createdAt'], properties: { id: { type: 'string' }, state: { type: 'string' }, kind: { type: 'string' }, correlationId: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' } } },
        OperationResponse: { type: 'object', required: ['operation', 'idempotentReplay', 'requestId'], properties: { operation: { $ref: '#/components/schemas/Operation' }, idempotentReplay: { type: 'boolean' }, requestId: { type: 'string', format: 'uuid' } } },
        Event: { type: 'object', required: ['id', 'sequence', 'type', 'level', 'correlationId', 'createdAt'], properties: { id: { type: 'string' }, sequence: { type: 'integer' }, type: { type: 'string' }, level: { type: 'string' }, correlationId: { type: 'string' }, payload: {}, createdAt: { type: 'string', format: 'date-time' } } },
      },
    },
  }
}
