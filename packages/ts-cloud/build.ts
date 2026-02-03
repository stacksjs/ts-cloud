import { dts } from 'bun-plugin-dtsx'
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
    minify: true,
    plugins: [dts()],
  })

  if (!libResult.success) {
    console.error('Library build failed:')
    for (const log of libResult.logs) {
      console.error(log)
    }
  }

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
  }
}

build()
