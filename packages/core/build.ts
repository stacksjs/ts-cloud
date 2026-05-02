async function build() {
  const result = await Bun.build({
    entrypoints: ['./src/index.ts'],
    outdir: './dist',
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }

  const declarations = Bun.spawn([
    'bunx',
    'tsc',
    '-p',
    'tsconfig.json',
    '--emitDeclarationOnly',
    '--noEmit',
    'false',
    '--declarationMap',
    'false',
  ], {
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const exitCode = await declarations.exited
  if (exitCode !== 0) process.exit(exitCode)
}

build()
