import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { computeStorageAgent } from '../../src/drivers/shared/compute-storage-agent'

// Opt-in Linux integration test: all host paths and locks are shadowed inside
// a private mount namespace. Only the named temporary volume directory is used.
const volumePath = process.env.TS_CLOUD_TEST_VOLUME_PATH
const device = process.env.TS_CLOUD_TEST_VOLUME_DEVICE
const enabled = process.platform === 'linux' && process.getuid?.() === 0 && !!volumePath && !!device

test.skipIf(!enabled)('shared parent mounts cannot redirect root cleanup onto deployment data', async () => {
  const fixture = fs.mkdtempSync(path.join(tmpdir(), 'ts-cloud-mount-test-'))
  const name = path.basename(fixture)
  const webRoot = path.join(fixture, 'www')
  const site = path.join(webRoot, name)
  const destination = path.join(volumePath!, 'releases', name)
  const pendingSite = `${site}-pending`
  const pendingDestination = `${destination}-pending`
  const policy = { webRoot, volumes: [{ key: 'deployments', name: 'fixture', size: 250, id: 1,
    device: device!, mountPath: volumePath!, allowFormat: false }],
  deploymentStorage: { volume: 'deployments', migrateExisting: true, includeBackups: false,
    locks: ['/run/lock/backup.lock'] } }
  try {
    for (const directory of ['etc/ts-cloud', 'etc/systemd/system', 'etc/rpx/sites.d', 'state', 'locks', 'bin'])
      fs.mkdirSync(path.join(fixture, directory), { recursive: true })
    fs.mkdirSync(path.join(site, 'releases', 'retired'), { recursive: true })
    fs.writeFileSync(path.join(site, 'releases', 'retired', 'proof'), 'preserved volume data\n')
    fs.writeFileSync(path.join(fixture, 'etc', 'fstab'), '')
    fs.writeFileSync(path.join(fixture, 'bin', 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    // The fixture volume is already mounted. Never resize the real test device.
    fs.writeFileSync(path.join(fixture, 'bin', 'resize2fs'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const script = path.join(fixture, 'agent.mjs')
    fs.writeFileSync(script, `await (${computeStorageAgent.toString()})(${JSON.stringify(policy)}, ['ensure-site', ${JSON.stringify(site)}, ${JSON.stringify(name)}]);`)
    for (const command of ['apply', 'reclaim'])
      fs.writeFileSync(path.join(fixture, `${command}.mjs`), `await (${computeStorageAgent.toString()})(${JSON.stringify(policy)}, [${JSON.stringify(command)}]);`)
    fs.writeFileSync(path.join(fixture, 'pending.mjs'), `await (${computeStorageAgent.toString()})(${JSON.stringify(policy)}, ['ensure-site', ${JSON.stringify(pendingSite)}, ${JSON.stringify(name)}]);`)
    const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`
    const commands = [
      'set -eu',
      'if mountpoint -q /run/ts-cloud-root-web; then umount -R /run/ts-cloud-root-web; fi',
      `mount --bind ${quote(path.join(fixture, 'etc'))} /etc`,
      `mount --bind ${quote(path.join(fixture, 'state'))} /var/lib/ts-cloud`,
      `mount --bind ${quote(path.join(fixture, 'locks'))} /run/lock`,
      `mount --bind ${quote(webRoot)} ${quote(webRoot)}`,
      `mount --make-shared ${quote(webRoot)}`,
      `PATH=${quote(path.join(fixture, 'bin'))}:$PATH bun ${quote(script)}`,
      `test "$(findmnt -n -o PROPAGATION --mountpoint /run/ts-cloud-root-web)" = private`,
      `test ! -e ${quote(path.join('/run/ts-cloud-root-web', name, 'releases', 'retired', 'proof'))}`,
      `test -f ${quote(path.join(destination, 'retired', 'proof'))}`,
      'flock /run/lock/backup.lock sleep 20 &',
      'backup=$!; trap "kill $backup 2>/dev/null || true" EXIT',
      'for attempt in $(seq 1 50); do if ! flock -n /run/lock/backup.lock true; then break; fi; sleep 0.02; done',
      '! flock -n /run/lock/backup.lock true',
      `PATH=${quote(path.join(fixture, 'bin'))}:$PATH timeout 5 bun ${quote(path.join(fixture, 'reclaim.mjs'))} | tee ${quote(path.join(fixture, 'reclaim.log'))}`,
      `grep -q 'Deferring deployment storage reclamation' ${quote(path.join(fixture, 'reclaim.log'))}`,
      'flock -n /run/lock/ts-cloud-compute-storage.lock true',
      `PATH=${quote(path.join(fixture, 'bin'))}:$PATH timeout 5 bun ${quote(path.join(fixture, 'apply.mjs'))}`,
      `PATH=${quote(path.join(fixture, 'bin'))}:$PATH timeout 5 bun ${quote(script)}`,
      `test -f ${quote(path.join(destination, 'retired', 'proof'))}`,
      `mkdir -p ${quote(path.join(pendingSite, 'releases', 'current'))}`,
      `touch ${quote(path.join(pendingSite, 'releases', 'current', 'proof'))}`,
      `if PATH=${quote(path.join(fixture, 'bin'))}:$PATH timeout 1 bun ${quote(path.join(fixture, 'pending.mjs'))}; then exit 1; else test "$?" = 124; fi`,
      `! mountpoint -q ${quote(path.join(pendingSite, 'releases'))}`,
      `test -f ${quote(path.join(pendingSite, 'releases', 'current', 'proof'))}`,
    ]
    const child = Bun.spawn(['unshare', '--mount', '--propagation', 'private', 'bash', '-c', commands.join('\n')], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ exit, stderr: exit ? stderr : '', stdout: exit ? stdout : '' }).toEqual({ exit: 0, stderr: '', stdout: '' })
    expect(fs.readFileSync(path.join(destination, 'retired', 'proof'), 'utf8')).toBe('preserved volume data\n')
  } finally {
    fs.rmSync(destination, { recursive: true, force: true })
    fs.rmSync(pendingDestination, { recursive: true, force: true })
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}, 60_000)
