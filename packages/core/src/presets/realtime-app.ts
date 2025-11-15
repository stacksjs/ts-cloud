import type { CloudConfig } from '@ts-cloud/types'

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
        routes: {
          connect: {
            functionName: 'websocket-connect',
          },
          disconnect: {
            functionName: 'websocket-disconnect',
          },
          default: {
            functionName: 'websocket-default',
          },
          custom: [{
            routeKey: 'sendMessage',
            functionName: 'websocket-send-message',
          }, {
            routeKey: 'joinRoom',
            functionName: 'websocket-join-room',
          }],
        },
      },
      functions: {
        websocket: [{
          name: 'connect',
          runtime: 'nodejs20.x',
          handler: 'dist/websocket/connect.handler',
          memory: 512,
          timeout: 30,
        }, {
          name: 'disconnect',
          runtime: 'nodejs20.x',
          handler: 'dist/websocket/disconnect.handler',
          memory: 512,
          timeout: 30,
        }, {
          name: 'default',
          runtime: 'nodejs20.x',
          handler: 'dist/websocket/default.handler',
          memory: 512,
          timeout: 30,
        }, {
          name: 'send-message',
          runtime: 'nodejs20.x',
          handler: 'dist/websocket/sendMessage.handler',
          memory: 512,
          timeout: 30,
        }, {
          name: 'join-room',
          runtime: 'nodejs20.x',
          handler: 'dist/websocket/joinRoom.handler',
          memory: 512,
          timeout: 30,
        }],
        // Stream processor for broadcasting
        streams: [{
          name: 'broadcast',
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
        }],
      },
      database: {
        dynamodb: {
          tables: [{
            name: `${slug}-connections`,
            partitionKey: 'connectionId',
            billingMode: 'PAY_PER_REQUEST',
            ttl: {
              enabled: true,
              attributeName: 'ttl',
            },
            globalSecondaryIndexes: [{
              name: 'RoomIndex',
              partitionKey: 'roomId',
              sortKey: 'connectionId',
              projectionType: 'ALL',
            }],
          }, {
            name: `${slug}-messages`,
            partitionKey: 'roomId',
            sortKey: 'timestamp',
            billingMode: 'PAY_PER_REQUEST',
            streamEnabled: true,
            pointInTimeRecovery: true,
            globalSecondaryIndexes: [{
              name: 'UserIndex',
              partitionKey: 'userId',
              sortKey: 'timestamp',
              projectionType: 'ALL',
            }],
          }, {
            name: `${slug}-rooms`,
            partitionKey: 'roomId',
            billingMode: 'PAY_PER_REQUEST',
          }],
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
