/**
 * Hetzner cloud-init: wraps the shared Ubuntu bootstrap as #cloud-config.
 *
 * The provisioning recipe itself lives in
 * {@link import('../shared/ubuntu-bootstrap')} (shared with the AWS path and
 * the golden-image bake). `generateUbuntuAppCloudInit` is kept as a back-compat
 * alias for the shared builder.
 */
import { gzipSync } from 'node:zlib'

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

/**
 * The most user_data a server may be created with. Hetzner refuses more with
 * `422 invalid input in field 'user_data'`, which names neither the limit nor
 * the size, and EC2 has the same 32 KiB ceiling in its own words.
 */
export const CLOUD_INIT_USER_DATA_LIMIT = 32 * 1024

export function wrapCloudInitUserData(bootstrapScript: string, extras: CloudInitUserDataExtras = {}): string {
  const scriptPath = extras.scriptPath ?? '/var/lib/cloud/ts-cloud-bootstrap.sh'
  const permissions = extras.permissions ?? '0755'
  const wrap = (content: string, encoding?: string): string => `#cloud-config
${yamlBlock(extras.before)}write_files:
  - path: ${scriptPath}
    permissions: '${permissions}'
    owner: root:root
${encoding ? `    encoding: ${encoding}\n` : ''}    content: |
${content.split('\n').map(line => `      ${line}`).join('\n')}
runcmd:
  - [ bash, ${scriptPath} ]
${yamlBlock(extras.after)}`

  const plain = wrap(bootstrapScript)
  if (Buffer.byteLength(plain) <= CLOUD_INIT_USER_DATA_LIMIT) return plain

  // A box that gets its gateway, database and search at first boot carries a
  // script past the limit: an app with rpx, Postgres and Typesense was 42 KB.
  // cloud-init unpacks `gz+b64` content itself, and a shell script packs to
  // well under half, so the same script is sent, only smaller. Lines of 76
  // keep the YAML block scalar readable in the provider's console.
  const packed = gzipSync(bootstrapScript).toString('base64').replace(/(.{76})/g, '$1\n').trimEnd()
  const compressed = wrap(packed, 'gz+b64')
  const size = Buffer.byteLength(compressed)
  if (size > CLOUD_INIT_USER_DATA_LIMIT) {
    throw new Error(
      `The first-boot script is ${Buffer.byteLength(plain)} bytes, ${size} compressed, and a server can be created with at most ${CLOUD_INIT_USER_DATA_LIMIT}. `
      + 'Provision fewer services at first boot, or bake them into an image (compute.bakedImage).',
    )
  }
  return compressed
}
