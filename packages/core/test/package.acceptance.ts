import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'bun:test'
import { packageCandidateRegistry } from './candidate-registry'

// Build the workspace explicitly first. A supplied published archive never builds.
test('the installed core SDK delivers its canonical JSON schema and precise public types', async () => {
  const evidenceBase = process.env.TS_CLOUD_PACKAGE_EVIDENCE ?? tmpdir()
  await mkdir(evidenceBase, { recursive: true })
  const directory = await mkdtemp(join(evidenceBase, 'ts-cloud-core-package-'))
  const consumer = join(directory, 'consumer')
  const archive = join(directory, 'core.tgz')
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const commands: Array<Record<string, unknown>> = []
  const receipt: Record<string, unknown> = { directory, commands, completed: false }
  let registry: Awaited<ReturnType<typeof packageCandidateRegistry>> | undefined
  const candidateArchives: Array<{ name: string, archive: string }> = []
  async function run(phase: string, args: string[], cwd: string) {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/token|password|secret|private_key|^npm_config_|^bun_auth_/i.test(key)) delete env[key]
    }
    const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const output = stdout + stderr
    const log = `${commands.length}-${phase}.log`
    await writeFile(join(directory, log), output)
    commands.push({ phase, args, code, log, diagnostics: [...output.matchAll(/error TS(\d+)/g)].map(match => Number(match[1])) })
    return { code, output }
  }
  try {
    const supplied = process.env.TS_CLOUD_CORE_ARCHIVE
    if (supplied) {
      receipt.archiveInput = resolve(supplied)
      await copyFile(resolve(supplied), archive)
    }
    else {
      const packed = await run('pack-core', [process.execPath, '--no-env-file', 'pm', 'pack', '--ignore-scripts', '--filename', archive], resolve(import.meta.dir, '..'))
      expect(packed.code, packed.output).toBe(0)
    }
    const bytes = await readFile(archive)
    receipt.archiveSHA256 = hash(bytes)
    const files = await new Bun.Archive(bytes).files()
    const manifest = await files.get('package/package.json')!.json()
    expect(manifest.name).toBe('@ts-cloud/core')
    receipt.version = manifest.version
    expect(await files.get('package/LICENSE.md')!.text()).toBe(await readFile(resolve(import.meta.dir, '../../../LICENSE.md'), 'utf8'))
    const canonicalSchema = await readFile(resolve(import.meta.dir, '../src/schema/cloud-config.schema.json'))
    const dependencies: Record<string, string> = { '@ts-cloud/core': `file:${archive}` }
    if (!supplied) {
      const awsArchive = join(directory, 'aws-types.tgz')
      const packed = await run('pack-aws-types', [process.execPath, '--no-env-file', 'pm', 'pack', '--ignore-scripts', '--filename', awsArchive], resolve(import.meta.dir, '../../aws-types'))
      expect(packed.code, packed.output).toBe(0)
      const awsFiles = await new Bun.Archive(await readFile(awsArchive)).files()
      const awsManifest = await awsFiles.get('package/package.json')!.json()
      // The candidate supplies an unreleased workspace version. Ownership still
      // belongs to core's manifest; published checks resolve AWS from npm.
      expect(awsManifest.name).toBe('@ts-cloud/aws-types')
      expect(manifest.dependencies['@ts-cloud/aws-types']).toBe(awsManifest.version)
      candidateArchives.push({ name: '@ts-cloud/core', archive }, { name: '@ts-cloud/aws-types', archive: awsArchive })
      registry = await packageCandidateRegistry(candidateArchives)
      dependencies['@ts-cloud/core'] = manifest.version
      receipt.registryProvider = { kind: 'prepublication-original-archives', url: registry.url, requests: registry.requests }
    }
    await mkdir(consumer)
    const registryURL = registry?.url ?? 'https://registry.npmjs.org/'
    await writeFile(join(consumer, '.npmrc'), `registry=${registryURL}\n@ts-cloud:registry=${registryURL}\nalways-auth=false\n`)
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies, devDependencies: { typescript: '7.0.2', '@types/bun': '1.4.4' } }))
    const compilerOptions = { target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: false, paths: {}, types: ['bun'], noEmit: true }
    receipt.compilerOptions = compilerOptions
    await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: ['control.ts'] }))
    const prefix = `import { cloudConfigSchema } from '@ts-cloud/core';
type IsAny<T> = 0 extends (1 & T) ? true : false;`
    const controls = [
      { text: `const title: string = cloudConfigSchema.title;
const minimum: number = cloudConfigSchema.properties.project.properties.name.minLength;
const safe: false = null as unknown as IsAny<typeof cloudConfigSchema>;
const safeMinimum: false = null as unknown as IsAny<typeof cloudConfigSchema.properties.project.properties.name.minLength>;` },
      { code: 2322, text: 'const wrong: number = cloudConfigSchema.title' },
      { code: 2339, text: 'const phantom = cloudConfigSchema.notASchemaMember' },
    ]
    let lockSHA256: string | undefined
    for (const flags of [[], ['--frozen-lockfile']]) {
      const phase = flags.length ? 'frozen' : 'normal'
      const installed = await run(`${phase}-install`, [process.execPath, '--no-env-file', 'install', `--registry=${registryURL}`, ...flags], consumer)
      expect(installed.code, installed.output).toBe(0)
      const lock = hash(await readFile(join(consumer, 'bun.lock')))
      if (lockSHA256) expect(lock).toBe(lockSHA256)
      else { lockSHA256 = lock; receipt.lockSHA256 = lock }
      for (const owner of candidateArchives.length ? candidateArchives : [{ name: manifest.name, archive }]) {
        const original = await new Bun.Archive(await readFile(owner.archive)).files()
        for (const [name, file] of original) {
          expect(name.startsWith('package/') && !name.split('/').includes('..')).toBe(true)
          const installedFile = await readFile(join(consumer, 'node_modules', owner.name, name.slice('package/'.length)))
          expect(hash(installedFile), `${owner.name}/${name}`).toBe(hash(new Uint8Array(await file.arrayBuffer())))
        }
      }
      const compiler = JSON.parse(await readFile(join(consumer, 'node_modules/typescript/package.json'), 'utf8'))
      expect(compiler.version).toBe('7.0.2')
      for (const [index, control] of controls.entries()) {
        await writeFile(join(consumer, 'control.ts'), `${prefix}\n${control.text}\n`)
        const checked = await run(`${phase}-control-${index}`, [process.execPath, '--no-env-file', join(consumer, 'node_modules/typescript/lib/tsc.js'), '--project', 'tsconfig.json'], consumer)
        expect(checked.code === 0, checked.output).toBe(index === 0)
        if ('code' in control) expect(checked.output.match(/error TS\d+/g), checked.output).toEqual([`error TS${control.code}`])
      }
      const schemaFile = join(consumer, 'node_modules/@ts-cloud/core/dist/schema/cloud-config.schema.json')
      expect(hash(await readFile(schemaFile))).toBe(hash(canonicalSchema))
      await writeFile(join(consumer, 'runtime.ts'), `import assert from 'node:assert/strict'; import { cloudConfigSchema } from '@ts-cloud/core'; assert.deepEqual(cloudConfigSchema, ${canonicalSchema.toString()});`)
      const runtime = await run(`${phase}-runtime`, [process.execPath, '--no-env-file', 'runtime.ts'], consumer)
      expect(runtime.code, runtime.output).toBe(0)
    }
    receipt.completed = true
  }
  finally {
    await registry?.stop()
    await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2))
    await rm(consumer, { recursive: true, force: true })
    if (!process.env.TS_CLOUD_PACKAGE_EVIDENCE) await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
