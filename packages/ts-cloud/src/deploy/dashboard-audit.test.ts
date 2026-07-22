import { describe, expect, it } from 'bun:test'
import { dashboardMutationAuditPayload } from './local-dashboard-server'

describe('dashboard mutation audit envelope', () => {
  it('records action, target, outcome, and bounded timing', () => {
    expect(dashboardMutationAuditPayload('delete', '/api/sites', { site: 'acme.example', confirm: 'acme.example' }, 200, 12.8)).toEqual({ method: 'DELETE', path: '/api/sites', target: 'acme.example', status: 200, outcome: 'succeeded', durationMs: 13, input: { site: 'acme.example' } })
  })

  it('omits secret values, passwords, confirmations, and unknown request fields', () => {
    const payload = dashboardMutationAuditPayload('post', '/api/serverless/secrets', { secretId: 'prod/stripe', value: 'must-not-leak', password: 'hidden', confirm: 'prod/stripe', arbitrary: 'no' }, 409, 2)
    expect(payload.outcome).toBe('failed')
    expect(payload.target).toBe('prod/stripe')
    expect(JSON.stringify(payload)).not.toContain('must-not-leak')
    expect(JSON.stringify(payload)).not.toContain('hidden')
    expect(payload.input).toEqual({ secretId: 'prod/stripe' })
  })
})
