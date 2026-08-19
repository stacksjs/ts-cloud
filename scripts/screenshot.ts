#!/usr/bin/env bun
/**
 * Screenshot the ts-cloud management dashboard with Bun's built-in WebView.
 *
 * Usage:
 *   # start the dashboard yourself, then:
 *   bun scripts/screenshot.ts http://127.0.0.1:7676 ./shots /serverless /serverless/queues /server/sites
 *
 * Each path is captured with a fresh WebView (most reliable). Output is written
 * as <path-slug>.png in <outDir>.
 *
 * Note: `WebView.screenshot()` requires a Bun build whose WebView is healthy
 * (stable 1.3.14+). Some canary builds panic in the screenshot path; if you hit
 * `panic: index out of bounds`, run this with a stable `bun`.
 *
 * Docs: https://bun.com/reference/bun/WebView/screenshot
 */

const [base, outDir, ...paths] = process.argv.slice(2)

if (!base || !outDir || paths.length === 0) {
  console.error('usage: bun scripts/screenshot.ts <baseUrl> <outDir> <path...>')
  process.exit(1)
}

const WIDTH = Number(process.env.SHOT_WIDTH ?? 1440)
const HEIGHT = Number(process.env.SHOT_HEIGHT ?? 1600)
const SETTLE_MS = Number(process.env.SHOT_SETTLE_MS ?? 2500)

function slug(path: string): string {
  return path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'index'
}

for (const path of paths) {
  const url = `${base}${path}`
  const out = `${outDir}/${slug(path)}.png`
  const view = new Bun.WebView({ url, width: WIDTH, height: HEIGHT })
  try {
    // Give the SPA time to hydrate and render live data before capturing.
    await Bun.sleep(SETTLE_MS)
    const buf = await view.screenshot({ encoding: 'buffer', format: 'png' })
    await Bun.write(out, buf as Uint8Array)
    console.log(`captured ${url} -> ${out}`)
  } catch (error: any) {
    console.error(`failed ${url}: ${error?.message ?? error}`)
  } finally {
    view.close()
  }
}
