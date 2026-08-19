#!/usr/bin/env bun
/**
 * Upstream drift check for Vitess.
 *
 * This exists because of a bug that shipped: the vtctldclient installer built
 * its download URL as `vitess-<version>-<arch>.tar.gz`, while the real asset
 * embeds the release commit (`vitess-21.0.0-d9bc0da.tar.gz`). Every install
 * 404'd. The unit tests passed the whole time, because they asserted the
 * script MENTIONED a version and an architecture rather than that the URL
 * could resolve.
 *
 * Unit tests cannot catch that class of bug: the failure lives in an
 * assumption about somebody else's release process, which can change without
 * a commit to this repository. So this runs on a schedule and talks to the
 * real API.
 *
 * It verifies the assumptions the installer and the pantry recipe actually
 * depend on:
 *
 *   1. the pinned vtctldclient version still exists upstream
 *   2. its release still publishes a `vitess-*.tar.gz` asset
 *   3. the asset URL the installer's parser extracts really resolves
 *   4. the source tag the pantry recipe builds from still exists
 *
 * Any of these breaking means installs are broken for everyone; finding out
 * from a scheduled check beats finding out from a failed production deploy.
 */

import process from 'node:process'
import {
  buildEtcdUnit,
  buildMysqlctldUnit,
  buildVtcomboUnit,
  buildVtctldUnit,
  buildVtgateUnit,
  buildVttabletUnit,
} from '../packages/ts-cloud/src/drivers/shared/vitess-provision'

const REPO = 'vitessio/vitess'
const API = `https://api.github.com/repos/${REPO}`

/** Kept in sync with DEFAULT_VTCTLDCLIENT_VERSION in dashboard-vitess.ts. */
const PINNED_VERSION = '21.0.0'

interface Failure { check: string, detail: string }

const failures: Failure[] = []
const notes: string[] = []

function headers(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/vnd.github+json' }
  // CI provides a token; without one the API allows 60 requests/hour, which is
  // enough for this script but not for a busy runner.
  if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return h
}

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    notes.push(`  ok    ${name}: ${await fn()}`)
  }
  catch (error: any) {
    failures.push({ check: name, detail: error?.message ?? String(error) })
  }
}

/**
 * Resolve the release asset exactly the way the installer's shell does, so a
 * change that breaks the installer breaks this check too. Reimplementing the
 * lookup a "better" way here would let the two drift apart and defeat the
 * point.
 */
async function resolveAsset(version: string): Promise<string> {
  const res = await fetch(`${API}/releases/tags/v${version}`, { headers: headers() })
  if (!res.ok) throw new Error(`releases/tags/v${version} returned ${res.status}`)
  const body = await res.json() as { assets?: Array<{ name: string, browser_download_url: string }> }
  const asset = (body.assets ?? []).find(a => /^vitess-[0-9].*\.tar\.gz$/.test(a.name))
  if (!asset) {
    const names = (body.assets ?? []).map(a => a.name).join(', ') || '(none)'
    throw new Error(`no vitess-*.tar.gz asset on v${version}. Assets present: ${names}`)
  }
  return asset.browser_download_url
}

/**
 * Wrapped in `main()` rather than run at the top level: this repository bans
 * top-level await, because it breaks the binary builds that bundle this code.
 */
async function main(): Promise<void> {
  await check('pinned vtctldclient version exists upstream', async () => {
    const res = await fetch(`${API}/releases/tags/v${PINNED_VERSION}`, { headers: headers() })
    if (!res.ok) throw new Error(`v${PINNED_VERSION} returned ${res.status}; the pin may have been yanked`)
    return `v${PINNED_VERSION}`
  })

  await check('release publishes a vitess-*.tar.gz asset', async () => {
    const url = await resolveAsset(PINNED_VERSION)
    return url.split('/').pop() ?? url
  })

  await check('resolved asset URL actually downloads', async () => {
    const url = await resolveAsset(PINNED_VERSION)
    // Range request: proves the object is served without pulling ~600MB.
    const res = await fetch(url, { headers: { range: 'bytes=0-1023' } })
    if (res.status !== 200 && res.status !== 206)
      throw new Error(`${url} returned ${res.status}`)
    return `HTTP ${res.status}`
  })

  await check('source tag the pantry recipe builds from exists', async () => {
    // The recipe fetches /archive/refs/tags/v<version>.tar.gz rather than a
    // release asset, so it can break independently of the release.
    const url = `https://github.com/${REPO}/archive/refs/tags/v${PINNED_VERSION}.tar.gz`
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    if (!res.ok) throw new Error(`${url} returned ${res.status}`)
    return `HTTP ${res.status}`
  })

  await check('a newer stable release is reported, not silently missed', async () => {
    const res = await fetch(`${API}/releases?per_page=20`, { headers: headers() })
    if (!res.ok) throw new Error(`releases returned ${res.status}`)
    const body = await res.json() as Array<{ tag_name: string, prerelease: boolean }>
    const stable = body.filter(r => !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
    const latest = stable[0]?.tag_name?.slice(1)
    // Informational, not a failure: being behind upstream is normal, and the
    // pin must match the cluster rather than the newest tag. It is surfaced so
    // the gap is visible instead of drifting for years unnoticed.
    return latest && latest !== PINNED_VERSION
      ? `latest upstream is ${latest}; pinned client is ${PINNED_VERSION}`
      : `pinned at the latest (${PINNED_VERSION})`
  })

  await check('every flag the provisioner emits still exists upstream', async () => {
    // The reason this check exists at all. Vitess renamed its flags from
    // snake_case to kebab-case and then removed the old forms, which turned
    // every generated systemd unit into one that refuses to start. Nothing in
    // the unit tests could see it: the units were internally consistent and
    // matched their assertions exactly. Only upstream knows the truth.
    //
    // Validated against the newest stable release, because `vitess.io` with
    // no pinned version installs exactly that.
    const releases = await fetch(`${API}/releases?per_page=20`, { headers: headers() })
    if (!releases.ok) throw new Error(`releases returned ${releases.status}`)
    const stable = (await releases.json() as Array<{ tag_name: string, prerelease: boolean }>)
      .filter(r => !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
    const tag = stable[0]?.tag_name
    if (!tag) throw new Error('could not determine the newest stable release')

    const cfg = { cell: 'zone1', keyspaces: [{ name: 'commerce', sharded: true }] }
    const units: Record<string, string> = {
      vtgate: buildVtgateUnit(cfg),
      vtctld: buildVtctldUnit(cfg),
      vttablet: buildVttabletUnit(cfg, 'commerce', '-80'),
      mysqlctld: buildMysqlctldUnit(cfg),
      vtcombo: buildVtcomboUnit(cfg),
      etcd: buildEtcdUnit(),
    }

    const problems: string[] = []
    let checked = 0
    for (const [daemon, unit] of Object.entries(units)) {
      // etcd is not a Vitess binary and has no flag dump here.
      if (daemon === 'etcd') continue
      const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${tag}/go/flags/endtoend/${daemon}.txt`)
      if (!res.ok) {
        problems.push(`${daemon}: no flag reference at ${tag} (HTTP ${res.status})`)
        continue
      }
      const doc = await res.text()
      const exec = unit.split('\n').find(l => l.startsWith('ExecStart=')) ?? ''
      for (const match of exec.matchAll(/--([a-zA-Z0-9_-]+)/g)) {
        const flag = match[1]
        checked++
        // A flag with a short alias is listed as `-v, --version`, so the
        // optional prefix matters: without it the check would reject flags
        // that exist, which is the worse failure for a guard.
        if (!new RegExp(`^\\s+(?:-\\w, )?--${flag}[ =]`, 'm').test(doc))
          problems.push(`${daemon}: --${flag} does not exist in ${tag}`)
      }
    }

    if (problems.length > 0) throw new Error(`${problems.length} invalid flag(s):\n      ${problems.join('\n      ')}`)
    return `${checked} flags valid against ${tag}`
  })

  console.log('Vitess upstream checks\n')
  for (const note of notes) console.log(note)

  if (failures.length > 0) {
    console.error('\nFAILED:\n')
    for (const f of failures) console.error(`  ${f.check}\n    ${f.detail}\n`)
    console.error(
      'Vitess changed something the installer or the pantry recipe depends on.\n'
      + 'Fix packages/ts-cloud/src/deploy/dashboard-vitess.ts (asset resolution)\n'
      + 'or the vitess.io recipe in the pantry registry before this reaches a deploy.',
    )
    process.exit(1)
  }

  console.log('\nAll upstream assumptions still hold.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
