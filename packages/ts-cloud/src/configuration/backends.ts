import type { SecretsManagerClient } from '../aws/secrets-manager'
import type { SSMClient } from '../aws/ssm'
import type { ControlPlaneStore } from '../control-plane'
import type { ConfigurationBackend } from './model'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export interface SecretWrite {
  reference?: string
  name: string
  value: string
  idempotencyKey: string
}
export interface SecretWriteResult {
  reference: string
  version: string
}
export interface ConfigurationSecretBackend {
  readonly kind: Exclude<ConfigurationBackend, 'plaintext'>
  put(input: SecretWrite): Promise<SecretWriteResult>
  resolve(reference: string): Promise<string>
  remove(reference: string): Promise<void>
  validate(reference: string): Promise<boolean>
}

export class LocalEncryptedConfigurationBackend implements ConfigurationSecretBackend {
  readonly kind = 'local_encrypted' as const
  private readonly key: Buffer
  constructor(
    private readonly controlPlane: ControlPlaneStore,
    encryptionKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!encryptionKey) throw new Error('Configuration encryption key is required.')
    this.key = createHash('sha256').update(`ts-cloud:configuration:${encryptionKey}`).digest()
  }
  private encrypt(value: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv),
      ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
  }
  private decrypt(value: string): string {
    const [version, iv, tag, ciphertext] = value.split('.')
    if (version !== 'v1' || !iv || !tag || !ciphertext)
      throw new Error('Encrypted configuration secret is unavailable.')
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      throw new Error('Encrypted configuration secret could not be decrypted.')
    }
  }
  async put(input: SecretWrite): Promise<SecretWriteResult> {
    if (!input.value) throw new Error('Configuration secrets cannot be empty.')
    const reference = input.reference ?? `secret://configuration/${input.name}/${crypto.randomUUID()}`
    if (!/^secret:\/\/configuration\/[A-Za-z0-9._/-]+$/.test(reference))
      throw new Error('Invalid local configuration secret reference.')
    const current = this.controlPlane.database
      .query<{ version: number }, [string]>('SELECT version FROM configuration_secret_values WHERE reference=?')
      .get(reference)
    const version = (current?.version ?? 0) + 1,
      now = this.now().toISOString()
    this.controlPlane.database.run(
      `INSERT INTO configuration_secret_values (reference,ciphertext,fingerprint,version,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(reference) DO UPDATE SET ciphertext=excluded.ciphertext,fingerprint=excluded.fingerprint,version=excluded.version,updated_at=excluded.updated_at`,
      [reference, this.encrypt(input.value), createHash('sha256').update(input.value).digest('hex'), version, now, now],
    )
    return { reference, version: String(version) }
  }
  async resolve(reference: string): Promise<string> {
    const row = this.controlPlane.database
      .query<{ ciphertext: string }, [string]>('SELECT ciphertext FROM configuration_secret_values WHERE reference=?')
      .get(reference)
    if (!row) throw new Error('Configuration secret was not found.')
    return this.decrypt(row.ciphertext)
  }
  async remove(reference: string): Promise<void> {
    this.controlPlane.database.run('DELETE FROM configuration_secret_values WHERE reference=?', [reference])
  }
  async validate(reference: string): Promise<boolean> {
    return !!this.controlPlane.database
      .query<{ found: number }, [string]>('SELECT 1 AS found FROM configuration_secret_values WHERE reference=?')
      .get(reference)
  }
}

type SecretsManagerApi = Pick<
  SecretsManagerClient,
  'createSecret' | 'putSecretValue' | 'getSecretValue' | 'describeSecret' | 'deleteSecret'
>
export class AwsSecretsManagerConfigurationBackend implements ConfigurationSecretBackend {
  readonly kind = 'aws_secrets_manager' as const
  constructor(
    private readonly client: SecretsManagerApi,
    private readonly region: string,
  ) {}
  async put(input: SecretWrite): Promise<SecretWriteResult> {
    if (input.reference) {
      const id = this.id(input.reference),
        result = await this.client.putSecretValue({
          SecretId: id,
          SecretString: input.value,
          ClientRequestToken: input.idempotencyKey,
        })
      return { reference: input.reference, version: result.VersionId ?? input.idempotencyKey }
    }
    const result = await this.client.createSecret({
      Name: input.name,
      SecretString: input.value,
      ClientRequestToken: input.idempotencyKey,
      Tags: [{ Key: 'managed-by', Value: 'ts-cloud' }],
    })
    return {
      reference: `aws-sm://${this.region}/${encodeURIComponent(result.ARN ?? result.Name ?? input.name)}`,
      version: result.VersionId ?? input.idempotencyKey,
    }
  }
  async resolve(reference: string): Promise<string> {
    const value = await this.client.getSecretValue({ SecretId: this.id(reference) })
    if (value.SecretString == null) throw new Error('AWS Secrets Manager value is unavailable.')
    return value.SecretString
  }
  async remove(reference: string): Promise<void> {
    await this.client.deleteSecret({ SecretId: this.id(reference), RecoveryWindowInDays: 7 })
  }
  async validate(reference: string): Promise<boolean> {
    try {
      await this.client.describeSecret(this.id(reference))
      return true
    } catch {
      return false
    }
  }
  private id(reference: string): string {
    const parsed = new URL(reference)
    if (parsed.protocol !== 'aws-sm:' || parsed.hostname !== this.region)
      throw new Error('Invalid AWS Secrets Manager reference.')
    return decodeURIComponent(parsed.pathname.slice(1))
  }
}

type SsmApi = Pick<SSMClient, 'putParameter' | 'getParameter' | 'deleteParameter'>
export class AwsSsmConfigurationBackend implements ConfigurationSecretBackend {
  readonly kind = 'aws_ssm' as const
  constructor(
    private readonly client: SsmApi,
    private readonly region: string,
  ) {}
  async put(input: SecretWrite): Promise<SecretWriteResult> {
    const name = input.reference ? this.name(input.reference) : `/${input.name.replace(/^\/+/, '')}`
    const result = await this.client.putParameter({
      Name: name,
      Value: input.value,
      Type: 'SecureString',
      Overwrite: !!input.reference,
      Description: 'Managed by ts-cloud',
    })
    return { reference: `aws-ssm://${this.region}${name}`, version: String(result.Version ?? 1) }
  }
  async resolve(reference: string): Promise<string> {
    const result = await this.client.getParameter({ Name: this.name(reference), WithDecryption: true })
    if (result.Parameter?.Value == null) throw new Error('AWS SSM parameter value is unavailable.')
    return result.Parameter.Value
  }
  async remove(reference: string): Promise<void> {
    await this.client.deleteParameter({ Name: this.name(reference) })
  }
  async validate(reference: string): Promise<boolean> {
    try {
      return !!(await this.client.getParameter({ Name: this.name(reference), WithDecryption: false })).Parameter
    } catch {
      return false
    }
  }
  private name(reference: string): string {
    const parsed = new URL(reference)
    if (parsed.protocol !== 'aws-ssm:' || parsed.hostname !== this.region || !parsed.pathname.startsWith('/'))
      throw new Error('Invalid AWS SSM reference.')
    return parsed.pathname
  }
}

export class ExternalConfigurationBackend implements ConfigurationSecretBackend {
  readonly kind = 'external' as const
  async put(): Promise<SecretWriteResult> {
    throw new Error('External secret references cannot be written by ts-cloud.')
  }
  async resolve(): Promise<string> {
    throw new Error('External secrets must be resolved by the deployment provider.')
  }
  async remove(): Promise<void> {}
  async validate(reference: string): Promise<boolean> {
    return /^(?:vault|doppler|op|external):\/\//.test(reference)
  }
}
