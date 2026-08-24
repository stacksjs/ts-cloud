/**
 * End-to-end check of `site:move` against two real Linux machines.
 *
 * Every other test of this operation drives injected effects: they prove the
 * PLAN is right — the ordering, the resume behaviour, what refuses to run — and
 * assert the generated shell as strings. None of them can tell you the shell
 * actually works. For an operation that archives a live site, carries its
 * database and its private keys, and drains the box it came from, "the string
 * looked right" is not the same claim as "it ran".
 *
 * So this boots two systemd containers, builds a realistic site on the first —
 * release tree, `current` symlink, shared state symlinked into the release,
 * systemd units that really run — and then executes the scripts the operation
 * generates, in the order it generates them, against real `systemd`, real `tar`
 * and real `curl`.
 *
 * Skipped when Docker is unavailable, so a machine without it reports a skip
 * rather than a false pass.
 *
 * @see https://github.com/stacksjs/ts-cloud/issues/167
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDrainedSiteScanScript, parseDrainedSites } from '../../src/operations/drained-sites'
import {
  buildCertificatePackScript,
  buildCertificateStateScript,
  buildCertificateUnpackScript,
  buildDrainSourceScript,
  buildHealthGateScript,
  buildPauseWorkersScript,
  buildRestoreScript,
  buildSnapshotScript,
  buildSourceStateScript,
  buildTargetStateScript,
  buildWorkersStateScript,
  certificatesMatch,
  parseCertificateState,
  parseSourceDrained,
  parseTargetReady,
  parseWorkersPaused,
  siteMoveArchivePath,
  siteMoveCertArchivePath,
} from '../../src/operations/site-move'

const SOURCE = 'ts-cloud-move-source'
const TARGET = 'ts-cloud-move-target'
const IMAGE = 'ts-cloud-move-box:22.04'
const SLUG = 'hq'
const SITE = 'bughq'
const APP_BASE = `/var/www/${SLUG}-${SITE}`
const RELEASE = 'r1'
const PORT = 3010
const DOMAIN = 'bughq.example.com'
const CERTS_DIR = '/etc/rpx/certs'
/** Content written into shared state, to prove the move carries it byte-for-byte. */
const SHARED_DB_CONTENT = 'the-production-rows'

async function available(command: string[]): Promise<boolean> {
  const result = await Bun.$`${command}`.quiet().nothrow()
  return result.exitCode === 0
}

const canRun = await available(['docker', 'info'])

/** Run a script inside a box, the way the operation's exec effects would. */
async function exec(box: string, script: string): Promise<{ stdout: string, code: number }> {
  // Fed over stdin rather than as an argument, the same way the real transport
  // does it — so quoting behaves identically here and on a live box.
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

/** Run a script and require it to succeed, surfacing the box's own output when it does not. */
async function run(box: string, script: string): Promise<string> {
  const result = await exec(box, script)
  if (result.code !== 0) throw new Error(`${box} exited ${result.code}:\n${result.stdout}`)
  return result.stdout
}

describe.skipIf(!canRun)('site:move between two boxes (docker)', () => {
  let workspace: string

  async function boot(name: string): Promise<void> {
    await Bun.$`docker rm -f ${name}`.quiet().nothrow()
    await Bun.$`docker run -d --name ${name} --privileged --cgroupns=host \
      -v /sys/fs/cgroup:/sys/fs/cgroup:rw ${IMAGE}`.quiet()
    for (let attempt = 0; attempt < 60; attempt++) {
      const state = await Bun.$`docker exec ${name} systemctl is-system-running`.quiet().nothrow()
      const value = state.stdout.toString().trim()
      if (value === 'running' || value === 'degraded') return
      await Bun.sleep(1000)
    }
    throw new Error(`${name} never finished booting`)
  }

  /**
   * Build the site the way a deploy leaves it: a release directory, shared state
   * symlinked INTO that release, and `current` pointing at it. The symlinks are
   * the point — a move that dereferences them silently turns shared state back
   * into per-release state, which is the failure `sharedPaths` exists to prevent.
   */
  async function seedSite(): Promise<void> {
    await run(SOURCE, [
      'set -eu',
      `mkdir -p ${APP_BASE}/releases/${RELEASE}/database ${APP_BASE}/shared/database`,
      `printf '%s' '${SHARED_DB_CONTENT}' > ${APP_BASE}/shared/database/app.sqlite`,
      // The release links out to shared state, exactly as buildLinkSharedPaths leaves it.
      `ln -sfn ${APP_BASE}/shared/database/app.sqlite ${APP_BASE}/releases/${RELEASE}/database/app.sqlite`,
      `printf 'ok' > ${APP_BASE}/releases/${RELEASE}/index.html`,
      `ln -sfn ${APP_BASE}/releases/${RELEASE} ${APP_BASE}/current`,
      // The app: something that really binds the port the health gate polls.
      `cat > /etc/systemd/system/${SLUG}-${SITE}.service <<'EOF'`,
      '[Unit]',
      `Description=${SITE}`,
      '[Service]',
      `WorkingDirectory=${APP_BASE}/current`,
      `ExecStart=/usr/bin/python3 -m http.server ${PORT} --bind 127.0.0.1`,
      'Restart=always',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOF',
      // Background work: the units the move must stop before it snapshots.
      `cat > /etc/systemd/system/${SLUG}-${SITE}-scheduler.service <<'EOF'`,
      '[Unit]',
      'Description=scheduler',
      '[Service]',
      'ExecStart=/bin/sh -c "while true; do sleep 5; done"',
      'Restart=always',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOF',
      `sed 's/scheduler/queue-0/' /etc/systemd/system/${SLUG}-${SITE}-scheduler.service > /etc/systemd/system/${SLUG}-${SITE}-queue-0.service`,
      'systemctl daemon-reload',
      `systemctl enable --now ${SLUG}-${SITE}.service ${SLUG}-${SITE}-scheduler.service ${SLUG}-${SITE}-queue-0.service`,
      // TLS material, as the gateway would hold it.
      `mkdir -p ${CERTS_DIR}`,
      `printf 'CERT-BODY' > ${CERTS_DIR}/${DOMAIN}.crt`,
      `printf 'KEY-BODY' > ${CERTS_DIR}/${DOMAIN}.key`,
      `chmod 600 ${CERTS_DIR}/${DOMAIN}.key`,
    ].join('\n'))
  }

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ts-cloud-move-e2e-'))
    const dockerfile = join(workspace, 'Dockerfile')
    await writeFile(
      dockerfile,
      [
        'FROM ubuntu:22.04',
        'ENV DEBIAN_FRONTEND=noninteractive container=docker',
        'RUN apt-get update && apt-get install -y systemd systemd-sysv curl python3 ca-certificates \\',
        ' && apt-get clean && rm -rf /var/lib/apt/lists/* \\',
        ' && rm -f /lib/systemd/system/multi-user.target.wants/* /etc/systemd/system/*.wants/* \\',
        '          /lib/systemd/system/local-fs.target.wants/* /lib/systemd/system/sockets.target.wants/*udev*',
        'STOPSIGNAL SIGRTMIN+3',
        'CMD ["/lib/systemd/systemd"]',
      ].join('\n'),
    )
    await Bun.$`docker build -q -f ${dockerfile} -t ${IMAGE} ${workspace}`.quiet()
    await boot(SOURCE)
    await boot(TARGET)
    await seedSite()
  }, 900_000)

  afterAll(async () => {
    await Bun.$`docker rm -f ${SOURCE}`.quiet().nothrow()
    await Bun.$`docker rm -f ${TARGET}`.quiet().nothrow()
    await rm(workspace, { recursive: true, force: true })
  })

  it('starts from a site that is genuinely serving', async () => {
    const health = await exec(SOURCE, buildHealthGateScript(PORT, '/'))
    expect(health.code).toBe(0)
    expect(health.stdout).toContain('healthy')
  })

  /**
   * The state check has to read real `systemctl` output. If the parser and the
   * shell disagree the plan silently decides a step is already done.
   */
  it('sees the background units running, and the parser agrees', async () => {
    const state = await run(SOURCE, buildWorkersStateScript(SLUG, SITE))
    expect(parseWorkersPaused(state)).toBe(false)
    expect(state).toContain(`active:${SLUG}-${SITE}-scheduler.service`)
    expect(state).toContain(`active:${SLUG}-${SITE}-queue-0.service`)
  })

  it('pauses background work while leaving the site serving', async () => {
    await run(SOURCE, buildPauseWorkersScript(SLUG, SITE))

    expect(parseWorkersPaused(await run(SOURCE, buildWorkersStateScript(SLUG, SITE)))).toBe(true)
    // The web service is deliberately untouched: the source is still live.
    const app = await exec(SOURCE, `systemctl is-active ${SLUG}-${SITE}.service`)
    expect(app.stdout.trim()).toBe('active')
    expect((await exec(SOURCE, buildHealthGateScript(PORT, '/'))).code).toBe(0)
  })

  it('archives the tree and the unit files together', async () => {
    await run(SOURCE, buildSnapshotScript(SLUG, SITE, APP_BASE))
    const listing = await run(SOURCE, `tar tzf ${siteMoveArchivePath(SLUG, SITE)}`)
    expect(listing).toContain(`${SLUG}-${SITE}/shared/database/app.sqlite`)
    expect(listing).toContain(`${SLUG}-${SITE}/releases/${RELEASE}/index.html`)
    expect(listing).toContain(`${SLUG}-${SITE}.service`)
    expect(listing).toContain(`${SLUG}-${SITE}-scheduler.service`)
  })

  /**
   * The claim this whole test exists for: `tar` must NOT dereference. A
   * flattened `current` turns one release into a second copy, and a flattened
   * shared path turns the database back into per-release state — silently, and
   * only visible one deploy later.
   */
  it('keeps current and the shared links as symlinks inside the archive', async () => {
    const verbose = await run(SOURCE, `tar tzvf ${siteMoveArchivePath(SLUG, SITE)}`)
    const current = verbose.split('\n').find(line => line.includes(`${SLUG}-${SITE}/current`))
    const shared = verbose.split('\n').find(line => line.includes(`releases/${RELEASE}/database/app.sqlite`))
    expect(current?.startsWith('l')).toBe(true)
    expect(shared?.startsWith('l')).toBe(true)
  })

  it('reports the target as empty before the move', async () => {
    const state = await run(TARGET, buildTargetStateScript(SLUG, SITE, APP_BASE))
    expect(parseTargetReady(state)).toBe(false)
    expect(state).toContain('tree:absent')
  })

  it('unpacks on the target and brings the site up there', async () => {
    const archive = siteMoveArchivePath(SLUG, SITE)
    const local = join(workspace, 'tree.tar.gz')
    await Bun.$`docker cp ${`${SOURCE}:${archive}`} ${local}`.quiet()
    await Bun.$`docker cp ${local} ${`${TARGET}:${archive}`}`.quiet()

    await run(TARGET, buildRestoreScript(SLUG, SITE, APP_BASE))

    const state = await run(TARGET, buildTargetStateScript(SLUG, SITE, APP_BASE))
    expect(parseTargetReady(state)).toBe(true)
  })

  it('carries the shared state across byte-for-byte, still as symlinks', async () => {
    const content = await run(TARGET, `cat ${APP_BASE}/shared/database/app.sqlite`)
    expect(content.trim()).toBe(SHARED_DB_CONTENT)

    // The release still POINTS at shared state rather than holding a copy.
    const linked = await run(TARGET, `readlink ${APP_BASE}/releases/${RELEASE}/database/app.sqlite`)
    expect(linked.trim()).toBe(`${APP_BASE}/shared/database/app.sqlite`)
    const current = await run(TARGET, `readlink ${APP_BASE}/current`)
    expect(current.trim()).toBe(`${APP_BASE}/releases/${RELEASE}`)

    // Writing through the release link reaches the shared file, as the app would.
    await run(TARGET, `printf 'new-rows' > ${APP_BASE}/releases/${RELEASE}/database/app.sqlite`)
    expect((await run(TARGET, `cat ${APP_BASE}/shared/database/app.sqlite`)).trim()).toBe('new-rows')
  })

  /** Two boxes running one scheduler against one dataset is the thing to avoid. */
  it('starts the app on the target but leaves its background units stopped', async () => {
    expect((await exec(TARGET, `systemctl is-active ${SLUG}-${SITE}.service`)).stdout.trim()).toBe('active')
    expect(parseWorkersPaused(await run(TARGET, buildWorkersStateScript(SLUG, SITE)))).toBe(true)
  })

  it('passes the health gate on the target, against a real listener', async () => {
    const health = await exec(TARGET, buildHealthGateScript(PORT, '/'))
    expect(health.code).toBe(0)
    expect(health.stdout).toContain('healthy')
  })

  it('fails the health gate when nothing is listening', async () => {
    const health = await exec(TARGET, buildHealthGateScript(3999, '/', 1))
    expect(health.code).not.toBe(0)
    expect(health.stdout).toContain('no healthy response')
  })

  it('carries the TLS material, keys still unreadable to others', async () => {
    const before = parseCertificateState(await run(SOURCE, buildCertificateStateScript(CERTS_DIR, [DOMAIN])))
    const targetBefore = parseCertificateState(await run(TARGET, buildCertificateStateScript(CERTS_DIR, [DOMAIN])))
    expect(certificatesMatch(before, targetBefore)).toBe(false)

    const archive = siteMoveCertArchivePath(SLUG, SITE)
    await run(SOURCE, buildCertificatePackScript(CERTS_DIR, [DOMAIN], archive))
    const local = join(workspace, 'certs.tar.gz')
    await Bun.$`docker cp ${`${SOURCE}:${archive}`} ${local}`.quiet()
    await Bun.$`docker cp ${local} ${`${TARGET}:${archive}`}`.quiet()
    await run(TARGET, buildCertificateUnpackScript(CERTS_DIR, archive))

    const after = parseCertificateState(await run(TARGET, buildCertificateStateScript(CERTS_DIR, [DOMAIN])))
    expect(certificatesMatch(before, after)).toBe(true)
    expect((await run(TARGET, `cat ${CERTS_DIR}/${DOMAIN}.key`)).trim()).toBe('KEY-BODY')
    expect((await run(TARGET, `stat -c %a ${CERTS_DIR}/${DOMAIN}.key`)).trim()).toBe('600')
  })

  /**
   * The drain is what makes the whole operation reversible: it stops the site on
   * the source and leaves every byte of it in place, so a bad cutover is undone
   * by starting the units again.
   */
  it('drains the source completely', async () => {
    await run(SOURCE, buildDrainSourceScript(SLUG, SITE))
    const state = await run(SOURCE, buildSourceStateScript(SLUG, SITE))
    expect(parseSourceDrained(state)).toBe(true)
    expect((await exec(SOURCE, buildHealthGateScript(PORT, '/', 1))).code).not.toBe(0)
  })

  it('leaves the source files untouched, so the move can still be undone', async () => {
    const content = await run(SOURCE, `cat ${APP_BASE}/shared/database/app.sqlite`)
    expect(content.trim()).toBe(SHARED_DB_CONTENT)
    expect((await exec(SOURCE, `test -L ${APP_BASE}/current`)).code).toBe(0)
    expect((await exec(SOURCE, `test -f /etc/systemd/system/${SLUG}-${SITE}.service`)).code).toBe(0)
  })

  /**
   * The drained tree is the rollback, and a teardown would take it. The scan has
   * to see that on a real box: the site's files present, nothing running for it.
   */
  it('is reported as a drained site, so a teardown can refuse', async () => {
    const scan = await run(SOURCE, buildDrainedSiteScanScript(SLUG).join('\n'))
    const drained = parseDrainedSites(scan)
    expect(drained.map(site => site.name)).toContain(SITE)
    expect(drained[0].size).not.toBe('?')
  })

  it('is not reported as drained on the target, which is serving it', async () => {
    const scan = await run(TARGET, buildDrainedSiteScanScript(SLUG).join('\n'))
    expect(parseDrainedSites(scan)).toEqual([])
  })

  it('comes back on the source by restarting it, with its data intact', async () => {
    await run(SOURCE, `systemctl start ${SLUG}-${SITE}.service`)
    const health = await exec(SOURCE, buildHealthGateScript(PORT, '/'))
    expect(health.code).toBe(0)
    expect((await run(SOURCE, `cat ${APP_BASE}/shared/database/app.sqlite`)).trim()).toBe(SHARED_DB_CONTENT)
  })

  /** Once the source is serving again, it is no longer holding anyone's rollback. */
  it('stops being reported as drained once it serves again', async () => {
    const scan = await run(SOURCE, buildDrainedSiteScanScript(SLUG).join('\n'))
    expect(parseDrainedSites(scan)).toEqual([])
  })
})
