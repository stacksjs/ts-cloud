/**
 * The canonical Ubuntu provisioning recipe for a ts-cloud compute box.
 *
 * This single bash builder is used in three places so there is exactly one
 * source of truth (and zero per-provider divergence):
 *  - **cold boot** — Hetzner cloud-init / AWS EC2 UserData run it on first boot.
 *  - **image bake** — the golden-image pipeline runs it to pre-install the
 *    stack, then snapshots the box into a Hetzner snapshot / AWS AMI.
 *  - **baked boot** — when a box boots from a pre-provisioned image, pass
 *    `baked: true` to skip the install-heavy steps (apt/runtime/php/services)
 *    that are already in the image, keeping only cheap per-boot setup.
 *
 * Targets Ubuntu (apt) — Forge's platform — on every provider, so the apt
 * provisioning, nginx vhosts, php-fpm sockets, and deploy scripts are identical
 * for Hetzner and AWS.
 */

export interface UbuntuBootstrapOptions {
  runtime?: 'bun' | 'node' | 'deno' | 'php'
  runtimeVersion?: string
  systemPackages?: string[]
  database?: 'sqlite' | 'mysql' | 'postgres'
  /**
   * Shell commands that install PHP-FPM + nginx + Composer, built by
   * {@link import('./php-provision').buildPhpProvisionScript}. Spliced
   * after the base packages so Laravel/PHP sites have their runtime ready
   * before any deploy. Used when `runtime === 'php'` (or `compute.php` is set).
   */
  phpProvision?: string[]
  /**
   * Shell commands that install on-box services (database engine, redis,
   * memcached, meilisearch) and create the app database + user, built by
   * {@link import('./db-provision')}. Spliced after the PHP provision.
   */
  servicesProvision?: string[]
  caddyfile?: string
  /**
   * Shell commands that install + start the rpx reverse-proxy gateway, built by
   * {@link import('./rpx-gateway').buildRpxProvisionScript}. Appended
   * after the runtime is installed so `bun add -g @stacksjs/rpx` works. Mutually
   * exclusive with `caddyfile` (the box runs one gateway).
   */
  rpxProvision?: string[]
  /**
   * The box boots from a pre-provisioned (golden) image that already has the
   * runtime + PHP + services + base packages installed. Skip those install
   * steps — only do the cheap per-boot setup (dirs, gateway config). Makes
   * boot near-instant. @default false
   */
  baked?: boolean
}

/**
 * Build the Ubuntu provisioning bash script (with `#!/bin/bash` shebang).
 */
export function buildUbuntuBootstrapScript(options: UbuntuBootstrapOptions = {}): string {
  const {
    runtime = 'bun',
    runtimeVersion = 'latest',
    systemPackages = [],
    database,
    phpProvision,
    servicesProvision,
    caddyfile,
    rpxProvision,
    baked = false,
  } = options

  const packages = new Set(systemPackages)
  if (database === 'sqlite') packages.add('sqlite3')
  else if (database === 'mysql') packages.add('mysql-client')
  else if (database === 'postgres') packages.add('postgresql-client')

  let script = `#!/bin/bash
set -euo pipefail
`

  // Install-heavy steps — skipped on a baked image (already provisioned).
  if (!baked) {
    script += `
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
  }

  // Cheap per-boot setup — runs on cold and baked boots alike.
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
