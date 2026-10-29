import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildAccessibleBunScript } from '../../src/drivers/shared/runtime-isolation'

test.skipIf(process.platform === 'win32')('adopts a host Bun outside protected homes atomically and idempotently', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ts-cloud-host-bun-')))
  try {
    const source = join(directory, 'root/.bun/bin/bun')
    const binary = join(directory, 'usr/local/bin/bun')
    const target = join(directory, 'opt/ts-cloud/bun/bin/bun')
    await mkdir(dirname(source), { recursive: true })
    await mkdir(dirname(binary), { recursive: true })
    await writeFile(source, '#!/bin/sh\nprintf pinned-runtime\n')
    await chmod(source, 0o700)
    await symlink(source, binary)
    const script = buildAccessibleBunScript().join('\n').replaceAll('/usr/local/bin/bun', binary).replaceAll('/opt/ts-cloud', join(directory, 'opt/ts-cloud')).replaceAll('/root/*|/home/*', `${directory}/root/*|${directory}/home/*`)
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = Bun.spawn(['/bin/sh', '-ec', script], { stdout: 'pipe', stderr: 'pipe' })
      expect(await child.exited).toBe(0)
      expect(await new Response(child.stderr).text()).toBe('')
      expect(await realpath(binary)).toBe(target)
      expect(await readFile(target, 'utf8')).toBe(await readFile(source, 'utf8'))
      expect((await stat(target)).mode & 0o777).toBe(0o755)
      expect((await stat(source)).mode & 0o777).toBe(0o700)
      const probe = Bun.spawn([binary], { stdout: 'pipe', stderr: 'pipe' })
      expect(await probe.exited).toBe(0)
      expect(await new Response(probe.stdout).text()).toBe('pinned-runtime')
    }
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})
