import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { SNSClient } from '../../src/aws/sns'
import { loadValidatedConfig } from './shared'

export function registerNotifyCommands(app: CLI): void {
  app
    .command('notify:topics', 'List all SNS topics')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('SNS Topics')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const sns = new SNSClient(region)

        const spinner = new cli.Spinner('Fetching topics...')
        spinner.start()

        const result = await sns.listTopics()
        const topics = result.Topics || []

        spinner.succeed(`Found ${topics.length} topic(s)`)

        if (topics.length === 0) {
          cli.info('No SNS topics found')
          cli.info('Use `cloud notify:create` to create a new topic')
          return
        }

        cli.table(
          ['Topic ARN', 'Name'],
          topics.map(t => {
            const name = t.TopicArn?.split(':').pop() || 'N/A'
            return [t.TopicArn || 'N/A', name]
          }),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list topics: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('notify:create <name>', 'Create a new SNS topic')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--fifo', 'Create a FIFO topic')
    .option('--display-name <name>', 'Display name for SMS subscriptions')
    .action(async (name: string, options: { region: string; fifo?: boolean; displayName?: string }) => {
      cli.header('Create SNS Topic')

      try {
        const sns = new SNSClient(options.region)

        // FIFO topics must end with .fifo
        const topicName = options.fifo && !name.endsWith('.fifo') ? `${name}.fifo` : name

        cli.info(`Topic name: ${topicName}`)
        cli.info(`Type: ${options.fifo ? 'FIFO' : 'Standard'}`)

        const confirmed = await cli.confirm('\nCreate this topic?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating topic...')
        spinner.start()

        const attributes: Record<string, string> = {}

        if (options.fifo) {
          attributes.FifoTopic = 'true'
          attributes.ContentBasedDeduplication = 'true'
        }

        if (options.displayName) {
          attributes.DisplayName = options.displayName
        }

        const result = await sns.createTopic({
          Name: topicName,
          Attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
        })

        spinner.succeed('Topic created')

        cli.success(`\nTopic ARN: ${result.TopicArn}`)
        cli.info('\nTo subscribe:')
        cli.info(`  cloud notify:subscribe ${result.TopicArn} --email user@example.com`)
      }
      catch (error: any) {
        cli.error(`Failed to create topic: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('notify:delete <topicArn>', 'Delete an SNS topic')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (topicArn: string, options: { region: string }) => {
      cli.header('Delete SNS Topic')

      try {
        const sns = new SNSClient(options.region)

        cli.warn(`This will delete topic: ${topicArn}`)
        cli.warn('All subscriptions will be removed.')

        const confirmed = await cli.confirm('\nDelete this topic?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Deleting topic...')
        spinner.start()

        await sns.deleteTopic(topicArn)

        spinner.succeed('Topic deleted')
      }
      catch (error: any) {
        cli.error(`Failed to delete topic: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('notify:subscribe <topicArn>', 'Subscribe to an SNS topic')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--email <address>', 'Email address')
    .option('--sms <number>', 'Phone number (E.164 format)')
    .option('--sqs <queueArn>', 'SQS queue ARN')
    .option('--lambda <functionArn>', 'Lambda function ARN')
    .option('--https <url>', 'HTTPS endpoint URL')
    .option('--filter <json>', 'Filter policy JSON')
    .action(async (topicArn: string, options: {
      region: string
      email?: string
      sms?: string
      sqs?: string
      lambda?: string
      https?: string
      filter?: string
    }) => {
      cli.header('Subscribe to SNS Topic')

      try {
        const sns = new SNSClient(options.region)

        let protocol: string
        let endpoint: string

        if (options.email) {
          protocol = 'email'
          endpoint = options.email
        }
        else if (options.sms) {
          protocol = 'sms'
          endpoint = options.sms
        }
        else if (options.sqs) {
          protocol = 'sqs'
          endpoint = options.sqs
        }
        else if (options.lambda) {
          protocol = 'lambda'
          endpoint = options.lambda
        }
        else if (options.https) {
          protocol = 'https'
          endpoint = options.https
        }
        else {
          cli.error('Specify a subscription type: --email, --sms, --sqs, --lambda, or --https')
          return
        }

        cli.info(`Topic: ${topicArn}`)
        cli.info(`Protocol: ${protocol}`)
        cli.info(`Endpoint: ${endpoint}`)

        const confirmed = await cli.confirm('\nCreate this subscription?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating subscription...')
        spinner.start()

        const params: any = {
          TopicArn: topicArn,
          Protocol: protocol,
          Endpoint: endpoint,
        }

        if (options.filter) {
          params.Attributes = {
            FilterPolicy: options.filter,
          }
        }

        const result = await sns.subscribe(params)

        spinner.succeed('Subscription created')

        if (result.SubscriptionArn === 'pending confirmation') {
          cli.info('\nSubscription is pending confirmation.')
          cli.info('The subscriber will receive a confirmation message.')
        }
        else {
          cli.success(`\nSubscription ARN: ${result.SubscriptionArn}`)
        }
      }
      catch (error: any) {
        cli.error(`Failed to subscribe: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('notify:unsubscribe <subscriptionArn>', 'Unsubscribe from an SNS topic')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (subscriptionArn: string, options: { region: string }) => {
      cli.header('Unsubscribe from SNS Topic')

      try {
        const sns = new SNSClient(options.region)

        cli.warn(`This will remove subscription: ${subscriptionArn}`)

        const confirmed = await cli.confirm('\nUnsubscribe?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Unsubscribing...')
        spinner.start()

        await sns.unsubscribe(subscriptionArn)

        spinner.succeed('Unsubscribed')
      }
      catch (error: any) {
        cli.error(`Failed to unsubscribe: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('notify:subscriptions <topicArn>', 'List subscriptions for a topic')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (topicArn: string, options: { region: string }) => {
      cli.header('Topic Subscriptions')

      try {
        const sns = new SNSClient(options.region)

        const spinner = new cli.Spinner('Fetching subscriptions...')
        spinner.start()

        const result = await sns.listSubscriptionsByTopic(topicArn)
        const subscriptions = result.Subscriptions || []

        spinner.succeed(`Found ${subscriptions.length} subscription(s)`)

        if (subscriptions.length === 0) {
          cli.info('No subscriptions found')
          return
        }

        cli.table(
          ['Protocol', 'Endpoint', 'Status', 'Subscription ARN'],
          subscriptions.map(s => [
            s.Protocol || 'N/A',
            s.Endpoint || 'N/A',
            s.SubscriptionArn === 'PendingConfirmation' ? 'Pending' : 'Confirmed',
            (s.SubscriptionArn || 'N/A').substring(0, 50),
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list subscriptions: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('notify:publish <topicArn>', 'Publish a message to an SNS topic')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--message <text>', 'Message body')
    .option('--subject <text>', 'Message subject (for email)')
    .option('--file <path>', 'Read message from file')
    .option('--json', 'Send as JSON message structure')
    .option('--group <id>', 'Message group ID (for FIFO topics)')
    .option('--dedup <id>', 'Deduplication ID (for FIFO topics)')
    .action(async (topicArn: string, options: {
      region: string
      message?: string
      subject?: string
      file?: string
      json?: boolean
      group?: string
      dedup?: string
    }) => {
      cli.header('Publish to SNS Topic')

      try {
        const sns = new SNSClient(options.region)

        let messageBody: string

        if (options.file) {
          const file = Bun.file(options.file)
          messageBody = await file.text()
        }
        else if (options.message) {
          messageBody = options.message
        }
        else {
          messageBody = await cli.prompt('Message')
        }

        if (!messageBody) {
          cli.error('Message is required')
          return
        }

        cli.info(`Topic: ${topicArn}`)
        cli.info(`Message length: ${messageBody.length} characters`)

        const confirmed = await cli.confirm('\nPublish this message?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Publishing message...')
        spinner.start()

        const params: any = {
          TopicArn: topicArn,
          Message: messageBody,
        }

        if (options.subject) {
          params.Subject = options.subject
        }

        if (options.json) {
          params.MessageStructure = 'json'
        }

        if (options.group) {
          params.MessageGroupId = options.group
        }

        if (options.dedup) {
          params.MessageDeduplicationId = options.dedup
        }

        const result = await sns.publish(params)

        spinner.succeed('Message published')

        cli.success(`\nMessage ID: ${result.MessageId}`)
      }
      catch (error: any) {
        cli.error(`Failed to publish message: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('notify:sms <phoneNumber>', 'Send an SMS message directly')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--message <text>', 'Message body')
    .option('--sender <id>', 'Sender ID or short code')
    .option('--type <type>', 'Message type (Transactional or Promotional)', { default: 'Transactional' })
    .action(async (phoneNumber: string, options: {
      region: string
      message?: string
      sender?: string
      type: string
    }) => {
      cli.header('Send SMS')

      try {
        const sns = new SNSClient(options.region)

        const messageBody = options.message || await cli.prompt('Message')

        if (!messageBody) {
          cli.error('Message is required')
          return
        }

        cli.info(`To: ${phoneNumber}`)
        cli.info(`Message: ${messageBody}`)
        cli.info(`Type: ${options.type}`)

        const confirmed = await cli.confirm('\nSend this SMS?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Sending SMS...')
        spinner.start()

        const params: any = {
          PhoneNumber: phoneNumber,
          Message: messageBody,
          MessageAttributes: {
            'AWS.SNS.SMS.SMSType': {
              DataType: 'String',
              StringValue: options.type,
            },
          },
        }

        if (options.sender) {
          params.MessageAttributes['AWS.SNS.SMS.SenderID'] = {
            DataType: 'String',
            StringValue: options.sender,
          }
        }

        const result = await sns.publish(params)

        spinner.succeed('SMS sent')

        cli.success(`\nMessage ID: ${result.MessageId}`)
      }
      catch (error: any) {
        cli.error(`Failed to send SMS: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('notify:topic:attributes <topicArn>', 'Show topic attributes')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (topicArn: string, options: { region: string }) => {
      cli.header('Topic Attributes')

      try {
        const sns = new SNSClient(options.region)

        const spinner = new cli.Spinner('Fetching attributes...')
        spinner.start()

        const attrs = await sns.getTopicAttributes(topicArn)

        spinner.succeed('Attributes loaded')

        cli.info('\nTopic Information:')
        cli.info(`  ARN: ${topicArn}`)
        cli.info(`  Display Name: ${attrs.DisplayName || 'Not set'}`)
        cli.info(`  Owner: ${attrs.Owner || 'N/A'}`)

        cli.info('\nSubscriptions:')
        cli.info(`  Confirmed: ${attrs.SubscriptionsConfirmed || 0}`)
        cli.info(`  Pending: ${attrs.SubscriptionsPending || 0}`)
        cli.info(`  Deleted: ${attrs.SubscriptionsDeleted || 0}`)

        cli.info('\nSettings:')
        cli.info(`  FIFO: ${(attrs as any).FifoTopic === 'true' ? 'Yes' : 'No'}`)
        cli.info(`  Content Deduplication: ${(attrs as any).ContentBasedDeduplication === 'true' ? 'Yes' : 'No'}`)

        if (attrs.EffectiveDeliveryPolicy) {
          cli.info('\nDelivery Policy: Configured')
        }

        if (attrs.Policy) {
          cli.info('\nAccess Policy: Configured')
        }
      }
      catch (error: any) {
        cli.error(`Failed to get attributes: ${error.message}`)
        process.exit(1)
      }
    })
}
