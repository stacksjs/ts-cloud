/**
 * Declaratively manage operator SSH keys in the box's `authorized_keys`.
 *
 * Keys are written inside a ts-cloud-managed block (delimited by marker
 * comments) so the set can be reconciled on every provision/deploy without
 * disturbing keys added out-of-band: the whole block is rewritten from the
 * config each time. Adding an SSH key is therefore "add an entry + redeploy".
 */
import type { SshKeyConfig } from '@ts-cloud/core'

const BLOCK_BEGIN = '# >>> ts-cloud managed keys >>>'
const BLOCK_END = '# <<< ts-cloud managed keys <<<'

/** Default authorized_keys path (root deploy user). */
export const DEFAULT_AUTHORIZED_KEYS = '/root/.ssh/authorized_keys'

export interface AuthorizedKeysOptions {
  /** authorized_keys file to manage. @default '/root/.ssh/authorized_keys' */
  path?: string
}

/**
 * Build the commands that reconcile the managed key block in authorized_keys.
 * Strips any previous ts-cloud block, then appends the current set. Returns `[]`
 * when there are no keys to manage.
 */
export function buildAuthorizedKeysScript(keys: SshKeyConfig[] = [], options: AuthorizedKeysOptions = {}): string[] {
  if (keys.length === 0)
    return []
  const path = options.path ?? DEFAULT_AUTHORIZED_KEYS
  const dir = path.replace(/\/[^/]*$/, '')

  const block = [
    BLOCK_BEGIN,
    ...keys.map(k => `${k.publicKey.trim()} ${k.name}`),
    BLOCK_END,
  ].join('\n')

  return [
    `mkdir -p ${dir}`,
    `touch ${path}`,
    // Remove a prior managed block (sed range delete), keeping other keys.
    `sed -i '/^${escapeSed(BLOCK_BEGIN)}$/,/^${escapeSed(BLOCK_END)}$/d' ${path}`,
    `cat >> ${path} <<'TS_CLOUD_KEYS_EOF'`,
    block,
    'TS_CLOUD_KEYS_EOF',
    `chmod 600 ${path}`,
  ]
}

/** Escape a literal string for use in a sed `/.../` address. */
function escapeSed(value: string): string {
  return value.replace(/[.*[\]\\/^$]/g, '\\$&')
}
