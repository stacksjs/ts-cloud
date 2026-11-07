import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { persistentStorageAgent } from '../../src/drivers/shared/persistent-storage-agent'

const volume = process.env.TS_CLOUD_TEST_VOLUME_PATH
const device = process.env.TS_CLOUD_TEST_VOLUME_DEVICE
const enabled = process.platform === 'linux' && process.getuid?.() === 0 && !!volume && !!device

// The real /etc, journal and locks are shadowed in a private mount namespace.
// Test failures may remove only these uniquely named, tiny fixture directories.
test.skipIf(!enabled)('persistent cutover preserves files, rejects unknown writers, rolls back and resumes safely', async () => {
  const fixture = fs.mkdtempSync('/var/tmp/ts-cloud-persistent-test-')
  const source = path.join(fixture, 'data')
  const destination = path.join(volume!, 'persistent', source.slice(1))
  const policy = { webRoot: fixture, volumes: [{ key: 'data', name: 'fixture', size: 320, id: 1, device: device!, mountPath: volume!, allowFormat: false }],
    persistentStorage: { volume: 'data', migrateExisting: true, locks: ['/run/lock/fixture-backup.lock'], deploymentLocks: [path.join(fixture, 'deploy.lock')], paths: [{ path: source, units: ['fixture-*.service'] }] } }
  try {
    for (const folder of ['data', 'etc/ts-cloud', 'etc/systemd/system', 'state', 'locks', 'bin']) fs.mkdirSync(path.join(fixture, folder), { recursive: true })
    fs.writeFileSync(path.join(source, 'proof'), 'all user bytes preserved\n')
    fs.writeFileSync(path.join(source, 'backup'), 'all backup bytes preserved\n')
    fs.linkSync(path.join(source, 'proof'), path.join(source, 'hardlink'))
    fs.symlinkSync('proof', path.join(source, 'symlink'))
    fs.chmodSync(path.join(source, 'proof'), 0o640)
    fs.writeFileSync(path.join(fixture, 'etc/fstab'), '# original\n')
    fs.writeFileSync(path.join(fixture, 'bin/systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> ${fixture}/calls
if [ "$1" = list-units ]; then echo 'fixture-api.service loaded active running Fixture'; fi
if [ "$1" = stop ]; then touch ${fixture}/stopped; fi
if [ "$1" = start ]; then rm -f ${fixture}/stopped; fi
if [ "$1" = is-active ] && [ -f ${fixture}/restarted ]; then exit 0; fi
if [ "$1" = is-active ] && [ -f ${fixture}/stopped ]; then exit 3; fi
if [ "$1" = daemon-reload ] && [ -f ${fixture}/fail-reload ]; then exit 1; fi
exit 0
`, { mode: 0o755 })
    fs.writeFileSync(path.join(fixture, 'bin/rsync'), `#!/bin/sh
/usr/bin/rsync "$@" || exit $?
case " $* " in *" --checksum "*) if [ -f ${fixture}/inject-restart ]; then touch ${fixture}/restarted; fi ;; esac
`, { mode: 0o755 })
    for (const command of ['apply', 'check']) fs.writeFileSync(path.join(fixture, `${command}.mjs`), `await (${persistentStorageAgent.toString()})(${JSON.stringify(policy)}, '${command}');`)
    const q = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`
    const apply = `PATH=${q(path.join(fixture, 'bin'))}:$PATH bun ${q(path.join(fixture, 'apply.mjs'))}`
    const commands = [
      'set -eu',
      'if mountpoint -q /run/ts-cloud-root-data; then umount /run/ts-cloud-root-data; fi',
      `mount --bind ${q(path.join(fixture, 'etc'))} /etc`,
      `mount --bind ${q(path.join(fixture, 'state'))} /var/lib/ts-cloud`,
      `mount --bind ${q(path.join(fixture, 'locks'))} /run/lock`,
      // Pending migrations still wait for backup exclusion before any cutover.
      `flock --no-fork /run/lock/fixture-backup.lock sleep 20 &`,
      'backup=$!; trap "kill $backup 2>/dev/null || true" EXIT',
      'for attempt in $(seq 1 50); do if ! flock -n /run/lock/fixture-backup.lock true; then break; fi; sleep 0.02; done',
      `if timeout --kill-after=1 1 env PATH=${q(path.join(fixture, 'bin'))}:$PATH bun ${q(path.join(fixture, 'apply.mjs'))}; then exit 25; else test "$?" -eq 124; fi`,
      `! mountpoint -q ${q(source)}`,
      'kill $backup; wait $backup 2>/dev/null || true',
      `exec 8<${q(path.join(source, 'proof'))}`,
      // Even a reader outside the declared units prevents hiding a root file.
      `if ${apply}; then exit 21; fi`,
      `test -f ${q(path.join(source, 'proof'))}`,
      `! mountpoint -q ${q(source)}`,
      'exec 8<&-',
      `touch ${q(path.join(fixture, 'inject-restart'))}`,
      `if ${apply}; then exit 24; fi`,
      `! mountpoint -q ${q(source)}`,
      `test -f ${q(path.join(source, 'proof'))}`,
      `rm ${q(path.join(fixture, 'inject-restart'))} ${q(path.join(fixture, 'restarted'))}`,
      `touch ${q(path.join(fixture, 'fail-reload'))}`,
      // Fail after mounting: restore fstab and original data before restarting.
      `if ${apply}; then exit 22; fi`,
      `! mountpoint -q ${q(source)}`,
      `test "$(cat /etc/fstab)" = '# original'`,
      `test -f ${q(path.join(source, 'backup'))}`,
      `rm ${q(path.join(fixture, 'fail-reload'))}`,
      // Reuse our owned staging destination and repair changed bytes.
      `printf 'corrupt same staged data' > ${q(path.join(destination, 'proof'))}`,
      `flock --no-fork ${q(path.join(fixture, 'deploy.lock'))} sleep 20 &`,
      'deployment=$!; trap "kill $deployment 2>/dev/null || true" EXIT',
      `for attempt in $(seq 1 50); do if ! flock -n ${q(path.join(fixture, 'deploy.lock'))} true; then break; fi; sleep 0.02; done`,
      `${apply} > ${q(path.join(fixture, 'apply.log'))} 2>&1 &`,
      'migration=$!; trap "kill $migration $deployment 2>/dev/null || true" EXIT',
      'for attempt in $(seq 1 100); do if grep -q locks_lock_inode_wait /proc/$migration/wchan; then break; fi; sleep 0.02; done',
      'grep -q locks_lock_inode_wait /proc/$migration/wchan',
      `! mountpoint -q ${q(source)}`,
      'kill $deployment; wait $deployment 2>/dev/null || true',
      'wait $migration',
      `mountpoint -q ${q(source)}`,
      `test "$(cat ${q(path.join(source, 'proof'))})" = 'all user bytes preserved'`,
      `test "$(cat ${q(path.join(source, 'backup'))})" = 'all backup bytes preserved'`,
      `test "$(stat -c %a ${q(path.join(source, 'proof'))})" = 640`,
      `test "$(stat -c %i ${q(path.join(source, 'proof'))})" = "$(stat -c %i ${q(path.join(source, 'hardlink'))})"`,
      `test -L ${q(path.join(source, 'symlink'))}`,
      // Idempotent applies must preserve writes made after activation.
      `echo 'new user data' > ${q(path.join(source, 'after'))}`,
      // A completed migration must not wait for an unrelated long backup.
      'flock --no-fork /run/lock/fixture-backup.lock sleep 20 &',
      'backup=$!; trap "kill $backup 2>/dev/null || true" EXIT',
      'for attempt in $(seq 1 50); do if ! flock -n /run/lock/fixture-backup.lock true; then break; fi; sleep 0.02; done',
      `timeout --kill-after=1 5 env PATH=${q(path.join(fixture, 'bin'))}:$PATH bun ${q(path.join(fixture, 'apply.mjs'))}`,
      'kill -0 $backup',
      `test -f ${q(path.join(destination, 'after'))}`,
      `PATH=${q(path.join(fixture, 'bin'))}:$PATH bun ${q(path.join(fixture, 'check.mjs'))}`,
      `umount ${q(source)}`,
      `test -z "$(ls -A ${q(source)})"`,
      // A missing mount fails even when the complete journal can be read and
      // backup exclusion is held; never accept the empty root stub as healthy.
      `if timeout --kill-after=1 5 env PATH=${q(path.join(fixture, 'bin'))}:$PATH bun ${q(path.join(fixture, 'apply.mjs'))}; then exit 26; else test "$?" -ne 124; fi`,
      `! mountpoint -q ${q(source)}`,
      // Missing persistent mounts fail health, never write to the root stub.
      `if PATH=${q(path.join(fixture, 'bin'))}:$PATH bun ${q(path.join(fixture, 'check.mjs'))}; then exit 23; fi`,
      `test -f ${q(path.join(destination, 'proof'))}`,
      'kill $backup; wait $backup 2>/dev/null || true',
    ]
    const child = Bun.spawn(['unshare', '--mount', '--propagation', 'private', 'bash', '-c', commands.join('\n')], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ exit, stderr: exit ? stderr : '', stdout: exit ? stdout : '' }).toEqual({ exit: 0, stderr: '', stdout: '' })
    const state = JSON.parse(fs.readFileSync(path.join(fixture, 'state/persistent-storage-state.json'), 'utf8'))
    expect(state.phase).toBe('complete')
    expect(state.entries[0].checksummedAt).toBeTruthy()
    expect(fs.readFileSync(path.join(destination, 'backup'), 'utf8')).toBe('all backup bytes preserved\n')
  } finally {
    fs.rmSync(destination, { recursive: true, force: true })
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}, 60_000)
