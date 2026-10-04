/**
 * Regression tests for readers that missed AWSClient.parseXmlResponse's
 * root stripping.
 *
 * The parser returns a single-root body's *contents*: a query-API
 * `<PublishResponse><PublishResult>..` arrives as `{ PublishResult: .. }` and
 * a CloudFront `<FunctionList>` as its children. Each reader below read the
 * wrapper (or a field one level too shallow) and so returned undefined, an
 * empty list or `false` against a live account; IAM never got the XML text its
 * regex helpers expect and threw on every call. The bodies are the shapes AWS
 * returned when this was audited, with example identifiers, run through the
 * real parser.
 */

import { describe, expect, it } from 'bun:test'
import { CloudFormationClient } from '../src/aws/cloudformation'
import { CloudFrontClient } from '../src/aws/cloudfront'
import { IAMClient } from '../src/aws/iam'
import { SNSClient } from '../src/aws/sns'
import { SQSClient } from '../src/aws/sqs'

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n'
const SNS_NS = 'xmlns="http://sns.amazonaws.com/doc/2010-03-31/"'
const METADATA = '<ResponseMetadata><RequestId>7b85d25a-cd91-507b-b395-b1612df9e571</RequestId></ResponseMetadata>'

/** Answer every request with `xml` parsed by the client's own AWSClient. */
function respondWith(client: object, xml: string, headers?: Record<string, string>): Array<Record<string, any>> {
  const aws: any = (client as any).client
  const calls: Array<Record<string, any>> = []
  aws.request = async (options: any) => {
    calls.push(options)
    const body = aws.parseXmlResponse(XML + xml)
    return headers ? { body, headers } : body
  }
  return calls
}

function snsBody(action: string, result: string): string {
  return `<${action}Response ${SNS_NS}><${action}Result>${result}</${action}Result>${METADATA}</${action}Response>`
}

describe('SNSClient reads through the stripped XML root', () => {
  it('createTopic returns the topic ARN (it returned undefined)', async () => {
    const sns = new SNSClient('us-east-1')
    respondWith(sns, snsBody('CreateTopic', '<TopicArn>arn:aws:sns:us-east-1:123456789012:alerts</TopicArn>'))
    expect(await sns.createTopic({ Name: 'alerts' })).toEqual({ TopicArn: 'arn:aws:sns:us-east-1:123456789012:alerts' })
  })

  it('subscribe returns the subscription ARN (it returned undefined)', async () => {
    const sns = new SNSClient('us-east-1')
    respondWith(sns, snsBody('Subscribe', '<SubscriptionArn>pending confirmation</SubscriptionArn>'))
    expect(await sns.subscribe({ TopicArn: 'arn:aws:sns:us-east-1:123456789012:alerts', Protocol: 'email', Endpoint: 'a@example.com' }))
      .toEqual({ SubscriptionArn: 'pending confirmation' })
  })

  it('publish returns the message ID (it returned undefined)', async () => {
    const sns = new SNSClient('us-east-1')
    respondWith(sns, snsBody('Publish', '<MessageId>94f20ce6-13c5-43a0-9a9e-ca52d816e90b</MessageId>'))
    expect(await sns.publish({ TopicArn: 'arn:aws:sns:us-east-1:123456789012:alerts', Message: 'hi' }))
      .toEqual({ MessageId: '94f20ce6-13c5-43a0-9a9e-ca52d816e90b' })
  })

  it('getTopicAttributes returns every attribute as a string (it returned only the ARN)', async () => {
    const sns = new SNSClient('us-east-1')
    respondWith(sns, snsBody('GetTopicAttributes', '<Attributes><entry><key>Owner</key><value>123456789012</value></entry><entry><key>SubscriptionsPending</key><value>0</value></entry><entry><key>DisplayName</key><value>Alerts</value></entry></Attributes>'))
    expect(await sns.getTopicAttributes('arn:aws:sns:us-east-1:123456789012:alerts')).toEqual({
      TopicArn: 'arn:aws:sns:us-east-1:123456789012:alerts',
      Owner: '123456789012',
      SubscriptionsPending: '0',
      DisplayName: 'Alerts',
    } as any)
  })

  it('listSubscriptionsByTopic returns the subscriptions, one as a one-element list', async () => {
    const sns = new SNSClient('us-east-1')
    respondWith(sns, snsBody('ListSubscriptionsByTopic', '<Subscriptions><member><TopicArn>arn:aws:sns:us-east-1:123456789012:alerts</TopicArn><Protocol>email</Protocol><SubscriptionArn>arn:aws:sns:us-east-1:123456789012:alerts:1</SubscriptionArn><Owner>123456789012</Owner><Endpoint>a@example.com</Endpoint></member></Subscriptions>'))
    const { Subscriptions } = await sns.listSubscriptionsByTopic('arn:aws:sns:us-east-1:123456789012:alerts')
    expect(Subscriptions).toHaveLength(1)
    expect(Subscriptions?.[0]?.Endpoint).toBe('a@example.com')
  })

  it('getSMSAttributes returns the single attribute as a string (it returned {})', async () => {
    const sns = new SNSClient('us-east-1')
    respondWith(sns, snsBody('GetSMSAttributes', '<attributes><entry><key>MonthlySpendLimit</key><value>1</value></entry></attributes>'))
    expect(await sns.getSMSAttributes()).toEqual({ MonthlySpendLimit: '1' })
  })

  it('checkIfPhoneNumberIsOptedOut reads the parsed boolean (it always said false)', async () => {
    const sns = new SNSClient('us-east-1')
    respondWith(sns, snsBody('CheckIfPhoneNumberIsOptedOut', '<isOptedOut>true</isOptedOut>'))
    expect(await sns.checkIfPhoneNumberIsOptedOut('+15555550100')).toBe(true)
  })

  it('listSMSSandboxPhoneNumbers returns a lone pending number (it returned [])', async () => {
    const sns = new SNSClient('us-east-1')
    respondWith(sns, snsBody('ListSMSSandboxPhoneNumbers', '<PhoneNumbers><member><PhoneNumber>+15555550100</PhoneNumber><Status>Pending</Status></member></PhoneNumbers>'))
    const { PhoneNumbers } = await sns.listSMSSandboxPhoneNumbers()
    expect(PhoneNumbers).toHaveLength(1)
    expect(PhoneNumbers?.[0]?.Status).toBe('Pending')
  })

  it('getSMSSandboxAccountStatus reports a sandboxed account (it always said false)', async () => {
    const sns = new SNSClient('us-east-1')
    respondWith(sns, snsBody('GetSMSSandboxAccountStatus', '<IsInSandbox>true</IsInSandbox>'))
    expect(await sns.getSMSSandboxAccountStatus()).toEqual({ IsInSandbox: true })
  })

  it('still reads a body that keeps the <PublishResponse> wrapper', async () => {
    const sns = new SNSClient('us-east-1')
    ;(sns as any).client.request = async () => ({ PublishResponse: { PublishResult: { MessageId: 'm-1' } } })
    expect(await sns.publish({ TopicArn: 'arn:aws:sns:us-east-1:123456789012:alerts', Message: 'hi' })).toEqual({ MessageId: 'm-1' })
  })
})

describe('SQSClient.getQueueAttributes', () => {
  it('maps each <Attribute> to a string entry (it returned {})', async () => {
    const sqs = new SQSClient('us-east-1')
    respondWith(sqs, `<GetQueueAttributesResponse xmlns="http://queue.amazonaws.com/doc/2012-11-05/"><GetQueueAttributesResult><Attribute><Name>QueueArn</Name><Value>arn:aws:sqs:us-east-1:123456789012:jobs</Value></Attribute><Attribute><Name>ApproximateNumberOfMessages</Name><Value>0</Value></Attribute></GetQueueAttributesResult>${METADATA}</GetQueueAttributesResponse>`)
    expect(await sqs.getQueueAttributes('https://sqs.us-east-1.amazonaws.com/123456789012/jobs')).toEqual({
      Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:123456789012:jobs', ApproximateNumberOfMessages: '0' },
    })
  })
})

describe('CloudFormationClient.createChangeSet', () => {
  it('returns the change set and stack IDs (it returned undefined for both)', async () => {
    const cfn = new CloudFormationClient('us-east-1')
    respondWith(cfn, `<CreateChangeSetResponse xmlns="http://cloudformation.amazonaws.com/doc/2010-05-15/"><CreateChangeSetResult><Id>arn:aws:cloudformation:us-east-1:123456789012:changeSet/cs/1</Id><StackId>arn:aws:cloudformation:us-east-1:123456789012:stack/app/1</StackId></CreateChangeSetResult>${METADATA}</CreateChangeSetResponse>`)
    expect(await cfn.createChangeSet({ stackName: 'app', changeSetName: 'cs', templateBody: '{}' } as any)).toEqual({
      Id: 'arn:aws:cloudformation:us-east-1:123456789012:changeSet/cs/1',
      StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/app/1',
    })
  })
})

describe('CloudFrontClient reads through the stripped XML root', () => {
  const NS = 'xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"'

  it('listFunctions returns the functions (it returned [])', async () => {
    const cf = new CloudFrontClient()
    respondWith(cf, `<FunctionList ${NS}><MaxItems>100</MaxItems><Quantity>1</Quantity><Items><FunctionSummary><Name>redirect</Name><FunctionConfig><Runtime>cloudfront-js-2.0</Runtime></FunctionConfig><FunctionMetadata><FunctionARN>arn:aws:cloudfront::123456789012:function/redirect</FunctionARN><Stage>LIVE</Stage><CreatedTime>2025-12-12T15:43:02.588Z</CreatedTime><LastModifiedTime>2025-12-12T15:43:02.616Z</LastModifiedTime></FunctionMetadata></FunctionSummary></Items></FunctionList>`)
    expect(await cf.listFunctions()).toEqual([{
      Name: 'redirect',
      FunctionARN: 'arn:aws:cloudfront::123456789012:function/redirect',
      Stage: 'LIVE',
      CreatedTime: '2025-12-12T15:43:02.588Z',
      LastModifiedTime: '2025-12-12T15:43:02.616Z',
    }])
  })

  it('listOriginAccessControls returns the controls (it returned [])', async () => {
    const cf = new CloudFrontClient()
    respondWith(cf, `<OriginAccessControlList ${NS}><Marker></Marker><MaxItems>200</MaxItems><IsTruncated>false</IsTruncated><Quantity>1</Quantity><Items><OriginAccessControlSummary><Id>E209NVEEQ8MSQ6</Id><Description>OAC for site</Description><Name>OAC-site</Name><SigningProtocol>sigv4</SigningProtocol><SigningBehavior>always</SigningBehavior><OriginAccessControlOriginType>s3</OriginAccessControlOriginType></OriginAccessControlSummary></Items></OriginAccessControlList>`)
    const controls = await cf.listOriginAccessControls()
    expect(controls).toHaveLength(1)
    expect(controls[0]).toMatchObject({ Id: 'E209NVEEQ8MSQ6', Name: 'OAC-site', SigningBehavior: 'always' })
  })

  it('getDistributionConfig returns the ETag header and the config without xmlns (the ETag was always empty)', async () => {
    const cf = new CloudFrontClient()
    const calls = respondWith(cf, `<DistributionConfig ${NS}><CallerReference>ref</CallerReference><Comment>site</Comment><Enabled>true</Enabled></DistributionConfig>`, { etag: 'E1MJJISQ42RE2I' })
    const { ETag, DistributionConfig } = await cf.getDistributionConfig('E16KTJRJFARR2W')
    expect(calls[0]?.returnHeaders).toBe(true)
    expect(ETag).toBe('E1MJJISQ42RE2I')
    expect(DistributionConfig).toEqual({ CallerReference: 'ref', Comment: 'site', Enabled: true } as any)
  })
})

describe('IAMClient', () => {
  it('asks for the raw XML its parse helpers read (every call threw "xml.match is not a function")', async () => {
    const iam = new IAMClient('us-east-1')
    const calls: Array<Record<string, any>> = []
    ;(iam as any).client.request = async (options: any) => {
      calls.push(options)
      return options.rawResponse
        ? `${XML}<GetUserResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetUserResult><User><Path>/</Path><UserName>deploy</UserName><Arn>arn:aws:iam::123456789012:user/deploy</Arn><UserId>AIDAEXAMPLEUSERID0001</UserId><CreateDate>2025-12-08T20:28:13Z</CreateDate></User></GetUserResult>${METADATA}</GetUserResponse>`
        : { GetUserResult: { User: { UserName: 'deploy' } } }
    }
    const user = await iam.getUser()
    expect(calls[0]?.rawResponse).toBe(true)
    expect(user).toMatchObject({ UserName: 'deploy', Arn: 'arn:aws:iam::123456789012:user/deploy', UserId: 'AIDAEXAMPLEUSERID0001' })
  })
})
