#!/usr/bin/env bun
/**
 * Builds the Bun custom-runtime Lambda layer zip.
 *
 * Downloads a pinned Bun release for the target architecture and assembles a
 * layer containing:
 *   bootstrap     -> /opt/bootstrap   (entrypoint Lambda invokes)
 *   bin/bun       -> /opt/bin/bun     (the Bun binary)
 *   runtime.ts    -> /opt/runtime.ts  (Runtime API <-> fetch adapter)
 *
 * Output: bun-lambda-layer-<arch>.zip  — publish it with deploy.ts.
 *
 * Usage:
 *   bun build-layer.ts [--arch arm64|x86_64] [--bun-version 1.3.13]
 *
 * Requires the `unzip` and `zip` CLIs (preinstalled on macOS and most Linux).
 */
import { rm } from 'node:fs/promises'
import { $ } from 'bun'

const args = process.argv.slice(2)
function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

const arch = flag('arch', 'arm64') // arm64 (Graviton, ~20% cheaper) | x86_64
const bunVersion = flag('bun-version', '1.3.13')
const bunTarget = arch === 'arm64' ? 'bun-linux-aarch64' : 'bun-linux-x64'

const here = import.meta.dir
const work = `${here}/.layer-build`
const out = `${here}/bun-lambda-layer-${arch}.zip`

async function main(): Promise<void> {
  console.log(`Building Bun ${bunVersion} runtime layer for ${arch}...`)

  await rm(work, { recursive: true, force: true })
  await $`mkdir -p ${work}/bin`

  // 1. Download the pinned Bun release for the Lambda architecture.
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${bunTarget}.zip`
  console.log(`Downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok)
    throw new Error(`Download failed: ${res.status} ${res.statusText} (${url})`)
  await Bun.write(`${work}/${bunTarget}.zip`, await res.arrayBuffer())

  // 2. Extract the bun binary.
  await $`unzip -o -q ${work}/${bunTarget}.zip -d ${work}`
  await $`cp ${work}/${bunTarget}/bun ${work}/bin/bun`
  await $`chmod 755 ${work}/bin/bun`

  // 3. Add the runtime loop + bootstrap (both must be executable / present at /opt).
  await $`cp ${here}/layer/runtime.ts ${work}/runtime.ts`
  await $`cp ${here}/layer/bootstrap ${work}/bootstrap`
  await $`chmod 755 ${work}/bootstrap`

  // 4. Zip the layer, preserving the executable bits on bootstrap and bin/bun.
  await rm(out, { force: true })
  await $`cd ${work} && zip -r -q -X ${out} bootstrap bin runtime.ts`

  const mb = (Bun.file(out).size / 1024 / 1024).toFixed(1)
  console.log(`\n✓ Layer built: ${out} (${mb} MB zipped)`)
  console.log(`  Bun binary is ~90 MB unzipped — well under Lambda's 250 MB limit.`)
  console.log(`  Next: AWS_PROFILE=stacks bun deploy.ts --arch ${arch}`)
}

main().catch((err) => {
  console.error('Layer build failed:', err)
  process.exit(1)
})
