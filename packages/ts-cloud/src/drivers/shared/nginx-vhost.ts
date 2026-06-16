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
  /**
   * Serve TLS directly from this vhost using operator-provided certs. When set,
   * the :80 block becomes an HTTPS redirect and a :443 `ssl` block serves the
   * site. Used for the `custom` SSL provider; for Let's Encrypt, certbot
   * rewrites the :80 block itself (leave this unset).
   */
  ssl?: { certPath: string, keyPath: string }
  /**
   * HTTP Basic auth (htpasswd). When set, the vhost requires auth and the
   * generated script writes the htpasswd file. The `realm` is shown in the
   * browser prompt.
   */
  auth?: { username: string, password: string, realm?: string }
}

/** Path of the htpasswd file for a site. */
export function htpasswdPath(siteName: string): string {
  return `/etc/nginx/.htpasswd-${siteName}`
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

/** Inner directives (root, index, security headers, locations) for a server block. */
function vhostBody(options: NginxVhostOptions): string[] {
  const type = options.type ?? 'laravel'
  const webDirectory = options.webDirectory ?? defaultWebDirectory(type)
  const root = resolveRoot(options.appDir, webDirectory)
  const isPhp = isPhpSiteType(type)
  const phpVersion = options.phpVersion ?? '8.3'

  const lines: string[] = [
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

  // HTTP Basic auth gates the whole site.
  if (options.auth) {
    lines.push(
      `    auth_basic "${options.auth.realm || 'Restricted'}";`,
      `    auth_basic_user_file ${htpasswdPath(options.siteName)};`,
      '',
    )
  }

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
      `        fastcgi_pass ${phpFpmSocketPath(phpVersion)};`,
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

  return lines
}

/**
 * Build the nginx server block text for a site. With `options.ssl`, emits a
 * :80 → HTTPS redirect plus a :443 `ssl` block (the `custom` cert path);
 * otherwise a single :80 block (certbot upgrades it for Let's Encrypt).
 */
export function buildNginxVhost(options: NginxVhostOptions): string {
  const serverNames = [options.domain, ...(options.aliases || [])].filter(Boolean).join(' ')
  const body = vhostBody(options)

  if (options.ssl) {
    const redirect = [
      'server {',
      '    listen 80;',
      '    listen [::]:80;',
      `    server_name ${serverNames};`,
      '    return 301 https://$host$request_uri;',
      '}',
    ]
    const tls = [
      'server {',
      '    listen 443 ssl;',
      '    listen [::]:443 ssl;',
      `    server_name ${serverNames};`,
      `    ssl_certificate ${options.ssl.certPath};`,
      `    ssl_certificate_key ${options.ssl.keyPath};`,
      '',
      ...body,
      '}',
    ]
    return `${[...redirect, '', ...tls].join('\n')}\n`
  }

  const lines = [
    'server {',
    '    listen 80;',
    '    listen [::]:80;',
    `    server_name ${serverNames};`,
    ...body,
    '}',
  ]
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

  const out: string[] = []

  // Generate the htpasswd file (apr1 hash via openssl — no apache2-utils dep).
  if (options.auth) {
    const file = htpasswdPath(options.siteName)
    // Single-quote-escape both fields so a `'` (or other shell metachar) in the
    // password/username can't break out of the command.
    const sq = (v: string): string => v.split('\'').join('\'\\\'\'')
    const pw = sq(options.auth.password)
    const user = sq(options.auth.username)
    out.push(
      `TS_CLOUD_HTPASS=$(openssl passwd -apr1 '${pw}')`,
      `printf '%s:%s\\n' '${user}' "$TS_CLOUD_HTPASS" > ${file}`,
      `chmod 640 ${file}`,
      `chown root:www-data ${file} 2>/dev/null || true`,
    )
  }

  out.push(
    `cat > ${available} <<'TS_CLOUD_NGINX_EOF'`,
    vhost.replace(/\n$/, ''),
    'TS_CLOUD_NGINX_EOF',
    `ln -sf ${available} ${enabled}`,
    // Drop the stock default site so it doesn't shadow our server_name.
    'rm -f /etc/nginx/sites-enabled/default',
    'nginx -t',
    'systemctl reload nginx',
  )
  return out
}
