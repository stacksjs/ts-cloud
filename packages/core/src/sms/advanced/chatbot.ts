/**
 * SMS Chatbot Integration
 *
 * Provides conversational SMS with AI/rule-based responses
 */

export interface ChatbotConfig {
  enabled: boolean
  provider: 'rules' | 'bedrock' | 'openai' | 'custom'
  welcomeMessage?: string
  fallbackMessage?: string
  sessionTimeout?: number
  maxTurns?: number
}

export interface ChatSession {
  sessionId: string
  phoneNumber: string
  startedAt: string
  lastMessageAt: string
  turnCount: number
  context: Record<string, any>
  status: 'active' | 'ended' | 'timeout'
}

export interface ChatRule {
  id: string
  priority: number
  patterns: string[]
  response: string
  action?: 'respond' | 'transfer' | 'end' | 'webhook'
  actionParams?: Record<string, any>
}

/**
 * SMS Chatbot Module
 */
export class SmsChatbot {
  /**
   * Lambda code for chatbot processing
   */
  static ChatbotProcessorCode: string = [
    `const { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, ScanCommand } = require('@aws-sdk/client-dynamodb');`,
    `const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');`,
    `const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');`,
    '',
    'const dynamodb = new DynamoDBClient({});',
    'const bedrock = new BedrockRuntimeClient({});',
    'const sns = new SNSClient({});',
    '',
    'const SESSIONS_TABLE = process.env.SESSIONS_TABLE;',
    'const RULES_TABLE = process.env.RULES_TABLE;',
    `const CHATBOT_CONFIG = JSON.parse(process.env.CHATBOT_CONFIG || '{}');`,
    '',
    'exports.handler = async (event) => {',
    `  console.log('Chatbot event:', JSON.stringify(event, null, 2));`,
    '  for (const record of event.Records) {',
    '    try {',
    `      const message = JSON.parse(record.Sns?.Message || record.body || '{}');`,
    '      const { originationNumber, messageBody } = message;',
    '      if (!originationNumber || !messageBody) continue;',
    '      const response = await processMessage(originationNumber, messageBody.trim());',
    '      await sendResponse(originationNumber, response);',
    '    } catch (error) {',
    `      console.error('Error:', error);`,
    '    }',
    '  }',
    '  return { statusCode: 200 };',
    '};',
    '',
    'async function processMessage(phoneNumber, message) {',
    '  const rules = await getRules();',
    '  const lowerMessage = message.toLowerCase();',
    '  for (const rule of rules) {',
    '    for (const pattern of rule.patterns) {',
    `      if (new RegExp(pattern, 'i').test(lowerMessage)) {`,
    '        return rule.response;',
    '      }',
    '    }',
    '  }',
    `  return CHATBOT_CONFIG.fallbackMessage || 'Sorry, I did not understand. Please try again.';`,
    '}',
    '',
    'async function getRules() {',
    '  const result = await dynamodb.send(new ScanCommand({ TableName: RULES_TABLE }));',
    '  return (result.Items || []).map(item => ({',
    `    patterns: JSON.parse(item.patterns?.S || '[]'),`,
    `    response: item.response?.S || '',`,
    '  })).sort((a, b) => (a.priority || 0) - (b.priority || 0));',
    '}',
    '',
    'async function sendResponse(phoneNumber, message) {',
    '  await sns.send(new PublishCommand({',
    '    PhoneNumber: phoneNumber,',
    '    Message: message.substring(0, 1600),',
    '    MessageAttributes: {',
    `      'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },`,
    '    },',
    '  }));',
    '}',
  ].join('\n')

  /**
   * Create sessions DynamoDB table
   */
  static createSessionsTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}ChatbotSessionsTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-chatbot-sessions`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'phoneNumber', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'phoneNumber', KeyType: 'HASH' },
          ],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
        },
      },
    }
  }

  /**
   * Create chatbot rules table
   */
  static createRulesTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}ChatbotRulesTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-chatbot-rules`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'id', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'id', KeyType: 'HASH' },
          ],
        },
      },
    }
  }

  /**
   * Create chatbot processor Lambda
   */
  static createChatbotProcessorLambda(config: {
    slug: string
    roleArn: string
    sessionsTable: string
    rulesTable: string
    chatbotConfig: ChatbotConfig
    originationNumber?: string
  }): Record<string, any> {
    return {
      [`${config.slug}ChatbotProcessorLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-chatbot-processor`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 30,
          MemorySize: 256,
          Code: {
            ZipFile: SmsChatbot.ChatbotProcessorCode,
          },
          Environment: {
            Variables: {
              SESSIONS_TABLE: config.sessionsTable,
              RULES_TABLE: config.rulesTable,
              CHATBOT_CONFIG: JSON.stringify(config.chatbotConfig),
              ORIGINATION_NUMBER: config.originationNumber || '',
            },
          },
        },
      },
    }
  }

  /**
   * Built-in chatbot rules
   */
  static readonly DefaultRules: ChatRule[] = [
    {
      id: 'greeting',
      priority: 1,
      patterns: ['^(hi|hello|hey|howdy)$', '^good (morning|afternoon|evening)'],
      response: 'Hello! How can I help you today?',
    },
    {
      id: 'help',
      priority: 2,
      patterns: ['^help$', 'what can you do', 'how does this work'],
      response: 'I can help with: 1) Account info 2) Support 3) Hours. Reply with a number.',
    },
    {
      id: 'hours',
      priority: 3,
      patterns: ['hours', 'open', 'when are you'],
      response: 'We are open Mon-Fri 9am-5pm EST. Closed weekends.',
    },
    {
      id: 'thanks',
      priority: 4,
      patterns: ['^(thanks|thank you|thx)'],
      response: `You're welcome! Is there anything else I can help with?`,
    },
    {
      id: 'bye',
      priority: 5,
      patterns: ['^(bye|goodbye|quit|exit|stop)$'],
      response: 'Goodbye! Text us anytime if you need help.',
      action: 'end',
    },
  ]
}

export default SmsChatbot
