/**
 * Bundle a Worker's entry into the single ES module Cloudflare runs.
 *
 * `Bun.build` does the work, with the settings that match the Workers
 * runtime: `target: 'browser'` (Workers expose web APIs, not Node's), `format:
 * 'esm'` (module Workers export a default handler object), and minified,
 * since the upload is size-capped. `cloudflare:*` imports
 * (`cloudflare:workers`, `cloudflare:sockets`) are provided by the runtime, so
 * they are left as imports rather than resolved.
 *
 * The upload path assumes exactly one module. A build that splits into chunks
 * or emits assets (an imported image, a `.wasm` file) is refused with the list
 * of files rather than uploading half a Worker.
 */
import type { WorkerModule } from './provider'
import { basename, extname } from 'node:path'
import { WORKER_MODULE_TYPE } from './provider'

export interface BundledWorker extends WorkerModule {
  /** Size of the module in bytes, as uploaded. */
  size: number
}

/**
 * Bundle `entryAbsolutePath` into one module, named after the entry
 * (`workers/tiles.ts` becomes `tiles.js`).
 *
 * @throws {Error} When the entry does not exist, the build fails (with Bun's
 * messages), or it produces anything other than one JavaScript file
 */
export async function bundleWorker(entryAbsolutePath: string): Promise<BundledWorker> {
  if (!(await Bun.file(entryAbsolutePath).exists()))
    throw new Error(`Worker entry not found: ${entryAbsolutePath}`)

  let result: Awaited<ReturnType<typeof Bun.build>>
  try {
    result = await Bun.build({
      entrypoints: [entryAbsolutePath],
      target: 'browser',
      format: 'esm',
      minify: true,
      external: ['cloudflare:*'],
    })
  }
  catch (error) {
    // Bun throws an AggregateError of build messages rather than returning
    // success: false in recent versions; both read the same to the caller.
    throw new Error(`Bundling Worker ${entryAbsolutePath} failed: ${buildMessages(error)}`)
  }

  if (!result.success)
    throw new Error(`Bundling Worker ${entryAbsolutePath} failed: ${result.logs.map(log => String(log.message ?? log)).join('; ')}`)

  if (result.outputs.length !== 1) {
    throw new Error(
      `Bundling Worker ${entryAbsolutePath} produced ${result.outputs.length} files (${result.outputs.map(output => output.path).join(', ')}); `
      + 'a Worker is uploaded as a single module, so remove the dynamic imports or asset imports that split it.',
    )
  }

  const output = result.outputs[0]!
  if (output.kind !== 'entry-point')
    throw new Error(`Bundling Worker ${entryAbsolutePath} produced a ${output.kind} instead of an entry module`)

  const content = await output.text()
  return {
    name: `${basename(entryAbsolutePath, extname(entryAbsolutePath))}.js`,
    content,
    type: WORKER_MODULE_TYPE,
    size: new TextEncoder().encode(content).byteLength,
  }
}

/** Bun's build failure, as one line. */
function buildMessages(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0)
    return error.errors.map(entry => (entry instanceof Error ? entry.message : String((entry as { message?: string })?.message ?? entry))).join('; ')
  return error instanceof Error ? error.message : String(error)
}
