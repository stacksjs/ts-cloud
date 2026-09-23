import type { DnsProvider, DnsRecord, DnsRecordResult } from '../dns/types'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { addDns01ChallengeRecord, generateLetsEncryptUserData, removeDns01ChallengeRecord } from './letsencrypt'

/** A provider with Cloudflare's semantics: upsert replaces by name + type, create adds. */
function cloudflareLike(initial: DnsRecordResult[] = []) {
  const zone: DnsRecordResult[] = [...initial]
  const provider: DnsProvider = {
    name: 'cloudflare',
    async listRecords() { return { success: true, records: [...zone] } },
    async createRecord(_d, record: DnsRecord) { zone.push({ ...record } as DnsRecordResult); return { success: true } },
    async upsertRecord(_d, record: DnsRecord) {
      const at = zone.findIndex(r => r.name === record.name && r.type === record.type)
      if (at === -1) zone.push({ ...record } as DnsRecordResult)
      else zone[at] = { ...record } as DnsRecordResult
      return { success: true }
    },
    async deleteRecord(_d, record: DnsRecord) {
      const at = zone.findIndex(r => r.name === record.name && r.type === record.type && r.content === record.content)
      if (at !== -1) zone.splice(at, 1)
      return { success: true }
    },
    async canManageDomain() { return true },
    async listDomains() { return ['example.com'] },
  }
  return { provider, zone }
}

const challenges = (zone: DnsRecordResult[]) => zone.filter(r => r.name === '_acme-challenge.example.com').map(r => r.content).sort()

describe('DNS-01 challenge records', () => {
  it('publishes a domain\'s and its wildcard\'s challenges side by side', async () => {
    const { provider, zone } = cloudflareLike()

    await addDns01ChallengeRecord(provider, 'example.com', 'apex-token')
    await addDns01ChallengeRecord(provider, 'example.com', 'wildcard-token')

    expect(challenges(zone)).toEqual(['apex-token', 'wildcard-token'])
  })

  it('does not duplicate a value that is already published', async () => {
    const { provider, zone } = cloudflareLike([{ type: 'TXT', name: '_acme-challenge.example.com', content: '"apex-token"' }])

    await addDns01ChallengeRecord(provider, 'example.com', 'apex-token')

    expect(zone).toHaveLength(1)
  })

  it('cleans up only its own value', async () => {
    const { provider, zone } = cloudflareLike()
    await addDns01ChallengeRecord(provider, 'example.com', 'apex-token')
    await addDns01ChallengeRecord(provider, 'example.com', 'wildcard-token')

    await removeDns01ChallengeRecord(provider, 'example.com', 'apex-token')

    expect(challenges(zone)).toEqual(['wildcard-token'])
  })
})

const hasJq = spawnSync('jq', ['--version']).status === 0

describe('Porkbun certbot cleanup hook', () => {
  it.skipIf(!hasJq)('looks up the challenge name and deletes only this run\'s value', () => {
    const userData = generateLetsEncryptUserData({
      domains: ['example.com', '*.example.com'],
      email: 'ops@example.com',
      challengeType: 'dns-01',
      dnsProvider: { provider: 'porkbun', apiKey: 'k', secretKey: 's' },
    } as any)
    const hook = userData.split("<< 'CLEANUPHOOK'\n")[1]?.split('\nCLEANUPHOOK')[0]
    expect(hook).toBeDefined()

    // A curl stand-in: answers the lookup with two challenges, one stale, and
    // records every URL it is asked for.
    const dir = mkdtempSync(join(tmpdir(), 'porkbun-hook-'))
    const log = join(dir, 'calls.log')
    writeFileSync(join(dir, 'curl'), `#!/bin/bash
for a in "$@"; do case "$a" in https://*) echo "$a" >> "${log}";; esac; done
case "$*" in
  *retrieveByNameType*) echo '{"status":"SUCCESS","records":[
    {"id":"111","name":"_acme-challenge.example.com","type":"TXT","content":"stale-from-last-month"},
    {"id":"222","name":"_acme-challenge.example.com","type":"TXT","content":"this-run"}]}';;
  *) echo '{"status":"SUCCESS"}';;
esac
`)
    chmodSync(join(dir, 'curl'), 0o755)
    writeFileSync(join(dir, 'hook.sh'), hook!)

    const run = spawnSync('bash', [join(dir, 'hook.sh')], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CERTBOT_DOMAIN: 'example.com', CERTBOT_VALIDATION: 'this-run', PORKBUN_API_KEY: 'k', PORKBUN_SECRET_KEY: 's' },
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)

    const calls = readFileSync(log, 'utf8').trim().split('\n')
    expect(calls[0]).toBe('https://api.porkbun.com/api/json/v3/dns/retrieveByNameType/example.com/TXT/_acme-challenge')
    expect(calls[1]).toBe('https://api.porkbun.com/api/json/v3/dns/delete/example.com/222')
    expect(calls).toHaveLength(2)
  })
})
