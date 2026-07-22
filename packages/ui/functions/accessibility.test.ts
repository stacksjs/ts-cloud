import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const pages = join(import.meta.dir, '..', 'pages')

async function source(path: string): Promise<string> {
  return readFile(join(pages, path), 'utf8')
}

describe('dashboard accessibility invariants', () => {
  it('gives every table header an explicit column scope', async () => {
    const files: string[] = []
    for await (const file of new Bun.Glob('**/*.stx').scan({ cwd: pages })) files.push(file)
    for (const file of files) {
      const html = await source(file)
      for (const header of html.matchAll(/<th\b[^>]*>/g))
        expect(header[0], `${file}: ${header[0]}`).toContain('scope="col"')
    }
  })

  it('keeps terminal, site refresh, and pollers inside stx composables', async () => {
    for (const file of ['server/terminal.stx', 'server/sites.stx', 'index.stx', 'server/logs.stx', 'serverless/logs.stx']) {
      const html = await source(file)
      expect(html, file).not.toMatch(/document\.|location\.reload|setInterval\(|new WebSocket/)
    }
  })

  it('names confirmation fields and announces streamed output', async () => {
    const confirm = await source('partials/op-confirm.stx')
    expect(confirm).toContain('aria-labelledby="op-confirm-prompt"')
    expect(confirm).toContain('aria-live="polite"')
    expect(confirm).toContain('type="button"')
    expect(await source('server/terminal.stx')).toContain('aria-label="Terminal output"')
  })
})
