import type { DnsProvider } from './types'
import { describe, expect, it } from 'bun:test'
import { dnsProviders, providerOfNameservers, servingProvider } from './index'

describe('whose nameservers these are', () => {
  it('knows the providers it can drive', () => {
    expect(providerOfNameservers(['alex.ns.cloudflare.com.', 'MELANY.ns.cloudflare.com'])).toBe('cloudflare')
    expect(providerOfNameservers(['ns-1.awsdns-01.org', 'ns-2.awsdns-02.co.uk'])).toBe('route53')
    expect(providerOfNameservers(['curitiba.ns.porkbun.com'])).toBe('porkbun')
    expect(providerOfNameservers(['ns01.domaincontrol.com'])).toBe('godaddy')
    expect(providerOfNameservers(['ns1.example.net'])).toBeUndefined()
  })
})

describe('finding the provider that serves a zone', () => {
  /** A stand-in provider that claims a domain, declines it, or cannot answer. */
  function provider(name: string, answer: boolean | 'throws'): DnsProvider {
    return {
      name,
      canManageDomain: async () => {
        if (answer === 'throws') throw new Error(`${name}: The security token included in the request is invalid`)
        return answer
      },
    } as unknown as DnsProvider
  }

  async function serving(candidates: DnsProvider[], nameservers: string[] | 'fails'): Promise<string | null> {
    const found = await servingProvider('example.com', candidates, {
      nameservers: async () => {
        if (nameservers === 'fails') throw new Error('SERVFAIL')
        return nameservers
      },
    })
    return found?.name ?? null
  }

  it('passes over a provider that cannot answer', async () => {
    expect(await serving([provider('route53', 'throws'), provider('cloudflare', true)], [])).toBe('cloudflare')
  })

  it('prefers the provider the nameservers point at over a registrar that also says yes', async () => {
    const both = [provider('porkbun', true), provider('cloudflare', true)]
    expect(await serving(both, ['alex.ns.cloudflare.com', 'melany.ns.cloudflare.com'])).toBe('cloudflare')
    expect(await serving(both, ['curitiba.ns.porkbun.com'])).toBe('porkbun')
    // Nameservers that cannot be read leave the first claim standing.
    expect(await serving(both, 'fails')).toBe('porkbun')
  })

  it('answers nothing when nobody holds the domain, without throwing', async () => {
    expect(await serving([provider('route53', 'throws'), provider('porkbun', false)], [])).toBeNull()
  })

  it('the factory survives credentials that do not work', async () => {
    // A bad token must end in "no provider", not an exception from a deploy step.
    const factory = new (dnsProviders.constructor as new () => typeof dnsProviders)()
    factory.addCloudflare?.('not-a-token')
    expect(await factory.getProviderForDomain('example.invalid', { nameservers: async () => [] })).toBeNull()
  })
})
