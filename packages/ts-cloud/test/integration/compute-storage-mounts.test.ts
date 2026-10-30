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
      'flock --no-fork /run/lock/backup.lock sleep 20 &',
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
      `echo 'pending volume data' > ${quote(path.join(pendingSite, 'releases', 'current', 'proof'))}`,
      `PATH=${quote(path.join(fixture, 'bin'))}:$PATH bun ${quote(path.join(fixture, 'pending.mjs'))} > ${quote(path.join(fixture, 'pending.log'))} 2>&1 &`,
      'pending=$!; trap "kill $pending $backup 2>/dev/null || true" EXIT',
      'for attempt in $(seq 1 100); do if grep -q locks_lock_inode_wait /proc/$pending/wchan; then break; fi; sleep 0.05; done',
      'grep -q locks_lock_inode_wait /proc/$pending/wchan',
      // Required backup exclusion remains held, but a waiting placement must
      // release the coordinator so a healthy tenant can validate its mounts.
      '! flock -n /run/lock/backup.lock true',
      'flock -n /run/lock/ts-cloud-compute-storage.lock true',
      `PATH=${quote(path.join(fixture, 'bin'))}:$PATH timeout 5 bun ${quote(script)}`,
      `! mountpoint -q ${quote(path.join(pendingSite, 'releases'))}`,
      `test -f ${quote(path.join(pendingSite, 'releases', 'current', 'proof'))}`,
      // A second caller observes the same unplaced entry. After the first
      // commits, the second must reload the journal instead of mounting twice.
      `PATH=${quote(path.join(fixture, 'bin'))}:$PATH bun ${quote(path.join(fixture, 'pending.mjs'))} > ${quote(path.join(fixture, 'pending-second.log'))} 2>&1 &`,
      'second=$!; trap "kill $pending $second $backup 2>/dev/null || true" EXIT',
      'for attempt in $(seq 1 100); do if grep -q locks_lock_inode_wait /proc/$second/wchan; then break; fi; sleep 0.05; done',
      'grep -q locks_lock_inode_wait /proc/$second/wchan',
      'flock -n /run/lock/ts-cloud-compute-storage.lock true',
      'kill $backup; wait $backup 2>/dev/null || true',
      'wait $pending; wait $second',
      `test -f ${quote(path.join(pendingDestination, 'current', 'proof'))}`,
      `flock --no-fork ${quote(path.join(site, '.ts-cloud/deploy.lock'))} sleep 20 &`,
      'deploy=$!; trap "kill $deploy 2>/dev/null || true" EXIT',
      `for attempt in $(seq 1 50); do if ! flock -n ${quote(path.join(site, '.ts-cloud/deploy.lock'))} true; then break; fi; sleep 0.02; done`,
      `! flock -n ${quote(path.join(site, '.ts-cloud/deploy.lock'))} true`,
      `PATH=${quote(path.join(fixture, 'bin'))}:$PATH timeout 5 bun ${quote(path.join(fixture, 'reclaim.mjs'))} | tee ${quote(path.join(fixture, 'reclaim-deploy.log'))}`,
      `grep -q 'Deferring deployment storage reclamation' ${quote(path.join(fixture, 'reclaim-deploy.log'))}`,
      'flock -n /run/lock/ts-cloud-compute-storage.lock true',
      `test -f ${quote(path.join(destination, 'retired', 'proof'))}`,
    ]
    const child = Bun.spawn(['unshare', '--mount', '--propagation', 'private', 'bash', '-c', commands.join('\n')], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ exit, stderr: exit ? stderr : '', stdout: exit ? stdout : '' }).toEqual({ exit: 0, stderr: '', stdout: '' })
    expect(fs.readFileSync(path.join(destination, 'retired', 'proof'), 'utf8')).toBe('preserved volume data\n')
    expect(fs.readFileSync(path.join(pendingDestination, 'current', 'proof'), 'utf8')).toBe('pending volume data\n')
    const journal = JSON.parse(fs.readFileSync(path.join(fixture, 'state', 'compute-storage-state.json'), 'utf8'))
    expect(journal.entries.filter((entry: { source: string }) => entry.source === path.join(pendingSite, 'releases'))).toHaveLength(1)
  } finally {
    fs.rmSync(destination, { recursive: true, force: true })
    fs.rmSync(pendingDestination, { recursive: true, force: true })
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}, 60_000)
