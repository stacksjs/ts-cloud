import type { CloudConfig } from '@stacksjs/ts-cloud-types'

/**
 * Real-time App Preset
 * Perfect for: Chat apps, collaborative tools, live dashboards, gaming backends
 * Includes: API Gateway WebSocket + Lambda + DynamoDB Streams
*/
export function createRealtimeAppPreset(options: {
  name: string
  slug: string
  domain?: string
}): Partial<CloudConfig> {
  const { name, slug, domain } = options

  return {
    project: {
      name,
      slug,
      region: 'us-east-1',
    },
    mode: 'serverless',
    environments: {
      production: {
        type: 'production',
        domain,
      },
    },
    infrastructure: {
      apiGateway: {
        type: 'websocket',
        customDomain: domain ? {
          domain,
          certificateArn: 'TO_BE_GENERATED',
        } : undefined,
        routes: [
          {
            path: '$connect',
            method: 'WEBSOCKET',
            integration: 'websocket-connect',
          },
          {
            path: '$disconnect',
            method: 'WEBSOCKET',
            integration: 'websocket-disconnect',
          },
          {
            path: '$default',
            method: 'WEBSOCKET',
            integration: 'websocket-default',
          },
          {
            path: 'sendMessage',
            method: 'WEBSOCKET',
            integration: 'websocket-send-message',
          },
          {
            path: 'joinRoom',
            method: 'WEBSOCKET',
            integration: 'websocket-join-room',
          },
        ],
      },
      functions: {
        connect: {
          runtime: 'nodejs20.x',
          handler: 'dist/websocket/connect.handler',
          memory: 512,
          timeout: 30,
        },
        disconnect: {
          runtime: 'nodejs20.x',
          handler: 'dist/websocket/disconnect.handler',
          memory: 512,
          timeout: 30,
        },
        default: {
          runtime: 'nodejs20.x',
          handler: 'dist/websocket/default.handler',
          memory: 512,
          timeout: 30,
        },
        'send-message': {
          runtime: 'nodejs20.x',
          handler: 'dist/websocket/sendMessage.handler',
          memory: 512,
          timeout: 30,
        },
        'join-room': {
          runtime: 'nodejs20.x',
          handler: 'dist/websocket/joinRoom.handler',
          memory: 512,
          timeout: 30,
        },
        // Stream processor for broadcasting
        broadcast: {
          runtime: 'nodejs20.x',
          handler: 'dist/streams/broadcast.handler',
          memory: 1024,
          timeout: 60,
          events: [{
            type: 'dynamodb-stream',
            tableName: `${slug}-messages`,
            startingPosition: 'LATEST',
            batchSize: 100,
          }],
        },
      },
      databases: {
        dynamodb: {
          tables: {
            [`${slug}-connections`]: {
              partitionKey: { name: 'connectionId', type: 'S' },
              billingMode: 'PAY_PER_REQUEST',
              globalSecondaryIndexes: [{
                name: 'RoomIndex',
                partitionKey: { name: 'roomId', type: 'S' },
                sortKey: { name: 'connectionId', type: 'S' },
                projection: 'ALL',
              }],
            },
            [`${slug}-messages`]: {
              partitionKey: { name: 'roomId', type: 'S' },
              sortKey: { name: 'timestamp', type: 'S' },
              billingMode: 'PAY_PER_REQUEST',
              streamEnabled: true,
              pointInTimeRecovery: true,
              globalSecondaryIndexes: [{
                name: 'UserIndex',
                partitionKey: { name: 'userId', type: 'S' },
                sortKey: { name: 'timestamp', type: 'S' },
                projection: 'ALL',
              }],
            },
            [`${slug}-rooms`]: {
              partitionKey: { name: 'roomId', type: 'S' },
              billingMode: 'PAY_PER_REQUEST',
            },
          },
        },
      },
      cache: {
        elasticache: {
          nodeType: 'cache.t3.small',
          numCacheNodes: 2,
          engine: 'redis',
          engineVersion: '7.0',
          // For connection state and rate limiting
        },
      },
      monitoring: {
        alarms: [{
          metric: 'WebSocketConnections',
          threshold: 10000,
          evaluationPeriods: 1,
        }, {
          metric: 'IntegrationLatency',
          threshold: 1000, // 1 second
          evaluationPeriods: 2,
        }],
        dashboard: {
          name: `${slug}-realtime`,
          widgets: [{
            type: 'metric',
            metrics: [
              'WebSocketConnections',
              'MessagesSent',
              'IntegrationLatency',
            ],
          }],
        },
      },
      security: {
        certificate: domain ? {
          domain,
          validationMethod: 'DNS',
        } : undefined,
        waf: {
          enabled: true,
          rules: ['rateLimit', 'connectionLimit'],
        },
      },
    },
  }
}
