/**
 * End-to-end check of the box SFTP path against a real Linux machine.
 *
 * Runs the provisioning script the Hetzner/box drivers generate inside a
 * systemd container, then drives the resulting server with the system's own
 * OpenSSH client — the same shape as a live box, short of the provider API.
 *
 * Skipped when Docker or the sftp client is unavailable, so a machine without
 * them reports a skip instead of a false pass.
 */

import type { CloudConfig } from '@ts-cloud/core'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildComputeProvisionScripts } from '../../src/drivers/shared/compute-provision'

const CONTAINER = 'ts-cloud-sftp-e2e'
const HOST_PORT = 22236
const SLUG = 'sftpbox'

async function available(command: string[]): Promise<boolean> {
  const result = await Bun.$`${command}`.quiet().nothrow()
  return result.exitCode === 0
}

const canRun = (await available(['docker', 'info'])) && (await available(['which', 'sftp']))

function boxConfig(publicKey: string): CloudConfig {
  return {
    project: { name: 'Sftp Box', slug: SLUG, region: 'nbg1' },
    environments: { production: { type: 'production' } },
    cloud: { provider: 'hetzner' },
    infrastructure: {
      compute: { size: 'small' },
      sftp: {
        storage: { type: 'efs' },
        port: 2222,
        users: { deploy: { sshPublicKeys: [publicKey], homeDirectory: 'incoming/deploy' } },
      },
    },
  }
}

/** The ts-sftp block of the generated provisioning script. */
function sftpProvisionScript(config: CloudConfig): string {
  const all = (buildComputeProvisionScripts(config).servicesProvision ?? []).join('\n')
  const start = all.indexOf('# --- ts-sftp')
  expect(start).toBeGreaterThanOrEqual(0)
  const restart = all.indexOf('systemctl restart', start)
  return all.slice(start, all.indexOf('\n', restart))
}

describe.skipIf(!canRun)('sftp on a box (docker)', () => {
  let workspace: string
  let keyPath: string

  /** Run a batch of sftp commands against the container. */
  async function sftp(commands: string[]): Promise<{ output: string; exitCode: number }> {
    const batch = join(workspace, `batch-${commands.length}-${Math.random().toString(36).slice(2)}.txt`)
    await writeFile(batch, `${commands.join('\n')}\n`)

    const result = await Bun.$`sftp -b ${batch} -P ${HOST_PORT} -i ${keyPath} \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
      -o IdentitiesOnly=yes -o PreferredAuthentications=publickey deploy@127.0.0.1`
      .cwd(workspace)
      .quiet()
      .nothrow()

    return { output: result.stdout.toString() + result.stderr.toString(), exitCode: result.exitCode }
  }

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ts-cloud-sftp-e2e-'))
    keyPath = join(workspace, 'client_key')
    await Bun.$`ssh-keygen -t ed25519 -f ${keyPath} -N ${''} -q`.quiet()
    const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim()

    const dockerfile = join(workspace, 'Dockerfile')
    await writeFile(
      dockerfile,
      [
        'FROM ubuntu:22.04',
        'ENV DEBIAN_FRONTEND=noninteractive container=docker',
        'RUN apt-get update && apt-get install -y systemd systemd-sysv curl unzip ca-certificates \\',
        ' && apt-get clean && rm -rf /var/lib/apt/lists/* \\',
        ' && rm -f /lib/systemd/system/multi-user.target.wants/* /etc/systemd/system/*.wants/* \\',
        '          /lib/systemd/system/local-fs.target.wants/* /lib/systemd/system/sockets.target.wants/*udev*',
        'STOPSIGNAL SIGRTMIN+3',
        'CMD ["/lib/systemd/systemd"]',
      ].join('\n'),
    )

    await Bun.$`docker build -q -f ${dockerfile} -t ts-cloud-sftp-box:22.04 ${workspace}`.quiet()
    await Bun.$`docker rm -f ${CONTAINER}`.quiet().nothrow()
    await Bun.$`docker run -d --name ${CONTAINER} --privileged --cgroupns=host \
      -v /sys/fs/cgroup:/sys/fs/cgroup:rw -p ${HOST_PORT}:2222 ts-cloud-sftp-box:22.04`.quiet()

    // Wait for systemd to finish booting inside the container.
    for (let attempt = 0; attempt < 30; attempt++) {
      const state = await Bun.$`docker exec ${CONTAINER} systemctl is-system-running`.quiet().nothrow()
      if (state.stdout.toString().trim() === 'running') break
      await Bun.sleep(1000)
    }

    const script = join(workspace, 'provision.sh')
    await writeFile(script, `${sftpProvisionScript(boxConfig(publicKey))}\n`)
    await Bun.$`docker cp ${script} ${`${CONTAINER}:/root/provision.sh`}`.quiet()

    const provision = await Bun.$`docker exec ${CONTAINER} bash -e /root/provision.sh`.quiet().nothrow()
    expect(provision.exitCode).toBe(0)
    await Bun.sleep(2000)
  }, 600_000)

  afterAll(async () => {
    await Bun.$`docker rm -f ${CONTAINER}`.quiet().nothrow()
    await rm(workspace, { recursive: true, force: true })
  })

  it('leaves the systemd unit active', async () => {
    const state = await Bun.$`docker exec ${CONTAINER} systemctl is-active ${`${SLUG}-sftp.service`}`.quiet().nothrow()
    expect(state.stdout.toString().trim()).toBe('active')
  })

  it('runs the server as its own unprivileged account', async () => {
    // A unit that cannot execute its interpreter fails with status=203/EXEC,
    // which is what happens when bun is left under /root.
    const unit = await Bun.$`docker exec ${CONTAINER} cat ${`/etc/systemd/system/${SLUG}-sftp.service`}`.quiet()
    expect(unit.stdout.toString()).toContain('User=ts-sftp')
    expect(unit.stdout.toString()).not.toContain('ExecStart=/root/')

    const owner = await Bun.$`docker exec ${CONTAINER} stat -c %U ${`/var/sftp/${SLUG}`}`.quiet()
    expect(owner.stdout.toString().trim()).toBe('ts-sftp')
  })

  it('accepts the configured user and serves their home directory', async () => {
    const result = await sftp(['pwd', 'ls'])
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('Remote working directory: /')
    expect(result.output).toContain('incoming')
  })

  it('round-trips a file through the box', async () => {
    const payload = new Uint8Array(512 * 1024)
    crypto.getRandomValues(payload)
    await writeFile(join(workspace, 'payload.bin'), payload)

    const result = await sftp([
      'cd incoming/deploy',
      'put payload.bin uploaded.bin',
      'get uploaded.bin roundtrip.bin',
    ])
    expect(result.exitCode).toBe(0)

    const roundtrip = await readFile(join(workspace, 'roundtrip.bin'))
    expect(Buffer.compare(roundtrip, Buffer.from(payload))).toBe(0)

    // The file really landed on the box, owned by the service account.
    const owner = await Bun.$`docker exec ${CONTAINER} stat -c %U ${`/var/sftp/${SLUG}/incoming/deploy/uploaded.bin`}`
      .quiet()
    expect(owner.stdout.toString().trim()).toBe('ts-sftp')
  })

  it('creates and removes directories', async () => {
    const result = await sftp([
      'cd incoming/deploy',
      'mkdir reports',
      'ls',
      'rmdir reports',
    ])
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('reports')
  })

  it('keeps the host key across a redeploy', async () => {
    const before = await Bun.$`docker exec ${CONTAINER} cat /etc/ts-sftp/host_key.pub`.quiet()
    const rerun = await Bun.$`docker exec ${CONTAINER} bash -e /root/provision.sh`.quiet().nothrow()
    expect(rerun.exitCode).toBe(0)

    const after = await Bun.$`docker exec ${CONTAINER} cat /etc/ts-sftp/host_key.pub`.quiet()
    expect(after.stdout.toString()).toBe(before.stdout.toString())
  }, 300_000)

  it('comes back on its own after a crash', async () => {
    await Bun.$`docker exec ${CONTAINER} pkill -f ts-sftp`.quiet().nothrow()

    // `systemctl is-active` reports active again while the restart is still in
    // flight, so poll the signal that actually matters: a client can connect.
    let result = await sftp(['ls'])
    for (let attempt = 0; attempt < 20 && result.exitCode !== 0; attempt++) {
      await Bun.sleep(500)
      result = await sftp(['ls'])
    }

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('incoming')

    const state = await Bun.$`docker exec ${CONTAINER} systemctl is-active ${`${SLUG}-sftp.service`}`.quiet().nothrow()
    expect(state.stdout.toString().trim()).toBe('active')
  }, 120_000)

  it('confines a client to the served root', async () => {
    // `..` is resolved inside the served namespace, so this asks for
    // <root>/etc — which does not exist — rather than the machine's /etc.
    const escape = await sftp(['ls ../../../../etc'])
    expect(escape.output).not.toContain('passwd')
    expect(escape.output).toMatch(/not found|Permission denied/i)

    // Climbing past the root lands back on the root itself.
    const root = await sftp(['ls ../../..'])
    expect(root.output).toContain('incoming')
  })
})
