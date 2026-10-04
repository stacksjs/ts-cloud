/**
 * Secrets Manager requires a ClientRequestToken on UpdateSecret (when it
 * carries a new value) and PutSecretValue. The AWS SDKs and CLI generate one
 * when the caller leaves it out; a raw HTTP client has to do the same, per
 * the API reference. createSecret already did; updateSecret never sent one,
 * and putSecretValue sent one only when the caller passed it.
 */

import { describe, expect, it } from 'bun:test'
import { SecretsManagerClient } from '../src/aws/secrets-manager'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function captureBodies(client: SecretsManagerClient): Array<Record<string, any>> {
  const bodies: Array<Record<string, any>> = []
  // @ts-expect-error — reach into the private AWSClient to stub one call
  client.client.request = async (options: any) => {
    bodies.push(JSON.parse(options.body))
    return {}
  }
  return bodies
}

describe('SecretsManagerClient sends a ClientRequestToken like the SDKs do', () => {
  it('updateSecret generates one when the caller passes none', async () => {
    const client = new SecretsManagerClient('us-east-1')
    const bodies = captureBodies(client)
    await client.updateSecret({ SecretId: 's', KmsKeyId: 'arn:aws:kms:us-east-1:1:key/k', SecretString: '{}' })
    expect(bodies[0]?.ClientRequestToken).toMatch(UUID)
  })

  it('updateSecret keeps a caller-supplied token', async () => {
    const client = new SecretsManagerClient('us-east-1')
    const bodies = captureBodies(client)
    await client.updateSecret({ SecretId: 's', SecretString: '{}', ClientRequestToken: 'caller-token-0000000000000000000000' })
    expect(bodies[0]?.ClientRequestToken).toBe('caller-token-0000000000000000000000')
  })

  it('putSecretValue generates one when the caller passes none', async () => {
    const client = new SecretsManagerClient('us-east-1')
    const bodies = captureBodies(client)
    await client.putSecretValue({ SecretId: 's', SecretString: '{}' })
    expect(bodies[0]?.ClientRequestToken).toMatch(UUID)
  })

  it('each call gets its own token', async () => {
    const client = new SecretsManagerClient('us-east-1')
    const bodies = captureBodies(client)
    await client.putSecretValue({ SecretId: 's', SecretString: '{}' })
    await client.putSecretValue({ SecretId: 's', SecretString: '{}' })
    expect(bodies[0]?.ClientRequestToken).not.toBe(bodies[1]?.ClientRequestToken)
  })
})
