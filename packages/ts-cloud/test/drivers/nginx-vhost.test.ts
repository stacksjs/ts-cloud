import { describe, expect, it } from 'bun:test'
import {
  buildNginxVhost,
  buildNginxVhostScript,
  defaultWebDirectory,
  isPhpSiteType,
} from '../../src/drivers/shared/nginx-vhost'

describe('buildNginxVhost', () => {
  it('renders a Laravel vhost with public root + php-fpm fastcgi', () => {
    const vhost = buildNginxVhost({
      siteName: 'app',
      domain: 'example.com',
      type: 'laravel',
      appDir: '/var/www/app/current',
      phpVersion: '8.3',
    })
    expect(vhost).toContain('server_name example.com;')
    expect(vhost).toContain('root /var/www/app/current/public;')
    expect(vhost).toContain('try_files $uri $uri/ /index.php?$query_string;')
    expect(vhost).toContain('fastcgi_pass unix:/run/php/php8.3-fpm.sock;')
    expect(vhost).toContain('error_page 404 /index.php;')
  })

  it('includes aliases in server_name', () => {
    const vhost = buildNginxVhost({
      siteName: 'app',
      domain: 'example.com',
      aliases: ['www.example.com'],
      type: 'laravel',
      appDir: '/var/www/app/current',
    })
    expect(vhost).toContain('server_name example.com www.example.com;')
  })

  it('emits redirects as exact-match 301s', () => {
    const vhost = buildNginxVhost({
      siteName: 'app',
      domain: 'example.com',
      type: 'laravel',
      appDir: '/var/www/app/current',
      redirects: { '/old': 'https://example.com/new' },
    })
    expect(vhost).toContain('location = /old { return 301 https://example.com/new; }')
  })

  it('renders an SPA fallback to index.html', () => {
    const vhost = buildNginxVhost({
      siteName: 'spa',
      domain: 'spa.example.com',
      type: 'spa',
      appDir: '/var/www/spa/current',
    })
    expect(vhost).toContain('try_files $uri $uri/ /index.html;')
    expect(vhost).not.toContain('fastcgi_pass')
  })

  it('renders a static site with a 404 fallback', () => {
    const vhost = buildNginxVhost({
      siteName: 'site',
      domain: 'site.example.com',
      type: 'static',
      appDir: '/var/www/site/current',
    })
    expect(vhost).toContain('try_files $uri $uri/ =404;')
    expect(vhost).toContain('root /var/www/site/current;')
  })

  it('serves vanilla PHP from the release root, not public/', () => {
    const vhost = buildNginxVhost({
      siteName: 'legacy',
      domain: 'legacy.example.com',
      type: 'php',
      appDir: '/var/www/legacy/current',
    })
    expect(vhost).toContain('root /var/www/legacy/current;')
    expect(vhost).toContain('fastcgi_pass')
  })
})

describe('buildNginxVhostScript', () => {
  it('writes, enables, tests, and reloads the vhost', () => {
    const script = buildNginxVhostScript({
      siteName: 'app',
      domain: 'example.com',
      type: 'laravel',
      appDir: '/var/www/app/current',
    }).join('\n')
    expect(script).toContain('cat > /etc/nginx/sites-available/app')
    expect(script).toContain('ln -sf /etc/nginx/sites-available/app /etc/nginx/sites-enabled/app')
    expect(script).toContain('rm -f /etc/nginx/sites-enabled/default')
    expect(script).toContain('nginx -t')
    expect(script).toContain('systemctl reload nginx')
  })
})

describe('site type helpers', () => {
  it('classifies php-served types', () => {
    expect(isPhpSiteType('laravel')).toBe(true)
    expect(isPhpSiteType('wordpress')).toBe(true)
    expect(isPhpSiteType('static')).toBe(false)
    expect(isPhpSiteType('spa')).toBe(false)
  })

  it('defaults laravel to public/ and php/static to the root', () => {
    expect(defaultWebDirectory('laravel')).toBe('public')
    expect(defaultWebDirectory('php')).toBe('')
    expect(defaultWebDirectory('static')).toBe('')
  })
})
