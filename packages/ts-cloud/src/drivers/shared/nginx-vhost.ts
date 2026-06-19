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
import type { SiteConfig, SiteNginxConfig } from '@ts-cloud/core'
import { phpFpmSocketPath } from './php-provision'

export type NginxSiteType = NonNullable<SiteConfig['type']>

/**
 * Resolve the nginx directive lines for a site's vhost from its
 * {@link SiteNginxConfig} and the server's reusable templates: the referenced
 * template's lines first, then the per-site `serverSnippet`. Unknown template
 * names resolve to nothing. Returns `[]` when there's no customization.
 */
export function resolveNginxSnippet(
  nginx: SiteNginxConfig | undefined,
  templates: Record<string, string[]> | undefined,
): string[] {
  if (!nginx)
    return []
  const out: string[] = []
  if (nginx.template && templates?.[nginx.template])
    out.push(...templates[nginx.template])
  if (nginx.serverSnippet)
    out.push(...nginx.serverSnippet)
  return out
}

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
  /**
   * Custom nginx directive lines injected into the server block (after the
   * managed directives) — a resolved reusable template plus per-site snippet.
   * See {@link import('@ts-cloud/core').SiteNginxConfig}.
   */
  serverSnippet?: string[]
  /** `client_max_body_size` override for this vhost (e.g. `'256M'`). */
  clientMaxBodySize?: string
  /** Emit an HSTS header. `true` = 1yr + includeSubDomains; object customizes. */
  hsts?: boolean | { maxAge?: number, includeSubDomains?: boolean, preload?: boolean }
  /** `ssl_protocols` for the custom-cert :443 block. */
  tlsProtocols?: string[]
  /** Per-site IP allow/deny (Forge "Security Rules"). */
  security?: { allow?: string[], deny?: string[] }
}

/** Render the HSTS header line, or `''` when disabled. */
function hstsHeader(hsts: NginxVhostOptions['hsts']): string {
  if (!hsts)
    return ''
  const o = typeof hsts === 'object' ? hsts : {}
  const maxAge = o.maxAge ?? 31536000
  const parts = [`max-age=${maxAge}`]
  if (o.includeSubDomains ?? true)
    parts.push('includeSubDomains')
  if (o.preload)
    parts.push('preload')
  return `    add_header Strict-Transport-Security "${parts.join('; ')}" always;`
}

/** Render nginx `allow`/`deny` lines for per-site IP access control. */
function securityRules(security: NginxVhostOptions['security']): string[] {
  if (!security || (!security.allow?.length && !security.deny?.length))
    return []
  const lines: string[] = []
  for (const ip of security.deny || [])
    lines.push(`    deny ${ip};`)
  if (security.allow?.length) {
    for (const ip of security.allow)
      lines.push(`    allow ${ip};`)
    lines.push('    deny all;')
  }
  return lines
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
  ]

  // HSTS (force HTTPS in browsers) — served on the TLS block; harmless on :80.
  const hsts = hstsHeader(options.hsts)
  if (hsts)
    lines.push(hsts)

  // Per-site IP allow/deny (Forge Security Rules) gate the whole server block.
  for (const rule of securityRules(options.security))
    lines.push(rule)

  lines.push(
    '',
    `    index ${isPhp ? 'index.php index.html' : 'index.html index.htm'};`,
    '',
    '    charset utf-8;',
    '',
  )

  // Per-vhost upload ceiling (overrides the http-level client_max_body_size).
  if (options.clientMaxBodySize) {
    lines.push(`    client_max_body_size ${options.clientMaxBodySize};`, '')
  }

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

  // Operator-supplied directives (resolved template + per-site snippet) are
  // injected last so they can add/override locations within the server block.
  if (options.serverSnippet && options.serverSnippet.length > 0) {
    lines.push('')
    for (const line of options.serverSnippet)
      lines.push(line ? `    ${line}` : '')
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
      ...(options.tlsProtocols?.length ? [`    ssl_protocols ${options.tlsProtocols.join(' ')};`] : []),
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
    // Validate + reload via the ts-cloud nginx wrapper (pantry binary + env).
    `${NGINX_WRAPPER} -t`,
    // Reload if running, else (re)start so the first deploy brings nginx up.
    'systemctl reload ts-cloud-nginx 2>/dev/null || systemctl restart ts-cloud-nginx 2>/dev/null || true',
  )
  return out
}

/** Wrapper that runs the pantry-installed nginx binary inside pantry's env. */
export const NGINX_WRAPPER = '/usr/local/bin/ts-cloud-nginx'

/**
 * Set up ts-cloud-managed nginx on top of the pantry-installed nginx binary:
 * a wrapper that runs nginx within `pantry env` (so it + its shared libs
 * resolve), a full `/etc/nginx/nginx.conf` that `include`s the per-site vhosts,
 * and a systemd unit on :80/:443. Replaces apt's nginx service (pantry's own
 * nginx service serves a minimal :8080 default and isn't started here).
 *
 * Run once at provision time, after the nginx binary is installed.
 */
export function buildNginxServiceScript(projectDir = '/opt/pantry'): string[] {
  return [
    'mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled /var/log/nginx /var/lib/nginx/body /var/lib/nginx/proxy /var/lib/nginx/fastcgi /var/lib/nginx/uwsgi /var/lib/nginx/scgi',
    'getent passwd www-data >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin www-data',
    'chown -R www-data:www-data /var/lib/nginx /var/log/nginx',
    // nginx wrapper — pantry env puts nginx + its libs on PATH/LD_LIBRARY_PATH.
    `cat > ${NGINX_WRAPPER} <<'TS_CLOUD_NGINXBIN_EOF'`,
    '#!/bin/sh',
    `eval "$(cd ${projectDir} && pantry env 2>/dev/null)"`,
    'NGINX_BIN=$(command -v nginx || echo /opt/pantry/pantry/.bin/nginx)',
    'exec "$NGINX_BIN" -c /etc/nginx/nginx.conf "$@"',
    'TS_CLOUD_NGINXBIN_EOF',
    `chmod +x ${NGINX_WRAPPER}`,
    // fastcgi_params — apt's nginx ships this; pantry's build does not. The PHP
    // vhost does `include fastcgi_params;`, so write the standard set.
    'cat > /etc/nginx/fastcgi_params <<\'TS_CLOUD_FCGI_EOF\'',
    'fastcgi_param  QUERY_STRING       $query_string;',
    'fastcgi_param  REQUEST_METHOD     $request_method;',
    'fastcgi_param  CONTENT_TYPE       $content_type;',
    'fastcgi_param  CONTENT_LENGTH     $content_length;',
    'fastcgi_param  SCRIPT_NAME        $fastcgi_script_name;',
    'fastcgi_param  REQUEST_URI        $request_uri;',
    'fastcgi_param  DOCUMENT_URI       $document_uri;',
    'fastcgi_param  DOCUMENT_ROOT      $document_root;',
    'fastcgi_param  SERVER_PROTOCOL    $server_protocol;',
    'fastcgi_param  REQUEST_SCHEME     $scheme;',
    'fastcgi_param  HTTPS              $https if_not_empty;',
    'fastcgi_param  GATEWAY_INTERFACE  CGI/1.1;',
    'fastcgi_param  SERVER_SOFTWARE    nginx/$nginx_version;',
    'fastcgi_param  REMOTE_ADDR        $remote_addr;',
    'fastcgi_param  REMOTE_PORT        $remote_port;',
    'fastcgi_param  SERVER_ADDR        $server_addr;',
    'fastcgi_param  SERVER_PORT        $server_port;',
    'fastcgi_param  SERVER_NAME        $server_name;',
    'fastcgi_param  REDIRECT_STATUS    200;',
    'TS_CLOUD_FCGI_EOF',
    // Full nginx.conf: workers as www-data, logs/pid/temp under /var, and the
    // per-site vhosts from sites-enabled.
    'cat > /etc/nginx/nginx.conf <<\'TS_CLOUD_NGINXCONF_EOF\'',
    'user www-data;',
    'worker_processes auto;',
    'pid /run/nginx.pid;',
    'error_log /var/log/nginx/error.log;',
    'events { worker_connections 1024; }',
    'http {',
    '    default_type application/octet-stream;',
    '    types {',
    '        text/html html htm;',
    '        text/css css;',
    '        application/javascript js;',
    '        application/json json;',
    '        image/svg+xml svg;',
    '        image/png png;',
    '        image/jpeg jpg jpeg;',
    '        image/gif gif;',
    '        image/x-icon ico;',
    '        image/webp webp;',
    '        font/woff2 woff2;',
    '        font/woff woff;',
    '        text/plain txt;',
    '    }',
    '    access_log /var/log/nginx/access.log;',
    '    sendfile on;',
    '    tcp_nopush on;',
    '    keepalive_timeout 65;',
    '    server_tokens off;',
    '    client_max_body_size 100m;',
    '    client_body_temp_path /var/lib/nginx/body;',
    '    proxy_temp_path /var/lib/nginx/proxy;',
    '    fastcgi_temp_path /var/lib/nginx/fastcgi;',
    '    uwsgi_temp_path /var/lib/nginx/uwsgi;',
    '    scgi_temp_path /var/lib/nginx/scgi;',
    // Catch-all default server: drop (HTTP 444) requests to hostnames no site
    // claims, so the box never serves a random site for an unconfigured domain
    // (Forge\'s default-site protection). Real site vhosts use an explicit
    // server_name and take precedence.
    '    server {',
    '        listen 80 default_server;',
    '        listen [::]:80 default_server;',
    '        server_name _;',
    '        return 444;',
    '    }',
    '    include /etc/nginx/sites-enabled/*;',
    '}',
    'TS_CLOUD_NGINXCONF_EOF',
    // systemd unit running nginx via the wrapper on :80/:443.
    'cat > /etc/systemd/system/ts-cloud-nginx.service <<\'TS_CLOUD_NGINXUNIT_EOF\'',
    '[Unit]',
    'Description=ts-cloud nginx (pantry)',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStartPre=${NGINX_WRAPPER} -t`,
    `ExecStart=${NGINX_WRAPPER} -g 'daemon off;'`,
    `ExecReload=${NGINX_WRAPPER} -s reload`,
    'Restart=always',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'TS_CLOUD_NGINXUNIT_EOF',
    'systemctl daemon-reload',
    'systemctl enable ts-cloud-nginx',
    // Start now if there is at least one site; otherwise it starts on first deploy.
    'ls /etc/nginx/sites-enabled/* >/dev/null 2>&1 && systemctl restart ts-cloud-nginx || true',
  ]
}
