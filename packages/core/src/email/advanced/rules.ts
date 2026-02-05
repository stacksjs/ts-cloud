/**
 * Email Rules and Automation
 *
 * Provides email filtering, routing, and automation
*/

export interface EmailRule {
  id: string
  name: string
  enabled: boolean
  priority: number
  conditions: RuleCondition[]
  conditionOperator: 'and' | 'or'
  actions: RuleAction[]
  createdAt: string
  updatedAt: string
}

export interface RuleCondition {
  field: 'from' | 'to' | 'subject' | 'body' | 'headers' | 'attachments' | 'size'
  operator: 'contains' | 'not-contains' | 'equals' | 'not-equals' | 'starts-with' | 'ends-with' | 'regex' | 'greater-than' | 'less-than'
  value: string
  caseSensitive?: boolean
}

export interface RuleAction {
  type: 'move' | 'copy' | 'delete' | 'label' | 'forward' | 'reply' | 'mark-read' | 'mark-starred' | 'webhook' | 'lambda'
  params: Record<string, any>
}

export interface AutomationWorkflow {
  id: string
  name: string
  trigger: WorkflowTrigger
  steps: WorkflowStep[]
  enabled: boolean
}

export interface WorkflowTrigger {
  type: 'email-received' | 'email-sent' | 'schedule' | 'webhook'
  conditions?: RuleCondition[]
}

export interface WorkflowStep {
  id: string
  type: 'delay' | 'condition' | 'action' | 'loop'
  config: Record<string, any>
  next?: string
  onTrue?: string
  onFalse?: string
}

/**
 * Email Rules Module
*/
export class EmailRules {
  /**
   * Lambda code for rule processing
  */
  static RuleProcessorCode = `
const { S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');

const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});
const lambda = new LambdaClient({});
const ses = new SESClient({});

const EMAIL_BUCKET = process.env.EMAIL_BUCKET;
const RULES_TABLE = process.env.RULES_TABLE;

exports.handler = async (event) => {
  console.log('Rule processor event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      const bucket = record.s3?.bucket?.name || EMAIL_BUCKET;
      const key = decodeURIComponent(record.s3?.object?.key?.replace(/\\+/g, ' ') || '');

      if (!key.endsWith('/metadata.json')) continue;

      // Get email metadata
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const metadata = JSON.parse(await result.Body.transformToString());

      // Get mailbox path
      const pathParts = key.split('/');
      const domain = pathParts[1];
      const localPart = pathParts[2];
      const mailbox = \`\${localPart}@\${domain}\`;

      // Get rules for this mailbox
      const rules = await getRules(mailbox);

      // Process rules in priority order
      for (const rule of rules) {
        if (!rule.enabled) continue;

        const matches = evaluateConditions(metadata, rule.conditions, rule.conditionOperator);
        if (!matches) continue;

        console.log(\`Rule matched: \${rule.name}\`);

        // Execute actions
        for (const action of rule.actions) {
          await executeAction(action, metadata, bucket, key, mailbox);
        }

        // Stop processing if rule says so
        if (rule.stopProcessing) break;
      }
    } catch (error) {
      console.error('Error processing rules:', error);
    }
  }

  return { statusCode: 200 };
};

async function getRules(mailbox) {
  const result = await dynamodb.send(new QueryCommand({
    TableName: RULES_TABLE,
    KeyConditionExpression: 'mailbox = :mailbox',
    ExpressionAttributeValues: {
      ':mailbox': { S: mailbox },
    },
  }));

  const rules = (result.Items || []).map(item => ({
    id: item.id.S,
    name: item.name.S,
    enabled: item.enabled?.BOOL ?? true,
    priority: parseInt(item.priority?.N || '0'),
    conditions: JSON.parse(item.conditions?.S || '[]'),
    conditionOperator: item.conditionOperator?.S || 'and',
    actions: JSON.parse(item.actions?.S || '[]'),
    stopProcessing: item.stopProcessing?.BOOL ?? false,
  }));

  // Sort by priority
  rules.sort((a, b) => a.priority - b.priority);

  return rules;
}

function evaluateConditions(metadata, conditions, operator) {
  if (!conditions || conditions.length === 0) return true;

  const results = conditions.map(condition => evaluateCondition(metadata, condition));

  if (operator === 'or') {
    return results.some(r => r);
  }
  return results.every(r => r);
}

function evaluateCondition(metadata, condition) {
  let value = '';

  switch (condition.field) {
    case 'from':
      value = metadata.from || '';
      break;
    case 'to':
      value = metadata.to || '';
      break;
    case 'subject':
      value = metadata.subject || '';
      break;
    case 'body':
      value = metadata.preview || '';
      break;
    case 'size':
      value = String(metadata.size || 0);
      break;
    default:
      return false;
  }

  const compareValue = condition.caseSensitive ? value : value.toLowerCase();
  const conditionValue = condition.caseSensitive ? condition.value : condition.value.toLowerCase();

  switch (condition.operator) {
    case 'contains':
      return compareValue.includes(conditionValue);
    case 'not-contains':
      return !compareValue.includes(conditionValue);
    case 'equals':
      return compareValue === conditionValue;
    case 'not-equals':
      return compareValue !== conditionValue;
    case 'starts-with':
      return compareValue.startsWith(conditionValue);
    case 'ends-with':
      return compareValue.endsWith(conditionValue);
    case 'regex':
      try {
        const regex = new RegExp(condition.value, condition.caseSensitive ? '' : 'i');
        return regex.test(value);
      } catch {
        return false;
      }
    case 'greater-than':
      return parseFloat(value) > parseFloat(condition.value);
    case 'less-than':
      return parseFloat(value) < parseFloat(condition.value);
    default:
      return false;
  }
}

async function executeAction(action, metadata, bucket, key, mailbox) {
  const basePath = key.replace('/metadata.json', '');

  switch (action.type) {
    case 'move':
      await moveEmail(bucket, basePath, action.params.folder, mailbox);
      break;

    case 'copy':
      await copyEmail(bucket, basePath, action.params.folder, mailbox);
      break;

    case 'delete':
      await deleteEmail(bucket, basePath);
      break;

    case 'label':
      await addLabel(bucket, key, metadata, action.params.label);
      break;

    case 'forward':
      await forwardEmail(bucket, basePath, metadata, action.params.to);
      break;

    case 'mark-read':
      await markAsRead(bucket, key, metadata);
      break;

    case 'mark-starred':
      await markAsStarred(bucket, key, metadata);
      break;

    case 'webhook':
      await callWebhook(action.params.url, metadata);
      break;

    case 'lambda':
      await invokeLambda(action.params.functionName, metadata);
      break;
  }
}

async function moveEmail(bucket, basePath, folder, mailbox) {
  const [localPart, domain] = mailbox.split('@');
  const newBasePath = \`mailboxes/\${domain}/\${localPart}/\${folder}/\${basePath.split('/').pop()}\`;

  // Copy all files
  const files = ['metadata.json', 'raw.eml', 'body.html', 'body.txt', 'preview.txt'];
  for (const file of files) {
    try {
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        CopySource: \`\${bucket}/\${basePath}/\${file}\`,
        Key: \`\${newBasePath}/\${file}\`,
      }));
      await s3.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: \`\${basePath}/\${file}\`,
      }));
    } catch {}
  }
}

async function copyEmail(bucket, basePath, folder, mailbox) {
  const [localPart, domain] = mailbox.split('@');
  const newBasePath = \`mailboxes/\${domain}/\${localPart}/\${folder}/\${basePath.split('/').pop()}\`;

  const files = ['metadata.json', 'raw.eml', 'body.html', 'body.txt', 'preview.txt'];
  for (const file of files) {
    try {
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        CopySource: \`\${bucket}/\${basePath}/\${file}\`,
        Key: \`\${newBasePath}/\${file}\`,
      }));
    } catch {}
  }
}

async function deleteEmail(bucket, basePath) {
  const files = ['metadata.json', 'raw.eml', 'body.html', 'body.txt', 'preview.txt'];
  for (const file of files) {
    try {
      await s3.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: \`\${basePath}/\${file}\`,
      }));
    } catch {}
  }
}

async function addLabel(bucket, key, metadata, label) {
  metadata.labels = metadata.labels || [];
  if (!metadata.labels.includes(label)) {
    metadata.labels.push(label);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(metadata, null, 2),
      ContentType: 'application/json',
    }));
  }
}

async function forwardEmail(bucket, basePath, metadata, to) {
  const rawResult = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: \`\${basePath}/raw.eml\`,
  }));
  const rawEmail = await rawResult.Body.transformToString();

  // Modify headers for forwarding
  const forwardedEmail = \`From: \${metadata.to}\\r\\nTo: \${to}\\r\\nSubject: Fwd: \${metadata.subject}\\r\\n\` + rawEmail.split('\\r\\n\\r\\n').slice(1).join('\\r\\n\\r\\n');

  await ses.send(new SendRawEmailCommand({
    RawMessage: { Data: Buffer.from(forwardedEmail) },
  }));
}

async function markAsRead(bucket, key, metadata) {
  metadata.isRead = true;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(metadata, null, 2),
    ContentType: 'application/json',
  }));
}

async function markAsStarred(bucket, key, metadata) {
  metadata.isStarred = true;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(metadata, null, 2),
    ContentType: 'application/json',
  }));
}

async function callWebhook(url, metadata) {
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'email.rule.matched', data: metadata }),
  });
}

async function invokeLambda(functionName, metadata) {
  await lambda.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'Event',
    Payload: JSON.stringify(metadata),
  }));
}
`

  /**
   * Create rules DynamoDB table
  */
  static createRulesTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}EmailRulesTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-email-rules`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'mailbox', AttributeType: 'S' },
            { AttributeName: 'id', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'mailbox', KeyType: 'HASH' },
            { AttributeName: 'id', KeyType: 'RANGE' },
          ],
        },
      },
    }
  }

  /**
   * Create rule processor Lambda
  */
  static createRuleProcessorLambda(config: {
    slug: string
    roleArn: string
    emailBucket: string
    rulesTable: string
  }): Record<string, any> {
    return {
      [`${config.slug}EmailRuleProcessorLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-email-rule-processor`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 60,
          MemorySize: 256,
          Code: {
            ZipFile: EmailRules.RuleProcessorCode,
          },
          Environment: {
            Variables: {
              EMAIL_BUCKET: config.emailBucket,
              RULES_TABLE: config.rulesTable,
            },
          },
        },
      },
    }
  }

  /**
   * Built-in rule templates
  */
  static readonly RuleTemplates = {
    spamFilter: {
      name: 'Spam Filter',
      conditions: [
        { field: 'subject', operator: 'regex', value: '(viagra|lottery|winner|prince|inheritance)', caseSensitive: false },
      ],
      conditionOperator: 'or',
      actions: [
        { type: 'move', params: { folder: 'spam' } },
        { type: 'mark-read', params: {} },
      ],
    },
    autoLabel: {
      name: 'Auto Label Invoices',
      conditions: [
        { field: 'subject', operator: 'contains', value: 'invoice', caseSensitive: false },
      ],
      conditionOperator: 'and',
      actions: [
        { type: 'label', params: { label: 'invoices' } },
      ],
    },
    forwardUrgent: {
      name: 'Forward Urgent',
      conditions: [
        { field: 'subject', operator: 'contains', value: 'urgent', caseSensitive: false },
      ],
      conditionOperator: 'and',
      actions: [
        { type: 'forward', params: { to: 'admin@example.com' } },
        { type: 'label', params: { label: 'urgent' } },
      ],
    },
  } as const
}

export default EmailRules
