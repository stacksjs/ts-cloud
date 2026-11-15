import { describe, expect, it } from 'bun:test'
import { applyDeclaredZoneSettings, delegateZoneFromConfig, describeDelegation, describeZoneSettings } from './delegate-from-config'

const CREDS = {
  porkbunApiKey: 'pk',
  porkbunSecretKey: 'sk',
  cloudflareApiToken: 'cf',
  cloudflareAccountId: 'acct',
}

/**
 * Every case here is one a real project is in, and none of them may fail a
 * deploy: a project that has not migrated, one whose credentials are absent
 * on a given runner, one that opted out. They report and move on.
 */
describe('delegateZoneFromConfig', () => {
  it('skips a project with no registrar declared', async () => {
    const result = await delegateZoneFromConfig({ domain: 'example.com', provider: 'cloudflare' }, { credentials: CREDS })
    expect(result.status).toBe('skipped')
  })

  it('skips when the zone already lives at the registrar', async () => {
    const result = await delegateZoneFromConfig(
      { domain: 'example.com', provider: 'porkbun', registrar: { provider: 'porkbun' } },
      { credentials: CREDS },
    )
    expect(result).toMatchObject({ status: 'skipped' })
    expect((result as any).reason).toContain('already porkbun')
  })

  it('skips, rather than throws, when the destination credential is missing', async () => {
    // A CI runner without the token must not take the deploy down with it.
    const result = await delegateZoneFromConfig(
      { domain: 'example.com', provider: 'cloudflare', registrar: { provider: 'porkbun' } },
      { credentials: { ...CREDS, cloudflareApiToken: undefined } },
    )
    expect(result).toMatchObject({ status: 'skipped' })
    expect((result as any).reason).toContain('CLOUDFLARE_API_TOKEN')
  })

  it('skips when the registrar credential is missing', async () => {
    const result = await delegateZoneFromConfig(
      { domain: 'example.com', provider: 'cloudflare', registrar: { provider: 'porkbun' } },
      { credentials: { ...CREDS, porkbunApiKey: undefined } },
    )
    expect(result).toMatchObject({ status: 'skipped' })
    expect((result as any).reason).toContain('PORKBUN')
  })

  it('honours an explicit opt-out', async () => {
    const result = await delegateZoneFromConfig(
      { domain: 'example.com', provider: 'cloudflare', registrar: { provider: 'porkbun', delegate: false } },
      { credentials: CREDS },
    )
    expect(result).toMatchObject({ status: 'skipped' })
    expect((result as any).reason).toContain('delegate is false')
  })

  it('reads credentials from the environment when none are passed', async () => {
    const result = await delegateZoneFromConfig(
      { domain: 'example.com', provider: 'cloudflare', registrar: { provider: 'porkbun' } },
      { env: {} },
    )
    // Empty env → no token → skipped, not a crash.
    expect(result.status).toBe('skipped')
  })
})

describe('describeDelegation', () => {
  it('says the nameservers were left alone when the copy was incomplete', () => {
    const lines = describeDelegation({
      status: 'blocked',
      domain: 'example.com',
      targetNameservers: ['a.ns', 'b.ns'],
      currentNameservers: ['old.ns'],
      records: [],
      missing: [{ name: 'example.com', type: 'MX', content: 'mail.example.com' }],
      warnings: ['1 record(s) did not arrive'],
    }).join('\n')

    expect(lines).toContain('NOT delegated')
    expect(lines).toContain('MX example.com')
    expect(lines).toContain('old.ns')
  })

  it('warns about propagation after a real delegation', () => {
    const lines = describeDelegation({
      status: 'delegated',
      domain: 'example.com',
      targetNameservers: ['a.ns', 'b.ns'],
      currentNameservers: ['old.ns'],
      records: [{ record: { name: 'example.com', type: 'A', content: '1.2.3.4' }, status: 'copied' }],
      missing: [],
      warnings: [],
    }).join('\n')

    expect(lines).toContain('1 record(s) copied')
    expect(lines).toContain('propagate')
  })
})

describe('applyDeclaredZoneSettings', () => {
  const base = { domain: 'example.com', provider: 'cloudflare' as const }

  it('skips a project that declares no zone settings', async () => {
    const result = await applyDeclaredZoneSettings(base, { credentials: CREDS })
    expect(result).toMatchObject({ status: 'skipped' })
    expect((result as any).reason).toContain('no dns.zone')
  })

  it('skips a provider that has no zone settings', async () => {
    const result = await applyDeclaredZoneSettings(
      { ...base, provider: 'porkbun', zone: { ssl: 'strict' } },
      { credentials: CREDS },
    )
    expect(result).toMatchObject({ status: 'skipped' })
  })

  it('skips, rather than throws, without a token', async () => {
    const result = await applyDeclaredZoneSettings(
      { ...base, zone: { ssl: 'strict' } },
      { credentials: { ...CREDS, cloudflareApiToken: undefined } },
    )
    expect(result).toMatchObject({ status: 'skipped' })
    expect((result as any).reason).toContain('CLOUDFLARE_API_TOKEN')
  })

  it('skips when the zone block is present but empty', async () => {
    const result = await applyDeclaredZoneSettings({ ...base, zone: {} }, { credentials: CREDS })
    expect(result).toMatchObject({ status: 'skipped' })
    expect((result as any).reason).toContain('no settings')
  })

  it('does not treat a header-only zone block as empty', async () => {
    // `visitorLocationHeaders` is not a zone setting and produces nothing in
    // the settings map, so a block declaring only it used to fall through the
    // "declares no settings" guard and never reach the header endpoint.
    const result = await applyDeclaredZoneSettings(
      { ...base, zone: { visitorLocationHeaders: true } },
      { credentials: { ...CREDS, cloudflareApiToken: undefined } },
    )
    expect(result).toMatchObject({ status: 'skipped' })
    expect((result as any).reason).toContain('CLOUDFLARE_API_TOKEN')
  })
})

describe('describeZoneSettings', () => {
  it('names what it changed, which is the drift being corrected', () => {
    const lines = describeZoneSettings({
      status: 'applied',
      domain: 'example.com',
      changed: [{ id: 'ssl', from: 'full', to: 'strict' }],
      failed: [],
    }).join('\n')

    expect(lines).toContain('ssl: full → strict')
  })

  it('reports a plan-gated setting without pretending it applied', () => {
    const lines = describeZoneSettings({
      status: 'unchanged',
      domain: 'example.com',
      changed: [],
      failed: [{ id: 'min_tls_version', error: 'not available on this plan' }],
    }).join('\n')

    expect(lines).toContain('could not set min_tls_version')
    expect(lines).not.toContain('already as declared')
  })

  it('says so when nothing needed doing', () => {
    const lines = describeZoneSettings({
      status: 'unchanged',
      domain: 'example.com',
      changed: [],
      failed: [],
    }).join('\n')

    expect(lines).toContain('already as declared')
  })
})

describe('delegating to Route 53', () => {
  const NAMESERVERS = ['ns-1.awsdns-01.org', 'ns-2.awsdns-02.com', 'ns-3.awsdns-03.net', 'ns-4.awsdns-04.co.uk']

  /** A zone host that keeps what it is given, as a hosted zone would. */
  function hostedZone(options: { drops?: (record: any) => boolean } = {}) {
    const records: any[] = []
    const created: string[] = []
    const add = async (_domain: string, record: any) => {
      if (!options.drops?.(record))
        records.push({ ...record })
      return { success: true }
    }
    return {
      name: 'route53',
      records,
      created,
      createZone: async (domain: string) => {
        created.push(domain)
        return { id: 'Z123', name: domain, status: 'active', nameServers: NAMESERVERS, created: true }
      },
      createRecord: add,
      upsertRecord: add,
      deleteRecord: async () => ({ success: true }),
      listRecords: async () => ({ success: true, records: records.map(r => ({ ...r })) }),
      canManageDomain: async () => true,
      listDomains: async () => ['example.com'],
    }
  }

  /** A registrar holding a zone and a set of nameservers. */
  function registrarWith(records: any[], nameservers = ['a.ns.porkbun.com', 'b.ns.porkbun.com']) {
    const state = { nameservers }
    return {
      name: 'porkbun',
      state,
      getNameServers: async () => state.nameservers,
      updateNameServers: async (_domain: string, next: string[]) => {
        state.nameservers = next
        return true
      },
      createRecord: async () => ({ success: true }),
      upsertRecord: async () => ({ success: true }),
      deleteRecord: async () => ({ success: true }),
      listRecords: async () => ({ success: true, records }),
      canManageDomain: async () => true,
      listDomains: async () => ['example.com'],
    }
  }

  const RECORDS = [
    { name: 'example.com', type: 'A', content: '203.0.113.7', ttl: 600 },
    { name: 'example.com', type: 'MX', content: 'mail.example.com', priority: 10, ttl: 600 },
    { name: 'example.com', type: 'TXT', content: 'v=spf1 mx -all', ttl: 600 },
    { name: 'example.com', type: 'NS', content: 'a.ns.porkbun.com', ttl: 600 },
  ]
  const CONFIG = { domain: 'example.com', provider: 'route53' as const, registrar: { provider: 'porkbun' as const } }

  it('creates the zone, copies the records and points the registrar at it', async () => {
    const host = hostedZone()
    const registrar = registrarWith(RECORDS)
    const result = await delegateZoneFromConfig(CONFIG, { credentials: CREDS, hosts: { route53: host as any }, registrar: registrar as any })

    expect(result).toMatchObject({ status: 'delegated', domain: 'example.com', targetNameservers: NAMESERVERS })
    expect(host.created).toEqual(['example.com'])
    // The registrar's own NS records are the delegation being replaced: never copied.
    expect(host.records.map(r => r.type).sort()).toEqual(['A', 'MX', 'TXT'])
    expect(registrar.state.nameservers).toEqual(NAMESERVERS)
    expect(describeDelegation(result)[0]).toContain('delegated to ns-1.awsdns-01.org')
  })

  it('leaves the nameservers alone when a record did not arrive', async () => {
    const host = hostedZone({ drops: record => record.type === 'MX' })
    const registrar = registrarWith(RECORDS)
    const result = await delegateZoneFromConfig(CONFIG, { credentials: CREDS, hosts: { route53: host as any }, registrar: registrar as any })

    expect(result.status).toBe('blocked')
    expect(registrar.state.nameservers).toEqual(['a.ns.porkbun.com', 'b.ns.porkbun.com'])
    expect((result as any).missing.map((r: any) => r.type)).toEqual(['MX'])
  })

  it('is a no-op once the registrar points at the hosted zone', async () => {
    const host = hostedZone()
    const registrar = registrarWith(RECORDS, NAMESERVERS.map(ns => `${ns.toUpperCase()}.`))
    const result = await delegateZoneFromConfig(CONFIG, { credentials: CREDS, hosts: { route53: host as any }, registrar: registrar as any })

    expect(result.status).toBe('already-delegated')
    expect(host.records).toHaveLength(0)
  })

  it('a dry run copies nothing and moves nothing', async () => {
    const host = hostedZone()
    const registrar = registrarWith(RECORDS)
    const result = await delegateZoneFromConfig(
      { ...CONFIG, registrar: { provider: 'porkbun', dryRun: true } },
      { credentials: CREDS, hosts: { route53: host as any }, registrar: registrar as any },
    )
    expect(result.status).toBe('ready')
    expect(host.records).toHaveLength(0)
    expect(registrar.state.nameservers).toEqual(['a.ns.porkbun.com', 'b.ns.porkbun.com'])
  })

  it('says that proxied hosts mean nothing where there is no edge', async () => {
    const host = hostedZone()
    const result = await delegateZoneFromConfig(
      { ...CONFIG, registrar: { provider: 'porkbun', proxied: ['example.com'] } },
      { credentials: CREDS, hosts: { route53: host as any }, registrar: registrarWith(RECORDS) as any },
    )
    expect(result.status).toBe('delegated')
    expect(host.records.every(r => r.proxied !== true)).toBe(true)
    expect((result as any).warnings.join(' ')).toContain('proxied is ignored')
  })

  it('skips, rather than throws, without AWS credentials', async () => {
    const result = await delegateZoneFromConfig(CONFIG, { credentials: { ...CREDS, aws: false } })
    expect(result).toMatchObject({ status: 'skipped' })
    expect((result as any).reason).toContain('AWS')
  })

  it('finds AWS credentials in the environment in any of the usual forms', async () => {
    const skipped = await delegateZoneFromConfig(CONFIG, { env: { PORKBUN_API_KEY: 'pk', PORKBUN_SECRET_KEY: 'sk' } })
    expect((skipped as any).reason).toContain('AWS')
    // A profile is enough to get past the credential check to the registrar's.
    const next = await delegateZoneFromConfig(CONFIG, { env: { AWS_PROFILE: 'work' } })
    expect((next as any).reason).toContain('PORKBUN')
  })

  it('does not delegate to a registrar\'s own nameservers', async () => {
    const result = await delegateZoneFromConfig(
      { domain: 'example.com', provider: 'godaddy', registrar: { provider: 'porkbun' } },
      { credentials: CREDS },
    )
    expect(result).toMatchObject({ status: 'skipped' })
    expect((result as any).reason).toContain('delegation to godaddy is not supported')
  })
})
