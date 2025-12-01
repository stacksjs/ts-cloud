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
  sessionTimeout?: number // minutes
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
  static ChatbotProcessorCode = `
const { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const dynamodb = new DynamoDBClient({});
const bedrock = new BedrockRuntimeClient({});
const sns = new SNSClient({});

const SESSIONS_TABLE = process.env.SESSIONS_TABLE;
const RULES_TABLE = process.env.RULES_TABLE;
const CHATBOT_CONFIG = JSON.parse(process.env.CHATBOT_CONFIG || '{}');
const ORIGINATION_NUMBER = process.env.ORIGINATION_NUMBER;

const SESSION_TIMEOUT = (CHATBOT_CONFIG.sessionTimeout || 30) * 60 * 1000; // Default 30 minutes

exports.handler = async (event) => {
  console.log('Chatbot processor event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.Sns?.Message || record.body || '{}');
      const { originationNumber, messageBody, destinationNumber } = message;

      if (!originationNumber || !messageBody) continue;

      const phoneNumber = originationNumber;
      const userMessage = messageBody.trim();

      // Get or create session
      let session = await getSession(phoneNumber);
      const isNewSession = !session;

      if (!session) {
        session = await createSession(phoneNumber);

        // Send welcome message
        if (CHATBOT_CONFIG.welcomeMessage) {
          await sendResponse(phoneNumber, CHATBOT_CONFIG.welcomeMessage);
        }
      }

      // Update session
      session = await updateSession(session.sessionId, userMessage);

      // Check max turns
      if (CHATBOT_CONFIG.maxTurns && session.turnCount > CHATBOT_CONFIG.maxTurns) {
        await sendResponse(phoneNumber, CHATBOT_CONFIG.fallbackMessage || 'Session ended. Text again to start a new conversation.');
        await endSession(session.sessionId);
        continue;
      }

      // Process message based on provider
      let response;
      switch (CHATBOT_CONFIG.provider) {
        case 'rules':
          response = await processWithRules(userMessage, session);
          break;
        case 'bedrock':
          response = await processWithBedrock(userMessage, session);
          break;
        case 'openai':
          response = await processWithOpenAI(userMessage, session);
          break;
        default:
          response = CHATBOT_CONFIG.fallbackMessage || 'I didn\\'t understand that. Please try again.';
      }

      // Send response
      await sendResponse(phoneNumber, response);

      console.log(\`Chatbot response to \${phoneNumber}: \${response.substring(0, 100)}...\`);
    } catch (error) {
      console.error('Error processing chatbot message:', error);
    }
  }

  return { statusCode: 200 };
};

async function getSession(phoneNumber) {
  const result = await dynamodb.send(new GetItemCommand({
    TableName: SESSIONS_TABLE,
    Key: { phoneNumber: { S: phoneNumber } },
  }));

  if (!result.Item) return null;

  const session = {
    sessionId: result.Item.sessionId.S,
    phoneNumber: result.Item.phoneNumber.S,
    startedAt: result.Item.startedAt.S,
    lastMessageAt: result.Item.lastMessageAt.S,
    turnCount: parseInt(result.Item.turnCount?.N || '0'),
    context: JSON.parse(result.Item.context?.S || '{}'),
    status: result.Item.status.S,
  };

  // Check timeout
  const lastMessage = new Date(session.lastMessageAt);
  if (Date.now() - lastMessage.getTime() > SESSION_TIMEOUT) {
    await endSession(session.sessionId);
    return null;
  }

  return session;
}

async function createSession(phoneNumber) {
  const sessionId = \`sess-\${Date.now()}-\${Math.random().toString(36).substr(2, 9)}\`;
  const now = new Date().toISOString();

  const session = {
    sessionId,
    phoneNumber,
    startedAt: now,
    lastMessageAt: now,
    turnCount: 0,
    context: {},
    status: 'active',
  };

  await dynamodb.send(new PutItemCommand({
    TableName: SESSIONS_TABLE,
    Item: {
      phoneNumber: { S: phoneNumber },
      sessionId: { S: sessionId },
      startedAt: { S: now },
      lastMessageAt: { S: now },
      turnCount: { N: '0' },
      context: { S: '{}' },
      status: { S: 'active' },
      ttl: { N: String(Math.floor(Date.now() / 1000) + 24 * 60 * 60) },
    },
  }));

  return session;
}

async function updateSession(sessionId, userMessage) {
  const now = new Date().toISOString();

  const result = await dynamodb.send(new UpdateItemCommand({
    TableName: SESSIONS_TABLE,
    Key: { sessionId: { S: sessionId } },
    UpdateExpression: 'SET lastMessageAt = :now, turnCount = turnCount + :one, lastUserMessage = :msg',
    ExpressionAttributeValues: {
      ':now': { S: now },
      ':one': { N: '1' },
      ':msg': { S: userMessage },
    },
    ReturnValues: 'ALL_NEW',
  }));

  return {
    sessionId,
    turnCount: parseInt(result.Attributes?.turnCount?.N || '1'),
    context: JSON.parse(result.Attributes?.context?.S || '{}'),
  };
}

async function endSession(sessionId) {
  await dynamodb.send(new UpdateItemCommand({
    TableName: SESSIONS_TABLE,
    Key: { sessionId: { S: sessionId } },
    UpdateExpression: 'SET #status = :ended',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':ended': { S: 'ended' },
    },
  }));
}

async function processWithRules(message, session) {
  // Get rules
  const result = await dynamodb.send(new ScanCommand({
    TableName: RULES_TABLE,
  }));

  const rules = (result.Items || [])
    .map(item => ({
      id: item.id.S,
      priority: parseInt(item.priority?.N || '0'),
      patterns: JSON.parse(item.patterns?.S || '[]'),
      response: item.response.S,
      action: item.action?.S,
    }))
    .sort((a, b) => a.priority - b.priority);

  const lowerMessage = message.toLowerCase();

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(lowerMessage)) {
        return rule.response;
      }
    }
  }

  return CHATBOT_CONFIG.fallbackMessage || 'I didn\\'t understand that. Please try again.';
}

async function processWithBedrock(message, session) {
  try {
    const prompt = 'You are a helpful SMS assistant. Keep responses brief (under 160 characters when possible). User: ' + message + ' Assistant:';

    const result = await bedrock.send(new InvokeModelCommand({
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    }));

    const response = JSON.parse(new TextDecoder().decode(result.body));
    return response.content?.[0]?.text || CHATBOT_CONFIG.fallbackMessage;
  } catch (error) {
    console.error('Bedrock error:', error);
    return CHATBOT_CONFIG.fallbackMessage || 'Sorry, I encountered an error. Please try again.';
  }
}

async function processWithOpenAI(message, session) {
  // OpenAI integration would require API key configuration
  return CHATBOT_CONFIG.fallbackMessage || 'OpenAI integration not configured.';
}

async function sendResponse(phoneNumber, message) {
  await sns.send(new PublishCommand({
    PhoneNumber: phoneNumber,
    Message: message.substring(0, 1600), // SMS limit
    MessageAttributes: {
      'AWS.SNS.SMS.SMSType': {
        DataType: 'String',
        StringValue: 'Transactional',
      },
    },
  }));
}
\`

  /**
   * Create sessions DynamoDB table
   */
  static createSessionsTable(config: { slug: string }): Record<string, any> {
    return {
      [\`\${config.slug}ChatbotSessionsTable\`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: \`\${config.slug}-chatbot-sessions\`,
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
      [\`\${config.slug}ChatbotRulesTable\`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: \`\${config.slug}-chatbot-rules\`,
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
      [\`\${config.slug}ChatbotProcessorLambda\`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: \`\${config.slug}-chatbot-processor\`,
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
      response: 'You\\'re welcome! Is there anything else I can help with?',
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
