/** Reconcile minimum swap capacity without taking active swap offline. */
export function buildSwapScript(sizeGb: number): string[] {
  if (!Number.isFinite(sizeGb) || sizeGb < 0)
    throw new Error('Swap capacity must be a finite, nonnegative number')
  const target = Math.floor(sizeGb) * 1024 ** 3
  if (target === 0) return []
  return [
    '(',
    'flock -x 9',
    `swap_target=${target}`,
    'swap_total=$(awk \'NR > 1 { total += $3 * 1024 } END { printf "%.0f", total }\' /proc/swaps)',
    'if [ "$swap_total" -lt "$swap_target" ]; then',
    '  swap_missing=$(( (swap_target - swap_total + 1048575) / 1048576 ))',
    '  swap_path=/swapfile',
    '  swap_index=0',
    '  while [ -e "$swap_path" ] || [ -L "$swap_path" ]; do',
    '    swap_index=$((swap_index + 1))',
    '    swap_path="/swapfile-ts-cloud-$swap_index"',
    '  done',
    '  (umask 077; set -C; : > "$swap_path")',
    '  fallocate -l "${swap_missing}M" "$swap_path" || dd if=/dev/zero of="$swap_path" bs=1M count="$swap_missing" status=none',
    '  chmod 600 "$swap_path"',
    '  mkswap "$swap_path" >/dev/null',
    '  swapon "$swap_path"',
    '  printf "%s none swap sw 0 0\\n" "$swap_path" >> /etc/fstab',
    'fi',
    ') 9>/run/lock/ts-cloud-swap.lock',
  ]
}
