import type { JsonValue } from '../control-plane'
import type { ConfigurationSecretBackend } from './backends'
import type { ConfigurationBackend, ConfigurationEntry, ConfigurationKind, ConfigurationMutationResult, ConfigurationScope } from './model'
import { createHmac } from 'node:crypto'
import { sanitizeControlPlaneValue } from '../control-plane'
import { LocalEncryptedConfigurationBackend } from './backends'
import { parseDotenv, serializeDotenv } from './dotenv'
import { ConfigurationStore } from './store'

export interface ConfigurationMetadata {
  id: string
  key: string
  kind: ConfigurationKind
  scope: ConfigurationScope
  inherited: boolean
  overridden: boolean
  required: boolean
  backend?: ConfigurationBackend
  backendVersion?: string
  reference?: string
  lastUsedAt?: string
  rotatedAt?: string
  version: number
  updatedAt: string
  value?: string
}

export interface ConfigurationWarning {
  key?: string
  code: 'reserved' | 'limit' | 'missing_required' | 'stale_reference'
  message: string
}
export interface ResolvedConfiguration {
  values: Record<string, string>
  entries: Record<string, ConfigurationMetadata>
  warnings: ConfigurationWarning[]
  configurationHash: string
}

export interface SetConfigurationInput {
  organizationId: string
  projectId: string
  scope: ConfigurationScope
  key: string
  kind: ConfigurationKind
  value?: string
  reference?: string
  backend?: Exclude<ConfigurationBackend, 'plaintext'>
  required?: boolean
  metadata?: Record<string, JsonValue>
  expectedVersion?: number
  confirmed?: boolean
  idempotencyKey?: string
  actorId?: string
  origin?: ConfigurationEntry['origin']
}

export interface ConfigurationPlan {
  added: string[]
  changed: string[]
  removed: string[]
  unchanged: string[]
  affectedResourceIds: string[]
  warnings: ConfigurationWarning[]
}

const SENSITIVE_REFERENCE = /^(?:secret|aws-sm|aws-ssm|vault|doppler|op|external):\/\//
const RESERVED = /^(?:AWS_|TS_CLOUD_|PORT$|HOST$)/

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}
function metadata(
  entry: ConfigurationEntry,
  options: { inherited?: boolean; overridden?: boolean; canReadSecretMetadata?: boolean } = {},
): ConfigurationMetadata {
  const secret = entry.kind === 'secret'
  return {
    id: entry.id,
    key: entry.key,
    kind: entry.kind,
    scope: entry.scope,
    inherited: !!options.inherited,
    overridden: !!options.overridden,
    required: entry.required,
    backend: !secret || options.canReadSecretMetadata ? entry.backend : undefined,
    backendVersion: !secret || options.canReadSecretMetadata ? entry.backendVersion : undefined,
    reference: secret && options.canReadSecretMetadata ? entry.secretRef : undefined,
    value: !secret ? entry.value : undefined,
    lastUsedAt: entry.lastUsedAt,
    rotatedAt: entry.rotatedAt,
    version: entry.version,
    updatedAt: entry.updatedAt,
  }
}

export class ConfigurationService {
  readonly store: ConfigurationStore
  private readonly backends = new Map<ConfigurationBackend, ConfigurationSecretBackend>()
  private readonly fingerprintKey: string
  private readonly now: () => Date

  constructor(
    store: ConfigurationStore,
    options: {
      encryptionKey: string
      fingerprintKey?: string
      backends?: ConfigurationSecretBackend[]
      now?: () => Date
    },
  ) {
    this.store = store
    this.fingerprintKey = options.fingerprintKey ?? options.encryptionKey
    this.now = options.now ?? (() => new Date())
    if (!this.fingerprintKey) throw new Error('Configuration fingerprint key is required.')
    const configured = options.backends ?? [
      new LocalEncryptedConfigurationBackend(store.controlPlane, options.encryptionKey, this.now),
    ]
    for (const backend of configured) this.backends.set(backend.kind, backend)
  }

  list(input: {
    projectId: string
    scope?: ConfigurationScope
    kind?: ConfigurationKind
    search?: string
    canReadSecretMetadata?: boolean
  }): ConfigurationMetadata[] {
    const search = input.search?.toLowerCase()
    return this.store
      .list(input)
      .filter((entry) => !search || entry.key.toLowerCase().includes(search))
      .map((entry) => metadata(entry, { canReadSecretMetadata: input.canReadSecretMetadata }))
  }

  plan(input: {
    projectId: string
    scope: ConfigurationScope
    values: Record<string, string>
    removeMissing?: boolean
  }): ConfigurationPlan {
    const existing = this.store.list({ projectId: input.projectId, scope: input.scope }),
      byKey = new Map(existing.map((entry) => [entry.key, entry])),
      warnings: ConfigurationWarning[] = []
    const added: string[] = [],
      changed: string[] = [],
      unchanged: string[] = []
    for (const [key, value] of Object.entries(input.values)) {
      warnings.push(...this.warnings(key, value))
      const current = byKey.get(key)
      if (!current) added.push(key)
      else if (current.valueFingerprint !== this.fingerprint(value)) changed.push(key)
      else unchanged.push(key)
    }
    const removed = input.removeMissing
      ? existing.filter((entry) => !Object.hasOwn(input.values, entry.key)).map((entry) => entry.key)
      : []
    return {
      added: sorted(added),
      changed: sorted(changed),
      removed: sorted(removed),
      unchanged: sorted(unchanged),
      affectedResourceIds: this.affectedResources(input.projectId, input.scope, [...added, ...changed, ...removed]),
      warnings,
    }
  }

  async set(
    input: SetConfigurationInput,
  ): Promise<{ entry: ConfigurationEntry; mutation: ConfigurationMutationResult; warnings: ConfigurationWarning[] }> {
    const requestHash = this.requestHash(input),
      idempotencyKey = input.idempotencyKey
    if (idempotencyKey) {
      const prior = this.store.mutation(idempotencyKey)
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new Error('Idempotency key was already used for a different configuration mutation.')
        const existing = this.store.get(String(prior.result.entryId ?? ''))
        if (!existing) throw new Error('Idempotent configuration result is no longer available.')
        return {
          entry: existing,
          mutation: prior.result.mutation as unknown as ConfigurationMutationResult,
          warnings: [],
        }
      }
    }
    if (input.value != null && SENSITIVE_REFERENCE.test(input.value))
      throw new Error('Secret references must use the reference field, not a plaintext value field.')
    const current = this.store.find(input.projectId, input.scope, input.key),
      fingerprint = this.fingerprint(input.value ?? input.reference ?? '')
    if (current && input.expectedVersion != null && current.version !== input.expectedVersion)
      throw new Error('Configuration entry changed; refresh and retry.')
    if (current && current.kind !== input.kind)
      throw new Error('Delete the existing entry before changing between variable and secret kinds.')
    const backendKind: ConfigurationBackend =
      input.kind === 'variable' ? 'plaintext' : (input.backend ?? (input.reference ? 'external' : 'local_encrypted'))
    const replacing =
      !!current &&
      (current.valueFingerprint !== fingerprint ||
        current.backend !== backendKind ||
        current.required !== !!input.required)
    if (
      replacing &&
      (this.isProduction(current!) || this.store.dependencies(current!.id).length > 0) &&
      !input.confirmed
    )
      throw new Error('Confirmation is required because this replacement affects production or dependent services.')
    let secretRef = input.reference,
      backendVersion: string | undefined
    if (input.kind === 'secret') {
      const backend = this.backend(backendKind)
      if (input.reference && input.value == null) {
        if (!(await backend.validate(input.reference)))
          throw new Error('Secret backend reference is unavailable or invalid.')
        backendVersion = current?.backendVersion ?? 'external'
      } else {
        if (input.value == null) throw new Error('A secret value or external reference is required.')
        const written = await backend.put({
          reference: current?.backend === backendKind ? current.secretRef : undefined,
          name: this.backendName(input),
          value: input.value,
          idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
        })
        secretRef = written.reference
        backendVersion = written.version
      }
    }
    const value = input.kind === 'variable' ? input.value : undefined
    if (input.kind === 'variable' && value == null) throw new Error('A variable value is required.')
    const changed =
      !current ||
      current.valueFingerprint !== fingerprint ||
      current.backend !== backendKind ||
      current.secretRef !== secretRef ||
      current.backendVersion !== backendVersion ||
      current.required !== !!input.required
    const entry = current
      ? changed
        ? this.store.update(current.id, current.version, {
            value,
            valueFingerprint: fingerprint,
            secretRef,
            backend: backendKind,
            backendVersion,
            required: !!input.required,
            metadata: sanitizeControlPlaneValue(input.metadata ?? current.metadata) as Record<string, JsonValue>,
            rotatedAt: input.kind === 'secret' ? this.now().toISOString() : current.rotatedAt,
          })
        : current
      : this.store.create({
          organizationId: input.organizationId,
          projectId: input.projectId,
          scope: input.scope,
          key: input.key,
          kind: input.kind,
          value,
          valueFingerprint: fingerprint,
          secretRef,
          backend: backendKind,
          backendVersion,
          origin: input.origin ?? 'managed',
          required: !!input.required,
          metadata: sanitizeControlPlaneValue(input.metadata ?? {}) as Record<string, JsonValue>,
          rotatedAt: input.kind === 'secret' ? this.now().toISOString() : undefined,
        })
    const affectedResourceIds = this.affectedResources(input.projectId, input.scope, [input.key])
    const mutation: ConfigurationMutationResult = {
      added: current ? [] : [input.key],
      changed: current && changed ? [input.key] : [],
      removed: [],
      unchanged: current && !changed ? [input.key] : [],
      affectedResourceIds,
      versions: { [input.key]: entry.version },
    }
    if (idempotencyKey)
      this.store.recordMutation({
        projectId: input.projectId,
        idempotencyKey,
        requestHash,
        actorId: input.actorId,
        result: { entryId: entry.id, mutation: mutation as unknown as JsonValue },
      })
    this.audit(
      input.projectId,
      input.actorId,
      current && changed ? 'configuration.updated' : current ? 'configuration.unchanged' : 'configuration.created',
      entry,
      affectedResourceIds,
    )
    return { entry, mutation, warnings: this.warnings(input.key, input.value ?? '') }
  }

  async importDotenv(
    input: Omit<SetConfigurationInput, 'key' | 'kind' | 'value'> & { source: string; secretKeys?: string[] },
  ): Promise<{
    document: ReturnType<typeof parseDotenv>
    mutation?: ConfigurationMutationResult
    warnings: ConfigurationWarning[]
  }> {
    const document = parseDotenv(input.source)
    if (!document.valid) return { document, warnings: [] }
    const secretKeys = new Set(input.secretKeys ?? []),
      aggregate: ConfigurationMutationResult = {
        added: [],
        changed: [],
        removed: [],
        unchanged: [],
        affectedResourceIds: [],
        versions: {},
      },
      warnings: ConfigurationWarning[] = []
    for (const [key, value] of Object.entries(document.values)) {
      const result = await this.set({
        ...input,
        source: undefined,
        key,
        value,
        kind: secretKeys.has(key) ? 'secret' : 'variable',
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${key}` : undefined,
      } as SetConfigurationInput)
      aggregate.added.push(...result.mutation.added)
      aggregate.changed.push(...result.mutation.changed)
      aggregate.unchanged.push(...result.mutation.unchanged)
      aggregate.affectedResourceIds.push(...result.mutation.affectedResourceIds)
      Object.assign(aggregate.versions, result.mutation.versions)
      warnings.push(...result.warnings)
    }
    aggregate.added = sorted(aggregate.added)
    aggregate.changed = sorted(aggregate.changed)
    aggregate.unchanged = sorted(aggregate.unchanged)
    aggregate.affectedResourceIds = sorted(aggregate.affectedResourceIds)
    return { document, mutation: aggregate, warnings }
  }

  exportVariables(input: { projectId: string; scope: ConfigurationScope }): string {
    return serializeDotenv(
      Object.fromEntries(
        this.store
          .list({ projectId: input.projectId, scope: input.scope, kind: 'variable' })
          .map((entry) => [entry.key, entry.value ?? '']),
      ),
    )
  }

  async transfer(input: {
    entryId: string
    targetScope: ConfigurationScope
    mode: 'copy' | 'move'
    confirmed?: boolean
    actorId?: string
    idempotencyKey?: string
  }): Promise<{ entry: ConfigurationEntry; mutation: ConfigurationMutationResult }> {
    const source = this.store.get(input.entryId)
    if (!source) throw new Error('Configuration entry was not found.')
    if (source.scope.type === input.targetScope.type && source.scope.id === input.targetScope.id)
      throw new Error('Choose a different destination scope.')
    const value =
      source.kind === 'variable'
        ? source.value
        : source.backend === 'external'
          ? undefined
          : await this.backend(source.backend).resolve(source.secretRef!)
    const secretBackend =
      source.kind === 'secret' ? (source.backend as Exclude<ConfigurationBackend, 'plaintext'>) : undefined
    const copied = await this.set({
      organizationId: source.organizationId,
      projectId: source.projectId,
      scope: input.targetScope,
      key: source.key,
      kind: source.kind,
      value,
      reference: source.backend === 'external' ? source.secretRef : undefined,
      backend: secretBackend,
      required: source.required,
      metadata: source.metadata,
      confirmed: input.confirmed,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:copy` : undefined,
      origin: source.origin,
    })
    if (input.mode === 'move')
      await this.remove({
        entryId: source.id,
        expectedVersion: source.version,
        confirmed: input.confirmed,
        actorId: input.actorId,
      })
    const mutation: ConfigurationMutationResult = {
      added: copied.mutation.added,
      changed: copied.mutation.changed,
      removed: input.mode === 'move' ? [source.key] : [],
      unchanged: copied.mutation.unchanged,
      affectedResourceIds: sorted([
        ...copied.mutation.affectedResourceIds,
        ...this.affectedResources(source.projectId, source.scope, [source.key]),
      ]),
      versions: copied.mutation.versions,
    }
    return { entry: copied.entry, mutation }
  }

  async resolve(input: {
    projectId: string
    environmentId?: string
    resourceId?: string
    functionId?: string
    previewId?: string
    trustedPreview?: boolean
    allowedPreviewSecrets?: string[]
    nativeReferences?: boolean
    canReadSecretMetadata?: boolean
  }): Promise<ResolvedConfiguration> {
    const all = this.store.list({ projectId: input.projectId }),
      candidates = all
        .filter((entry) => this.applies(entry, input))
        .sort((left, right) => this.rank(left.scope.type) - this.rank(right.scope.type))
    const selected = new Map<string, ConfigurationEntry>(),
      overridden = new Set<string>()
    for (const entry of candidates) {
      if (selected.has(entry.key)) overridden.add(entry.key)
      selected.set(entry.key, entry)
    }
    const values: Record<string, string> = {},
      entries: Record<string, ConfigurationMetadata> = {},
      warnings: ConfigurationWarning[] = [],
      allowed = new Set(input.allowedPreviewSecrets ?? [])
    for (const [key, entry] of selected) {
      if (
        input.previewId &&
        entry.kind === 'secret' &&
        entry.scope.type !== 'preview' &&
        (!input.trustedPreview || !allowed.has(key))
      )
        continue
      if (entry.kind === 'variable') values[key] = entry.value ?? ''
      else if (input.nativeReferences) values[key] = entry.secretRef!
      else {
        const backend = this.backend(entry.backend)
        if (!(await backend.validate(entry.secretRef!))) {
          warnings.push({ key, code: 'stale_reference', message: `${key} points to an unavailable secret.` })
          if (entry.required)
            warnings.push({ key, code: 'missing_required', message: `${key} is required but unavailable.` })
          continue
        }
        values[key] = await backend.resolve(entry.secretRef!)
      }
      entries[key] = metadata(entry, {
        inherited:
          entry.scope.type !==
          (input.previewId
            ? 'preview'
            : input.functionId
              ? 'function'
              : input.resourceId
                ? 'service'
                : input.environmentId
                  ? 'environment'
                  : 'project'),
        overridden: overridden.has(key),
        canReadSecretMetadata: input.canReadSecretMetadata,
      })
      this.store.controlPlane.database.run('UPDATE configuration_entries SET last_used_at=? WHERE id=?', [
        this.now().toISOString(),
        entry.id,
      ])
    }
    return {
      values,
      entries,
      warnings,
      configurationHash: this.fingerprint(
        [...selected.values()]
          .map((entry) => `${entry.key}:${entry.valueFingerprint}:${entry.version}`)
          .sort()
          .join('\n'),
      ),
    }
  }

  async reveal(input: {
    entryId: string
    canRevealSecrets: boolean
    recentlyAuthenticated: boolean
    actorId?: string
  }): Promise<string> {
    const entry = this.store.get(input.entryId)
    if (!entry || entry.kind !== 'secret') throw new Error('Configuration secret was not found.')
    if (!input.canRevealSecrets) throw new Error('Secret reveal permission is required.')
    if (!input.recentlyAuthenticated) throw new Error('Recent authentication is required to reveal a secret.')
    const value = await this.backend(entry.backend).resolve(entry.secretRef!)
    this.audit(entry.projectId, input.actorId, 'configuration.secret.revealed', entry, [])
    return value
  }

  async remove(input: {
    entryId: string
    expectedVersion: number
    confirmed?: boolean
    actorId?: string
  }): Promise<ConfigurationMutationResult> {
    const entry = this.store.get(input.entryId)
    if (!entry) throw new Error('Configuration entry was not found.')
    const dependencies = this.store.dependencies(entry.id),
      production = entry.scope.environmentId
        ? this.store.controlPlane
            .listEnvironments(entry.projectId)
            .some((environment) => environment.id === entry.scope.environmentId && environment.kind === 'production')
        : entry.scope.type === 'project'
    if ((production || dependencies.length) && !input.confirmed)
      throw new Error('Confirmation is required because this configuration affects production or dependent services.')
    if (entry.kind === 'secret' && entry.backend !== 'external')
      await this.backend(entry.backend).remove(entry.secretRef!)
    this.store.remove(entry.id, input.expectedVersion)
    const affectedResourceIds = sorted(dependencies.map((item) => item.resourceId))
    const result: ConfigurationMutationResult = {
      added: [],
      changed: [],
      removed: [entry.key],
      unchanged: [],
      affectedResourceIds,
      versions: {},
    }
    this.audit(entry.projectId, input.actorId, 'configuration.deleted', entry, affectedResourceIds)
    return result
  }

  private applies(
    entry: ConfigurationEntry,
    target: { projectId: string; environmentId?: string; resourceId?: string; functionId?: string; previewId?: string },
  ): boolean {
    if (entry.scope.type === 'project') return true
    if (entry.scope.type === 'environment') return entry.scope.id === target.environmentId
    if (entry.scope.type === 'service') return entry.scope.id === target.resourceId
    if (entry.scope.type === 'function') return entry.scope.id === target.functionId
    return entry.scope.id === target.previewId
  }
  private rank(scope: ConfigurationScope['type']): number {
    return { project: 0, environment: 1, service: 2, function: 3, preview: 4 }[scope]
  }
  private fingerprint(value: string): string {
    return `hmac-sha256:${createHmac('sha256', this.fingerprintKey).update(value).digest('hex')}`
  }
  private requestHash(input: SetConfigurationInput): string {
    return this.fingerprint(JSON.stringify({ ...input, idempotencyKey: undefined, actorId: undefined }))
  }
  private backend(kind: ConfigurationBackend): ConfigurationSecretBackend {
    const backend = this.backends.get(kind)
    if (!backend) throw new Error(`Configuration secret backend is not configured: ${kind}`)
    return backend
  }
  private backendName(input: SetConfigurationInput): string {
    return `ts-cloud/${input.projectId}/${input.scope.type}/${input.scope.id}/${input.key}`.replace(
      /[^A-Za-z0-9/_+=.@-]/g,
      '-',
    )
  }
  private isProduction(entry: ConfigurationEntry): boolean {
    return (
      entry.scope.type === 'project' ||
      (!!entry.scope.environmentId &&
        this.store.controlPlane
          .listEnvironments(entry.projectId)
          .some((environment) => environment.id === entry.scope.environmentId && environment.kind === 'production'))
    )
  }
  private warnings(key: string, value: string): ConfigurationWarning[] {
    const warnings: ConfigurationWarning[] = []
    if (RESERVED.test(key))
      warnings.push({ key, code: 'reserved', message: `${key} may be reserved by the runtime or provider.` })
    if (Buffer.byteLength(value) > 64 * 1024)
      warnings.push({ key, code: 'limit', message: `${key} exceeds the portable 64 KiB value limit.` })
    return warnings
  }
  private affectedResources(projectId: string, scope: ConfigurationScope, keys: string[]): string[] {
    const explicit = this.store
      .list({ projectId, scope })
      .filter((entry) => keys.includes(entry.key))
      .flatMap((entry) => this.store.dependencies(entry.id).map((item) => item.resourceId))
    if (scope.type === 'service' || scope.type === 'function') return sorted([...explicit, scope.id])
    if (scope.type === 'environment')
      return sorted([
        ...explicit,
        ...this.store.controlPlane.listResources(projectId, scope.id).map((resource) => resource.id),
      ])
    if (scope.type === 'preview') {
      const preview = this.store.controlPlane.database
        .query<{ resource_id: string }, [string]>('SELECT resource_id FROM preview_instances WHERE id=?')
        .get(scope.id)
      return sorted([...explicit, ...(preview ? [preview.resource_id] : [])])
    }
    return sorted([...explicit, ...this.store.controlPlane.listResources(projectId).map((resource) => resource.id)])
  }
  private audit(
    projectId: string,
    actorId: string | undefined,
    type: string,
    entry: ConfigurationEntry,
    affectedResourceIds: string[],
  ): void {
    this.store.controlPlane.appendEvent({
      projectId,
      actorId,
      type,
      payload: {
        entryId: entry.id,
        key: entry.key,
        kind: entry.kind,
        scopeType: entry.scope.type,
        scopeId: entry.scope.id,
        backend: entry.backend,
        version: entry.version,
        affectedResourceIds,
      },
    })
  }
}
