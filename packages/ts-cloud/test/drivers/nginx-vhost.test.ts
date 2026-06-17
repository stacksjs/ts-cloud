import { describe, expect, it } from 'bun:test'
import {
  buildNginxServiceScript,
  buildNginxVhost,
  buildNginxVhostScript,
  defaultWebDirectory,
  isPhpSiteType,
} from '../../src/drivers/shared/nginx-vhost'

describe('buildNginxServiceScript', () => {
  it('sets up ts-cloud nginx on the pantry binary via a systemd unit', () => {
    const script = buildNginxServiceScript().join('\n')
    // Wrapper runs the pantry nginx binary inside pantry env.
    expect(script).toContain('/usr/local/bin/ts-cloud-nginx')
    expect(script).toContain('pantry env')
    // Full nginx.conf includes the per-site vhosts and runs as www-data.
    expect(script).toContain('include /etc/nginx/sites-enabled/*;')
    expect(script).toContain('user www-data;')
    // systemd unit on the box (not apt's nginx service).
    expect(script).toContain('/etc/systemd/system/ts-cloud-nginx.service')
    expect(script).toContain('systemctl enable ts-cloud-nginx')
  })

  it('includes a catch-all default server returning 444 for unconfigured domains', () => {
    const script = buildNginxServiceScript().join('\n')
    expect(script).toContain('listen 80 default_server;')
    expect(script).toContain('server_name _;')
    expect(script).toContain('return 444;')
  })
})

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
    expect(vhost).toContain('fastcgi_pass 127.0.0.1:9074;')
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
    expect(script).toContain('/usr/local/bin/ts-cloud-nginx -t')
    expect(script).toContain('systemctl reload ts-cloud-nginx')
  })
})

describe('basic auth (htpasswd)', () => {
  it('emits auth_basic directives referencing the site htpasswd file', () => {
    const vhost = buildNginxVhost({
      siteName: 'ui',
      domain: 'ui.example.com',
      type: 'static',
      appDir: '/var/www/ui/current',
      auth: { username: 'admin', password: 's3cret', realm: 'ts-cloud' },
    })
    expect(vhost).toContain('auth_basic "ts-cloud";')
    expect(vhost).toContain('auth_basic_user_file /etc/nginx/.htpasswd-ui;')
  })

  it('generates the htpasswd file via openssl in the script', () => {
    const script = buildNginxVhostScript({
      siteName: 'ui',
      domain: 'ui.example.com',
      type: 'static',
      appDir: '/var/www/ui/current',
      auth: { username: 'admin', password: 's3cret' },
    }).join('\n')
    expect(script).toContain("openssl passwd -apr1 's3cret'")
    expect(script).toContain("printf '%s:%s\\n' 'admin'")
    expect(script).toContain('/etc/nginx/.htpasswd-ui')
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
