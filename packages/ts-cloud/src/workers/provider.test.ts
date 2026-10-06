import type { WorkerUpload } from './provider'
import { describe, expect, it } from 'bun:test'
import { CloudflareFailure, fakeCloudflare } from '../r2/test-fetch'
import {
  CONTENT_HASH_BINDING,
  workerContentHash,
  WorkersApiError,
  WorkersPermissionError,
  WorkersProvider,
} from './provider'

const ACCOUNT = 'acc123'
const SCRIPT = `/accounts/${ACCOUNT}/workers/scripts/tiles`
const DOMAINS = `/accounts/${ACCOUNT}/workers/domains`
const NOT_FOUND = new CloudflareFailure(404, [{ code: 10007, message: 'This Worker does not exist on your account.' }])
const AUTH_ERROR = new CloudflareFailure(403, [{ code: 10000, message: 'Authentication error' }])

const upload: WorkerUpload = {
  mainModule: 'tiles.js',
  modules: [{ name: 'tiles.js', content: 'export default{fetch(){return new Response("ok")}}', type: 'application/javascript+module' }],
  bindings: [
    { type: 'r2_bucket', name: 'TILES', bucket_name: 'my-tiles' },
    { type: 'plain_text', name: 'MODE', text: 'prod' },
  ],
  compatibilityDate: '2025-09-01',
  compatibilityFlags: ['nodejs_compat'],
}

function provider(routes: Record<string, unknown>) {
  const fake = fakeCloudflare(routes)
  return { workers: new WorkersProvider({ apiToken: 'tok', accountId: ACCOUNT, fetch: fake.fetch }), ...fake }
}

/** Settings as Cloudflare would return them after uploading `upload`. */
function deployedSettings(hash: string = workerContentHash(upload)) {
  return {
    bindings: [
      ...upload.bindings!,
      { type: 'plain_text', name: CONTENT_HASH_BINDING, text: hash },
      { type: 'secret_text', name: 'API_KEY' },
    ],
    compatibility_date: '2025-09-01',
    compatibility_flags: ['nodejs_compat'],
  }
}

describe('WorkersProvider', () => {
  describe('upload', () => {
    it('sends a multipart body with a metadata part and one module part', async () => {
      const { workers, writes } = provider({ [`PUT ${SCRIPT}`]: { id: 'tiles', etag: 'e1' } })

      await workers.uploadModuleScript('tiles', upload)

      const [put] = writes()
      expect(put!.headers.authorization).toBe('Bearer tok')
      // fetch sets the multipart boundary itself, so no content type is forced.
      expect(put!.headers['content-type']).toBeUndefined()
      const form = put!.body as FormData
      expect(form).toBeInstanceOf(FormData)
      expect([...form.keys()]).toEqual(['metadata', 'tiles.js'])

      expect(JSON.parse(form.get('metadata') as string)).toEqual({
        main_module: 'tiles.js',
        bindings: upload.bindings,
        compatibility_date: '2025-09-01',
        compatibility_flags: ['nodejs_compat'],
        keep_bindings: ['secret_text'],
      })

      const module = form.get('tiles.js') as File
      expect(module.name).toBe('tiles.js')
      expect(module.type).toBe('application/javascript+module')
      expect(await module.text()).toBe(upload.modules[0]!.content)
    })

    it('refuses an upload whose main module is not among the modules', async () => {
      const { workers, calls } = provider({})
      await expect(workers.uploadModuleScript('tiles', { ...upload, mainModule: 'other.js' })).rejects.toThrow('not one of the uploaded modules')
      expect(calls).toEqual([])
    })
  })

  describe('ensureModuleScript', () => {
    it('uploads a new script with the content hash binding', async () => {
      const { workers, writes } = provider({
        [`GET ${SCRIPT}/settings`]: NOT_FOUND,
        [`PUT ${SCRIPT}`]: { id: 'tiles' },
      })

      const result = await workers.ensureModuleScript('tiles', upload)

      expect(result).toEqual({ action: 'created', hash: workerContentHash(upload) })
      const metadata = JSON.parse((writes()[0]!.body as FormData).get('metadata') as string)
      expect(metadata.bindings).toContainEqual({ type: 'plain_text', name: CONTENT_HASH_BINDING, text: result.hash })
      expect(metadata.bindings).toContainEqual({ type: 'r2_bucket', name: 'TILES', bucket_name: 'my-tiles' })
    })

    it('skips the upload when the deployed hash and bindings match', async () => {
      const { workers, writes } = provider({ [`GET ${SCRIPT}/settings`]: deployedSettings() })
      expect(await workers.ensureModuleScript('tiles', upload)).toEqual({ action: 'unchanged', hash: workerContentHash(upload) })
      expect(writes()).toEqual([])
    })

    it('uploads when the code changed', async () => {
      const { workers, writes } = provider({
        [`GET ${SCRIPT}/settings`]: deployedSettings(),
        [`PUT ${SCRIPT}`]: { id: 'tiles' },
      })
      const changed = { ...upload, modules: [{ ...upload.modules[0]!, content: 'export default{}' }] }
      expect((await workers.ensureModuleScript('tiles', changed)).action).toBe('updated')
      expect(writes()).toHaveLength(1)
    })

    it('uploads when a binding was changed in the dashboard since', async () => {
      const settings = deployedSettings()
      settings.bindings[1] = { type: 'plain_text', name: 'MODE', text: 'edited-by-hand' }
      const { workers, writes } = provider({
        [`GET ${SCRIPT}/settings`]: settings,
        [`PUT ${SCRIPT}`]: { id: 'tiles' },
      })
      expect((await workers.ensureModuleScript('tiles', upload)).action).toBe('updated')
      expect(writes()).toHaveLength(1)
    })

    it('hashes independently of binding and flag order', () => {
      const reordered = { ...upload, bindings: [...upload.bindings!].reverse(), compatibilityFlags: ['nodejs_compat'] }
      expect(workerContentHash(reordered)).toBe(workerContentHash(upload))
      expect(workerContentHash({ ...upload, compatibilityDate: '2024-01-01' })).not.toBe(workerContentHash(upload))
    })
  })

  describe('custom domains', () => {
    const attachedHere = { id: 'd1', hostname: 'tiles.example.com', service: 'tiles', zone_id: 'zone1', environment: 'production' }

    it('attaches a missing hostname with the service, zone and environment', async () => {
      const { workers, writes } = provider({
        [`GET ${DOMAINS}`]: [],
        [`PUT ${DOMAINS}`]: attachedHere,
      })

      const result = await workers.ensureCustomDomain('tiles.example.com', { service: 'tiles', zoneId: 'zone1' })

      expect(result.action).toBe('attached')
      expect(writes()[0]!.body).toEqual({ hostname: 'tiles.example.com', service: 'tiles', zone_id: 'zone1', environment: 'production' })
    })

    it('is a no-op when the hostname is already attached to this Worker', async () => {
      const { workers, writes } = provider({ [`GET ${DOMAINS}`]: [attachedHere] })
      expect((await workers.ensureCustomDomain('Tiles.Example.com', { service: 'tiles', zoneId: 'zone1' })).action).toBe('unchanged')
      expect(writes()).toEqual([])
    })

    it('refuses to move a hostname another Worker serves', async () => {
      const { workers, writes } = provider({ [`GET ${DOMAINS}`]: [{ ...attachedHere, service: 'other' }] })
      await expect(workers.ensureCustomDomain('tiles.example.com', { service: 'tiles' })).rejects.toThrow('attached to the Worker \'other\'')
      expect(writes()).toEqual([])
    })

    it('passes list filters as query parameters and detaches by id', async () => {
      const { workers, calls } = provider({ [`GET ${DOMAINS}`]: [attachedHere], [`DELETE ${DOMAINS}/d1`]: null })
      await workers.listCustomDomains({ service: 'tiles', hostname: 'tiles.example.com' })
      expect(calls[0]!.query.get('service')).toBe('tiles')
      expect(calls[0]!.query.get('hostname')).toBe('tiles.example.com')
      await workers.detachCustomDomain('d1')
      expect(calls[1]!.method).toBe('DELETE')
    })
  })

  describe('errors', () => {
    it('names the missing permission for scripts', async () => {
      const { workers } = provider({ [`GET ${SCRIPT}/settings`]: AUTH_ERROR })
      const error = await workers.getSettings('tiles').catch(caught => caught)
      expect(error).toBeInstanceOf(WorkersPermissionError)
      expect(error.permission).toContain('Workers Scripts: Edit')
      expect(error.message).toContain('missing the "Workers Scripts: Edit (account)" permission')
    })

    it('names the routes permission for custom domains', async () => {
      const { workers } = provider({ [`PUT ${DOMAINS}`]: AUTH_ERROR })
      const error = await workers.attachCustomDomain('tiles.example.com', { service: 'tiles' }).catch(caught => caught)
      expect(error).toBeInstanceOf(WorkersPermissionError)
      expect(error.permission).toContain('Workers Routes: Edit')
    })

    it('treats a missing script as null, and keeps other errors with their codes', async () => {
      const { workers } = provider({
        [`GET ${SCRIPT}/settings`]: NOT_FOUND,
        [`PUT ${SCRIPT}`]: new CloudflareFailure(400, [{ code: 10021, message: 'Uncaught SyntaxError' }]),
      })
      expect(await workers.getSettings('tiles')).toBeNull()
      const error = await workers.uploadModuleScript('tiles', upload).catch(caught => caught)
      expect(error).toBeInstanceOf(WorkersApiError)
      expect(error).not.toBeInstanceOf(WorkersPermissionError)
      expect(error.hasCode(10021)).toBe(true)
      expect(error.message).toContain('10021: Uncaught SyntaxError')
    })
  })
})
