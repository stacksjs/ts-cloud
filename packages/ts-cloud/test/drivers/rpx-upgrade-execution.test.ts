import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRpxUpgradeScript } from '../../src/drivers/shared/rpx-gateway'

describe('gateway upgrade transaction', () => {
  for (const failure of ['none', 'compile', 'start']) {
    it(`preserves configuration and ${failure === 'none' ? 'installs the new runtime' : `restores the runtime after a ${failure} failure`}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'rpx-upgrade-'))
      try {
        const etc = join(root, 'etc')
        const install = join(root, 'install')
        const bin = join(root, 'bin')
        await Promise.all([mkdir(etc), mkdir(join(install, 'node_modules/@stacksjs/rpx'), { recursive: true }), mkdir(bin)])
        await writeFile(join(install, 'version'), 'old')
        await writeFile(join(etc, 'gateway'), 'old-binary', { mode: 0o755 })
        await writeFile(join(etc, 'gateway.ts'), 'original assembler')
        await writeFile(join(etc, 'service'), 'operator settings')
        const bun = join(bin, 'bun')
        await writeFile(bun, `#!/bin/bash
set -eu
if [ "$1" = add ]; then
  mkdir -p node_modules/@stacksjs/rpx
  echo -n new > version
else
  [ "$FAILURE" != compile ] || exit 17
  while [ "$1" != --outfile ]; do shift; done
  echo -n new-binary > "$2"
fi
`, { mode: 0o755 })
        await writeFile(join(bin, 'flock'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
        await writeFile(join(bin, 'systemctl'), `#!/bin/bash
if [ "$1" = restart ] && [ "$FAILURE" = start ] && [ ! -f "$TEST_ROOT/restarted" ]; then
  touch "$TEST_ROOT/restarted"
  exit 1
fi
`, { mode: 0o755 })
        const commands = buildRpxUpgradeScript({ version: '0.11.61', bunBin: bun }).join('\n')
          .replaceAll('/opt/rpx-gateway', install).replaceAll('/etc/rpx', etc)
        const child = Bun.spawn(['bash', '-c', commands], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAILURE: failure, TEST_ROOT: root }, stdout: 'pipe', stderr: 'pipe' })
        await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
        expect(await child.exited).toBe(failure === 'none' ? 0 : failure === 'compile' ? 17 : 1)
        expect(await readFile(join(install, 'version'), 'utf8')).toBe(failure === 'none' ? 'new' : 'old')
        expect(await readFile(join(etc, 'gateway'), 'utf8')).toBe(failure === 'none' ? 'new-binary' : 'old-binary')
        expect(await readFile(join(etc, 'gateway.ts'), 'utf8')).toBe('original assembler')
        expect(await readFile(join(etc, 'service'), 'utf8')).toBe('operator settings')
      }
      finally { await rm(root, { recursive: true, force: true }) }
    })
  }
})
