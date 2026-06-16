/**
 * Ubuntu cloud-init bootstrap for Hetzner compute targets.
 * Mirrors Compute.UserData.generateBunAppScript but uses apt instead of dnf
 * and omits AWS CLI (deploys use SCP + SSH).
 */

export interface UbuntuBootstrapOptions {
  runtime?: 'bun' | 'node' | 'deno' | 'php'
  runtimeVersion?: string
  systemPackages?: string[]
  database?: 'sqlite' | 'mysql' | 'postgres'
  /**
   * Shell commands that install PHP-FPM + nginx + Composer, built by
   * {@link import('../shared/php-provision').buildPhpProvisionScript}. Spliced
   * after the base packages so Laravel/PHP sites have their runtime ready
   * before any deploy. Used when `runtime === 'php'` (or `compute.php` is set).
   */
  phpProvision?: string[]
  /**
   * Shell commands that install on-box services (database engine, redis,
   * memcached, meilisearch) and create the app database + user, built by
   * {@link import('../shared/db-provision')}. Spliced after the PHP provision.
   */
  servicesProvision?: string[]
  caddyfile?: string
  /**
   * Shell commands that install + start the rpx reverse-proxy gateway, built by
   * {@link import('../shared/rpx-gateway').buildRpxProvisionScript}. Appended
   * after the runtime is installed so `bun add -g @stacksjs/rpx` works. Mutually
   * exclusive with `caddyfile` (the box runs one gateway).
   */
  rpxProvision?: string[]
}

export function generateUbuntuAppCloudInit(options: UbuntuBootstrapOptions = {}): string {
  const {
    runtime = 'bun',
    runtimeVersion = 'latest',
    systemPackages = [],
    database,
    phpProvision,
    servicesProvision,
    caddyfile,
    rpxProvision,
  } = options

  const packages = new Set(systemPackages)
  if (database === 'sqlite') packages.add('sqlite3')
  else if (database === 'mysql') packages.add('mysql-client')
  else if (database === 'postgres') packages.add('postgresql-client')

  let script = `#!/bin/bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y curl tar gzip unzip git ca-certificates
`

  if (packages.size > 0) {
    script += `
apt-get install -y ${[...packages].join(' ')}
`
  }

  // PHP/Laravel box: install nginx + php-fpm + Composer before the runtime
  // branch. A `php` runtime installs nothing in the bun/node/deno chain below.
  if (phpProvision && phpProvision.length > 0) {
    script += `
${phpProvision.join('\n')}
`
  }

  // On-box services (database engine, redis, memcached, meilisearch) + app
  // database/user creation. Runs after PHP so the engine client is available.
  if (servicesProvision && servicesProvision.length > 0) {
    script += `
${servicesProvision.join('\n')}
`
  }

  if (runtime === 'bun') {
    script += `
export BUN_INSTALL="/root/.bun"
curl -fsSL https://bun.sh/install | bash${runtimeVersion === 'latest' ? '' : ` -s "bun-v${runtimeVersion}"`}
ln -sf /root/.bun/bin/bun /usr/local/bin/bun
echo 'export BUN_INSTALL="/root/.bun"' > /etc/profile.d/bun.sh
echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> /etc/profile.d/bun.sh
`
  }
  else if (runtime === 'node') {
    const nodeMajor = (runtimeVersion === 'latest' || !runtimeVersion) ? '20' : runtimeVersion.split('.')[0]
    script += `
curl -fsSL https://deb.nodesource.com/setup_${nodeMajor}.x | bash -
apt-get install -y nodejs
ln -sf /usr/bin/node /usr/local/bin/node
ln -sf /usr/bin/npm /usr/local/bin/npm
`
  }
  else if (runtime === 'deno') {
    script += `
curl -fsSL https://deno.land/install.sh | sh
ln -sf /root/.deno/bin/deno /usr/local/bin/deno
`
  }

  script += `
mkdir -p /var/www /var/ts-cloud/staging /var/ts-cloud/releases
`

  if (caddyfile) {
    const escaped = caddyfile.replace(/\$/g, '\\$')
    script += `
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=\${ARCH}" -o /usr/local/bin/caddy
chmod +x /usr/local/bin/caddy

getent group caddy >/dev/null || groupadd --system caddy
getent passwd caddy >/dev/null || useradd --system --gid caddy \\
  --create-home --home-dir /var/lib/caddy \\
  --shell /usr/sbin/nologin --comment "Caddy web server" caddy

mkdir -p /etc/caddy /var/lib/caddy /var/log/caddy
chown -R caddy:caddy /var/lib/caddy /var/log/caddy

cat > /etc/systemd/system/caddy.service <<'CADDY_UNIT_EOF'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
CADDY_UNIT_EOF

cat > /etc/caddy/Caddyfile <<'CADDY_CONFIG_EOF'
${escaped}
CADDY_CONFIG_EOF

systemctl daemon-reload
systemctl enable caddy
systemctl start caddy
`
  }

  // rpx gateway: install + start the reverse proxy generated from the sites
  // model. Runs after the runtime install so `bun add -g @stacksjs/rpx` works.
  if (rpxProvision && rpxProvision.length > 0) {
    // The provision script carries its own `set -euo pipefail`; strip a leading
    // duplicate so the embedded block is clean.
    const body = rpxProvision[0] === 'set -euo pipefail'
      ? rpxProvision.slice(1)
      : rpxProvision
    script += `
${body.join('\n')}
`
  }

  script += `
echo "ts-cloud bootstrap complete — instance is ready for site deploys"
`

  return script
}

/**
 * Wrap a bash bootstrap script as Hetzner cloud-init user_data (#cloud-config).
 *
 * The script is written to disk via `write_files` and then executed through an
 * explicit `bash` invocation in `runcmd`. cloud-init runs bare `runcmd` entries
 * with `/bin/sh` (dash on Ubuntu), which chokes on bash-only syntax like
 * `set -o pipefail` and aborts the whole bootstrap — so embedding the script
 * inline under `runcmd:` silently breaks bun/caddy installation. Writing the
 * file (shebang preserved) and running `bash <file>` guarantees a bash shell.
 */
export function wrapCloudInitUserData(bootstrapScript: string): string {
  const scriptPath = '/var/lib/cloud/ts-cloud-bootstrap.sh'
  const indented = bootstrapScript
    .split('\n')
    .map(line => `      ${line}`)
    .join('\n')

  return `#cloud-config
write_files:
  - path: ${scriptPath}
    permissions: '0755'
    owner: root:root
    content: |
${indented}
runcmd:
  - [ bash, ${scriptPath} ]
`
}
