/**
 * Single entry exporting the three handlers the ts-cloud serverless adapter
 * bridges to API Gateway (fetch), SQS (queue), and EventBridge/CLI (cli).
 */
export default {
  fetch(req: Request): Response {
    const url = new URL(req.url)
    return Response.json({ ok: true, path: url.pathname, method: req.method })
  },

  queue(payload: unknown): void {
    // Process one SQS job. Throw to signal failure (the message is retried / DLQ'd).
    console.log('processing job', payload)
  },

  cli(event: { command: string }): { statusCode: number, output: string } {
    // Handles scheduled `schedule:run` and on-demand `cloud command "..."`.
    console.log('running command', event.command)
    return { statusCode: 0, output: `ran ${event.command}` }
  },
}
