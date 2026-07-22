import { describe, expect, test } from 'bun:test'
import { AwsSecretsManagerConfigurationBackend, AwsSsmConfigurationBackend, ExternalConfigurationBackend } from './backends'

describe('provider configuration backends', () => {
  test('creates and versions AWS Secrets Manager values with stable references', async () => {
    const calls: any[] = [], client = {
      createSecret: async (input: any) => { calls.push(['create', input]); return { ARN: 'arn:aws:secretsmanager:us-east-1:123:secret:app', VersionId: 'v1' } },
      putSecretValue: async (input: any) => { calls.push(['put', input]); return { VersionId: 'v2' } },
      getSecretValue: async (input: any) => { calls.push(['get', input]); return { SecretString: 'resolved' } },
      describeSecret: async (input: any) => { calls.push(['describe', input]); return {} },
      deleteSecret: async (input: any) => { calls.push(['delete', input]); return {} },
    }, backend = new AwsSecretsManagerConfigurationBackend(client as any, 'us-east-1')
    const created = await backend.put({ name: 'ts-cloud/project/TOKEN', value: 'first', idempotencyKey: 'request-1' }), rotated = await backend.put({ reference: created.reference, name: 'ignored', value: 'second', idempotencyKey: 'request-2' })
    expect(created.version).toBe('v1'); expect(rotated).toEqual({ reference: created.reference, version: 'v2' })
    expect(await backend.resolve(created.reference)).toBe('resolved'); expect(await backend.validate(created.reference)).toBe(true); await backend.remove(created.reference)
    expect(calls.map(item => item[0])).toEqual(['create', 'put', 'get', 'describe', 'delete'])
    expect(calls[1][1]).toMatchObject({ ClientRequestToken: 'request-2', SecretString: 'second' })
    expect(calls[4][1]).toMatchObject({ RecoveryWindowInDays: 7 })
  })

  test('uses SecureString and decryption only at the SSM deployment boundary', async () => {
    const calls: any[] = [], client = { putParameter: async (input: any) => { calls.push(['put', input]); return { Version: 3 } }, getParameter: async (input: any) => { calls.push(['get', input]); return { Parameter: { Value: input.WithDecryption ? 'resolved' : undefined } } }, deleteParameter: async (input: any) => { calls.push(['delete', input]) } }, backend = new AwsSsmConfigurationBackend(client as any, 'us-west-2')
    const written = await backend.put({ name: 'ts-cloud/app/TOKEN', value: 'secret', idempotencyKey: 'ignored' })
    expect(written).toEqual({ reference: 'aws-ssm://us-west-2/ts-cloud/app/TOKEN', version: '3' })
    expect(calls[0][1]).toMatchObject({ Type: 'SecureString', Overwrite: false, Value: 'secret' })
    expect(await backend.validate(written.reference)).toBe(true); expect(await backend.resolve(written.reference)).toBe('resolved'); await backend.remove(written.reference)
    expect(calls[1][1].WithDecryption).toBe(false); expect(calls[2][1].WithDecryption).toBe(true)
  })

  test('validates external references without attempting resolution', async () => {
    const backend = new ExternalConfigurationBackend()
    expect(await backend.validate('vault://team/app/token')).toBe(true)
    expect(await backend.validate('https://example.test/token')).toBe(false)
    await expect(backend.resolve()).rejects.toThrow('deployment provider')
  })
})
