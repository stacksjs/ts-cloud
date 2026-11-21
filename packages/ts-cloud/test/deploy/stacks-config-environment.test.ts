import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('loads the Stacks blueprint and state directory for the requested release environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ts-cloud-stacks-env-'))
  try {
    await mkdir(join(directory, 'config'))
    await writeFile(join(directory, 'config/cloud.ts'), `
const target = new URL(import.meta.url).searchParams.get('env') ?? 'production'
export const tsCloud = {
  project: { name: 'example', slug: 'example-' + target, region: 'us-east-1' },
  stateDir: 'state/' + target,
}
`)
    const loader = new URL('../../bin/commands/shared.ts', import.meta.url).href
    const script = `
import { loadValidatedConfig } from ${JSON.stringify(loader)}
const configs = []
for (const environment of [undefined, 'staging', 'production', 'staging']) {
  const config = await loadValidatedConfig(environment)
  configs.push([config.project.slug, config.stateDir])
}
console.log(JSON.stringify(configs))
`
    async function loadTargets() {
      const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script], { cwd: directory, stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect(status, stderr).toBe(0)
      return JSON.parse(stdout)
    }
    expect(await loadTargets()).toEqual([
      ['example-production', 'state/production'],
      ['example-staging', 'state/staging'],
      ['example-production', 'state/production'],
      ['example-staging', 'state/staging'],
    ])

    await writeFile(join(directory, 'cloud.config.ts'), "export default { project: { slug: 'standalone', region: 'us-east-1' }, stateDir: 'cloud-state' }")
    expect(await loadTargets()).toEqual(Array.from({ length: 4 }, () => ['standalone', 'cloud-state']))
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})
