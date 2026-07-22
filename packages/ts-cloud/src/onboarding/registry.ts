import type { ControlPlaneStore } from '../control-plane'
import type { RegistryConnection, RegistryCredential } from './types'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

type Row = Record<string, unknown>
type RegistryFetch = typeof fetch

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}
function host(value: string): string {
  const parsed = new URL(value.includes('://') ? value : `https://${value}`)
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname))
    throw new Error('Registry host must use HTTPS')
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('Registry host cannot contain credentials')
  return `${parsed.protocol}//${parsed.host}`
}
function map(row: Row): RegistryConnection {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    provider: String(row.provider) as RegistryConnection['provider'],
    name: String(row.name),
    host: String(row.host),
    credentialConfigured: !!row.credential_ciphertext,
    credentialFingerprint: optional(row.credential_fingerprint),
    credentialExpiresAt: optional(row.credential_expires_at),
    status: String(row.status) as RegistryConnection['status'],
    healthMessage: optional(row.health_message),
    lastTestedAt: optional(row.last_tested_at),
    version: Number(row.version),
    createdByActorId: optional(row.created_by_actor_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export class RegistryConnectionStore {
  private readonly key: Buffer
  private readonly nowFn: () => Date
  private readonly idFn: () => string
  constructor(
    private readonly controlPlane: ControlPlaneStore,
    options: { encryptionKey: string; now?: () => Date; id?: () => string },
  ) {
    if (!options.encryptionKey) throw new Error('Registry encryption key is required')
    this.key = createHash('sha256').update(`ts-cloud:registry:${options.encryptionKey}`).digest()
    this.nowFn = options.now ?? (() => new Date())
    this.idFn = options.id ?? (() => crypto.randomUUID())
  }
  private now(): string {
    return this.nowFn().toISOString()
  }
  private encrypt(value: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`
  }
  private decrypt(value: string): string {
    const [version, iv, tag, data] = value.split('.')
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Registry credential envelope is invalid')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
  }
  private current(row: Row): RegistryConnection {
    const item = map(row)
    return item.status !== 'disconnected' &&
      item.credentialExpiresAt &&
      new Date(item.credentialExpiresAt).getTime() <= this.nowFn().getTime()
      ? { ...item, status: 'expired', healthMessage: 'Registry credential expired; rotate it before pulling images.' }
      : item
  }
  create(input: {
    organizationId: string
    provider: RegistryConnection['provider']
    name: string
    host: string
    credential?: RegistryCredential
    credentialExpiresAt?: string
    actorId?: string
  }): RegistryConnection {
    if (!['docker_hub', 'ghcr', 'ecr', 'gcr', 'generic'].includes(input.provider))
      throw new Error('A supported registry provider is required')
    const encoded = input.credential ? JSON.stringify(input.credential) : undefined
    const id = this.idFn()
    const now = this.now()
    this.controlPlane.database.run(
      'INSERT INTO registry_connections (id, organization_id, provider, name, host, credential_ciphertext, credential_fingerprint, credential_expires_at, created_by_actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        input.organizationId,
        input.provider,
        input.name.trim().slice(0, 80),
        host(input.host),
        encoded ? this.encrypt(encoded) : null,
        encoded ? fingerprint(encoded) : null,
        input.credentialExpiresAt ?? null,
        input.actorId ?? null,
        now,
        now,
      ],
    )
    this.controlPlane.appendEvent({
      organizationId: input.organizationId,
      actorId: input.actorId,
      type: 'registry.connection.created',
      payload: { connectionId: id, provider: input.provider, host: host(input.host), credentialConfigured: !!encoded },
    })
    return this.get(id)!
  }
  get(id: string): RegistryConnection | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM registry_connections WHERE id=?').get(id)
    return row ? this.current(row) : undefined
  }
  list(organizationId: string): RegistryConnection[] {
    return this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM registry_connections WHERE organization_id=? ORDER BY name')
      .all(organizationId)
      .map((row) => this.current(row))
  }
  credential(id: string): RegistryCredential | undefined {
    const row = this.controlPlane.database
      .query<Row, [string]>('SELECT credential_ciphertext FROM registry_connections WHERE id=?')
      .get(id)
    return row?.credential_ciphertext
      ? (JSON.parse(this.decrypt(String(row.credential_ciphertext))) as RegistryCredential)
      : undefined
  }
  rotate(
    id: string,
    credential: RegistryCredential,
    input: { expiresAt?: string; actorId?: string } = {},
  ): RegistryConnection {
    const current = this.get(id)
    if (!current || current.status === 'disconnected') throw new Error('Registry connection was not found')
    const encoded = JSON.stringify(credential)
    this.controlPlane.database.run(
      "UPDATE registry_connections SET credential_ciphertext=?, credential_fingerprint=?, credential_expires_at=?, status='pending', health_message=NULL, version=version+1, updated_at=? WHERE id=?",
      [this.encrypt(encoded), fingerprint(encoded), input.expiresAt ?? null, this.now(), id],
    )
    this.controlPlane.appendEvent({
      organizationId: current.organizationId,
      actorId: input.actorId,
      type: 'registry.credential.rotated',
      payload: { connectionId: id, fingerprint: fingerprint(encoded), expiresAt: input.expiresAt ?? null },
    })
    return this.get(id)!
  }
  disconnect(id: string, actorId?: string): RegistryConnection {
    const current = this.get(id)
    if (!current) throw new Error('Registry connection was not found')
    this.controlPlane.database.run(
      "UPDATE registry_connections SET credential_ciphertext=NULL, credential_fingerprint=NULL, status='disconnected', health_message='Disconnected by an administrator', version=version+1, updated_at=? WHERE id=?",
      [this.now(), id],
    )
    this.controlPlane.appendEvent({
      organizationId: current.organizationId,
      actorId,
      type: 'registry.connection.disconnected',
      level: 'warning',
      payload: { connectionId: id },
    })
    return this.get(id)!
  }

  async test(
    id: string,
    input: { image?: string; fetch?: RegistryFetch; timeoutMs?: number } = {},
  ): Promise<RegistryConnection> {
    const connection = this.get(id)
    if (!connection || ['disconnected', 'expired'].includes(connection.status))
      throw new Error('Active registry connection was not found')
    const credential = this.credential(id)
    const fetchFn = input.fetch ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000)
    const basic = credential?.token
      ? `Bearer ${credential.token}`
      : credential?.username || credential?.password
        ? `Basic ${Buffer.from(`${credential.username ?? ''}:${credential.password ?? ''}`).toString('base64')}`
        : undefined
    try {
      let response = await fetchFn(`${connection.host}/v2/`, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: basic ? { Authorization: basic } : undefined,
      })
      const challenge = response.headers.get('www-authenticate') ?? ''
      if (response.status === 401 && challenge.startsWith('Bearer ') && credential) {
        const params = Object.fromEntries(
          [...challenge.slice(7).matchAll(/(\w+)="([^"]+)"/g)].map((match) => [match[1]!, match[2]!]),
        )
        const realm = new URL(params.realm ?? '')
        if (realm.protocol !== 'https:') throw new Error('Registry authentication realm must use HTTPS')
        if (params.service) realm.searchParams.set('service', params.service)
        if (input.image) realm.searchParams.set('scope', `repository:${parseImage(input.image).repository}:pull`)
        const tokenResponse = await fetchFn(realm, {
          signal: controller.signal,
          redirect: 'error',
          headers: basic ? { Authorization: basic } : undefined,
        })
        if (!tokenResponse.ok) throw new Error(`Registry authentication failed (${tokenResponse.status})`)
        const token = (await tokenResponse.json()) as { token?: string; access_token?: string }
        const bearer = token.token ?? token.access_token
        if (!bearer) throw new Error('Registry did not return an access token')
        response = input.image
          ? await manifestRequest(fetchFn, connection.host, input.image, bearer, controller.signal)
          : await fetchFn(`${connection.host}/v2/`, {
              signal: controller.signal,
              redirect: 'error',
              headers: { Authorization: `Bearer ${bearer}` },
            })
      } else if (response.ok && input.image)
        response = await manifestRequest(
          fetchFn,
          connection.host,
          input.image,
          credential?.token,
          controller.signal,
          basic,
        )
      const status = response.ok ? 'healthy' : 'degraded'
      const message = response.ok
        ? input.image
          ? 'Registry image is readable.'
          : 'Registry connection is healthy.'
        : `Registry request failed (${response.status})`
      this.controlPlane.database.run(
        'UPDATE registry_connections SET status=?, health_message=?, last_tested_at=?, version=version+1, updated_at=? WHERE id=?',
        [status, message, this.now(), this.now(), id],
      )
      return this.get(id)!
    } catch (error) {
      const message = controller.signal.aborted
        ? 'Registry request timed out.'
        : error instanceof Error
          ? error.message
          : 'Registry test failed'
      this.controlPlane.database.run(
        "UPDATE registry_connections SET status='degraded', health_message=?, last_tested_at=?, version=version+1, updated_at=? WHERE id=?",
        [message.slice(0, 1000), this.now(), this.now(), id],
      )
      return this.get(id)!
    } finally {
      clearTimeout(timer)
    }
  }
}

function parseImage(image: string): { repository: string; reference: string } {
  const value = image.replace(/^https?:\/\//, '')
  const slash = value.indexOf('/')
  if (slash < 1) throw new Error('Image must include registry/repository')
  const path = value.slice(slash + 1)
  const digest = path.lastIndexOf('@')
  const colon = path.lastIndexOf(':')
  const split = digest >= 0 ? digest : colon > path.lastIndexOf('/') ? colon : -1
  const repository = split >= 0 ? path.slice(0, split) : path
  const reference = split >= 0 ? path.slice(split + 1) : 'latest'
  if (!/^[A-Za-z0-9_.\/-]+$/.test(repository) || !/^[A-Za-z0-9_.:+-]+$/.test(reference))
    throw new Error('Image reference is invalid')
  return { repository, reference }
}
async function manifestRequest(
  fetchFn: RegistryFetch,
  root: string,
  image: string,
  token: string | undefined,
  signal: AbortSignal,
  authorization?: string,
): Promise<Response> {
  const parsed = parseImage(image)
  return fetchFn(`${root}/v2/${parsed.repository}/manifests/${encodeURIComponent(parsed.reference)}`, {
    method: 'HEAD',
    redirect: 'error',
    signal,
    headers: {
      Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
      ...(token ? { Authorization: `Bearer ${token}` } : authorization ? { Authorization: authorization } : {}),
    },
  })
}
