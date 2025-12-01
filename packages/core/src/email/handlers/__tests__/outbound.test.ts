import { describe, expect, it } from 'bun:test'
import { handler } from '../outbound'

describe('Outbound Email Handler', () => {
  it('should export handler code as string', () => {
    expect(typeof handler).toBe('string')
    expect(handler).toContain('exports.handler')
  })

  it('should contain SES client import', () => {
    expect(handler).toContain('SESClient')
    expect(handler).toContain('SendRawEmailCommand')
  })

  it('should build MIME messages', () => {
    expect(handler).toContain('MIME-Version')
    expect(handler).toContain('Content-Type')
    expect(handler).toContain('boundary')
  })

  it('should support HTML and text content', () => {
    expect(handler).toContain('text/html')
    expect(handler).toContain('text/plain')
    expect(handler).toContain('multipart/alternative')
  })

  it('should handle attachments', () => {
    expect(handler).toContain('attachments')
    expect(handler).toContain('Content-Disposition: attachment')
    expect(handler).toContain('multipart/mixed')
  })

  it('should store sent emails', () => {
    expect(handler).toContain('sent/')
    expect(handler).toContain('metadata.json')
  })
})
