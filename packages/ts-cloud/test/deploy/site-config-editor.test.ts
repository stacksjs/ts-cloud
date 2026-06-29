import { describe, expect, it } from 'bun:test'
import { addSiteToCloudConfig, renderSiteSnippet } from '../../src/deploy/site-config-editor'

// Assert the rewritten config still parses as TypeScript so a malformed result
// (e.g. a missing separating comma between sites) fails loudly.
function assertValidTs(code: string): void {
  expect(code).not.toContain(',,')
  new Bun.Transpiler({ loader: 'ts' }).transformSync(code)
}

describe('renderSiteSnippet', () => {
  it('renders a server-static site snippet', () => {
    expect(renderSiteSnippet({
      name: 'docs',
      deploy: 'server',
      root: 'dist/docs/.bunpress',
      path: '/docs',
      domain: 'example.com',
      build: 'bun run docs:build',
      pathRewriteStyle: 'directory',
    })).toContain("deploy: 'server'")
  })
})

describe('addSiteToCloudConfig', () => {
  it('inserts a site before the closing sites object brace', () => {
    const config = `export default {
  sites: {
    main: {
      root: '.',
    },
  },
}
`

    const updated = addSiteToCloudConfig({
      configText: config,
      name: 'marketing',
      deploy: 'server',
      root: '../adblock/dist/site',
      path: '/',
      domain: 'verygoodadblock.org',
      build: 'cd ../adblock && bun run site:build',
    })

    expect(updated).toContain('marketing: {')
    expect(updated).toContain("domain: 'verygoodadblock.org'")
    expect(updated.indexOf('marketing: {')).toBeLessThan(updated.indexOf('\n  },\n}'))
    assertValidTs(updated)
  })

  it('adds a separating comma when the previous site has no trailing comma', () => {
    const config = `export default {
  sites: {
    main: {
      root: '.'
    }
  },
}
`
    const updated = addSiteToCloudConfig({
      configText: config,
      name: 'docs',
      deploy: 'server',
      root: 'dist/docs',
      domain: 'example.com',
    })

    expect(updated).toContain('docs: {')
    assertValidTs(updated)
  })

  it('refuses duplicate sites', () => {
    expect(() => addSiteToCloudConfig({
      configText: `export default { sites: { docs: { root: 'dist' } } }`,
      name: 'docs',
      root: 'dist/docs',
    })).toThrow("Site 'docs' already exists")
  })

  it('ignores braces inside strings while finding the sites block', () => {
    const updated = addSiteToCloudConfig({
      configText: `export default { sites: { main: { root: '{dist}' } } }`,
      name: 'docs',
      root: 'dist/docs',
    })

    expect(updated).toContain('docs: {')
    assertValidTs(updated)
  })
})
