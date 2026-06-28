import { join } from 'node:path'

const __dirname = import.meta.dirname

async function build() {
  // Build library with types generation
  const libResult = await Bun.build({
    entrypoints: [join(__dirname, 'src/index.ts')],
    outdir: join(__dirname, 'dist'),
    root: join(__dirname, 'src'),
    target: 'node',
    format: 'esm',
    splitting: false,
    minify: false,
  })

  if (!libResult.success) {
    console.error('Library build failed:')
    for (const log of libResult.logs) {
      console.error(log)
    }
    process.exit(1)
  }

  const declarations = Bun.spawn([
    'bunx',
    'tsc',
    '-p',
    join(__dirname, 'tsconfig.json'),
    '--emitDeclarationOnly',
    '--noEmit',
    'false',
    '--declarationMap',
    'false',
  ], {
    stdout: 'inherit',
    stderr: 'inherit',
  })

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

build()
