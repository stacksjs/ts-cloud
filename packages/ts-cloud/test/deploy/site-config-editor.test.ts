import { describe, expect, it } from 'bun:test'
import { addSiteToCloudConfig, isValidHostname, removeSiteFromCloudConfig, renderAliasesValue, renderEnvValue, renderSiteSnippet, renderSslValue, setSitePropertyInCloudConfig, updateSiteInCloudConfig } from '../../src/deploy/site-config-editor'

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

  it('renders env vars and an ssl toggle', () => {
    const snippet = renderSiteSnippet({ name: 'web', root: '.', ssl: false, env: { NODE_ENV: 'production', LOG_LEVEL: 'info' } })
    expect(snippet).toContain('ssl: false,')
    expect(snippet).toContain('env: {')
    expect(snippet).toContain("NODE_ENV: 'production',")
    expect(snippet).toContain("LOG_LEVEL: 'info',")

    const sslSnippet = renderSiteSnippet({ name: 'web', root: '.', ssl: { provider: 'letsencrypt' } })
    expect(sslSnippet).toContain("ssl: { provider: 'letsencrypt' },")
  })
})

const baseConfig = `export default {
  sites: {
    main: {
      root: '/var/www/main',
      domain: 'acme.com',
    },
    docs: {
      root: '/var/www/docs',
      domain: 'acme.com',
      path: '/docs',
    },
  },
}
`

describe('removeSiteFromCloudConfig', () => {
  it('removes the named site and leaves valid TS', () => {
    const updated = removeSiteFromCloudConfig({ configText: baseConfig, name: 'docs' })
    expect(updated).not.toContain('docs:')
    expect(updated).toContain('main:')
    assertValidTs(updated)
  })

  it('removes the first site too', () => {
    const updated = removeSiteFromCloudConfig({ configText: baseConfig, name: 'main' })
    expect(updated).not.toMatch(/\bmain:/)
    expect(updated).toContain('docs:')
    assertValidTs(updated)
  })

  it('throws for an unknown site', () => {
    expect(() => removeSiteFromCloudConfig({ configText: baseConfig, name: 'nope' })).toThrow('does not exist')
  })

  it('round-trips remove → add without corrupting the config', () => {
    const removed = removeSiteFromCloudConfig({ configText: baseConfig, name: 'docs' })
    const readded = addSiteToCloudConfig({ configText: removed, name: 'docs', root: '/var/www/docs', domain: 'acme.com' })
    expect(readded).toContain('docs: {')
    assertValidTs(readded)
  })
})

describe('updateSiteInCloudConfig', () => {
  it('replaces a site definition with merged fields (env + ssl)', () => {
    const updated = updateSiteInCloudConfig({
      configText: baseConfig,
      name: 'main',
      root: '/var/www/main',
      domain: 'acme.com',
      ssl: false,
      env: { NODE_ENV: 'production' },
    })
    // Exactly one `main:` entry remains, now carrying the new fields.
    expect(updated.match(/\bmain:\s*\{/g)?.length).toBe(1)
    expect(updated).toContain('ssl: false,')
    expect(updated).toContain("NODE_ENV: 'production',")
    assertValidTs(updated)
  })
})

describe('setSitePropertyInCloudConfig', () => {
  const withExtras = `export default {
  sites: {
    web: {
      root: '/var/www/web',
      domain: 'acme.com',
      ssl: { provider: 'letsencrypt' },
      queues: [{ name: 'default', processes: 2 }],
    },
  },
}
`

  it('inserts a new property without disturbing existing ones', () => {
    const updated = setSitePropertyInCloudConfig({ configText: withExtras, siteName: 'web', key: 'env', valueText: renderEnvValue({ NODE_ENV: 'production', API_URL: 'https://api.acme.com' }) })
    expect(updated).toContain("NODE_ENV: 'production',")
    // Other fields — crucially the queues — must be preserved (no data loss).
    expect(updated).toContain("queues: [{ name: 'default', processes: 2 }]")
    expect(updated).toContain("domain: 'acme.com',")
    assertValidTs(updated)
  })

  it('replaces an existing property value (object → false) preserving the rest', () => {
    const updated = setSitePropertyInCloudConfig({ configText: withExtras, siteName: 'web', key: 'ssl', valueText: renderSslValue(false) })
    expect(updated).toContain('ssl: false,')
    expect(updated).not.toContain("ssl: { provider: 'letsencrypt' }")
    expect(updated).toContain("queues: [{ name: 'default', processes: 2 }]")
    assertValidTs(updated)
  })

  it('renders ssl and env value text', () => {
    expect(renderSslValue(true)).toBe('true')
    expect(renderSslValue(false)).toBe('false')
    expect(renderSslValue({ provider: 'letsencrypt' })).toBe("{ provider: 'letsencrypt' }")
    expect(renderEnvValue({})).toBe('{}')
    expect(renderEnvValue({ A: '1' })).toContain("A: '1',")
  })

  it('throws for an unknown site', () => {
    expect(() => setSitePropertyInCloudConfig({ configText: withExtras, siteName: 'nope', key: 'ssl', valueText: 'false' })).toThrow('does not exist')
  })

  it('renders a validated, deduped, lowercased aliases array', () => {
    expect(renderAliasesValue([])).toBe('[]')
    expect(renderAliasesValue(['WWW.Example.com', 'cdn.example.com', 'www.example.com'])).toBe("['www.example.com', 'cdn.example.com']")
    expect(() => renderAliasesValue(['not a host'])).toThrow(/valid hostname/)
    expect(isValidHostname('a.example.com')).toBe(true)
    expect(isValidHostname('localhost')).toBe(false)
  })
})
