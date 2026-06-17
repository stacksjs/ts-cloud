/**
 * ts-cloud JS Lambda custom-runtime loop (provided.al2023).
 *
 * Shared by both the Node and Bun custom runtimes — it is plain ESM that runs
 * under either `node /opt/runtime.mjs` or `bun /opt/runtime.mjs`. It implements
 * the AWS Lambda Runtime API event loop and delegates each invocation to the
 * handler exported by the deployment artifact (the ts-cloud serverless adapter
 * already bundled `http`/`queue`/`cli` into `index.mjs`).
 *
 * The function's configured Handler (e.g. `index.http`) arrives as `_HANDLER`,
 * so the same artifact + layer serve all three functions; only `_HANDLER`
 * differs per function.
 */

const RUNTIME_API = process.env.AWS_LAMBDA_RUNTIME_API
const BASE = `http://${RUNTIME_API}/2018-06-01/runtime`
const TASK_ROOT = process.env.LAMBDA_TASK_ROOT ?? '/var/task'
const HANDLER = process.env._HANDLER ?? 'index.http'

async function resolveHandler() {
  const lastDot = HANDLER.lastIndexOf('.')
  const file = lastDot === -1 ? HANDLER : HANDLER.slice(0, lastDot)
  const exportName = lastDot === -1 ? 'http' : HANDLER.slice(lastDot + 1)

  let mod
  for (const ext of ['.mjs', '.js', '.cjs', '']) {
    try {
      mod = await import(`${TASK_ROOT}/${file}${ext}`)
      break
    }
    catch {
      // try the next extension
    }
  }
  if (!mod)
    throw new Error(`Cannot load handler module "${file}" from ${TASK_ROOT}`)

  const fn = mod[exportName] ?? mod.default?.[exportName] ?? mod.default
  if (typeof fn !== 'function')
    throw new TypeError(`Handler "${HANDLER}" did not resolve to a function`)
  return fn
}

async function postInitError(err) {
  await fetch(`${BASE}/init/error`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ errorType: err?.name ?? 'InitError', errorMessage: String(err?.message ?? err) }),
  }).catch(() => {})
}

async function main() {
  let handler
  try {
    handler = await resolveHandler()
  }
  catch (err) {
    await postInitError(err)
    process.exit(1)
    return
  }

  // The Runtime API event loop: long-poll for the next invocation, run the
  // handler, post the response (or error), repeat.
  for (;;) {
    const next = await fetch(`${BASE}/invocation/next`)
    const requestId = next.headers.get('lambda-runtime-aws-request-id')
    if (!requestId) continue

    let event
    try {
      event = await next.json()
    }
    catch {
      event = {}
    }

    try {
      const result = await handler(event)
      await fetch(`${BASE}/invocation/${requestId}/response`, {
        method: 'POST',
        body: result === undefined ? '' : JSON.stringify(result),
      })
    }
    catch (err) {
      await fetch(`${BASE}/invocation/${requestId}/error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ errorType: err?.name ?? 'Error', errorMessage: String(err?.message ?? err) }),
      }).catch(() => {})
    }
  }
}

main()
