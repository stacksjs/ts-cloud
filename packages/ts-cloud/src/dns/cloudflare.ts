/**
 * Cloudflare DNS Provider
 * API documentation: https://developers.cloudflare.com/api/resources/dns/subresources/records/
 */
import type { CreateRecordResult, DeleteRecordResult, DnsProvider, DnsRecord, DnsRecordResult, DnsRecordType, ListRecordsResult } from './types'
import { PROXIABLE_RECORD_TYPES } from './types'

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4'

interface CloudflareApiResponse<T = any> {
  success: boolean
  errors: Array<{ code: number; message: string }>
  messages: string[]
  result: T
  result_info?: {
    page: number
    per_page: number
    total_pages: number
    count: number
    total_count: number
  }
}

interface CloudflareRecord {
  id: string
  zone_id: string
  zone_name: string
  name: string
  type: string
  content: string
  proxiable: boolean
  proxied: boolean
  ttl: number
  locked: boolean
  meta: Record<string, any>
  comment?: string
  tags?: string[]
  created_on: string
  modified_on: string
  priority?: number
  /** Structured RDATA, used for the types whose fields do not fit `content` (SRV, CAA). */
  data?: SrvRdata | Record<string, unknown>
}

/** One entry of `GET /zones/{id}/settings` (and the body of a per-setting PATCH). */
export interface CloudflareZoneSetting {
  id: string
  value: unknown
  editable?: boolean
  modified_on?: string | null
}

/**
 * A rule inside a phase entrypoint ruleset (cache rules, transform rules, …).
 * Only the fields ts-cloud writes or has to preserve are modelled.
 */
export interface CloudflareRule {
  id?: string
  action: string
  expression: string
  description?: string
  enabled?: boolean
  action_parameters?: Record<string, unknown>
}

interface CloudflareRuleset {
  id: string
  name: string
  kind: string
  phase: string
  rules?: CloudflareRule[]
}

/**
 * Marker that identifies a rule as ts-cloud's, carried in the rule description.
 *
 * Cloudflare's phase entrypoints are replace-only — `PUT .../entrypoint` sets
 * the WHOLE rule list — so writing our rules naively would delete every rule a
 * human added in the dashboard. Tagging ours lets a reconcile rewrite only what
 * it owns and carry everything else through untouched.
 */
export const CLOUDFLARE_MANAGED_RULE_PREFIX = '[ts-cloud]'

/** Ruleset phases ts-cloud manages rules in. */
export type CloudflareRulesetPhase = 'http_request_cache_settings' | 'http_request_late_transform'

export interface CloudflareProviderOptions {
  /** Zone id, so the API token can be scoped to a single zone. */
  zoneId?: string
  /** Account id, for account-scoped resources. */
  accountId?: string
}

export class CloudflareProvider implements DnsProvider {
  readonly name = 'cloudflare'
  private apiToken: string
  /** Zone name → zone id. */
  private zoneCache: Map<string, string> = new Map()
  /** Zone id configured up front (single-zone token); resolved to a name on first use. */
  private readonly configuredZoneId?: string
  private readonly accountId?: string
  /** Name of {@link configuredZoneId}, learned once from the API. */
  private configuredZoneName?: string

  constructor(apiToken: string, options: CloudflareProviderOptions = {}) {
    this.apiToken = apiToken
    this.configuredZoneId = options.zoneId
    this.accountId = options.accountId
  }

  /**
   * Make an authenticated API request to Cloudflare
   */
  private async request<T>(method: string, endpoint: string, body?: any): Promise<CloudflareApiResponse<T>> {
    const url = `${CLOUDFLARE_API_URL}${endpoint}`

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    }

    const options: RequestInit = {
      method,
      headers,
    }

    if (body) {
      options.body = JSON.stringify(body)
    }

    const response = await fetch(url, options)
    const data = (await response.json()) as CloudflareApiResponse<T>

    if (!data.success) {
      const errorMessages = data.errors.map((e) => e.message).join(', ')
      throw new Error(`Cloudflare API error: ${errorMessages}`)
    }

    return data
  }

  /**
   * Get the root domain from a full domain name
   * e.g., "api.example.com" -> "example.com"
   */
  private getRootDomain(domain: string): string {
    const parts = domain.replace(/\.$/, '').split('.')
    if (parts.length >= 2) {
      return parts.slice(-2).join('.')
    }
    return domain
  }

  /**
   * Resolve the zone a hostname belongs to, as both id and name.
   *
   * A configured {@link CloudflareProviderOptions.zoneId} is tried first and is
   * the only path that works with a single-zone API token: the by-name fallback
   * calls `GET /zones?name=…`, an ACCOUNT-level listing that a zone-scoped token
   * cannot read — it returns an empty list, which is indistinguishable from "the
   * domain isn't here" unless you already know the token is narrow.
   *
   * Resolving the configured zone also yields its real name, which is what makes
   * record naming correct for multi-label suffixes (`example.co.uk`). The
   * fallback can only guess the apex from the last two labels.
   */
  private async resolveZone(domain: string): Promise<{ id: string, name: string }> {
    const hostname = domain.replace(/\.$/, '').toLowerCase()

    if (this.configuredZoneId) {
      const name = await this.resolveConfiguredZoneName()
      if (name && (hostname === name || hostname.endsWith(`.${name}`))) {
        return { id: this.configuredZoneId, name }
      }
    }

    const rootDomain = this.getRootDomain(hostname)
    const cached = this.zoneCache.get(rootDomain)
    if (cached) {
      return { id: cached, name: rootDomain }
    }

    // Look up zone by name
    const response = await this.request<CloudflareZone[]>('GET', `/zones?name=${encodeURIComponent(rootDomain)}`)

    if (!response.result || response.result.length === 0) {
      throw new Error(
        `Zone not found for domain: ${rootDomain}. ` +
          `If the API token is scoped to a single zone, set its zone id (CLOUDFLARE_ZONE_ID) — ` +
          `zone lookup by name needs account-wide Zone:Read.`,
      )
    }

    const zoneId = response.result[0].id
    this.zoneCache.set(rootDomain, zoneId)
    return { id: zoneId, name: response.result[0].name || rootDomain }
  }

  /** Name of the configured zone, fetched once. Undefined if it can't be read. */
  private async resolveConfiguredZoneName(): Promise<string | undefined> {
    if (!this.configuredZoneId) return undefined
    if (this.configuredZoneName) return this.configuredZoneName

    try {
      const response = await this.request<CloudflareZone>('GET', `/zones/${this.configuredZoneId}`)
      const name = response.result?.name?.toLowerCase()
      if (!name) return undefined
      this.configuredZoneName = name
      this.zoneCache.set(name, this.configuredZoneId)
      return name
    } catch {
      // A token without Zone:Read still manages DNS fine; fall back to by-name.
      return undefined
    }
  }

  /**
   * Get Zone ID for a domain (with caching)
   */
  private async getZoneId(domain: string): Promise<string> {
    return (await this.resolveZone(domain)).id
  }

  /**
   * Get the full record name
   * Cloudflare stores records with full domain names
   *
   * `zoneName` is the zone's actual name as Cloudflare reports it, not a guess
   * from the requested domain — see {@link resolveZone}.
   */
  private getFullRecordName(name: string, zoneName: string): string {
    const cleanName = name.replace(/\.$/, '')

    // If name is empty or equals the zone apex, return the apex
    if (!cleanName || cleanName === zoneName || cleanName === '@') {
      return zoneName
    }

    // If name already ends with the zone name, return as-is
    if (cleanName.endsWith(`.${zoneName}`)) {
      return cleanName
    }

    // Otherwise, append the zone name
    return `${cleanName}.${zoneName}`
  }

  /**
   * Convert DnsRecord to Cloudflare record format
   */
  private toCloudflareRecord(record: DnsRecord, zoneName: string, proxied?: boolean): Partial<CloudflareRecord> {
    const cfRecord: Partial<CloudflareRecord> = {
      type: record.type,
      name: this.getFullRecordName(record.name, zoneName),
      content: record.content || record.value || '',
      ttl: record.ttl || 1, // 1 = automatic in Cloudflare
    }

    // Proxying is only meaningful — and only ACCEPTED — for A/AAAA/CNAME.
    // Sending `proxied` on a TXT/MX/CAA record is a hard API error, so the flag
    // is dropped for those types rather than forwarded.
    const desiredProxy = proxied ?? record.proxied
    if (desiredProxy !== undefined && PROXIABLE_RECORD_TYPES.has(record.type)) {
      cfRecord.proxied = desiredProxy
      // A proxied record is served from Cloudflare's edge, so its TTL is the
      // edge's to choose; Cloudflare rejects anything but "automatic" (1) here.
      if (desiredProxy) cfRecord.ttl = 1
    }

    // MX records require priority
    if (record.type === 'MX' && record.priority !== undefined) {
      cfRecord.priority = record.priority
    }

    // SRV carries four fields (priority, weight, port, target) that do not fit
    // in `content`, so Cloudflare takes them as a structured `data` object.
    //
    // Sending the RDATA as a content string INSTEAD looks like it works — the
    // API accepts it — and then stores a record whose priority is counted
    // twice: once from the leading number in the string and once from the
    // `priority` field. Mail and calendar clients read the result as a
    // malformed target and fall back to guessing hostnames, which fails
    // quietly on the client rather than loudly here.
    if (record.type === 'SRV') {
      const parsed = parseSrvContent(record)
      if (parsed) {
        cfRecord.data = parsed
        // `content` and `data` are mutually exclusive for SRV; leaving the
        // string in place makes Cloudflare reject the whole record.
        delete cfRecord.content
        delete cfRecord.priority
      } else if (record.priority !== undefined) {
        cfRecord.priority = record.priority
      }
    }

    return cfRecord
  }

  /**
   * Convert Cloudflare record to DnsRecordResult format
   */
  private fromCloudflareRecord(record: CloudflareRecord): DnsRecordResult {
    return {
      id: record.id,
      name: record.name,
      type: record.type as DnsRecordType,
      content: record.content,
      ttl: record.ttl,
      priority: record.priority,
      proxied: record.proxied,
    }
  }

  async createRecord(domain: string, record: DnsRecord): Promise<CreateRecordResult> {
    try {
      const zone = await this.resolveZone(domain)
      const cfRecord = this.toCloudflareRecord(record, zone.name)

      const response = await this.request<CloudflareRecord>('POST', `/zones/${zone.id}/dns_records`, cfRecord)

      return {
        success: true,
        id: response.result.id,
        message: 'Record created successfully',
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  async upsertRecord(domain: string, record: DnsRecord): Promise<CreateRecordResult> {
    try {
      const zone = await this.resolveZone(domain)
      const fullName = this.getFullRecordName(record.name, zone.name)

      // First, try to find existing record
      const existingResponse = await this.request<CloudflareRecord[]>(
        'GET',
        `/zones/${zone.id}/dns_records?type=${record.type}&name=${encodeURIComponent(fullName)}`,
      )

      const existing = existingResponse.result?.[0]

      // An upsert that says nothing about proxying must not CHANGE proxying.
      //
      // Cloudflare's record update is a full PUT: any field left out is reset to
      // its default, and the default for `proxied` is `false`. Every deploy
      // re-upserts the box's address records, so without carrying the current
      // value forward a single deploy would grey-cloud the site — dropping the
      // CDN, exposing the origin IP, and doing it silently, since the record
      // still resolves and the site still loads.
      const proxied = record.proxied ?? existing?.proxied
      const cfRecord = this.toCloudflareRecord(record, zone.name, proxied)

      if (existing) {
        // Update existing record
        const response = await this.request<CloudflareRecord>(
          'PUT',
          `/zones/${zone.id}/dns_records/${existing.id}`,
          cfRecord,
        )

        return {
          success: true,
          id: response.result.id,
          message: 'Record updated successfully',
        }
      }

      // Create new record
      const response = await this.request<CloudflareRecord>('POST', `/zones/${zone.id}/dns_records`, cfRecord)

      return {
        success: true,
        id: response.result.id,
        message: 'Record created successfully',
      }
    } catch (error) {
      // If upsert fails, try create
      return this.createRecord(domain, record)
    }
  }

  async deleteRecord(domain: string, record: DnsRecord): Promise<DeleteRecordResult> {
    try {
      const zone = await this.resolveZone(domain)
      const zoneId = zone.id
      const fullName = this.getFullRecordName(record.name, zone.name)

      // Find the record to delete
      const existingResponse = await this.request<CloudflareRecord[]>(
        'GET',
        `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(fullName)}`,
      )

      if (!existingResponse.result || existingResponse.result.length === 0) {
        return {
          success: false,
          message: 'Record not found',
        }
      }

      // Find matching record by content
      const matchingRecord = existingResponse.result.find((r) => r.content === record.content)

      if (!matchingRecord) {
        return {
          success: false,
          message: 'Record with matching content not found',
        }
      }

      await this.request('DELETE', `/zones/${zoneId}/dns_records/${matchingRecord.id}`)

      return {
        success: true,
        message: 'Record deleted successfully',
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  async listRecords(domain: string, type?: DnsRecordType): Promise<ListRecordsResult> {
    try {
      const zoneId = await this.getZoneId(domain)

      let endpoint = `/zones/${zoneId}/dns_records?per_page=100`
      if (type) {
        endpoint += `&type=${type}`
      }

      const allRecords: CloudflareRecord[] = []
      let page = 1
      let hasMore = true

      // Paginate through all records
      while (hasMore) {
        const response = await this.request<CloudflareRecord[]>('GET', `${endpoint}&page=${page}`)

        allRecords.push(...(response.result || []))

        if (response.result_info) {
          hasMore = page < response.result_info.total_pages
          page++
        } else {
          hasMore = false
        }
      }

      return {
        success: true,
        records: allRecords.map((r) => this.fromCloudflareRecord(r)),
      }
    } catch (error) {
      return {
        success: false,
        records: [],
        message: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  async canManageDomain(domain: string): Promise<boolean> {
    try {
      await this.getZoneId(domain)
      return true
    } catch {
      return false
    }
  }

  /**
   * List all domains (zones) managed by this Cloudflare account
   */
  async listDomains(): Promise<string[]> {
    try {
      const allZones: CloudflareZone[] = []
      let page = 1
      let hasMore = true

      while (hasMore) {
        const response = await this.request<CloudflareZone[]>('GET', `/zones?per_page=50&page=${page}`)

        allZones.push(...(response.result || []))

        if (response.result_info) {
          hasMore = page < response.result_info.total_pages
          page++
        } else {
          hasMore = false
        }
      }

      return allZones.map((z) => z.name)
    } catch {
      return []
    }
  }

  /**
   * Create a zone in this account, or return the one already there.
   *
   * Idempotent on purpose. A zone migration is re-run far more often than it
   * succeeds first time — a too-narrow token, a half-imported record set, a
   * nameserver flip that has not propagated — and every one of those reruns
   * would otherwise die on Cloudflare's "zone already exists" (code 1061)
   * before reaching the import that actually needed fixing.
   *
   * `accountId` is required by the API for anything but a single-account token,
   * so it falls back to {@link CloudflareProviderOptions.accountId} and fails
   * loudly rather than letting Cloudflare pick an account for you.
   *
   * The returned `nameServers` are the pair the registrar has to be pointed at.
   * They are assigned at creation and never change for the life of the zone, so
   * they can be read once here and used to drive the registrar update.
   */
  async createZone(
    domain: string,
    options: { accountId?: string, jumpStart?: boolean } = {},
  ): Promise<{
    id: string
    name: string
    status: string
    nameServers: string[]
    created: boolean
  }> {
    const name = domain.replace(/\.$/, '').toLowerCase()
    const accountId = options.accountId ?? this.accountId

    if (!accountId) {
      throw new Error(
        `Cannot create zone ${name}: no Cloudflare account id. ` +
          `Set CLOUDFLARE_ACCOUNT_ID, or pass accountId.`,
      )
    }

    // Look before creating. The obvious idempotent shape — POST and treat
    // "already exists" as success — assumes that is the error a duplicate
    // produces. It is not always: Cloudflare checks the account's limit on
    // PENDING (unactivated) zones first, so re-running a migration whose zone
    // is already created but not yet delegated fails with "exceeded the limit
    // for adding zones" instead. That reads as a billing problem and hides the
    // fact that the zone it wanted is sitting right there.
    const found = await this.getZoneDetails(name)
    if (found) return { ...found, created: false }

    try {
      const response = await this.request<CloudflareZone>('POST', '/zones', {
        name,
        account: { id: accountId },
        // Cloudflare's "jump start" scrapes the CURRENT authoritative nameservers
        // and imports whatever it can guess. That sounds helpful and is not: it
        // silently drops what it cannot scrape (anything not resolvable by a
        // simple sweep) while making the zone look populated, so a partial
        // import reads as a complete one. We import explicitly instead, from a
        // provider listing we can diff.
        jump_start: options.jumpStart ?? false,
      })

      const zone = response.result
      this.zoneCache.set(zone.name, zone.id)

      return {
        id: zone.id,
        name: zone.name,
        status: zone.status,
        nameServers: zone.name_servers ?? [],
        created: true,
      }
    } catch (error) {
      // 1061 is "zone already exists in this account" — the idempotent path.
      // Any other failure is real and must surface.
      const message = error instanceof Error ? error.message : String(error)
      if (!/already exists|1061/i.test(message)) throw error

      const existing = await this.getZoneDetails(name)
      if (!existing) throw error

      return { ...existing, created: false }
    }
  }

  /**
   * Get zone details (Cloudflare-specific)
   */
  async getZoneDetails(domain: string): Promise<{
    id: string
    name: string
    status: string
    nameServers: string[]
    paused: boolean
  } | null> {
    try {
      const zoneId = await this.getZoneId(domain)
      const response = await this.request<CloudflareZone>('GET', `/zones/${zoneId}`)

      return {
        id: response.result.id,
        name: response.result.name,
        status: response.result.status,
        nameServers: response.result.name_servers,
        paused: response.result.paused,
      }
    } catch {
      return null
    }
  }

  /**
   * Purge cache for a domain (Cloudflare-specific)
   */
  async purgeCache(
    domain: string,
    options?: {
      purgeEverything?: boolean
      files?: string[]
      tags?: string[]
      hosts?: string[]
    },
  ): Promise<boolean> {
    try {
      const zoneId = await this.getZoneId(domain)

      const body: Record<string, any> = {}

      if (options?.purgeEverything) {
        body.purge_everything = true
      } else {
        if (options?.files) body.files = options.files
        if (options?.tags) body.tags = options.tags
        if (options?.hosts) body.hosts = options.hosts
      }

      // Default to purge everything if no options specified
      if (Object.keys(body).length === 0) {
        body.purge_everything = true
      }

      await this.request('POST', `/zones/${zoneId}/purge_cache`, body)

      return true
    } catch {
      return false
    }
  }

  /**
   * Get proxy status for a record (Cloudflare-specific)
   * Returns whether a record is proxied through Cloudflare
   */
  async getRecordProxyStatus(domain: string, record: DnsRecord): Promise<boolean | null> {
    try {
      const zone = await this.resolveZone(domain)
      const zoneId = zone.id
      const fullName = this.getFullRecordName(record.name, zone.name)

      const response = await this.request<CloudflareRecord[]>(
        'GET',
        `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(fullName)}`,
      )

      if (response.result && response.result.length > 0) {
        const matchingRecord = response.result.find((r) => r.content === record.content)
        return matchingRecord?.proxied ?? null
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * Update proxy status for a record (Cloudflare-specific)
   */
  async setRecordProxyStatus(domain: string, record: DnsRecord, proxied: boolean): Promise<boolean> {
    try {
      const zone = await this.resolveZone(domain)
      const zoneId = zone.id
      const fullName = this.getFullRecordName(record.name, zone.name)

      // Find the record
      const response = await this.request<CloudflareRecord[]>(
        'GET',
        `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(fullName)}`,
      )

      if (!response.result || response.result.length === 0) {
        return false
      }

      const matchingRecord = response.result.find((r) => r.content === record.content)
      if (!matchingRecord) {
        return false
      }

      // Update the record with new proxy status
      await this.request('PATCH', `/zones/${zoneId}/dns_records/${matchingRecord.id}`, { proxied })

      return true
    } catch {
      return false
    }
  }

  /**
   * Public zone id for a hostname — the entry point for the Cloudflare-specific
   * work (settings, rulesets, purge) that sits outside the DnsProvider contract.
   */
  async zoneIdFor(domain: string): Promise<string> {
    return this.getZoneId(domain)
  }

  /** Account id this provider was configured with, if any. */
  get account(): string | undefined {
    return this.accountId
  }

  /**
   * Read every zone setting, keyed by setting id.
   *
   * Used to make {@link applyZoneSettings} a real reconcile: settings that
   * already hold the desired value are left alone, so a deploy reports what it
   * actually changed instead of rewriting the whole zone every time.
   */
  async getZoneSettings(domain: string): Promise<Record<string, unknown>> {
    const zoneId = await this.getZoneId(domain)
    const response = await this.request<CloudflareZoneSetting[]>('GET', `/zones/${zoneId}/settings`)

    const settings: Record<string, unknown> = {}
    for (const setting of response.result || []) settings[setting.id] = setting.value
    return settings
  }

  /**
   * Apply zone settings, skipping any that already match.
   *
   * Returns one entry per setting that was actually written, plus the failures.
   * Failures are collected rather than thrown: zone settings are largely
   * independent, several are plan-gated (a Free zone rejects `min_tls_version`
   * above 1.0 on some plans, `http3` needs the feature enabled), and one
   * unavailable toggle must not abort a deploy that has already shipped code.
   */
  async applyZoneSettings(
    domain: string,
    desired: Record<string, unknown>,
  ): Promise<{ changed: Array<{ id: string, from: unknown, to: unknown }>, failed: Array<{ id: string, error: string }> }> {
    const zoneId = await this.getZoneId(domain)
    const current = await this.getZoneSettings(domain).catch(() => ({}) as Record<string, unknown>)

    const changed: Array<{ id: string, from: unknown, to: unknown }> = []
    const failed: Array<{ id: string, error: string }> = []

    for (const [id, value] of Object.entries(desired)) {
      if (value === undefined) continue
      const existing = current[id]
      if (existing !== undefined && deepEqual(existing, value)) continue

      try {
        await this.request('PATCH', `/zones/${zoneId}/settings/${id}`, { value })
        changed.push({ id, from: existing, to: value })
      }
      catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }

    return { changed, failed }
  }

  /**
   * Read the rules currently in a phase entrypoint ruleset.
   *
   * A zone that has never had a rule in this phase has no entrypoint at all and
   * the API answers 404, which is a normal empty state rather than a failure.
   */
  async getPhaseRules(domain: string, phase: CloudflareRulesetPhase): Promise<CloudflareRule[]> {
    const zoneId = await this.getZoneId(domain)
    try {
      const response = await this.request<CloudflareRuleset>('GET', `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`)
      return response.result?.rules || []
    }
    catch {
      return []
    }
  }

  /**
   * Replace ts-cloud's rules in a phase while preserving everyone else's.
   *
   * Cloudflare only exposes a whole-list PUT for a phase entrypoint, so a naive
   * write deletes every rule someone added in the dashboard. Rules ts-cloud owns
   * are tagged in their description with {@link CLOUDFLARE_MANAGED_RULE_PREFIX};
   * this drops exactly those, appends the new ones, and carries the rest through
   * in their original order.
   *
   * Passing an empty `rules` removes ts-cloud's rules from the phase.
   */
  async putManagedPhaseRules(
    domain: string,
    phase: CloudflareRulesetPhase,
    rules: CloudflareRule[],
  ): Promise<{ success: boolean, message?: string }> {
    try {
      const zoneId = await this.getZoneId(domain)
      const existing = await this.getPhaseRules(domain, phase)
      const foreign = existing.filter(rule => !(rule.description || '').startsWith(CLOUDFLARE_MANAGED_RULE_PREFIX))

      const managed = rules.map(rule => ({
        ...rule,
        description: rule.description?.startsWith(CLOUDFLARE_MANAGED_RULE_PREFIX)
          ? rule.description
          : `${CLOUDFLARE_MANAGED_RULE_PREFIX} ${rule.description || phase}`,
      }))

      // Strip server-assigned ids from preserved rules: Cloudflare rejects a PUT
      // that reuses ids, treating the list as a fresh definition of the phase.
      const payload = [...foreign, ...managed].map(({ id: _id, ...rule }) => rule)

      await this.request('PUT', `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, { rules: payload })
      return { success: true }
    }
    catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** Structural comparison for zone-setting values (objects like HSTS, plain scalars). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (typeof a !== 'object') return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }

  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  // Cloudflare echoes settings back with extra keys, so compare only what was asked for.
  return Object.keys(bRecord).every(key => deepEqual(aRecord[key], bRecord[key]))
}

/** The four fields an `SRV` record carries, as Cloudflare's structured RDATA. */
interface SrvRdata {
  priority: number
  weight: number
  port: number
  target: string
}

/**
 * Pull SRV's four fields out of whichever shape the caller supplied.
 *
 * A record may arrive already split (`priority`/`weight`/`port` set, `content`
 * holding just the target) or as one RDATA string — Route53 and every zone-file
 * export use the string form. Both have to end up as the same `data` object.
 *
 * Returns null when neither shape yields all four, so the caller can fall back
 * rather than write a half-formed record.
 */
function parseSrvContent(record: DnsRecord): SrvRdata | null {
  const raw = (record.content || record.value || '').trim()

  if (record.weight !== undefined && record.port !== undefined && record.priority !== undefined && raw) {
    return { priority: record.priority, weight: record.weight, port: record.port, target: stripTrailingDot(raw) }
  }

  const parts = raw.split(/\s+/)
  if (parts.length < 4) return null

  const [priority, weight, port] = parts.slice(0, 3).map(Number)
  if (![priority, weight, port].every(Number.isFinite)) return null

  return { priority, weight, port, target: stripTrailingDot(parts.slice(3).join(' ')) }
}

/** Trailing dots are legal in a zone file and rejected by Cloudflare. */
function stripTrailingDot(value: string): string {
  return value.replace(/\.$/, '')
}

interface CloudflareZone {
  id: string
  name: string
  status: string
  paused: boolean
  type: string
  development_mode: number
  name_servers: string[]
}
