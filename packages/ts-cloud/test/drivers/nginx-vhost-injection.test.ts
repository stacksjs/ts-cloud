import { describe, expect, it } from 'bun:test'
import { isValidHostname, renderStringValue } from '../../src/deploy/site-config-editor'
import { buildNginxVhost } from '../../src/drivers/shared/nginx-vhost'

/**
 * Regression tests for nginx `server_name` injection.
 *
 * A site's `domain` is member-editable and is interpolated straight into the
 * generated `server_name` directive. nginx is whitespace-insensitive, so an
 * unvalidated value can close the server block and open an attacker-controlled
 * one — e.g. `location / { root /; autoindex on; }`, which exposes the whole
 * filesystem (other tenants' .env files, the dashboard user store, SSH keys)
 * over HTTP on a shared box.
 */

// Closes the generated block, opens a filesystem-exposing one, then reopens a
// server block so the result still parses.
const INJECTION = 'x.com; } location / { root /; autoindex on; } server { server_name y.com'

describe('server_name injection', () => {
  it('rejects a domain carrying nginx directives', () => {
    expect(isValidHostname(INJECTION)).toBe(false)
  })

  it('refuses to build a vhost from an injected domain', () => {
    expect(() => buildNginxVhost({
      siteName: 'app',
      domain: INJECTION,
      appDir: '/var/www/app/current',
    })).toThrow(/not a valid hostname/)
  })

  it('refuses to build a vhost from an injected alias', () => {
    expect(() => buildNginxVhost({
      siteName: 'app',
      domain: 'example.com',
      aliases: [INJECTION],
      appDir: '/var/www/app/current',
    })).toThrow(/not a valid hostname/)
  })

  it('rejects whitespace, newlines and directive punctuation in a hostname', () => {
    for (const bad of ['a.com b.com', 'a.com\nserver_name evil.com', 'a.com;', 'a.com{', 'a.com}']) {
      expect(() => buildNginxVhost({
        siteName: 'app',
        domain: bad,
        appDir: '/var/www/app/current',
      })).toThrow(/not a valid hostname/)
    }
  })

  it('rejects an empty server_name rather than emitting `server_name ;`', () => {
    expect(() => buildNginxVhost({
      siteName: 'app',
      domain: '',
      appDir: '/var/www/app/current',
    })).toThrow(/no server_name/)
  })

  // compute-deploy falls back to `domain: site.domain || siteName`, so an
  // internal site with no configured domain arrives here as a single label.
  // The generator must keep accepting those or every such deploy breaks.
  it('accepts a single-label host (the siteName fallback)', () => {
    for (const host of ['main', 'docs', 'localhost']) {
      const vhost = buildNginxVhost({
        siteName: host,
        domain: host,
        appDir: '/var/www/app/current',
      })
      expect(vhost).toContain(`server_name ${host};`)
    }
  })

  it('still builds a normal vhost, including wildcard aliases', () => {
    const vhost = buildNginxVhost({
      siteName: 'app',
      domain: 'app.example.com',
      aliases: ['www.example.com', '*.cdn.example.com'],
      appDir: '/var/www/app/current',
    })
    expect(vhost).toContain('server_name app.example.com www.example.com *.cdn.example.com;')
  })
})

describe('cloud.config.ts string escaping', () => {
  it('escapes newlines so a value cannot terminate the string literal', () => {
    const rendered = renderStringValue('a\nb')
    expect(rendered).not.toContain('\n')
    expect(rendered).toBe('\'a\\nb\'')
  })

  it('escapes carriage returns, quotes and backslashes', () => {
    expect(renderStringValue('a\rb')).not.toContain('\r')
    expect(renderStringValue('it\'s')).toBe('\'it\\\'s\'')
    expect(renderStringValue('a\\b')).toBe('\'a\\\\b\'')
  })
})
