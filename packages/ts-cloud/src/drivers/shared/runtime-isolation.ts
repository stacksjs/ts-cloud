import { createHash } from 'node:crypto'

/** Preserve ProtectHome when adopting a host whose Bun was installed under root. */
export function buildAccessibleBunScript(): string[] {
  return [
    'if [ -x /usr/local/bin/bun ]; then',
    '  TS_CLOUD_HOST_BUN="$(readlink -f /usr/local/bin/bun)"',
    '  case "$TS_CLOUD_HOST_BUN" in /root/*|/home/*)',
    '    install -d -m 755 /opt/ts-cloud /opt/ts-cloud/bun /opt/ts-cloud/bun/bin',
    '    TS_CLOUD_BUN_STAGE="$(mktemp /opt/ts-cloud/bun/bin/.bun.XXXXXX)"',
    '    install -m 755 "$TS_CLOUD_HOST_BUN" "$TS_CLOUD_BUN_STAGE"',
    '    mv -f "$TS_CLOUD_BUN_STAGE" /opt/ts-cloud/bun/bin/bun',
    '    ln -sfn /opt/ts-cloud/bun/bin/bun /usr/local/bin/bun',
    '  ;; esac',
    'fi',
  ]
}

/** One unprivileged identity per project; its web/API/workers may share that project's data. */
export function runtimeIsolationUser(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('Runtime isolation requires a safe project slug')
  const suffix = slug.length <= 24 ? slug : `${slug.slice(0, 15)}-${createHash('sha256').update(slug).digest('hex').slice(0, 8)}`
  return `tsc-${suffix}`
}

export function runtimeIsolationDirectives(user: string, base: string, slug: string): string[] {
  return [`User=${user}`, `Group=${user}`, 'NoNewPrivileges=true', 'PrivateTmp=true', 'ProtectHome=true', 'ProtectProc=invisible', 'InaccessiblePaths=-/run/postgresql -/var/run/postgresql', 'TemporaryFileSystem=/var/www:ro', `BindPaths=${base} -/var/www/${slug}-shared`, 'UMask=0077', `Environment=HOME=/var/lib/ts-cloud/${user}`]
}

/** Only take ownership of this project's release and explicitly shared project data. */
export function runtimeIsolationSetup(slug: string, base: string, targets: readonly string[]): string[] {
  const user = runtimeIsolationUser(slug)
  if (!base.startsWith(`/var/www/${slug}-`) || base.slice('/var/www/'.length).includes('/'))
    throw new Error('Runtime isolation requires a project-namespaced application directory')
  const home = `/var/lib/ts-cloud/${user}`
  const shared = `/var/www/${slug}-shared`
  const paths = [...new Set([base, ...targets])]
  for (const path of paths) {
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').includes('..')
      || !(path === base || path.startsWith(`${base}/`) || path === shared || path.startsWith(`${shared}/`)))
      throw new Error(`Runtime isolation cannot take ownership outside project ${slug}`)
  }
  return [
    ...buildAccessibleBunScript(),
    `if ! id -u ${user} >/dev/null 2>&1; then useradd --system --user-group --create-home --home-dir ${home} --shell /usr/sbin/nologin ${user}; fi`,
    `[ "$(id -u ${user})" != 0 ] && [ "$(getent passwd ${user} | cut -d: -f6)" = ${home} ] || { echo 'Unexpected runtime isolation identity' >&2; exit 1; }`,
    `install -d -m 700 -o ${user} -g ${user} ${home}`,
    ...paths.map(path => `chown -hR ${user}:${user} ${path}`),
    `chmod 750 ${base}`,
  ]
}
