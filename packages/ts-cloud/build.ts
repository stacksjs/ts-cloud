import { dirname, join } from 'node:path'

const __dirname = import.meta.dirname

async function build() {
  // Build the library root AND every subpath entry point declared in the
  // package.json exports map ("./aws", "./deploy", "./dns", "./drivers",
  // "./operations", "./push", "./spend", "./protection"). Bundling only
  // src/index.ts leaves those subpaths as .d.ts-only
  // in dist, so `import '@stacksjs/ts-cloud/drivers'` fails at runtime for
  // consumers. Splitting keeps shared code in chunks instead of duplicating
  // it into each subpath bundle.
  const libResult = await Bun.build({
    entrypoints: [
      join(__dirname, 'src/index.ts'),
      join(__dirname, 'src/aws/index.ts'),
      join(__dirname, 'src/deploy/index.ts'),
      join(__dirname, 'src/dns/index.ts'),
      join(__dirname, 'src/drivers/index.ts'),
      join(__dirname, 'src/operations/index.ts'),
      join(__dirname, 'src/push/index.ts'),
      join(__dirname, 'src/spend/index.ts'),
      join(__dirname, 'src/protection/index.ts'),
    ],
    outdir: join(__dirname, 'dist'),
    root: join(__dirname, 'src'),
    target: 'node',
    format: 'esm',
    splitting: true,
    // The library is 9MB of JS across ~90 chunks and every consumer downloads
    // all of it. Unminified it was a quarter whitespace.
    minify: true,
  })

  if (!libResult.success) {
    console.error('Library build failed:')
    for (const log of libResult.logs) {
      console.error(log)
    }
    process.exit(1)
  }

  const declarations = Bun.spawn(
    [
      'bunx',
      'tsc',
      '-p',
      join(__dirname, 'tsconfig.json'),
      '--emitDeclarationOnly',
      '--noEmit',
      'false',
      '--declarationMap',
      'false',
    ],
    {
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )

  const declarationExitCode = await declarations.exited
  if (declarationExitCode !== 0) process.exit(declarationExitCode)

  // Build the three executables together, with splitting on.
  //
  // Separately and unsplit, each one inlined the entire graph it reaches: the
  // CLI and the dashboard server overlap almost completely — config loading,
  // the AWS and Hetzner drivers, the deploy pipeline — and shipped two full
  // copies of it, 5.6MB for 3.6MB of distinct code. One build lets Bun put the
  // shared half in chunks that both entries import.
  //
  // The entries keep their own graphs at runtime: a chunk is loaded only by an
  // entry that imports it, so the long-running dashboard still does not pull
  // in the CLI's whole command tree, which is the reason it has its own entry.
  const executablesResult = await Bun.build({
    entrypoints: [
      join(__dirname, 'bin/cli.ts'),
      join(__dirname, 'bin/dashboard-server.ts'),
      join(__dirname, 'bin/stacks-scheduler.ts'),
    ],
    outdir: join(__dirname, 'dist/bin'),
    target: 'node',
    format: 'esm',
    splitting: true,
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  })

  if (!executablesResult.success) {
    console.error('Executable build failed:')
    for (const log of executablesResult.logs) {
      console.error(log)
    }
    process.exit(1)
  }

  // Must run before anything executes the bundles: they are unusable for any
  // non-ASCII text until the pragma is gone.
  await stripBunPragma()

  // Bundle the management dashboard (the @ts-cloud/ui stx app) into the package so
  // `cloud deploy` can auto-ship it from any consumer project (no local packages/ui).
  await bundleManagementUi()

  // Also ship the UI *source* (templates + a vendored, dependency-free charts
  // module) so `cloud dashboard:serve` / `buddy cloud:dashboard` can rebuild the
  // cockpit with LIVE data in any consumer project that has the stx toolchain
  // (Stacks projects do) — not just the prebuilt sample-data HTML.
  await bundleManagementUiSource()
}

/**
 * Remove the `// @bun` pragma Bun.build writes into shebang entry bundles.
 *
 * The pragma tells the Bun runtime "this file is already transpiled", which
 * makes it skip transpilation and load the source down a fast path that decodes
 * it as latin-1 rather than UTF-8. Every non-ASCII character in every string
 * literal is then corrupted into its individual UTF-8 bytes: `—` becomes
 * `â€"`, `·` becomes `Â·`, and the CLI's own `✓` becomes `â`.
 *
 * It is not cosmetic and not limited to our own text — it corrupts any customer
 * data that flows through the CLI or the dashboard payload, so a project or
 * domain named `Käufer` renders wrong on the box. The pragma alone is the
 * trigger — the shebang is incidental; it just happens that only our `bin/*.js`
 * entries get the pragma emitted, which is why the same string is correct when
 * imported from `dist/index.js` and wrong when the CLI serves it.
 *
 * Reported upstream as https://github.com/oven-sh/bun/issues/37161 — drop this
 * step once that is fixed in the Bun version we build with.
 *
 * Dropping the line costs a little startup time and buys back correctness.
 * Verified by diffing byte-identical bundles that differ only in this line.
 */
async function stripBunPragma(): Promise<void> {
  const { readdirSync, readFileSync, writeFileSync } = await import('node:fs')
  const binDir = join(__dirname, 'dist', 'bin')
  const stripped: string[] = []
  for (const entry of readdirSync(binDir)) {
    if (!entry.endsWith('.js')) continue
    const file = join(binDir, entry)
    const source = readFileSync(file, 'utf8')
    // Only the pragma line, whether or not a shebang precedes it.
    const next = source.replace(/^(#![^\n]*\n)?\/\/ @bun\n/, (_match, shebang) => shebang ?? '')
    if (next !== source) {
      writeFileSync(file, next)
      stripped.push(entry)
    }
  }
  // Assert rather than trust: shipping a bundle that still carries the pragma
  // means every accented character the CLI touches is wrong on the box, and
  // nothing downstream would catch it.
  const remaining = readdirSync(binDir).filter(
    (entry) => entry.endsWith('.js') && /^(?:#![^\n]*\n)?\/\/ @bun\n/.test(readFileSync(join(binDir, entry), 'utf8')),
  )
  if (remaining.length)
    throw new Error(`Bun pragma still present in ${remaining.join(', ')} — non-ASCII text would be corrupted at runtime.`)

  console.warn(
    stripped.length
      ? `Bun pragma: stripped '// @bun' from ${stripped.join(', ')} (it makes Bun read the bundle as latin-1).`
      : "Bun pragma: none found — check whether Bun still emits '// @bun' for shebang bundles.",
  )
}

async function bundleManagementUi(): Promise<void> {
  const { existsSync, cpSync, rmSync } = await import('node:fs')
  const uiDir = join(__dirname, '..', 'ui')
  if (!existsSync(join(uiDir, 'package.json'))) {
    console.warn('UI bundle: packages/ui not found — skipping dashboard bundle.')
    return
  }

  const built = Bun.spawnSync(['bun', 'run', 'build'], { cwd: uiDir, stdout: 'inherit', stderr: 'inherit' })
  if (built.exitCode !== 0) {
    console.warn('UI bundle: `bun run build` in packages/ui failed — skipping dashboard bundle.')
    return
  }

  const distUi = join(uiDir, 'dist')
  const dest = join(__dirname, 'dist', 'ui')
  if (!existsSync(distUi)) {
    console.warn('UI bundle: packages/ui/dist not produced — skipping.')
    return
  }
  rmSync(dest, { recursive: true, force: true })
  cpSync(distUi, dest, { recursive: true })
  console.warn(`UI bundle: shipped dashboard → ${dest}`)
}

/**
 * Ship everything the pages import at `dist/ui-src/`: the templates, the
 * `functions/` composables verbatim, and each `src/` module vendored
 * dependency-free (its npm imports inlined). The local dashboard server
 * rebuilds this with the project's live data at serve time using the host's stx
 * toolchain, so the cockpit shows REAL data everywhere — not the prebuilt
 * sample-data fallback.
 *
 * The completeness check at the end is the important part. stx's bundler
 * reports a missing import on stderr but still exits 0, so an incomplete
 * bundle does not fail the box's rebuild — it produces pages whose client
 * scripts are silently truncated, which is worse than falling back to the
 * prebuilt UI because the fallback never fires. Publishing a bundle that
 * cannot rebuild itself must fail here, loudly, instead.
 */
async function bundleManagementUiSource(): Promise<void> {
  const { existsSync, cpSync, rmSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs')
  const uiDir = join(__dirname, '..', 'ui')
  if (!existsSync(join(uiDir, 'pages'))) {
    console.warn('UI source bundle: packages/ui/pages not found — skipping.')
    return
  }

  const dest = join(__dirname, 'dist', 'ui-src')
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(join(dest, 'src'), { recursive: true })

  // Ship the page templates (and their partials) verbatim.
  cpSync(join(uiDir, 'pages'), join(dest, 'pages'), { recursive: true })

  // The composables are plain TypeScript with no npm imports, so they ship as
  // they are. Tests stay behind — they would drag `bun:test` into the bundle.
  mkdirSync(join(dest, 'functions'), { recursive: true })
  for (const entry of readdirSync(join(uiDir, 'functions'))) {
    if (!entry.endsWith('.ts') || entry.includes('.test.')) continue
    cpSync(join(uiDir, 'functions', entry), join(dest, 'functions', entry))
  }

  // Vendor each src/ module into a dependency-free one, so the only thing the
  // box needs to rebuild the UI is stx itself (no @ts-charts install).
  for (const entry of readdirSync(join(uiDir, 'src'))) {
    if (!entry.endsWith('.ts') || entry.includes('.test.')) continue
    const bundled = await Bun.build({
      entrypoints: [join(uiDir, 'src', entry)],
      target: 'node',
      format: 'esm',
      minify: false,
    })
    if (!bundled.success || bundled.outputs.length === 0) {
      console.warn(`UI source bundle: bundling src/${entry} failed — skipping ui-src.`)
      rmSync(dest, { recursive: true, force: true })
      return
    }
    writeFileSync(join(dest, 'src', entry), await bundled.outputs[0].text())
  }

  // Minimal package.json so resolveUiSourceDir detects the bundle and stx builds it.
  writeFileSync(
    join(dest, 'package.json'),
    `${JSON.stringify({ name: '@ts-cloud/ui', type: 'module', private: true }, null, 2)}\n`,
  )

  const missing = missingUiSourceImports(dest, readdirSync, readFileSync, existsSync)
  if (missing.length) {
    rmSync(dest, { recursive: true, force: true })
    throw new Error(
      `UI source bundle is incomplete — the box could not rebuild the cockpit from it. Missing:\n  ${missing.join('\n  ')}`,
    )
  }
  console.warn(`UI source bundle: shipped live-rebuildable source → ${dest}`)
}

/**
 * Every `../../…` import the shipped pages make, that the bundle does not
 * actually contain. Keeps a new page's helper from being left behind.
 */
function missingUiSourceImports(
  dest: string,
  readdirSync: typeof import('node:fs').readdirSync,
  readFileSync: typeof import('node:fs').readFileSync,
  existsSync: typeof import('node:fs').existsSync,
): string[] {
  const pages: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.stx')) pages.push(path)
    }
  }
  walk(join(dest, 'pages'))

  const missing = new Set<string>()
  for (const page of pages) {
    const source = readFileSync(page, 'utf8')
    for (const match of source.matchAll(/from\s+'(\.\.\/[^']+)'/g)) {
      const target = join(dirname(page), match[1])
      if (!existsSync(target)) missing.add(`${match[1]} (imported by ${page.slice(dest.length + 1)})`)
    }
  }
  return [...missing].sort()
}

build()
