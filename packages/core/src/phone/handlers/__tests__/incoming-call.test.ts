import { describe, expect, it } from 'bun:test'
import { handler } from '../incoming-call'

describe('Incoming Call Handler', () => {
  it('should export handler code as string', () => {
    expect(typeof handler).toBe('string')
    expect(handler).toContain('exports.handler')
  })

  it('should contain SNS client import', () => {
    expect(handler).toContain('SNSClient')
    expect(handler).toContain('PublishCommand')
  })

  it('should contain DynamoDB client import', () => {
    expect(handler).toContain('DynamoDBClient')
    expect(handler).toContain('PutItemCommand')
  })

  it('should extract contact data', () => {
    expect(handler).toContain('ContactData')
    expect(handler).toContain('CustomerEndpoint')
    expect(handler).toContain('SystemEndpoint')
  })

  it('should log calls to DynamoDB', () => {
    expect(handler).toContain('CALL_LOG_TABLE')
    expect(handler).toContain('contactId')
  })

  it('should send notifications', () => {
    expect(handler).toContain('NOTIFICATION_TOPIC_ARN')
    expect(handler).toContain('incoming_call')
  })

  it('should support webhook notifications', () => {
    expect(handler).toContain('WEBHOOK_URL')
    expect(handler).toContain('fetch')
  })
})
