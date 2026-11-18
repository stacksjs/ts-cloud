import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSwapScript } from '../../src/drivers/shared/swap'

test('adds only the missing capacity, preserves active files and symlinks, and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloud-swap-'))
  try {
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(root, 'swapfile'), 'active swap contents')
    await writeFile(join(root, 'unrelated'), 'preserve me')
    await symlink(join(root, 'unrelated'), join(root, 'swapfile-ts-cloud-1'))
    await writeFile(join(root, 'active'), 'Filename Type Size Used Priority\n/existing file 8388608 8388608 -2\n')
    await writeFile(join(root, 'fstab'), '# existing entries\n')
    const commands: Record<string, string> = {
      flock: 'exit 0',
      swapon: 'size=$(cat "$SWAP_TEST_ROOT/size"); printf "%s file %s 0 -3\\n" "$1" "$((size / 1024))" >> "$SWAP_TEST_ROOT/active"',
      fallocate: 'size=${2%M}; echo $((size * 1048576)) > "$SWAP_TEST_ROOT/size"',
      mkswap: 'printf "%s\\n" "$1" >> "$SWAP_TEST_ROOT/formatted"',
    }
    for (const [name, body] of Object.entries(commands)) {
      const path = join(bin, name)
      await writeFile(path, `#!/bin/bash\nset -eu\n${body}\n`)
      await chmod(path, 0o755)
    }
    const script = ['set -euo pipefail', ...buildSwapScript(12)].join('\n')
      .replaceAll('/swapfile', `${root}/swapfile`)
      .replaceAll('/etc/fstab', `${root}/fstab`)
      .replaceAll('/proc/swaps', `${root}/active`)
      .replaceAll('/run/lock/ts-cloud-swap.lock', `${root}/swap.lock`)
    const run = async () => {
      const child = Bun.spawn(['/bin/bash', '-c', script], {
        env: { PATH: `${bin}:/usr/bin:/bin`, SWAP_TEST_ROOT: root }, stdout: 'pipe', stderr: 'pipe',
      })
      const error = await new Response(child.stderr).text()
      expect(await child.exited, error).toBe(0)
    }
    await run()
    await run()
    expect(await readFile(join(root, 'swapfile'), 'utf8')).toBe('active swap contents')
    expect(await readFile(join(root, 'unrelated'), 'utf8')).toBe('preserve me')
    expect(await readFile(join(root, 'size'), 'utf8')).toBe('4294967296\n')
    expect(await readFile(join(root, 'formatted'), 'utf8')).toBe(`${root}/swapfile-ts-cloud-2\n`)
    expect(await readFile(join(root, 'fstab'), 'utf8')).toBe(`# existing entries\n${root}/swapfile-ts-cloud-2 none swap sw 0 0\n`)
    expect((await stat(join(root, 'swapfile-ts-cloud-2'))).mode & 0o777).toBe(0o600)
    expect(script).not.toContain('swapoff')
    expect(script).toContain('flock -x 9')
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('disabling swap makes no changes and invalid capacities fail before execution', () => {
  expect(buildSwapScript(0)).toEqual([])
  for (const capacity of [NaN, Infinity, -1])
    expect(() => buildSwapScript(capacity)).toThrow('finite, nonnegative')
})
