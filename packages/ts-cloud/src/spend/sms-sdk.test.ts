import { afterEach, describe, expect, it } from 'bun:test'
import { AlertStore, NotificationRouter } from '../alerts'
import { TsCloudClient } from '../api'
import { ControlPlaneStore } from '../control-plane'

const stores: ControlPlaneStore[] = []
const NOW = new Date('2026-07-16T12:00:00Z')

function fixture() {
  const controlPlane = new ControlPlaneStore({ path: ':memory:' })
  stores.push(controlPlane)
  const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
  const alerts = new AlertStore(controlPlane, { encryptionKey: 'sms-fixture-key', now: () => NOW })
  return { controlPlane, organization, alerts }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('SMS notification channel', () => {
  it('accepts sms as a channel kind', () => {
    const { alerts, organization } = fixture()
    const channel = alerts.createChannel({
      organizationId: organization.id,
      name: 'oncall',
      kind: 'sms',
      config: { to: '+15550100' },
    })
    expect(channel.kind).toBe('sms')
  })

  it('sends the summary line through the injected adapter', async () => {
    const { alerts, organization } = fixture()
    const sent: Array<{ to: string; text: string }> = []
    const channel = alerts.createChannel({
      organizationId: organization.id,
      name: 'oncall',
      kind: 'sms',
      config: { to: '+15550100' },
    })
    const router = new NotificationRouter(alerts, {
      now: () => NOW,
      smsImpl: async (input) => {
        sent.push({ to: input.to, text: input.text })
      },
    })
    const result = await router.testChannel(channel.id)
    expect(result.ok).toBe(true)
    expect(sent[0].to).toBe('+15550100')
  })

  it('says plainly when no adapter is configured rather than silently dropping', async () => {
    const { alerts, organization } = fixture()
    const channel = alerts.createChannel({
      organizationId: organization.id,
      name: 'oncall',
      kind: 'sms',
      config: { to: '+15550100' },
    })
    const result = await new NotificationRouter(alerts, { now: () => NOW }).testChannel(channel.id)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('SMS adapter is not configured')
  })

  it('refuses a channel with no destination number', async () => {
    const { alerts, organization } = fixture()
    const channel = alerts.createChannel({
      organizationId: organization.id,
      name: 'oncall',
      kind: 'sms',
      config: {},
    })
    const router = new NotificationRouter(alerts, { now: () => NOW, smsImpl: async () => {} })
    const result = await router.testChannel(channel.id)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('`to` number')
  })

  it('truncates, because an SMS is not a JSON payload', async () => {
    const { alerts, organization } = fixture()
    const sent: string[] = []
    const channel = alerts.createChannel({
      organizationId: organization.id,
      name: 'oncall',
      kind: 'sms',
      config: { to: '+15550100' },
    })
    const router = new NotificationRouter(alerts, {
      now: () => NOW,
      smsImpl: async (input) => {
        sent.push(input.text)
      },
    })
    await router.testChannel(channel.id)
    expect(sent[0].length).toBeLessThanOrEqual(300)
  })
})

describe('SDK spend methods', () => {
  function client(handler: (url: string) => unknown) {
    return new TsCloudClient({
      baseUrl: 'https://api.test',
      token: 'secret',
      fetch: (async (url: string) =>
        new Response(JSON.stringify(handler(String(url))), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as never,
    })
  }

  it('asks the usage endpoint with the scope it was given', async () => {
    const urls: string[] = []
    const api = client((url) => {
      urls.push(url)
      return { totalCents: 100 }
    })
    await api.usage({ projectId: 'proj-1', period: 'weekly' })
    expect(urls[0]).toContain('/api/v1/usage?')
    expect(urls[0]).toContain('projectId=proj-1')
    expect(urls[0]).toContain('period=weekly')
  })

  it('omits the query entirely when nothing is scoped', async () => {
    const urls: string[] = []
    await client((url) => {
      urls.push(url)
      return {}
    }).usage()
    expect(urls[0]).toBe('https://api.test/api/v1/usage')
  })

  it('requires a window for rollups and repeats the meter parameter', async () => {
    const urls: string[] = []
    await client((url) => {
      urls.push(url)
      return { data: [] }
    }).usageRollups({ from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z', meters: ['edge.requests', 'edge.egress_gb'] })
    expect(urls[0]).toContain('meter=edge.requests')
    expect(urls[0]).toContain('meter=edge.egress_gb')
  })

  it('defaults the allowance question to a deploy', async () => {
    const urls: string[] = []
    const api = client((url) => {
      urls.push(url)
      return { allowed: true, blockedBy: null, reason: null }
    })
    const verdict = await api.allowance()
    expect(urls[0]).toContain('operation=deploy')
    expect(verdict.allowed).toBe(true)
  })

  it('reads budgets and anomalies', async () => {
    const urls: string[] = []
    const api = client((url) => {
      urls.push(url)
      return { data: [] }
    })
    await api.budgets({ projectId: 'proj-1' })
    await api.anomalies({ unacknowledged: true })
    expect(urls[0]).toContain('/api/v1/spend/budgets?projectId=proj-1')
    expect(urls[1]).toContain('unacknowledged=true')
  })
})
