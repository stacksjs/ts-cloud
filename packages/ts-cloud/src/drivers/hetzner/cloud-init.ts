/**
 * Hetzner cloud-init: wraps the shared Ubuntu bootstrap as #cloud-config.
 *
 * The provisioning recipe itself lives in
 * {@link import('../shared/ubuntu-bootstrap')} (shared with the AWS path and
 * the golden-image bake). `generateUbuntuAppCloudInit` is kept as a back-compat
 * alias for the shared builder.
 */
export {
  buildUbuntuBootstrapScript as generateUbuntuAppCloudInit,
  type UbuntuBootstrapOptions,
} from '../shared/ubuntu-bootstrap'

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
export interface CloudInitUserDataExtras {
  /** Where the script is written on the box. @default '/var/lib/cloud/ts-cloud-bootstrap.sh' */
  scriptPath?: string
  /** File mode of the written script. @default '0755' */
  permissions?: string
  /**
   * Top-level cloud-config YAML emitted before `write_files:` (hostname,
   * users, packages, ...). Complete lines, already at top-level indentation.
   */
  before?: string
  /** Top-level cloud-config YAML emitted after `runcmd:`. */
  after?: string
}

function yamlBlock(value: string | undefined): string {
  if (!value) return ''
  return value.endsWith('\n') ? value : `${value}\n`
}

export function wrapCloudInitUserData(bootstrapScript: string, extras: CloudInitUserDataExtras = {}): string {
  const scriptPath = extras.scriptPath ?? '/var/lib/cloud/ts-cloud-bootstrap.sh'
  const permissions = extras.permissions ?? '0755'
  const indented = bootstrapScript
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n')

  return `#cloud-config
${yamlBlock(extras.before)}write_files:
  - path: ${scriptPath}
    permissions: '${permissions}'
    owner: root:root
    content: |
${indented}
runcmd:
  - [ bash, ${scriptPath} ]
${yamlBlock(extras.after)}`
}
