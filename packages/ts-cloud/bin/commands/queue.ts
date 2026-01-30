import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { SQSClient } from '../../src/aws/sqs'
import { loadValidatedConfig } from './shared'

export function registerQueueCommands(app: CLI): void {
  app
    .command('queue:list', 'List all SQS queues')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('SQS Queues')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const sqs = new SQSClient(region)

        const spinner = new cli.Spinner('Fetching queues...')
        spinner.start()

        const result = await sqs.listQueues()
        const queues = result.QueueUrls || []

        spinner.succeed(`Found ${queues.length} queue(s)`)

        if (queues.length === 0) {
          cli.info('No SQS queues found')
          cli.info('Use `cloud queue:create` to create a new queue')
          return
        }

        // Get attributes for each queue
        const queueData: { url: string; name: string; messages: string; type: string }[] = []

        for (const queueUrl of queues) {
          try {
            const attrs = await sqs.getQueueAttributes({
              QueueUrl: queueUrl,
              AttributeNames: ['ApproximateNumberOfMessages', 'FifoQueue'],
            })

            const name = queueUrl.split('/').pop() || queueUrl
            queueData.push({
              url: queueUrl,
              name,
              messages: attrs.Attributes?.ApproximateNumberOfMessages || '0',
              type: attrs.Attributes?.FifoQueue === 'true' ? 'FIFO' : 'Standard',
            })
          }
          catch {
            const name = queueUrl.split('/').pop() || queueUrl
            queueData.push({
              url: queueUrl,
              name,
              messages: 'N/A',
              type: 'Unknown',
            })
          }
        }

        cli.table(
          ['Queue Name', 'Messages', 'Type'],
          queueData.map(q => [q.name, q.messages, q.type]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list queues: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('queue:create <name>', 'Create a new SQS queue')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--fifo', 'Create a FIFO queue')
    .option('--dlq <queueArn>', 'Dead letter queue ARN')
    .option('--max-retries <number>', 'Max receive count before DLQ', { default: '3' })
    .option('--visibility <seconds>', 'Visibility timeout in seconds', { default: '30' })
    .option('--retention <days>', 'Message retention in days', { default: '4' })
    .action(async (name: string, options: {
      region: string
      fifo?: boolean
      dlq?: string
      maxRetries: string
      visibility: string
      retention: string
    }) => {
      cli.header('Create SQS Queue')

      try {
        const sqs = new SQSClient(options.region)

        // FIFO queues must end with .fifo
        const queueName = options.fifo && !name.endsWith('.fifo') ? `${name}.fifo` : name

        cli.info(`Queue name: ${queueName}`)
        cli.info(`Type: ${options.fifo ? 'FIFO' : 'Standard'}`)
        cli.info(`Visibility timeout: ${options.visibility} seconds`)
        cli.info(`Message retention: ${options.retention} days`)
        if (options.dlq) {
          cli.info(`Dead letter queue: ${options.dlq}`)
          cli.info(`Max retries: ${options.maxRetries}`)
        }

        const confirmed = await cli.confirm('\nCreate this queue?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating queue...')
        spinner.start()

        const attributes: Record<string, string> = {
          VisibilityTimeout: options.visibility,
          MessageRetentionPeriod: (Number.parseInt(options.retention) * 24 * 60 * 60).toString(),
        }

        if (options.fifo) {
          attributes.FifoQueue = 'true'
          attributes.ContentBasedDeduplication = 'true'
        }

        if (options.dlq) {
          attributes.RedrivePolicy = JSON.stringify({
            deadLetterTargetArn: options.dlq,
            maxReceiveCount: Number.parseInt(options.maxRetries),
          })
        }

        const result = await sqs.createQueue({
          QueueName: queueName,
          Attributes: attributes,
        })

        spinner.succeed('Queue created')

        cli.success(`\nQueue URL: ${result.QueueUrl}`)
        cli.info('\nTo send a message:')
        cli.info(`  cloud queue:send ${queueName} --message "Hello World"`)
      }
      catch (error: any) {
        cli.error(`Failed to create queue: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('queue:delete <name>', 'Delete an SQS queue')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (name: string, options: { region: string }) => {
      cli.header('Delete SQS Queue')

      try {
        const sqs = new SQSClient(options.region)

        cli.warn(`This will permanently delete queue: ${name}`)
        cli.warn('All messages in the queue will be lost!')

        const confirmed = await cli.confirm('\nDelete this queue?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Getting queue URL...')
        spinner.start()

        const urlResult = await sqs.getQueueUrl({ QueueName: name })

        if (!urlResult.QueueUrl) {
          spinner.fail('Queue not found')
          return
        }

        spinner.text = 'Deleting queue...'

        await sqs.deleteQueue({ QueueUrl: urlResult.QueueUrl })

        spinner.succeed('Queue deleted')
      }
      catch (error: any) {
        cli.error(`Failed to delete queue: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('queue:send <name>', 'Send a message to an SQS queue')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--message <body>', 'Message body')
    .option('--file <path>', 'Read message body from file')
    .option('--group <id>', 'Message group ID (for FIFO queues)')
    .option('--dedup <id>', 'Deduplication ID (for FIFO queues)')
    .option('--delay <seconds>', 'Delay delivery in seconds', { default: '0' })
    .action(async (name: string, options: {
      region: string
      message?: string
      file?: string
      group?: string
      dedup?: string
      delay: string
    }) => {
      cli.header('Send SQS Message')

      try {
        const sqs = new SQSClient(options.region)

        // Get message body
        let messageBody: string

        if (options.file) {
          const file = Bun.file(options.file)
          messageBody = await file.text()
        }
        else if (options.message) {
          messageBody = options.message
        }
        else {
          messageBody = await cli.prompt('Message body')
        }

        if (!messageBody) {
          cli.error('Message body is required')
          return
        }

        const spinner = new cli.Spinner('Getting queue URL...')
        spinner.start()

        const urlResult = await sqs.getQueueUrl({ QueueName: name })

        if (!urlResult.QueueUrl) {
          spinner.fail('Queue not found')
          return
        }

        spinner.text = 'Sending message...'

        const params: any = {
          QueueUrl: urlResult.QueueUrl,
          MessageBody: messageBody,
          DelaySeconds: Number.parseInt(options.delay),
        }

        if (options.group) {
          params.MessageGroupId = options.group
        }

        if (options.dedup) {
          params.MessageDeduplicationId = options.dedup
        }

        const result = await sqs.sendMessage(params)

        spinner.succeed('Message sent')

        cli.success(`\nMessage ID: ${result.MessageId}`)
        if (result.SequenceNumber) {
          cli.info(`Sequence Number: ${result.SequenceNumber}`)
        }
      }
      catch (error: any) {
        cli.error(`Failed to send message: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('queue:receive <name>', 'Receive messages from an SQS queue')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--max <number>', 'Maximum number of messages', { default: '1' })
    .option('--wait <seconds>', 'Long polling wait time', { default: '0' })
    .option('--delete', 'Delete messages after receiving')
    .action(async (name: string, options: {
      region: string
      max: string
      wait: string
      delete?: boolean
    }) => {
      cli.header('Receive SQS Messages')

      try {
        const sqs = new SQSClient(options.region)

        const spinner = new cli.Spinner('Getting queue URL...')
        spinner.start()

        const urlResult = await sqs.getQueueUrl({ QueueName: name })

        if (!urlResult.QueueUrl) {
          spinner.fail('Queue not found')
          return
        }

        spinner.text = 'Receiving messages...'

        const result = await sqs.receiveMessage({
          QueueUrl: urlResult.QueueUrl,
          MaxNumberOfMessages: Number.parseInt(options.max),
          WaitTimeSeconds: Number.parseInt(options.wait),
          AttributeNames: ['All'],
          MessageAttributeNames: ['All'],
        })

        const messages = result.Messages || []

        spinner.succeed(`Received ${messages.length} message(s)`)

        if (messages.length === 0) {
          cli.info('No messages available')
          return
        }

        for (const msg of messages) {
          cli.info(`\n--- Message: ${msg.MessageId} ---`)
          cli.info(`Body: ${msg.Body}`)

          if (msg.Attributes) {
            cli.info(`Sent: ${msg.Attributes.SentTimestamp ? new Date(Number.parseInt(msg.Attributes.SentTimestamp)).toISOString() : 'N/A'}`)
            cli.info(`Receive Count: ${msg.Attributes.ApproximateReceiveCount || 'N/A'}`)
          }

          if (options.delete && msg.ReceiptHandle) {
            await sqs.deleteMessage({
              QueueUrl: urlResult.QueueUrl!,
              ReceiptHandle: msg.ReceiptHandle,
            })
            cli.info('(Deleted)')
          }
        }
      }
      catch (error: any) {
        cli.error(`Failed to receive messages: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('queue:purge <name>', 'Purge all messages from an SQS queue')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (name: string, options: { region: string }) => {
      cli.header('Purge SQS Queue')

      try {
        const sqs = new SQSClient(options.region)

        cli.warn(`This will delete ALL messages in queue: ${name}`)
        cli.warn('This action cannot be undone!')

        const confirmed = await cli.confirm('\nPurge this queue?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Getting queue URL...')
        spinner.start()

        const urlResult = await sqs.getQueueUrl({ QueueName: name })

        if (!urlResult.QueueUrl) {
          spinner.fail('Queue not found')
          return
        }

        spinner.text = 'Purging queue...'

        await sqs.purgeQueue({ QueueUrl: urlResult.QueueUrl })

        spinner.succeed('Queue purged')

        cli.info('\nNote: It may take up to 60 seconds for the purge to complete.')
      }
      catch (error: any) {
        cli.error(`Failed to purge queue: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('queue:stats <name>', 'Show SQS queue statistics')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (name: string, options: { region: string }) => {
      cli.header(`SQS Queue Stats: ${name}`)

      try {
        const sqs = new SQSClient(options.region)

        const spinner = new cli.Spinner('Fetching queue stats...')
        spinner.start()

        const urlResult = await sqs.getQueueUrl({ QueueName: name })

        if (!urlResult.QueueUrl) {
          spinner.fail('Queue not found')
          return
        }

        const attrs = await sqs.getQueueAttributes({
          QueueUrl: urlResult.QueueUrl,
          AttributeNames: ['All'],
        })

        spinner.succeed('Stats loaded')

        const a = attrs.Attributes || {}

        cli.info('\nQueue Information:')
        cli.info(`  URL: ${urlResult.QueueUrl}`)
        cli.info(`  ARN: ${a.QueueArn || 'N/A'}`)
        cli.info(`  Type: ${a.FifoQueue === 'true' ? 'FIFO' : 'Standard'}`)

        cli.info('\nMessages:')
        cli.info(`  Available: ${a.ApproximateNumberOfMessages || '0'}`)
        cli.info(`  In Flight: ${a.ApproximateNumberOfMessagesNotVisible || '0'}`)
        cli.info(`  Delayed: ${a.ApproximateNumberOfMessagesDelayed || '0'}`)

        cli.info('\nConfiguration:')
        cli.info(`  Visibility Timeout: ${a.VisibilityTimeout || '30'} seconds`)
        cli.info(`  Message Retention: ${Number.parseInt(a.MessageRetentionPeriod || '345600') / 86400} days`)
        cli.info(`  Max Message Size: ${Number.parseInt(a.MaximumMessageSize || '262144') / 1024} KB`)
        cli.info(`  Receive Wait Time: ${a.ReceiveMessageWaitTimeSeconds || '0'} seconds`)

        if (a.RedrivePolicy) {
          const dlqPolicy = JSON.parse(a.RedrivePolicy)
          cli.info('\nDead Letter Queue:')
          cli.info(`  Target ARN: ${dlqPolicy.deadLetterTargetArn}`)
          cli.info(`  Max Receives: ${dlqPolicy.maxReceiveCount}`)
        }

        cli.info('\nTimestamps:')
        cli.info(`  Created: ${a.CreatedTimestamp ? new Date(Number.parseInt(a.CreatedTimestamp) * 1000).toISOString() : 'N/A'}`)
        cli.info(`  Last Modified: ${a.LastModifiedTimestamp ? new Date(Number.parseInt(a.LastModifiedTimestamp) * 1000).toISOString() : 'N/A'}`)
      }
      catch (error: any) {
        cli.error(`Failed to get queue stats: ${error.message}`)
        process.exit(1)
      }
    })
}
