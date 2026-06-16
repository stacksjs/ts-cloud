/**
 * Generate an nginx server block (vhost) for a Forge-style site and the shell
 * commands that install it.
 *
 * Site `type` drives the template:
 *  - `laravel` / `statamic` / `wordpress` — `public/` web root, `index.php`,
 *    `try_files … /index.php?$query_string`, and a `fastcgi_pass` to the site's
 *    php-fpm socket (see {@link import('./php-provision').phpFpmSocketPath}).
 *  - `php` — generic PHP app behind php-fpm, web root at the release root.
 *  - `static` — plain files, `try_files … =404`.
 *  - `spa` — SPA fallback to `/index.html`.
 *
 * The block listens on :80 only; TLS (the `:443` block + redirect) is layered
 * on by certbot in the SSL step, so this stays stable across cert renewals.
 */
import type { SiteConfig } from '@ts-cloud/core'
import { phpFpmSocketPath } from './php-provision'

export type NginxSiteType = NonNullable<SiteConfig['type']>

export interface NginxVhostOptions {
  /** Site key — names the config file (`/etc/nginx/sites-available/<siteName>`). */
  siteName: string
  /** Primary hostname (`server_name`). */
  domain: string
  /** Additional hostnames added to `server_name`. */
  aliases?: string[]
  /** Site type — selects the template. @default 'laravel' */
  type?: NginxSiteType
  /**
   * Directory the vhost serves from. For zero-downtime sites this is the
   * `current` symlink (`/var/www/<site>/current`); the web root appends
   * {@link webDirectory}.
   */
  appDir: string
  /** Web root relative to {@link appDir}. Defaults per type (see {@link defaultWebDirectory}). */
  webDirectory?: string
  /** PHP version selecting the php-fpm socket. @default '8.3' */
  phpVersion?: string
  /** `from path` → `to URL` 301 redirects. */
  redirects?: Record<string, string>
}

const PHP_TYPES: ReadonlySet<NginxSiteType> = new Set(['laravel', 'php', 'statamic', 'wordpress'])

/** Whether a site type is served by php-fpm. */
export function isPhpSiteType(type: NginxSiteType): boolean {
  return PHP_TYPES.has(type)
}

/** Default web root (relative to the release dir) for a site type. */
export function defaultWebDirectory(type: NginxSiteType): string {
  // Laravel/Statamic/WordPress serve from public/; vanilla PHP and static
  // sites serve from the release root.
  return type === 'laravel' || type === 'statamic' || type === 'wordpress' ? 'public' : ''
}

/** Join an app dir + web directory into an absolute root, dropping trailing slashes. */
function resolveRoot(appDir: string, webDirectory: string): string {
  const base = appDir.replace(/\/+$/, '')
  const sub = webDirectory.replace(/^\/+|\/+$/g, '')
  return sub ? `${base}/${sub}` : base
}

/**
 * Build the nginx server block text for a site.
 */
export function buildNginxVhost(options: NginxVhostOptions): string {
  const type = options.type ?? 'laravel'
  const webDirectory = options.webDirectory ?? defaultWebDirectory(type)
  const root = resolveRoot(options.appDir, webDirectory)
  const serverNames = [options.domain, ...(options.aliases || [])].filter(Boolean).join(' ')
  const isPhp = isPhpSiteType(type)
  const phpVersion = options.phpVersion ?? '8.3'

  const lines: string[] = [
    'server {',
    '    listen 80;',
    '    listen [::]:80;',
    `    server_name ${serverNames};`,
    `    root ${root};`,
    '',
    '    add_header X-Frame-Options "SAMEORIGIN";',
    '    add_header X-Content-Type-Options "nosniff";',
    '',
    `    index ${isPhp ? 'index.php index.html' : 'index.html index.htm'};`,
    '',
    '    charset utf-8;',
    '',
  ]

  // Redirects emitted as exact-match 301s before the catch-all location.
  for (const [from, to] of Object.entries(options.redirects || {})) {
    lines.push(`    location = ${from} { return 301 ${to}; }`)
  }
  if (Object.keys(options.redirects || {}).length > 0)
    lines.push('')

  if (isPhp) {
    lines.push(
      '    location / {',
      '        try_files $uri $uri/ /index.php?$query_string;',
      '    }',
      '',
      '    location = /favicon.ico { access_log off; log_not_found off; }',
      '    location = /robots.txt  { access_log off; log_not_found off; }',
      '',
      '    error_page 404 /index.php;',
      '',
      '    location ~ \\.php$ {',
      `        fastcgi_pass unix:${phpFpmSocketPath(phpVersion)};`,
      '        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;',
      '        include fastcgi_params;',
      '    }',
      '',
      '    location ~ /\\.(?!well-known).* {',
      '        deny all;',
      '    }',
    )
  }
  else if (type === 'spa') {
    lines.push(
      '    location / {',
      '        try_files $uri $uri/ /index.html;',
      '    }',
    )
  }
  else {
    // static
    lines.push(
      '    location / {',
      '        try_files $uri $uri/ =404;',
      '    }',
    )
  }

  lines.push('}')
  return `${lines.join('\n')}\n`
}

/**
 * Build the shell commands that write the vhost, enable it, validate the nginx
 * config, and reload. Re-runnable (overwrites the config + refreshes the symlink).
 */
export function buildNginxVhostScript(options: NginxVhostOptions): string[] {
  const available = `/etc/nginx/sites-available/${options.siteName}`
  const enabled = `/etc/nginx/sites-enabled/${options.siteName}`
  const vhost = buildNginxVhost(options)

  return [
    `cat > ${available} <<'TS_CLOUD_NGINX_EOF'`,
    vhost.replace(/\n$/, ''),
    'TS_CLOUD_NGINX_EOF',
    `ln -sf ${available} ${enabled}`,
    // Drop the stock default site so it doesn't shadow our server_name.
    'rm -f /etc/nginx/sites-enabled/default',
    'nginx -t',
    'systemctl reload nginx',
  ]
}
