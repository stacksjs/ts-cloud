import { join } from 'node:path'

const __dirname = import.meta.dirname

async function build() {
  // Build the library root AND every subpath entry point declared in the
  // package.json exports map ("./aws", "./deploy", "./dns", "./drivers",
  // "./push"). Bundling only src/index.ts leaves those subpaths as .d.ts-only
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
      join(__dirname, 'src/push/index.ts'),
    ],
    outdir: join(__dirname, 'dist'),
    root: join(__dirname, 'src'),
    target: 'node',
    format: 'esm',
    splitting: true,
    minify: false,
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

  // Build CLI entry point
  const cliResult = await Bun.build({
    entrypoints: [join(__dirname, 'bin/cli.ts')],
    outdir: join(__dirname, 'dist/bin'),
    target: 'node',
    format: 'esm',
    splitting: false,
    minify: true,
  })

  if (!cliResult.success) {
    console.error('CLI build failed:')
    for (const log of cliResult.logs) {
      console.error(log)
    }
    process.exit(1)
  }

  // Bundle the management dashboard (the @ts-cloud/ui stx app) into the package so
  // `cloud deploy` can auto-ship it from any consumer project (no local packages/ui).
  await bundleManagementUi()

  // Also ship the UI *source* (templates + a vendored, dependency-free charts
  // module) so `cloud dashboard:serve` / `buddy cloud:dashboard` can rebuild the
  // cockpit with LIVE data in any consumer project that has the stx toolchain
  // (Stacks projects do) — not just the prebuilt sample-data HTML.
  await bundleManagementUiSource()
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
 * Ship the UI templates + a self-contained `charts.ts` (with `@ts-charts/charts`
 * inlined) at `dist/ui-src/`. The local dashboard server rebuilds this with the
 * project's live data at serve time using the host's stx toolchain, so the
 * cockpit shows REAL data everywhere — not the prebuilt sample-data fallback.
 */
async function bundleManagementUiSource(): Promise<void> {
  const { existsSync, cpSync, rmSync, mkdirSync, writeFileSync } = await import('node:fs')
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

  // Vendor src/charts.ts into a dependency-free module so the only thing needed
  // to rebuild the UI at serve time is stx itself (no @ts-charts/charts install).
  const charts = await Bun.build({
    entrypoints: [join(uiDir, 'src', 'charts.ts')],
    target: 'node',
    format: 'esm',
    minify: false,
  })
  if (!charts.success || charts.outputs.length === 0) {
    console.warn('UI source bundle: charts bundling failed — skipping ui-src.')
    rmSync(dest, { recursive: true, force: true })
    return
  }
  writeFileSync(join(dest, 'src', 'charts.ts'), await charts.outputs[0].text())

  // Minimal package.json so resolveUiSourceDir detects the bundle and stx builds it.
  writeFileSync(
    join(dest, 'package.json'),
    `${JSON.stringify({ name: '@ts-cloud/ui', type: 'module', private: true }, null, 2)}\n`,
  )
  console.warn(`UI source bundle: shipped live-rebuildable source → ${dest}`)
}

build()
