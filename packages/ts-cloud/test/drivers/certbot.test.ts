import { describe, expect, it } from 'bun:test'
import {
  buildCertbotInstallScript,
  buildCertbotIssueScript,
  buildSslScript,
  resolveSslProvider,
} from '../../src/drivers/shared/certbot'
import { buildNginxVhost } from '../../src/drivers/shared/nginx-vhost'

describe('resolveSslProvider', () => {
  it('defaults to letsencrypt when a domain is present', () => {
    expect(resolveSslProvider({ root: '.', type: 'laravel', domain: 'x.com' })).toBe('letsencrypt')
  })
  it('is none without a domain', () => {
    expect(resolveSslProvider({ root: '.', type: 'laravel' })).toBe('none')
  })
  it('honours an explicit provider', () => {
    expect(resolveSslProvider({ root: '.', domain: 'x.com', ssl: { provider: 'custom' } })).toBe('custom')
  })
})

describe('buildCertbotInstallScript', () => {
  it('installs certbot + nginx plugin and a renew/reload hook', () => {
    const script = buildCertbotInstallScript().join('\n')
    expect(script).toContain('apt-get install -y certbot python3-certbot-nginx')
    expect(script).toContain('renewal-hooks/deploy/reload-nginx.sh')
    expect(script).toContain('systemctl enable certbot.timer')
  })
})

describe('buildCertbotIssueScript', () => {
  it('issues for the domain + aliases with redirect and email', () => {
    const script = buildCertbotIssueScript({ domain: 'x.com', aliases: ['www.x.com'], email: 'a@x.com' }).join('\n')
    expect(script).toContain('certbot ')
    expect(script).toContain('--nginx')
    expect(script).toContain('--redirect')
    expect(script).toContain('--keep-until-expiring')
    expect(script).toContain('-d x.com')
    expect(script).toContain('-d www.x.com')
    expect(script).toContain('-m a@x.com')
  })

  it('registers without email when none is given', () => {
    const script = buildCertbotIssueScript({ domain: 'x.com' }).join('\n')
    expect(script).toContain('--register-unsafely-without-email')
  })
})

describe('buildSslScript', () => {
  it('returns the full certbot flow for a letsencrypt site', () => {
    const script = buildSslScript({ root: '.', type: 'laravel', domain: 'x.com' }).join('\n')
    expect(script).toContain('--nginx')
    expect(script).toContain('-d x.com')
  })

  it('issues a wildcard cert via DNS-01 (cloudflare) when configured', () => {
    const script = buildSslScript({
      root: '.', type: 'laravel', domain: 'x.com',
      ssl: { wildcard: true, dns: { provider: 'cloudflare', credentials: { dns_cloudflare_api_token: 'tok' }, propagationSeconds: 30 } },
    }).join('\n')
    expect(script).toContain('python3-certbot-dns-cloudflare')
    expect(script).toContain('--dns-cloudflare')
    expect(script).toContain('--dns-cloudflare-credentials /etc/letsencrypt/ts-cloud-cloudflare.ini')
    expect(script).toContain('--dns-cloudflare-propagation-seconds 30')
    expect(script).toContain('certonly')
    expect(script).toContain('-d *.x.com')
    expect(script).toContain('-d x.com')
    expect(script).toContain('dns_cloudflare_api_token = tok')
  })

  it('skips a wildcard request with no DNS config (HTTP-01 cannot do wildcards)', () => {
    expect(buildSslScript({ root: '.', type: 'laravel', domain: 'x.com', ssl: { wildcard: true } })).toEqual([])
  })
  it('is empty for a custom-cert site (handled in the vhost)', () => {
    expect(buildSslScript({ root: '.', domain: 'x.com', ssl: { provider: 'custom', certPath: '/c', keyPath: '/k' } })).toEqual([])
  })
})

describe('nginx vhost with custom TLS', () => {
  it('emits an HTTP→HTTPS redirect and a :443 ssl block', () => {
    const vhost = buildNginxVhost({
      siteName: 'app',
      domain: 'x.com',
      type: 'laravel',
      appDir: '/var/www/app/current',
      ssl: { certPath: '/etc/ssl/x.crt', keyPath: '/etc/ssl/x.key' },
    })
    expect(vhost).toContain('return 301 https://$host$request_uri;')
    expect(vhost).toContain('listen 443 ssl;')
    expect(vhost).toContain('ssl_certificate /etc/ssl/x.crt;')
    expect(vhost).toContain('ssl_certificate_key /etc/ssl/x.key;')
    expect(vhost).toContain('fastcgi_pass')
  })
})
