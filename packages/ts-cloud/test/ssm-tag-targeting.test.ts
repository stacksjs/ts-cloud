/**
 * SSMClient tag-targeting tests.
 *
 * Verifies the SendCommand / ListCommandInvocations request shapes used by
 * the new sendCommandByTags helper. The underlying AWS request is replaced
 * with a spy so the tests run offline and don't hit AWS.
 */

import { describe, expect, it, mock } from 'bun:test'
import { SSMClient } from '../src/aws/ssm'

interface CapturedRequest {
  service: string
  region: string
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
}

/**
 * Replace the SSM client's underlying request method with a spy that returns
 * canned responses keyed by the SSM action (X-Amz-Target header).
 */
function withMockedClient(
  ssm: SSMClient,
  responses: Record<string, any>,
): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = []
  ;(ssm as any).client.request = mock(async (req: CapturedRequest) => {
    calls.push(req)
    const action = req.headers?.['X-Amz-Target']?.split('.')?.[1]
    return responses[action ?? ''] ?? {}
  })
  return { calls }
}

describe('SSMClient.sendCommand', () => {
  it('passes Targets through when given (no InstanceIds required)', async () => {
    const ssm = new SSMClient('us-east-1')
    const { calls } = withMockedClient(ssm, {
      SendCommand: { Command: { CommandId: 'cmd-1' } },
    })

    await ssm.sendCommand({
      Targets: [
        { Key: 'tag:Project', Values: ['my-app'] },
        { Key: 'tag:Environment', Values: ['production'] },
      ],
      DocumentName: 'AWS-RunShellScript',
      Parameters: { commands: ['echo hi'] },
    })

    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].body!)
    expect(body.Targets).toEqual([
      { Key: 'tag:Project', Values: ['my-app'] },
      { Key: 'tag:Environment', Values: ['production'] },
    ])
    expect(body.InstanceIds).toBeUndefined()
    expect(body.DocumentName).toBe('AWS-RunShellScript')
    expect(body.Parameters).toEqual({ commands: ['echo hi'] })
  })

  it('throws when neither InstanceIds nor Targets is given', () => {
    const ssm = new SSMClient('us-east-1')
    withMockedClient(ssm, {})

    expect(
      ssm.sendCommand({ DocumentName: 'AWS-RunShellScript' }),
    ).rejects.toThrow('SendCommand requires either InstanceIds or Targets')
  })
})

describe('SSMClient.sendCommandByTags', () => {
  it('converts the tags map to SSM Targets shape (tag:Key prefix)', async () => {
    const ssm = new SSMClient('us-east-1')
    const { calls } = withMockedClient(ssm, {
      SendCommand: { Command: { CommandId: 'cmd-2' } },
      ListCommandInvocations: {
        CommandInvocations: [{
          InstanceId: 'i-aaa',
          Status: 'Success',
          CommandPlugins: [{ Output: 'ok' }],
        }],
      },
    })

    await ssm.sendCommandByTags({
      tags: { Project: 'my-app', Environment: 'production', Role: 'app' },
      commands: ['systemctl restart app'],
      pollIntervalMs: 1,
      maxWaitMs: 1000,
    })

    const sendCall = calls.find(c => c.headers?.['X-Amz-Target']?.endsWith('.SendCommand'))!
    const body = JSON.parse(sendCall.body!)

    expect(body.Targets).toEqual([
      { Key: 'tag:Project', Values: ['my-app'] },
      { Key: 'tag:Environment', Values: ['production'] },
      { Key: 'tag:Role', Values: ['app'] },
    ])
    expect(body.DocumentName).toBe('AWS-RunShellScript')
    expect(body.Parameters).toEqual({ commands: ['systemctl restart app'] })
  })

  it('returns success once all matched instances reach Success', async () => {
    const ssm = new SSMClient('us-east-1')
    withMockedClient(ssm, {
      SendCommand: { Command: { CommandId: 'cmd-3' } },
      ListCommandInvocations: {
        CommandInvocations: [
          { InstanceId: 'i-aaa', Status: 'Success', CommandPlugins: [{ Output: 'ok' }] },
          { InstanceId: 'i-bbb', Status: 'Success', CommandPlugins: [{ Output: 'ok' }] },
        ],
      },
    })

    const result = await ssm.sendCommandByTags({
      tags: { Project: 'my-app' },
      commands: ['true'],
      pollIntervalMs: 1,
      maxWaitMs: 1000,
    })

    expect(result.success).toBe(true)
    expect(result.instanceCount).toBe(2)
    expect(result.perInstance.map(p => p.instanceId).sort()).toEqual(['i-aaa', 'i-bbb'])
  })

  it('returns success=false when any instance fails', async () => {
    const ssm = new SSMClient('us-east-1')
    withMockedClient(ssm, {
      SendCommand: { Command: { CommandId: 'cmd-4' } },
      ListCommandInvocations: {
        CommandInvocations: [
          { InstanceId: 'i-aaa', Status: 'Success' },
          { InstanceId: 'i-bbb', Status: 'Failed', StatusDetails: 'systemctl is-active returned 3' },
        ],
      },
    })

    const result = await ssm.sendCommandByTags({
      tags: { Project: 'my-app' },
      commands: ['systemctl restart broken'],
      pollIntervalMs: 1,
      maxWaitMs: 1000,
    })

    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
    const failed = result.perInstance.find(p => p.instanceId === 'i-bbb')!
    expect(failed.status).toBe('Failed')
  })

  it('returns Failed Send result when SSM does not return a CommandId', async () => {
    const ssm = new SSMClient('us-east-1')
    withMockedClient(ssm, {
      SendCommand: {}, // no Command field
    })

    const result = await ssm.sendCommandByTags({
      tags: { Project: 'my-app' },
      commands: ['true'],
      pollIntervalMs: 1,
      maxWaitMs: 1000,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Failed to send command')
  })
})
