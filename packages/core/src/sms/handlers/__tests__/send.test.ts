import { describe, expect, it } from 'bun:test'
import { handler } from '../send'

describe('SMS Send Handler', () => {
  it('should export handler code as string', () => {
    expect(typeof handler).toBe('string')
    expect(handler).toContain('exports.handler')
  })

  it('should contain Pinpoint client import', () => {
    expect(handler).toContain('PinpointClient')
    expect(handler).toContain('SendMessagesCommand')
  })

  it('should contain SNS client as fallback', () => {
    expect(handler).toContain('SNSClient')
    expect(handler).toContain('PublishCommand')
  })

  it('should support templated messages', () => {
    expect(handler).toContain('template')
    expect(handler).toContain('templateData')
    expect(handler).toContain('resolveTemplate')
  })

  it('should log messages to DynamoDB', () => {
    expect(handler).toContain('MESSAGE_LOG_TABLE')
    expect(handler).toContain('messageId')
  })

  it('should support message types', () => {
    expect(handler).toContain('TRANSACTIONAL')
    expect(handler).toContain('PROMOTIONAL')
  })

  it('should handle delivery status', () => {
    expect(handler).toContain('DeliveryStatus')
    expect(handler).toContain('SENT')
  })
})
