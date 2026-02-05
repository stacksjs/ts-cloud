/**
 * Email Scheduling (Send Later)
 *
 * Provides scheduled email sending functionality
*/

export interface ScheduledEmail {
  id: string
  email: {
    from: string
    to: string | string[]
    cc?: string[]
    bcc?: string[]
    subject: string
    html?: string
    text?: string
    attachments?: Array<{
      filename: string
      content: string
      contentType?: string
    }>
  }
  scheduledFor: string
  timezone?: string
  status: 'pending' | 'sent' | 'failed' | 'cancelled'
  createdAt: string
  sentAt?: string
  error?: string
  retryCount?: number
}

/**
 * Email Scheduling Module
*/
export class EmailScheduling {
  /**
   * Lambda code for processing scheduled emails
  */
  static SchedulerLambdaCode = `
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');

const s3 = new S3Client({});
const ses = new SESClient({});
const EMAIL_BUCKET = process.env.EMAIL_BUCKET;

exports.handler = async (event) => {
  console.log('Email scheduler event:', JSON.stringify(event, null, 2));

  const now = new Date();

  // List scheduled emails
  const listResult = await s3.send(new ListObjectsV2Command({
    Bucket: EMAIL_BUCKET,
    Prefix: 'scheduled/',
  }));

  const objects = listResult.Contents || [];

  for (const obj of objects) {
    if (!obj.Key.endsWith('.json')) continue;

    try {
      // Get scheduled email
      const getResult = await s3.send(new GetObjectCommand({
        Bucket: EMAIL_BUCKET,
        Key: obj.Key,
      }));

      const scheduled = JSON.parse(await getResult.Body.transformToString());

      // Skip if not pending
      if (scheduled.status !== 'pending') continue;

      // Check if it's time to send
      const scheduledTime = new Date(scheduled.scheduledFor);
      if (scheduledTime > now) continue;

      console.log(\`Sending scheduled email: \${scheduled.id}\`);

      try {
        // Build and send email
        const rawMessage = buildRawEmail(scheduled.email);
        const sendResult = await ses.send(new SendRawEmailCommand({
          RawMessage: { Data: Buffer.from(rawMessage) },
        }));

        // Update status to sent
        scheduled.status = 'sent';
        scheduled.sentAt = new Date().toISOString();
        scheduled.messageId = sendResult.MessageId;

        // Move to sent folder
        await s3.send(new PutObjectCommand({
          Bucket: EMAIL_BUCKET,
          Key: \`scheduled-sent/\${scheduled.id}.json\`,
          Body: JSON.stringify(scheduled, null, 2),
          ContentType: 'application/json',
        }));

        // Delete from scheduled folder
        await s3.send(new DeleteObjectCommand({
          Bucket: EMAIL_BUCKET,
          Key: obj.Key,
        }));

        console.log(\`Sent scheduled email: \${scheduled.id}\`);
      } catch (sendError) {
        console.error(\`Failed to send scheduled email: \${scheduled.id}\`, sendError);

        // Update retry count
        scheduled.retryCount = (scheduled.retryCount || 0) + 1;

        if (scheduled.retryCount >= 3) {
          scheduled.status = 'failed';
          scheduled.error = sendError.message;
        }

        await s3.send(new PutObjectCommand({
          Bucket: EMAIL_BUCKET,
          Key: obj.Key,
          Body: JSON.stringify(scheduled, null, 2),
          ContentType: 'application/json',
        }));
      }
    } catch (error) {
      console.error(\`Error processing scheduled email: \${obj.Key}\`, error);
    }
  }

  return { statusCode: 200 };
};

function buildRawEmail(email) {
  const boundary = \`----=_Part_\${Date.now()}\`;
  let raw = '';

  raw += \`From: \${email.from}\\r\\n\`;
  raw += \`To: \${Array.isArray(email.to) ? email.to.join(', ') : email.to}\\r\\n\`;
  if (email.cc) raw += \`Cc: \${email.cc.join(', ')}\\r\\n\`;
  raw += \`Subject: =?UTF-8?B?\${Buffer.from(email.subject).toString('base64')}?=\\r\\n\`;
  raw += \`Date: \${new Date().toUTCString()}\\r\\n\`;
  raw += 'MIME-Version: 1.0\\r\\n';

  if (email.html && email.text) {
    raw += \`Content-Type: multipart/alternative; boundary="\${boundary}"\\r\\n\\r\\n\`;
    raw += \`--\${boundary}\\r\\n\`;
    raw += 'Content-Type: text/plain; charset=UTF-8\\r\\n\\r\\n';
    raw += email.text + '\\r\\n\\r\\n';
    raw += \`--\${boundary}\\r\\n\`;
    raw += 'Content-Type: text/html; charset=UTF-8\\r\\n\\r\\n';
    raw += email.html + '\\r\\n\\r\\n';
    raw += \`--\${boundary}--\\r\\n\`;
  } else if (email.html) {
    raw += 'Content-Type: text/html; charset=UTF-8\\r\\n\\r\\n';
    raw += email.html;
  } else {
    raw += 'Content-Type: text/plain; charset=UTF-8\\r\\n\\r\\n';
    raw += email.text || '';
  }

  return raw;
}
`

  /**
   * Create scheduler Lambda function
  */
  static createSchedulerLambda(config: {
    slug: string
    roleArn: string
    emailBucket: string
  }): Record<string, any> {
    return {
      [`${config.slug}EmailSchedulerLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-email-scheduler`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 300,
          MemorySize: 256,
          Code: {
            ZipFile: EmailScheduling.SchedulerLambdaCode,
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
   * Create EventBridge rule to trigger scheduler
  */
  static createSchedulerRule(config: {
    slug: string
    lambdaArn: string
    scheduleExpression?: string
  }): Record<string, any> {
    return {
      [`${config.slug}EmailSchedulerRule`]: {
        Type: 'AWS::Events::Rule',
        Properties: {
          Name: `${config.slug}-email-scheduler`,
          Description: 'Trigger email scheduler every minute',
          ScheduleExpression: config.scheduleExpression || 'rate(1 minute)',
          State: 'ENABLED',
          Targets: [
            {
              Id: 'EmailSchedulerTarget',
              Arn: config.lambdaArn,
            },
          ],
        },
      },
      [`${config.slug}EmailSchedulerPermission`]: {
        Type: 'AWS::Lambda::Permission',
        Properties: {
          FunctionName: config.lambdaArn,
          Action: 'lambda:InvokeFunction',
          Principal: 'events.amazonaws.com',
          SourceArn: { 'Fn::GetAtt': [`${config.slug}EmailSchedulerRule`, 'Arn'] },
        },
      },
    }
  }

  /**
   * Schedule an email (SDK helper)
  */
  static async scheduleEmail(params: {
    s3Client: any
    bucket: string
    email: ScheduledEmail['email']
    scheduledFor: Date | string
    timezone?: string
  }): Promise<ScheduledEmail> {
    const { s3Client, bucket, email, scheduledFor, timezone } = params

    const id = `sched-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    const scheduled: ScheduledEmail = {
      id,
      email,
      scheduledFor: typeof scheduledFor === 'string' ? scheduledFor : scheduledFor.toISOString(),
      timezone,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }

    await s3Client.send({
      Bucket: bucket,
      Key: `scheduled/${id}.json`,
      Body: JSON.stringify(scheduled, null, 2),
      ContentType: 'application/json',
    })

    return scheduled
  }

  /**
   * Cancel a scheduled email
  */
  static async cancelScheduledEmail(params: {
    s3Client: any
    bucket: string
    id: string
  }): Promise<boolean> {
    const { s3Client, bucket, id } = params

    try {
      // Get scheduled email
      const result = await s3Client.send({
        Bucket: bucket,
        Key: `scheduled/${id}.json`,
      })

      const scheduled = JSON.parse(result.Body)

      if (scheduled.status !== 'pending') {
        return false
      }

      // Update status
      scheduled.status = 'cancelled'

      await s3Client.send({
        Bucket: bucket,
        Key: `scheduled/${id}.json`,
        Body: JSON.stringify(scheduled, null, 2),
        ContentType: 'application/json',
      })

      return true
    }
    catch {
      return false
    }
  }

  /**
   * List scheduled emails
  */
  static async listScheduledEmails(params: {
    s3Client: any
    bucket: string
    status?: ScheduledEmail['status']
  }): Promise<ScheduledEmail[]> {
    const { s3Client, bucket, status } = params

    const result = await s3Client.send({
      Bucket: bucket,
      Prefix: 'scheduled/',
    })

    const emails: ScheduledEmail[] = []

    for (const obj of result.Contents || []) {
      if (!obj.Key.endsWith('.json')) continue

      try {
        const getResult = await s3Client.send({
          Bucket: bucket,
          Key: obj.Key,
        })

        const scheduled = JSON.parse(getResult.Body)

        if (!status || scheduled.status === status) {
          emails.push(scheduled)
        }
      }
      catch {
        // Skip invalid files
      }
    }

    // Sort by scheduled time
    emails.sort((a, b) =>
      new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime()
    )

    return emails
  }
}

export default EmailScheduling
