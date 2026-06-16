#!/usr/bin/env bun
/**
 * Generate the golden-image bake recipe from the project's cloud config and
 * write it to `images/recipe.sh`. Packer (or a manual snapshot run) executes
 * this on a base Ubuntu box to pre-install the full ts-cloud stack, then
 * snapshots it into a Hetzner snapshot / AWS AMI.
 *
 * Usage:
 *   bun run scripts/build-image.ts            # writes images/recipe.sh
 *   bun run scripts/build-image.ts --print    # print to stdout
 *
 * Then build + publish the image:
 *   packer build images/packer/hetzner.pkr.hcl   # → Hetzner snapshot
 *   packer build images/packer/aws.pkr.hcl       # → AWS AMI
 *
 * Reference the resulting image in cloud.config.ts:
 *   compute: { image: '<snapshot-or-ami-id>', bakedImage: true }
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfig } from '../packages/ts-cloud/src/config'
import { buildImageRecipe } from '../packages/ts-cloud/src/drivers/shared/image-recipe'

async function main(): Promise<void> {
  const config = await getConfig()
  const recipe = buildImageRecipe(config as any)

  if (process.argv.includes('--print')) {
    process.stdout.write(`${recipe}\n`)
    return
  }

  const out = join(process.cwd(), 'images', 'recipe.sh')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, recipe, { mode: 0o755 })
  // eslint-disable-next-line no-console
  console.log(`Wrote golden-image bake recipe → ${out}\n\nNext:\n  packer build images/packer/hetzner.pkr.hcl   # Hetzner snapshot\n  packer build images/packer/aws.pkr.hcl       # AWS AMI\nThen set compute.image + compute.bakedImage:true in cloud.config.ts`)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
