import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const cli = join(import.meta.dir, '../cli.ts')

describe('runtime CLI dry-run safety', () => {
  for (const args of [
    ['runtime:action', 'systemd:fixture:worker.service', 'stop', '--confirm', 'worker'],
    ['runtime:exec', 'systemd:fixture:worker.service', '--preset', 'process', '--confirm', 'worker'],
    ['runtime:download', 'systemd:fixture:worker.service', '/owned/file', 'download', '--confirm', 'worker'],
    ['runtime:upload', 'systemd:fixture:worker.service', 'upload', '/owned/file', '--confirm', 'worker'],
  ]) {
    for (const dryRun of [true, false]) {
      it(`${args[0]} ${dryRun ? 'rejects dry-run before configuration and state access' : 'loads configuration for ordinary execution'}`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'ts-cloud-runtime-dry-run-'))
        let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          const marker = join(root, 'config-evaluated')
          await mkdir(join(root, 'config'))
          await mkdir(join(root, 'home'))
          await writeFile(join(root, 'config/cloud.ts'), `await Bun.write(${JSON.stringify(marker)}, 'evaluated'); throw new Error('Runtime dry-run evaluated configuration'); export default {};`)
          const flags = dryRun ? [...args, '--dry-run'] : args
          child = Bun.spawn([process.execPath, '--no-env-file', cli, ...flags], {
            cwd: root,
            env: { HOME: join(root, 'home'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          })
          timeout = setTimeout(() => child?.kill(), 5_000)
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
          ])
          expect(code).toBe(1)
          expect(stdout + stderr).toContain(dryRun
            ? 'Runtime commands do not support --dry-run; no command was executed.'
            : 'Runtime dry-run evaluated configuration')
          expect(await Bun.file(marker).exists()).toBe(!dryRun)
          expect((await readdir(root)).sort()).toEqual(dryRun ? ['config', 'home'] : ['config', 'config-evaluated', 'home'])
        }
        finally {
          clearTimeout(timeout)
          if (child?.exitCode === null) child.kill()
          if (child) await child.exited
          await rm(root, { recursive: true, force: true })
        }
      }, 20_000)
    }
  }
})
