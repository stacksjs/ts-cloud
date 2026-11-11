/**
 * A stand-in for `kubectl` and `ssh`, installed on PATH under both names by
 * the tests. It appends the argv it was given to `$FAKE_BIN_LOG` (one JSON
 * line per call) and then behaves just enough like the real tool for stream
 * handling to be observable.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const name = process.env.FAKE_BIN_NAME ?? basename(process.argv[1]!)
const argv = process.argv.slice(2)
appendFileSync(process.env.FAKE_BIN_LOG!, `${JSON.stringify({ name, argv })}\n`)

const fixtures = process.env.FAKE_BIN_FIXTURES!
const out = (text: string) => process.stdout.write(text)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  if (name === 'ssh') {
    // The real sshd hands the last argument to the login shell. Doing the same
    // proves the quoted command line parses back into the argv it was built from.
    const child = Bun.spawn(['sh', '-c', argv[argv.length - 1]!], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
    process.exit(await child.exited)
  }

  // Skip the cluster flags to find the verb.
  const rest = [...argv]
  while (rest[0] === '--kubeconfig' || rest[0] === '--context') rest.splice(0, 2)
  const verb = rest[0] === 'config' || rest[0] === 'get' ? `${rest[0]} ${rest[1]}` : rest[0]

  if (argv.includes('boom') || process.env.FAKE_KUBECTL_FAIL === verb) {
    process.stderr.write('error: the server has asked for the client to provide credentials\n')
    process.exit(1)
  }

  switch (verb) {
    case 'config get-contexts':
      out('prod-eu\nstaging\n')
      break
    case 'config current-context':
      out('staging\n')
      break
    case 'get namespaces':
      out(readFileSync(join(fixtures, 'kubectl-namespaces.json'), 'utf8'))
      break
    case 'get pods':
      out(readFileSync(join(fixtures, 'kubectl-pods.json'), 'utf8'))
      break
    case 'exec': {
      const input = argv.includes('--stdin') ? await Bun.stdin.text() : '(no stdin)'
      out(`ran: ${input}`)
      process.stderr.write('warning: from the container\n')
      process.exit(input.includes('exit 3') ? 3 : 0)
    }
    // eslint-disable-next-line no-fallthrough
    case 'logs':
      out('2026-11-11T10:00:00Z first\n')
      out('2026-11-11T10:00:01Z café\n')
      if (argv.includes('--follow')) {
        for (let tick = 0; ; tick++) {
          await sleep(20)
          out(`tick ${tick}\n`)
        }
      }
      break
    default:
      process.stderr.write(`error: unknown command "${verb}"\n`)
      process.exit(1)
  }
}

main()
