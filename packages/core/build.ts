async function build() {
  const result = await Bun.build({
    entrypoints: ['./src/index.ts'],
    outdir: './dist',
    target: 'node',
    format: 'esm',
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }

  const declarations = Bun.spawn(
    ['bunx', 'tsc', '-p', 'tsconfig.json', '--emitDeclarationOnly', '--noEmit', 'false', '--declarationMap', 'false'],
    {
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )

  const exitCode = await declarations.exited
  if (exitCode !== 0) process.exit(exitCode)

  // The serverless pipeline reads several asset SOURCES at runtime by path
  // relative to the module (which, bundled, is dist/index.js → dist/). Copy
  // them into dist so packaging/layer-building works from the published package,
  // not just from the source tree.
  copyRuntimeAssets()
}

function copyRuntimeAssets(): void {
  const { mkdirSync, cpSync } = require('node:fs') as typeof import('node:fs')
  const src = `${import.meta.dir}/src`
  const dist = `${import.meta.dir}/dist`

  // Node/Bun runtime adapter (copied beside a generated bootstrap, then bundled).
  mkdirSync(`${dist}/runtime`, { recursive: true })
  cpSync(`${src}/serverless/runtime/adapter.ts`, `${dist}/runtime/adapter.ts`)

  // Shared Node/Bun custom-runtime loop + bootstraps (consumed by the layer builders).
  for (const f of ['runtime.mjs', 'node-bootstrap', 'bun-bootstrap'])
    cpSync(`${src}/serverless/runtimes/${f}`, `${dist}/${f}`)

  // PHP runtime assets (bootstrap, runtime loops, FastCGI client).
  cpSync(`${src}/serverless-php/runtime-assets`, `${dist}/runtime-assets`, { recursive: true })
}

build()
