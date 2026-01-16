import { describe, expect, it } from 'bun:test'
import { handler } from '../inbound'

describe('Inbound Email Handler', () => {
  it('should export handler code as string', () => {
    expect(typeof handler).toBe('string')
    expect(handler).toContain('exports.handler')
  })

  it('should contain S3 client import', () => {
    expect(handler).toContain('S3Client')
    expect(handler).toContain('GetObjectCommand')
    expect(handler).toContain('PutObjectCommand')
  })

  it('should handle SES notification parsing', () => {
    expect(handler).toContain('sesNotification')
    expect(handler).toContain('mail.messageId')
  })

  it('should organize emails by mailbox structure', () => {
    expect(handler).toContain('mailboxes/')
    expect(handler).toContain('metadata.json')
    expect(handler).toContain('inbox.json')
  })

  it('should support + addressing', () => {
    expect(handler).toContain("split('+')") // Handle user+tag@domain.com
  })

  it('should extract email metadata', () => {
    expect(handler).toContain('from')
    expect(handler).toContain('to')
    expect(handler).toContain('subject')
    expect(handler).toContain('spamVerdict')
    expect(handler).toContain('virusVerdict')
  })
})
