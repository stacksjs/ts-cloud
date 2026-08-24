/**
 * End-to-end check of the one part of `server:rename` that touches a machine.
 *
 * Three of the four records a rename updates are data — a provider API call, a
 * JSON state file, a row in the inventory — and unit tests cover them properly.
 * The fourth is shell run on the box, and it is the one with somewhere to go
 * wrong: `hostnamectl` is not always available, `/etc/hosts` may or may not
 * already carry a `127.0.1.1` line, and getting either wrong leaves a box whose
 * own name does not resolve — which surfaces later as `sudo` hanging, not as a
 * failed rename.
 *
 * Both paths are exercised: with systemd present (`hostnamectl`) and without it
 * (the `/etc/hostname` fallback the script falls back to).
 *
 * @see https://github.com/stacksjs/ts-cloud/issues/167
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSetHostnameScript } from '../../src/operations/server-rename'

const PLAIN = 'ts-cloud-rename-plain'
const IMAGE = 'ts-cloud-rename-box:22.04'
const NEW_NAME = 'hq-production-server'

async function available(command: string[]): Promise<boolean> {
  const result = await Bun.$`${command}`.quiet().nothrow()
  return result.exitCode === 0
}

const canRun = await available(['docker', 'info'])

async function exec(box: string, script: string): Promise<{ stdout: string, code: number }> {
  const child = Bun.spawn(['docker', 'exec', '-i', box, 'bash', '-s'], {
    stdin: new Blob([script]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { stdout: stdout + stderr, code }
}

async function run(box: string, script: string): Promise<string> {
  const result = await exec(box, script)
  if (result.code !== 0) throw new Error(`${box} exited ${result.code}:\n${result.stdout}`)
  return result.stdout
}

describe.skipIf(!canRun)('server:rename on a box (docker)', () => {
  let workspace: string

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ts-cloud-rename-e2e-'))
    const dockerfile = join(workspace, 'Dockerfile')
    await writeFile(
      dockerfile,
      ['FROM ubuntu:22.04', 'ENV DEBIAN_FRONTEND=noninteractive', 'RUN apt-get update && apt-get install -y hostname && apt-get clean'].join('\n'),
    )
    await Bun.$`docker build -q -f ${dockerfile} -t ${IMAGE} ${workspace}`.quiet()
    await Bun.$`docker rm -f ${PLAIN}`.quiet().nothrow()
    // No systemd, so `hostnamectl` is absent and the fallback has to carry it —
    // the path a minimal or containerised box actually takes.
    // CAP_SYS_ADMIN because setting a hostname needs it and containers drop it by
    // default — a real box's root has it, so without this the container would be
    // testing a restriction the target environment does not have.
    await Bun.$`docker run -d --name ${PLAIN} --hostname bughq --cap-add SYS_ADMIN ${IMAGE} sleep infinity`.quiet()
  }, 600_000)

  afterAll(async () => {
    await Bun.$`docker rm -f ${PLAIN}`.quiet().nothrow()
    await rm(workspace, { recursive: true, force: true })
  })

  it('starts from the old name', async () => {
    expect((await run(PLAIN, 'hostname')).trim()).toBe('bughq')
  })

  it('renames the box when hostnamectl is unavailable', async () => {
    const out = await run(PLAIN, buildSetHostnameScript(NEW_NAME))
    expect(out).toContain(`bughq -> ${NEW_NAME}`)
    expect((await run(PLAIN, 'hostname')).trim()).toBe(NEW_NAME)
    expect((await run(PLAIN, 'cat /etc/hostname')).trim()).toBe(NEW_NAME)
  })

  /**
   * Two `127.0.1.1` lines would leave the box resolving its own name two ways,
   * which is the failure mode this replaces-in-place rather than appends for.
   */
  it('leaves exactly one 127.0.1.1 entry, pointing at the new name', async () => {
    const hosts = await run(PLAIN, 'cat /etc/hosts')
    const lines = hosts.split('\n').filter(line => line.trim().startsWith('127.0.1.1'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(NEW_NAME)
    expect(lines[0]).not.toContain('bughq')
  })

  it('resolves its own new name', async () => {
    expect((await exec(PLAIN, `getent hosts ${NEW_NAME}`)).code).toBe(0)
  })

  /** Re-running a finished rename is what a resumed operation does. */
  it('is idempotent, and still leaves one entry', async () => {
    await run(PLAIN, buildSetHostnameScript(NEW_NAME))
    expect((await run(PLAIN, 'hostname')).trim()).toBe(NEW_NAME)
    const lines = (await run(PLAIN, 'cat /etc/hosts')).split('\n').filter(l => l.trim().startsWith('127.0.1.1'))
    expect(lines).toHaveLength(1)
  })

  it('adds the entry on a box that had none', async () => {
    // In place, for the same reason the product script is: /etc/hosts is a bind
    // mount in a container and cannot be renamed over.
    await run(PLAIN, 'TS_CLOUD_H="$(grep -v "^127.0.1.1" /etc/hosts)"; printf \'%s\\n\' "$TS_CLOUD_H" > /etc/hosts')
    expect((await run(PLAIN, 'cat /etc/hosts')).split('\n').filter(l => l.trim().startsWith('127.0.1.1'))).toHaveLength(0)

    await run(PLAIN, buildSetHostnameScript('hq-second-name'))
    const lines = (await run(PLAIN, 'cat /etc/hosts')).split('\n').filter(l => l.trim().startsWith('127.0.1.1'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('hq-second-name')
  })
})
