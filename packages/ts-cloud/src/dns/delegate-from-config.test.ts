import { describe, expect, it } from 'bun:test'
import { delegateZoneFromConfig, describeDelegation } from './delegate-from-config'

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
