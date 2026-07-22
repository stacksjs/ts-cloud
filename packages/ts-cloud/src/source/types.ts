import type { JsonValue } from '../control-plane'

export type SourceProvider = 'github' | 'gitlab' | 'bitbucket' | 'gitea' | 'generic_https' | 'generic_ssh'
export type SourceConnectionStatus = 'pending' | 'healthy' | 'degraded' | 'expired' | 'disconnected'

export interface SourceCapabilities {
  repositories: boolean
  branches: boolean
  tags: boolean
  webhooks: boolean
  pullRequests: boolean
  tokenRefresh: boolean
  deployKeys: boolean
}

export interface SourceConnection {
  id: string
  organizationId: string
  provider: SourceProvider
  name: string
  host: string
  owner?: string
  authKind: 'app' | 'oauth_token' | 'access_token' | 'deploy_key' | 'none'
  credentialConfigured: boolean
  credentialFingerprint?: string
  grantedScopes: string[]
  capabilities: SourceCapabilities
  status: SourceConnectionStatus
  healthMessage?: string
  lastTestedAt?: string
  lastSyncedAt?: string
  credentialExpiresAt?: string
  version: number
  createdByActorId?: string
  createdAt: string
  updatedAt: string
}

export interface SourceCredential {
  token?: string
  username?: string
  appId?: string
  installationId?: string
  privateKey?: string
}

export interface SourceRepository {
  id: string
  connectionId: string
  providerRepositoryId: string
  fullName: string
  cloneUrl: string
  defaultBranch: string
  visibility: 'public' | 'private' | 'internal' | 'unknown'
  archived: boolean
  metadata: JsonValue
  syncedAt: string
}

export interface SourceDeployKey {
  id: string
  connectionId: string
  name: string
  publicKey: string
  publicKeyFingerprint: string
  host: string
  hostKey: string
  hostKeyFingerprint: string
  createdByActorId?: string
  createdAt: string
  updatedAt: string
}

export interface SourceBinding {
  id: string
  projectId: string
  environmentId?: string
  resourceId?: string
  connectionId: string
  repositoryId?: string
  repositoryFullName: string
  defaultBranch: string
  branchRule?: string
  tagRule?: string
  monorepoRoot: string
  includePaths: string[]
  excludePaths: string[]
  submodules: boolean
  cloneDepth?: number
  deployKeyId?: string
  autoDeploy: boolean
  pullRequestPreviews: boolean
  status: 'active' | 'disabled'
  disabledReason?: string
  version: number
  createdByActorId?: string
  createdAt: string
  updatedAt: string
}

export interface SourceWebhook {
  id: string
  connectionId: string
  repositoryId?: string
  repositoryFullName: string
  providerWebhookId?: string
  /** Returned only when the webhook endpoint is created; stored as a hash. */
  endpointToken?: string
  events: string[]
  status: 'pending' | 'healthy' | 'degraded' | 'disabled'
  healthMessage?: string
  lastDeliveryAt?: string
  lastReconciledAt?: string
  createdAt: string
  updatedAt: string
}

export interface SourceWebhookDelivery {
  id: string
  connectionId: string
  webhookId: string
  providerDeliveryId: string
  event: string
  action?: string
  commitSha?: string
  signatureStatus: 'verified' | 'invalid' | 'missing'
  status: 'accepted' | 'ignored' | 'rejected' | 'duplicate' | 'enqueued' | 'failed'
  payloadSummary: JsonValue
  operationId?: string
  error?: string
  receivedAt: string
  processedAt?: string
}

export interface SourceConnectionStoreOptions {
  encryptionKey?: string
  now?: () => Date
  id?: () => string
}

export interface SourceRepositoryPage {
  repositories: Array<Omit<SourceRepository, 'id' | 'connectionId' | 'syncedAt'>>
  nextCursor?: string
}

export interface SourceRef {
  name: string
  commitSha: string
  protected?: boolean
}

export interface SourceRefPage {
  refs: SourceRef[]
  nextCursor?: string
}

export interface SourceWebhookRegistration {
  providerWebhookId: string
  active: boolean
  events: string[]
  url: string
}

export interface SourceConnectionTest {
  ok: boolean
  account?: string
  scopes: string[]
  message: string
}

export interface SourceCommitStatus {
  state: 'pending' | 'success' | 'failure' | 'error'
  url?: string
  description: string
  context?: string
}

export interface SourceProviderAdapter {
  readonly provider: SourceProvider
  readonly capabilities: SourceCapabilities
  testConnection: () => Promise<SourceConnectionTest>
  listRepositories: (input?: { cursor?: string, search?: string, limit?: number }) => Promise<SourceRepositoryPage>
  listBranches: (repository: string, input?: { cursor?: string, limit?: number }) => Promise<SourceRefPage>
  listTags: (repository: string, input?: { cursor?: string, limit?: number }) => Promise<SourceRefPage>
  createWebhook: (repository: string, input: { url: string, secret: string, events: string[] }) => Promise<SourceWebhookRegistration>
  listWebhooks: (repository: string) => Promise<SourceWebhookRegistration[]>
  updateWebhook: (repository: string, webhookId: string, input: { url: string, secret: string, events: string[] }) => Promise<SourceWebhookRegistration>
  deleteWebhook: (repository: string, webhookId: string) => Promise<void>
  setCommitStatus: (repository: string, commitSha: string, status: SourceCommitStatus) => Promise<void>
}
