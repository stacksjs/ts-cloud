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
}

build()
