import type { WorkerConfig } from '@ts-cloud/core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CloudflareFailure, fakeCloudflare } from '../r2/test-fetch'
import { bundleWorker } from './bundle'
import { CONTENT_HASH_BINDING, workerContentHash, WorkersPermissionError } from './provider'
import { reconcileCloudflareWorkers, workerBindings } from './reconcile'

const ACCOUNT = 'acc123'
const ZONE = 'zone1'
const SCRIPT = `/accounts/${ACCOUNT}/workers/scripts/my-tiles`
const DOMAINS = `/accounts/${ACCOUNT}/workers/domains`
const R2_BUCKETS = `/accounts/${ACCOUNT}/r2/buckets`
const DNS = `/zones/${ZONE}/dns_records`
const NOT_FOUND = new CloudflareFailure(404, [{ code: 10007, message: 'This Worker does not exist on your account.' }])

let projectRoot: string

beforeAll(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'ts-cloud-workers-'))
  writeFileSync(join(projectRoot, 'tiles.ts'), 'export default { fetch: (): Response => new Response("tiles") }\n')
})

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

const worker: WorkerConfig = {
  name: 'my-tiles',
  entry: 'tiles.ts',
  bindings: { r2Buckets: { TILES: 'my-tiles-bucket' }, vars: { MODE: 'prod' } },
  customDomains: ['tiles.example.com'],
}

const config = { infrastructure: { workers: { tiles: worker } } }

/** The upload ts-cloud builds for `worker`, to compute the hash it will compare. */
async function expectedHash(): Promise<string> {
  const bundle = await bundleWorker(join(projectRoot, 'tiles.ts'))
  return workerContentHash({
    mainModule: bundle.name,
    modules: [{ name: bundle.name, content: bundle.content, type: bundle.type }],
    bindings: workerBindings(worker, { warnings: [] }),
    compatibilityDate: '2025-09-01',
    compatibilityFlags: [],
  })
}

const ZONE_ROUTES = { [`GET /zones/${ZONE}`]: { id: ZONE, name: 'example.com' } }

// Zone lookups go through CloudflareProvider, which uses the global fetch, so
// the fake is installed globally as well as passed in.
const realFetch = globalThis.fetch
let installed: ReturnType<typeof fakeCloudflare>

function install(routes: Record<string, unknown>): ReturnType<typeof fakeCloudflare> {
  installed = fakeCloudflare(routes)
  globalThis.fetch = installed.fetch as typeof fetch
  return installed
}

function options(extra: Record<string, unknown> = {}) {
  return { apiToken: 'tok', accountId: ACCOUNT, zoneId: ZONE, projectRoot, fetch: installed.fetch, ...extra }
}

describe('reconcileCloudflareWorkers', () => {
  beforeEach(() => {
    install({})
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('does nothing without a workers block', async () => {
    const lines: string[] = []
    const summary = await reconcileCloudflareWorkers({ infrastructure: {} }, options({ log: (line: string) => lines.push(line) }))
    expect(summary).toEqual({ workers: [], warnings: [] })
    expect(installed.calls).toEqual([])
    expect(lines[0]).toContain('none declared')
  })

  it('skips with a warning when credentials are missing', async () => {
    const summary = await reconcileCloudflareWorkers(config, { apiToken: 'tok', projectRoot })
    expect(summary.workers).toEqual([])
    expect(summary.warnings[0]).toContain('CLOUDFLARE_ACCOUNT_ID')
    expect(installed.calls).toEqual([])
  })

  it('bundles, uploads and attaches a new Worker', async () => {
    const fake = install({
      ...ZONE_ROUTES,
      [`GET ${SCRIPT}/settings`]: NOT_FOUND,
      [`PUT ${SCRIPT}`]: { id: 'my-tiles' },
      [`GET ${DOMAINS}`]: [],
      [`GET ${R2_BUCKETS}`]: { buckets: [] },
      [`GET ${DNS}`]: [],
      [`PUT ${DOMAINS}`]: { id: 'd1', hostname: 'tiles.example.com', service: 'my-tiles', zone_id: ZONE },
    })

    const summary = await reconcileCloudflareWorkers(config, options())

    expect(summary.warnings).toEqual([])
    expect(summary.workers).toHaveLength(1)
    const [tiles] = summary.workers
    expect(tiles!.name).toBe('my-tiles')
    expect(tiles!.changes[0]).toMatch(/^bundled \d+ B$|^bundled [\d.]+ KB$/)
    expect(tiles!.changes.slice(1)).toEqual(['uploaded', 'custom domain tiles.example.com attached'])
    expect(tiles!.domains).toEqual([{ domain: 'tiles.example.com', status: 'pending' }])

    const writes = fake.writes()
    const form = writes.find(call => call.method === 'PUT' && call.path === SCRIPT)!.body as FormData
    const metadata = JSON.parse(form.get('metadata') as string)
    expect(metadata.main_module).toBe('tiles.js')
    expect(metadata.compatibility_date).toBe('2025-09-01')
    expect(metadata.bindings).toEqual([
      { type: 'r2_bucket', name: 'TILES', bucket_name: 'my-tiles-bucket' },
      { type: 'plain_text', name: 'MODE', text: 'prod' },
      { type: 'plain_text', name: CONTENT_HASH_BINDING, text: await expectedHash() },
    ])
    expect(await (form.get('tiles.js') as File).text()).toContain('tiles')

    expect(writes.find(call => call.method === 'PUT' && call.path === DOMAINS)!.body).toEqual({
      hostname: 'tiles.example.com',
      service: 'my-tiles',
      zone_id: ZONE,
      environment: 'production',
    })
  })

  it('skips the upload and the attach when nothing changed', async () => {
    const fake = install({
      [`GET ${SCRIPT}/settings`]: {
        bindings: [
          { type: 'r2_bucket', name: 'TILES', bucket_name: 'my-tiles-bucket' },
          { type: 'plain_text', name: 'MODE', text: 'prod' },
          { type: 'plain_text', name: CONTENT_HASH_BINDING, text: await expectedHash() },
        ],
      },
      [`GET ${DOMAINS}`]: [{ id: 'd1', hostname: 'tiles.example.com', service: 'my-tiles', zone_id: ZONE }],
    })

    const summary = await reconcileCloudflareWorkers(config, options())

    expect(summary.warnings).toEqual([])
    expect(summary.workers[0]!.changes.slice(1)).toEqual(['unchanged'])
    expect(summary.workers[0]!.domains).toEqual([{ domain: 'tiles.example.com', status: 'active' }])
    expect(fake.writes()).toEqual([])
  })

  it('dry run bundles and reads but writes nothing', async () => {
    const fake = install({
      ...ZONE_ROUTES,
      [`GET ${SCRIPT}/settings`]: NOT_FOUND,
      [`GET ${DOMAINS}`]: [],
      [`GET ${R2_BUCKETS}`]: { buckets: [] },
      [`GET ${DNS}`]: [],
    })

    const summary = await reconcileCloudflareWorkers(config, options({ dryRun: true }))

    expect(fake.writes()).toEqual([])
    expect(summary.warnings).toEqual([])
    expect(summary.workers[0]!.changes.slice(1)).toEqual(['would upload', 'would attach custom domain tiles.example.com'])
    expect(summary.workers[0]!.domains).toEqual([{ domain: 'tiles.example.com', status: 'not attached' }])
  })

  it('refuses a hostname an R2 bucket serves, saying to detach it first', async () => {
    const fake = install({
      [`GET ${SCRIPT}/settings`]: NOT_FOUND,
      [`PUT ${SCRIPT}`]: { id: 'my-tiles' },
      [`GET ${DOMAINS}`]: [],
      [`GET ${R2_BUCKETS}`]: { buckets: [{ name: 'old-tiles' }] },
      [`GET ${R2_BUCKETS}/old-tiles/domains/custom`]: { domains: [{ domain: 'tiles.example.com', enabled: true }] },
    })

    const summary = await reconcileCloudflareWorkers(config, options())

    expect(summary.workers[0]!.domains).toEqual([{ domain: 'tiles.example.com', status: 'conflict' }])
    expect(summary.warnings).toHaveLength(1)
    expect(summary.warnings[0]).toContain('attached to the R2 bucket \'old-tiles\'')
    expect(summary.warnings[0]).toContain('Detach it first')
    expect(fake.writes().map(call => `${call.method} ${call.path}`)).toEqual([`PUT ${SCRIPT}`])
  })

  it('refuses a hostname the config also gives an R2 bucket, without asking the API', async () => {
    install({
      [`GET ${SCRIPT}/settings`]: NOT_FOUND,
      [`PUT ${SCRIPT}`]: { id: 'my-tiles' },
    })
    const withR2 = { infrastructure: { ...config.infrastructure, r2: { buckets: { tiles: { name: 'my-tiles-bucket', customDomains: ['tiles.example.com'] } } } } }

    const summary = await reconcileCloudflareWorkers(withR2, options())

    expect(summary.workers[0]!.domains).toEqual([{ domain: 'tiles.example.com', status: 'conflict' }])
    expect(summary.warnings[0]).toContain('also declared as a custom domain of the R2 bucket \'my-tiles-bucket\'')
  })

  it('refuses a hostname with an existing DNS record', async () => {
    const fake = install({
      ...ZONE_ROUTES,
      [`GET ${SCRIPT}/settings`]: NOT_FOUND,
      [`PUT ${SCRIPT}`]: { id: 'my-tiles' },
      [`GET ${DOMAINS}`]: [],
      [`GET ${R2_BUCKETS}`]: { buckets: [] },
      [`GET ${DNS}`]: [{ name: 'tiles.example.com', type: 'CNAME', content: 'old.example.net' }],
    })

    const summary = await reconcileCloudflareWorkers(config, options())

    expect(summary.workers[0]!.domains).toEqual([{ domain: 'tiles.example.com', status: 'conflict' }])
    expect(summary.warnings[0]).toContain('already has a DNS record (CNAME old.example.net)')
    expect(summary.warnings[0]).toContain('Delete the record first')
    expect(fake.writes().some(call => call.path === DOMAINS)).toBe(false)
  })

  it('refuses a hostname another Worker serves', async () => {
    install({
      [`GET ${SCRIPT}/settings`]: NOT_FOUND,
      [`PUT ${SCRIPT}`]: { id: 'my-tiles' },
      [`GET ${DOMAINS}`]: [{ id: 'd9', hostname: 'tiles.example.com', service: 'legacy', zone_id: ZONE }],
    })

    const summary = await reconcileCloudflareWorkers(config, options())

    expect(summary.workers[0]!.domains).toEqual([{ domain: 'tiles.example.com', status: 'conflict' }])
    expect(summary.warnings[0]).toContain('attached to the Worker \'legacy\'')
  })

  it('throws a permission error naming Workers Scripts: Edit when the upload is refused', async () => {
    install({ [`GET ${SCRIPT}/settings`]: new CloudflareFailure(403, [{ code: 10000, message: 'Authentication error' }]) })

    const error = await reconcileCloudflareWorkers(config, options()).catch(caught => caught)

    expect(error).toBeInstanceOf(WorkersPermissionError)
    expect(error.message).toContain('Workers Scripts: Edit')
  })

  it('turns a domain permission error into a warning naming Workers Routes: Edit', async () => {
    install({
      ...ZONE_ROUTES,
      [`GET ${SCRIPT}/settings`]: NOT_FOUND,
      [`PUT ${SCRIPT}`]: { id: 'my-tiles' },
      [`GET ${DOMAINS}`]: [],
      [`GET ${R2_BUCKETS}`]: { buckets: [] },
      [`GET ${DNS}`]: [],
      [`PUT ${DOMAINS}`]: new CloudflareFailure(403, [{ code: 10000, message: 'Authentication error' }]),
    })

    const summary = await reconcileCloudflareWorkers(config, options())

    expect(summary.workers[0]!.domains).toEqual([{ domain: 'tiles.example.com', status: 'error' }])
    expect(summary.warnings[0]).toContain('Workers Routes: Edit')
  })

  it('fails the Worker clearly when its entry does not exist', async () => {
    const error = await reconcileCloudflareWorkers({ workers: { x: { ...worker, entry: 'nope.ts' } } }, options()).catch(caught => caught)
    expect(error.message).toContain('Worker my-tiles: Worker entry not found')
    expect(installed.calls).toEqual([])
  })

  it('rejects an invalid script name before bundling or calling the API', async () => {
    const summary = await reconcileCloudflareWorkers({ workers: { bad: { ...worker, name: 'Bad Name' } } }, options())
    expect(summary.workers).toEqual([])
    expect(summary.warnings[0]).toContain('invalid name')
    expect(installed.calls).toEqual([])
  })
})

describe('workerBindings', () => {
  it('adds the jurisdiction the config gives a bucket and drops reserved or duplicate names', () => {
    const warnings: string[] = []
    const bindings = workerBindings(
      { name: 'w', entry: 'w.ts', bindings: { r2Buckets: { EU: 'eu-bucket' }, vars: { EU: 'dup', [CONTENT_HASH_BINDING]: 'x' } } },
      { warnings, r2Buckets: { buckets: { eu: { name: 'eu-bucket', jurisdiction: 'eu' } } } },
    )
    expect(bindings).toEqual([{ type: 'r2_bucket', name: 'EU', bucket_name: 'eu-bucket', jurisdiction: 'eu' }])
    expect(warnings).toHaveLength(2)
  })
})
