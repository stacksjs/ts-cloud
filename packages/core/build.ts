import { dts } from 'bun-plugin-dtsx'

async function build() {
  await Bun.build({
    entrypoints: ['./src/index.ts'],
    outdir: './dist',
    plugins: [dts()],
  })
}

build()
