/**
 * Rename a server in place.
 *
 * Renaming is purely an identity change, and today it implies destroy-and-
 * recreate — which is not an acceptable cost for a naming-convention fix. It is
 * the smallest of the consolidation operations and the one with no data to move:
 * four records that all spell the same name, kept in step.
 *
 * The four, and why each matters:
 *
 * 1. **The provider record.** What the console shows and what a human greps for.
 * 2. **The local driver state pin** (`storage/cloud/state/<stack>.json`). This
 *    one is not cosmetic. `findComputeTargets` REJECTS a pinned server whose
 *    live name no longer matches the recorded one — a deliberate guard against
 *    a stale pin sending a database operation to another project's box — so a
 *    provider-side rename that does not update the pin quietly invalidates it.
 * 3. **The box's hostname.** What shells, logs, and the box's own reports say.
 * 4. **The fleet inventory record.** What every `server:*` command addresses.
 *
 * Ordering is chosen for the failure in between: the provider is renamed BEFORE
 * the pin is rewritten, so a crash between them leaves the pin stale (deploys
 * fall back to label matching and keep working) rather than pointing at a name
 * that does not exist yet. Every step re-derives its own state, so the fix for a
 * half-finished rename is to run it again.
 *
 * Nothing here is destructive: a rename is undone by renaming back, and putting
 * typed-confirmation ceremony on a reversible operation only teaches people to
 * type confirmations without reading them.
 *
 * @see https://github.com/stacksjs/ts-cloud/issues/167
 */
import type { OperationPlan, OperationStep } from './plan'

/**
 * The side effects a rename needs, injected so the operation is testable without
 * a provider, an SSH host, or a control-plane database — and so a second driver
 * can supply its own without this module knowing about it.
 *
 * The optional members are genuinely optional: a server enrolled by hand has no
 * provider record to rename, a project deploying purely from labels has no state
 * pin, and a box whose host key is not pinned cannot be reached to set a
 * hostname. Each missing capability drops its step from the plan rather than
 * failing the operation, and the plan says which ones it left out.
 */
export interface ServerRenameEffects {
  /** Every name already taken — provider project and inventory both. */
  takenNames: () => Promise<string[]>
  /** Live provider-side name. */
  providerName?: () => Promise<string | undefined>
  renameProvider?: (next: string) => Promise<void>
  /** Name recorded in the local driver state pin. */
  stateName?: () => Promise<string | undefined>
  writeStateName?: (next: string) => Promise<void>
  /** Hostname reported by the box itself. */
  remoteHostname?: () => Promise<string | undefined>
  setRemoteHostname?: (next: string) => Promise<void>
  /** Name on the fleet inventory record. */
  inventoryName: () => string
  renameInventory: (next: string) => Promise<void> | void
}

/**
 * A server name has to be a valid hostname, because it becomes one: providers
 * reject anything else, and the box's own `hostname` is set from it.
 *
 * RFC 1123 labels — letters, digits and hyphens, not starting or ending with a
 * hyphen, at most 63 characters each — joined by dots. Checked up front so a
 * rename fails before it has touched anything, rather than halfway through with
 * the provider renamed and the box not.
 */
export function validateServerName(name: string): void {
  if (name.length === 0) throw new Error('A server name cannot be empty.')
  if (name.length > 253) throw new Error(`'${name}' is longer than the 253 characters a hostname allows.`)
  for (const label of name.split('.')) {
    if (label.length === 0) throw new Error(`'${name}' has an empty label — a hostname cannot contain '..'.`)
    if (label.length > 63) throw new Error(`'${label}' is longer than the 63 characters a hostname label allows.`)
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
      throw new Error(
        `'${label}' is not a valid hostname label. Use letters, digits and hyphens, not starting or ending with a hyphen.`,
      )
  }
}

/**
 * Build the plan that renames `current` to `next`.
 *
 * Async because the preconditions — a legal name, and one nobody else holds —
 * are checked here rather than becoming steps. A precondition is not a unit of
 * work; making it one would let a plan print as if it were runnable and then
 * fail on its first step.
 */
export async function planServerRename(
  current: string,
  next: string,
  effects: ServerRenameEffects,
): Promise<OperationPlan> {
  validateServerName(next)

  if (current === next) throw new Error(`'${current}' is already named that.`)

  const taken = await effects.takenNames()
  if (taken.some(name => name === next && name !== current))
    throw new Error(`'${next}' is already taken. Server names have to be unique within a provider project.`)

  const steps: OperationStep[] = []

  // 1. The provider record first: a crash after this leaves the state pin stale,
  //    which degrades to label matching, rather than pinned to a name that does
  //    not exist yet.
  if (effects.providerName && effects.renameProvider) {
    const { providerName, renameProvider } = effects
    steps.push({
      id: 'provider',
      title: 'Rename the server at the provider',
      change: { from: current, to: next },
      satisfied: async () => (await providerName()) === next,
      apply: () => renameProvider(next),
    })
  }

  // 2. The state pin, immediately after — see the note above findComputeTargets.
  if (effects.stateName && effects.writeStateName) {
    const { stateName, writeStateName } = effects
    steps.push({
      id: 'state-pin',
      title: 'Update the recorded name in the local driver state',
      change: { from: current, to: next },
      // A project with no pin at all has nothing to update; treat it as done
      // rather than writing a pin the deploy never asked for.
      satisfied: async () => {
        const recorded = await stateName()
        return recorded === undefined || recorded === next
      },
      apply: () => writeStateName(next),
    })
  }

  // 3. The box's own hostname. Last of the remote changes because it is the only
  //    cosmetic one — a box whose hostname lags is confusing, not broken.
  if (effects.remoteHostname && effects.setRemoteHostname) {
    const { remoteHostname, setRemoteHostname } = effects
    steps.push({
      id: 'hostname',
      title: 'Set the hostname on the box',
      change: { from: current, to: next },
      satisfied: async () => (await remoteHostname()) === next,
      apply: () => setRemoteHostname(next),
    })
  }

  // 4. The inventory record last: it is what every `server:*` command addresses,
  //    so renaming it first would leave the operator addressing a server whose
  //    other three records still answer to the old name.
  steps.push({
    id: 'inventory',
    title: 'Rename the fleet inventory record',
    change: { from: current, to: next },
    satisfied: async () => effects.inventoryName() === next,
    apply: async () => {
      await effects.renameInventory(next)
    },
  })

  return { operation: 'server:rename', target: current, steps }
}

/**
 * Shell that sets the box's hostname persistently and keeps `/etc/hosts` in
 * step, so `sudo` and anything else resolving the local name does not stall on a
 * hostname with no entry.
 */
export function buildSetHostnameScript(next: string): string {
  const quoted = `'${next.replace(/'/g, `'"'"'`)}'`
  return [
    'set -eu',
    `TS_CLOUD_OLD="$(hostname)"`,
    `hostnamectl set-hostname ${quoted} 2>/dev/null || { echo ${quoted} > /etc/hostname && hostname ${quoted}; }`,
    // Replace the old name where it stands rather than appending: a second
    // 127.0.1.1 line would leave the box resolving its own name two ways.
    `if grep -q "127.0.1.1" /etc/hosts; then`,
    `  sed -i "s/^127\\.0\\.1\\.1.*/127.0.1.1\\t${next}/" /etc/hosts`,
    'else',
    `  printf '127.0.1.1\\t%s\\n' ${quoted} >> /etc/hosts`,
    'fi',
    'printf "%s -> %s\\n" "$TS_CLOUD_OLD" "$(hostname)"',
  ].join('\n')
}
