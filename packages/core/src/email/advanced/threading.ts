/**
 * Email Threading and Conversation View
 *
 * Groups emails into conversations based on subject and references
*/

export interface EmailThread {
  threadId: string
  subject: string
  participants: string[]
  messageCount: number
  unreadCount: number
  lastMessageDate: string
  firstMessageDate: string
  messages: ThreadMessage[]
  labels?: string[]
  isStarred?: boolean
}

export interface ThreadMessage {
  messageId: string
  from: string
  fromName?: string
  to: string[]
  cc?: string[]
  date: string
  bodyPreview: string
  isRead: boolean
  hasAttachments: boolean
}

/**
 * Email Threading Module
*/
export class EmailThreading {
  /**
   * Lambda code for threading emails
  */
  static ThreadingLambdaCode = `
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const s3 = new S3Client({});
const EMAIL_BUCKET = process.env.EMAIL_BUCKET;

exports.handler = async (event) => {
  console.log('Email threading event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      const bucket = record.s3?.bucket?.name || EMAIL_BUCKET;
      const key = decodeURIComponent(record.s3?.object?.key?.replace(/\\+/g, ' ') || '');

      if (!key.endsWith('/metadata.json')) continue;

      // Get email metadata
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const metadata = JSON.parse(await result.Body.transformToString());

      // Extract mailbox path
      const pathParts = key.split('/');
      const domain = pathParts[1];
      const localPart = pathParts[2];
      const mailboxPath = \`mailboxes/\${domain}/\${localPart}\`;

      // Generate thread ID from subject
      const threadId = generateThreadId(metadata.subject, metadata.from, metadata.to);

      // Update email metadata with thread ID
      metadata.threadId = threadId;
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(metadata, null, 2),
        ContentType: 'application/json',
      }));

      // Update thread index
      await updateThreadIndex(bucket, mailboxPath, threadId, metadata);

      console.log(\`Threaded email \${metadata.messageId} into thread \${threadId}\`);
    } catch (error) {
      console.error('Error threading email:', error);
    }
  }

  return { statusCode: 200 };
};

function generateThreadId(subject, from, to) {
  // Normalize subject (remove Re:, Fwd:, etc.)
  const normalizedSubject = subject
    .replace(/^(Re|Fwd|Fw|RE|FWD|FW):\\s*/gi, '')
    .trim()
    .toLowerCase();

  // Create hash from normalized subject
  const hash = crypto.createHash('md5')
    .update(normalizedSubject)
    .digest('hex')
    .substring(0, 12);

  return \`thread-\${hash}\`;
}

async function updateThreadIndex(bucket, mailboxPath, threadId, metadata) {
  const threadsKey = \`\${mailboxPath}/threads.json\`;
  let threads = {};

  // Load existing threads
  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: threadsKey,
    }));
    threads = JSON.parse(await result.Body.transformToString());
  } catch {
    // No threads file yet
  }

  // Get or create thread
  if (!threads[threadId]) {
    threads[threadId] = {
      threadId,
      subject: metadata.subject.replace(/^(Re|Fwd|Fw|RE|FWD|FW):\\s*/gi, '').trim(),
      participants: [],
      messageCount: 0,
      unreadCount: 0,
      messages: [],
      firstMessageDate: metadata.date,
      lastMessageDate: metadata.date,
    };
  }

  const thread = threads[threadId];

  // Add participant if not already in list
  if (!thread.participants.includes(metadata.from)) {
    thread.participants.push(metadata.from);
  }

  // Add message to thread
  thread.messages.push({
    messageId: metadata.messageId,
    from: metadata.from,
    fromName: metadata.fromName,
    to: [metadata.to],
    date: metadata.date,
    bodyPreview: metadata.preview || '',
    isRead: false,
    hasAttachments: metadata.hasAttachments || false,
  });

  // Update counts
  thread.messageCount = thread.messages.length;
  thread.unreadCount = thread.messages.filter(m => !m.isRead).length;

  // Update dates
  if (new Date(metadata.date) > new Date(thread.lastMessageDate)) {
    thread.lastMessageDate = metadata.date;
  }
  if (new Date(metadata.date) < new Date(thread.firstMessageDate)) {
    thread.firstMessageDate = metadata.date;
  }

  // Sort messages by date
  thread.messages.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Save threads
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: threadsKey,
    Body: JSON.stringify(threads, null, 2),
    ContentType: 'application/json',
  }));
}
`

  /**
   * Create threading Lambda function
  */
  static createThreadingLambda(config: {
    slug: string
    roleArn: string
    emailBucket: string
  }): Record<string, any> {
    return {
      [`${config.slug}EmailThreadingLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-email-threading`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 60,
          MemorySize: 256,
          Code: {
            ZipFile: EmailThreading.ThreadingLambdaCode,
          },
          Environment: {
            Variables: {
              EMAIL_BUCKET: config.emailBucket,
            },
          },
        },
      },
    }
  }

  /**
   * Get threads for a mailbox (SDK helper)
  */
  static async getThreads(params: {
    s3Client: any
    bucket: string
    mailbox: string
    limit?: number
    offset?: number
  }): Promise<EmailThread[]> {
    const { s3Client, bucket, mailbox, limit = 50, offset = 0 } = params

    const [localPart, domain] = mailbox.includes('@')
      ? mailbox.split('@')
      : [mailbox, 'default']

    const threadsKey = `mailboxes/${domain}/${localPart}/threads.json`

    try {
      const result = await s3Client.send({
        Bucket: bucket,
        Key: threadsKey,
      })

      const threads = JSON.parse(result.Body)
      const threadList = Object.values(threads) as EmailThread[]

      // Sort by last message date
      threadList.sort((a, b) =>
        new Date(b.lastMessageDate).getTime() - new Date(a.lastMessageDate).getTime()
      )

      return threadList.slice(offset, offset + limit)
    }
    catch {
      return []
    }
  }

  /**
   * Get a specific thread
  */
  static async getThread(params: {
    s3Client: any
    bucket: string
    mailbox: string
    threadId: string
  }): Promise<EmailThread | null> {
    const { s3Client, bucket, mailbox, threadId } = params

    const [localPart, domain] = mailbox.includes('@')
      ? mailbox.split('@')
      : [mailbox, 'default']

    const threadsKey = `mailboxes/${domain}/${localPart}/threads.json`

    try {
      const result = await s3Client.send({
        Bucket: bucket,
        Key: threadsKey,
      })

      const threads = JSON.parse(result.Body)
      return threads[threadId] || null
    }
    catch {
      return null
    }
  }
}

export default EmailThreading
