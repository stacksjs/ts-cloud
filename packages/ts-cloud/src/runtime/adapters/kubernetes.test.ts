import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interactiveSshOptions } from '../../drivers/shared/ssh-transport'
import { pumpProcessStream } from '../process-stream'
import { RuntimeStreamRegistry } from '../streams'
import {
  buildKubectlCommand,
  KubectlClient,
  kubectlExecArgs,
  kubectlLogsArgs,
  kubectlPodsArgs,
  KubernetesDiscoveryAdapter,
  kubernetesWorkloads,
  parseKubectlContexts,
  parseKubectlNamespaces,
  parseKubectlPods,
} from './kubernetes'

/**
 * These run a real child process: a fake `kubectl` and a fake `ssh` are put
 * first on PATH and record the argv they receive. Asserting on a builder's
 * return value would only prove the builder agrees with itself; what matters
 * is what the binary is handed, and that a name with a space or a quote in it
 * is still one argument when it gets there, locally and through a remote shell.
 */

const fixtures = join(import.meta.dir, '..', 'fixtures')
const bin = mkdtempSync(join(tmpdir(), 'ts-cloud-fake-bin-'))
const log = join(bin, 'calls.log')
const originalPath = process.env.PATH
const saved: Record<string, string | undefined> = {}

function calls(): Array<{ name: string; argv: string[] }> {
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

beforeAll(() => {
  // The shim is named kubectl/ssh but runs one script: tell it who it is.
  for (const name of ['kubectl', 'ssh']) {
    const file = join(bin, name)
    writeFileSync(file, `#!/bin/sh\nFAKE_BIN_NAME=${name} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(fixtures, 'fake-bin.ts'))} "$@"\n`)
    chmodSync(file, 0o755)
  }
  for (const key of ['FAKE_BIN_LOG', 'FAKE_BIN_FIXTURES', 'FAKE_KUBECTL_FAIL']) saved[key] = process.env[key]
  process.env.PATH = `${bin}:${originalPath}`
  process.env.FAKE_BIN_LOG = log
  process.env.FAKE_BIN_FIXTURES = fixtures
})

afterAll(() => {
  process.env.PATH = originalPath
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(bin, { recursive: true, force: true })
})

beforeEach(() => {
  writeFileSync(log, '')
  delete process.env.FAKE_KUBECTL_FAIL
})

const via = {
  host: '203.0.113.10',
  ssh: interactiveSshOptions({ user: 'deploy', identityFile: '/keys/id_ed25519', knownHostsFile: '/state/ssh/known_hosts' }),
}

/** The ssh options every remote call carries, in order, before the command line. */
const SSH_PREFIX = [
  '-i',
  '/keys/id_ed25519',
  '-p',
  '22',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'UserKnownHostsFile=/state/ssh/known_hosts',
  '-o',
  'LogLevel=ERROR',
  '-o',
  'ConnectTimeout=30',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=4',
  '-o',
  'BatchMode=yes',
  '-T',
  'deploy@203.0.113.10',
]

describe('kubectl argv', () => {
  it('puts the cluster flags first and nothing else', () => {
    expect(buildKubectlCommand({}, ['get', 'pods'])).toEqual(['kubectl', 'get', 'pods'])
    expect(buildKubectlCommand({ kubeconfig: '/k/config', context: 'prod-eu', binary: '/opt/bin/kubectl' }, ['get', 'pods'])).toEqual([
      '/opt/bin/kubectl',
      '--kubeconfig',
      '/k/config',
      '--context',
      'prod-eu',
      'get',
      'pods',
    ])
  })

  it('keeps the container command after --, where kubectl stops parsing', () => {
    expect(kubectlExecArgs({ namespace: 'shop', pod: 'web-0', container: 'app', command: ['bun', 'run', '-', '--namespace', 'x'], stdin: true })).toEqual([
      'exec',
      '--stdin',
      '--namespace',
      'shop',
      '--container',
      'app',
      'web-0',
      '--',
      'bun',
      'run',
      '-',
      '--namespace',
      'x',
    ])
    expect(kubectlExecArgs({ namespace: 'shop', pod: 'web-0', command: ['id'] })).toEqual(['exec', '--namespace', 'shop', 'web-0', '--', 'id'])
  })

  it('refuses a name that would be read as a flag', () => {
    expect(() => kubectlExecArgs({ namespace: 'shop', pod: '--kubeconfig=/etc/shadow', command: ['id'] })).toThrow(/cannot start with '-'/)
    expect(() => kubectlExecArgs({ namespace: '-n', pod: 'web-0', command: ['id'] })).toThrow(/namespace/)
    expect(() => kubectlLogsArgs({ namespace: 'shop', pod: 'web-0', container: '-c' })).toThrow(/container/)
    expect(() => buildKubectlCommand({ context: '--server=evil' }, ['get', 'pods'])).toThrow(/context/)
    expect(() => kubectlExecArgs({ namespace: 'shop', pod: 'web-0', command: [] })).toThrow(/needs a command/)
  })

  it('builds logs arguments and validates the ones kubectl would misread', () => {
    expect(kubectlLogsArgs({ namespace: 'shop', pod: 'web-0', container: 'app', follow: true, tail: 100, since: '5m', timestamps: true })).toEqual([
      'logs',
      '--namespace',
      'shop',
      '--container',
      'app',
      '--follow',
      '--tail',
      '100',
      '--since',
      '5m',
      '--timestamps',
      'web-0',
    ])
    expect(kubectlLogsArgs({ namespace: 'shop', pod: 'web-0', allContainers: true, previous: true, since: new Date('2026-11-11T10:00:00Z') })).toEqual([
      'logs',
      '--namespace',
      'shop',
      '--all-containers',
      '--prefix',
      '--since-time',
      '2026-11-11T10:00:00.000Z',
      '--previous',
      'web-0',
    ])
    expect(() => kubectlLogsArgs({ namespace: 'shop', pod: 'web-0', since: '5 minutes; rm -rf /' })).toThrow(/duration/)
    expect(() => kubectlLogsArgs({ namespace: 'shop', pod: 'web-0', tail: -1 })).toThrow(/tail/)
  })

  it('scopes a pod listing', () => {
    expect(kubectlPodsArgs()).toEqual(['get', 'pods', '--output', 'json'])
    expect(kubectlPodsArgs({ namespace: 'shop', selector: 'app=web' }, '10s')).toEqual([
      'get',
      'pods',
      '--namespace',
      'shop',
      '--selector',
      'app=web',
      '--request-timeout',
      '10s',
      '--output',
      'json',
    ])
    expect(kubectlPodsArgs({ namespace: 'shop', allNamespaces: true })).toEqual(['get', 'pods', '--all-namespaces', '--output', 'json'])
  })
})

describe('kubectl output parsing', () => {
  const pods = parseKubectlPods(readFileSync(join(fixtures, 'kubectl-pods.json'), 'utf8'))

  it('lists pods with their containers and the status a person would read', () => {
    expect(pods.map((pod) => [pod.namespace, pod.name, pod.status])).toEqual([
      ['shop', 'web-5d4f7c9b8-x2k4p', 'Running'],
      // The phase says Running. The container says otherwise, and that is the one to show.
      ['shop', 'worker-0', 'CrashLoopBackOff'],
    ])
    const web = pods[0]!
    expect(web.containers.map((c) => [c.name, c.type, c.state, c.ready, c.restartCount])).toEqual([
      ['proxy', 'container', 'running', true, 0],
      ['app', 'container', 'running', true, 1],
      ['migrate', 'init', 'terminated', true, 0],
    ])
    expect(web.owner).toBe('ReplicaSet/web-5d4f7c9b8')
    expect(web.node).toBe('node-a')
    expect(web.podIp).toBe('10.42.0.17')
  })

  it('picks the default container the way kubectl does', () => {
    // Annotated: not the first declared.
    expect(pods[0]!.defaultContainer).toBe('app')
    expect(pods[1]!.defaultContainer).toBe('worker')
  })

  it('parses contexts and namespaces', () => {
    expect(parseKubectlContexts('prod-eu\nstaging\n\n', 'staging\n')).toEqual([
      { name: 'prod-eu', current: false },
      { name: 'staging', current: true },
    ])
    expect(parseKubectlNamespaces(readFileSync(join(fixtures, 'kubectl-namespaces.json'), 'utf8')).map((ns) => [ns.name, ns.phase])).toEqual([
      ['default', 'Active'],
      ['old', 'Terminating'],
      ['shop', 'Active'],
    ])
  })

  it('treats empty output as nothing and a non-list as an error', () => {
    expect(parseKubectlPods('')).toEqual([])
    expect(() => parseKubectlPods('{"kind":"Status"}')).toThrow(/List/)
  })

  it('maps pods onto runtime workloads', () => {
    const workloads = kubernetesWorkloads(pods, { project: 'acme', environment: 'production', now: new Date('2026-11-11T12:00:00Z') }, 'kubernetes:prod-eu')
    expect(workloads.map((w) => [w.provider, w.kind, w.name, w.status, w.health])).toEqual([
      ['kubernetes', 'pod', 'web-5d4f7c9b8-x2k4p', 'running', 'healthy'],
      ['kubernetes', 'pod', 'worker-0', 'failed', 'unhealthy'],
    ])
    const web = workloads[0]!
    expect(web.links.providerId).toBe('shop/web-5d4f7c9b8-x2k4p')
    expect(web.links.service).toBe('web')
    expect(web.image).toBe('registry.example/web:1.4.2')
    expect(web.restartCount).toBe(1)
    expect(web.replicas[0]!.containers!.map((c) => c.name)).toEqual(['proxy', 'app', 'migrate'])
    expect(web.capabilities.exec.supported).toBe(true)
    expect(web.capabilities.restart.supported).toBe(false)
    expect(workloads[1]!.restartCount).toBe(12)
  })

  it('discovers through an injected reader, like the docker adapter', async () => {
    const adapter = new KubernetesDiscoveryAdapter(async () => readFileSync(join(fixtures, 'kubectl-pods.json'), 'utf8'), 'kubernetes:staging')
    const workloads = await adapter.discover({})
    expect(adapter.provider).toBe('kubernetes')
    expect(workloads).toHaveLength(2)
    expect(workloads[0]!.sourceId).toBe('kubernetes:staging')
  })
})

describe('KubectlClient against a fake kubectl on PATH', () => {
  it('lists contexts without contacting a cluster and flags the current one', async () => {
    const client = new KubectlClient({ kubeconfig: '/k/config' })
    expect(await client.listContexts()).toEqual([
      { name: 'prod-eu', current: false },
      { name: 'staging', current: true },
    ])
    expect(calls()).toEqual([
      { name: 'kubectl', argv: ['--kubeconfig', '/k/config', 'config', 'get-contexts', '--output', 'name'] },
      { name: 'kubectl', argv: ['--kubeconfig', '/k/config', 'config', 'current-context'] },
    ])
  })

  it('reports the selected context as current without asking', async () => {
    const client = new KubectlClient().withContext('prod-eu')
    expect((await client.listContexts()).find((c) => c.current)?.name).toBe('prod-eu')
    expect(calls()).toHaveLength(1)
  })

  it('lists namespaces and pods with the exact argv', async () => {
    const client = new KubectlClient({ context: 'prod-eu', requestTimeout: '10s' })
    expect((await client.listNamespaces()).map((ns) => ns.name)).toEqual(['default', 'old', 'shop'])
    expect((await client.listPods({ namespace: 'shop' })).map((pod) => pod.name)).toEqual(['web-5d4f7c9b8-x2k4p', 'worker-0'])
    expect(calls().map((call) => call.argv)).toEqual([
      ['--context', 'prod-eu', 'get', 'namespaces', '--request-timeout', '10s', '--output', 'json'],
      ['--context', 'prod-eu', 'get', 'pods', '--namespace', 'shop', '--request-timeout', '10s', '--output', 'json'],
    ])
  })

  it('rejects a failed listing with kubectl\'s own message', async () => {
    process.env.FAKE_KUBECTL_FAIL = 'get pods'
    await expect(new KubectlClient().listPods()).rejects.toThrow('kubectl get pods failed: the server has asked for the client to provide credentials')
  })

  it('pipes stdin to exec and keeps stdout and stderr apart', async () => {
    const script = 'console.log("it\'s $HOME")\n'
    const stream = new KubectlClient({ context: 'prod-eu' }).exec({
      namespace: 'shop',
      pod: 'web-0',
      container: 'app',
      command: ['bun', 'run', '-'],
      stdin: script,
    })
    const chunks: Array<{ stream: string; data: string }> = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(await stream.exited).toEqual({ code: 0, signal: null })
    expect(chunks.filter((c) => c.stream === 'stdout').map((c) => c.data).join('')).toBe(`ran: ${script}`)
    expect(chunks.filter((c) => c.stream === 'stderr').map((c) => c.data).join('')).toBe('warning: from the container\n')
    // The script went over stdin: it is nowhere in the argv.
    expect(calls()).toEqual([
      { name: 'kubectl', argv: ['--context', 'prod-eu', 'exec', '--stdin', '--namespace', 'shop', '--container', 'app', 'web-0', '--', 'bun', 'run', '-'] },
    ])
    expect(stream.command).toEqual(['kubectl', '--context', 'prod-eu', 'exec', '--stdin', '--namespace', 'shop', '--container', 'app', 'web-0', '--', 'bun', 'run', '-'])
  })

  it('reports a non-zero exit through exited, with the output kept', async () => {
    const result = await new KubectlClient().exec({ namespace: 'shop', pod: 'web-0', command: ['sh'], stdin: 'exit 3' }).collect()
    expect(result).toEqual({ code: 3, signal: null, stdout: 'ran: exit 3', stderr: 'warning: from the container\n' })
  })

  it('does not pass --stdin when there is nothing to pipe', async () => {
    const result = await new KubectlClient().exec({ namespace: 'shop', pod: 'web-0', command: ['id'] }).collect()
    expect(result.stdout).toBe('ran: (no stdin)')
    expect(calls()[0]!.argv).toEqual(['exec', '--namespace', 'shop', 'web-0', '--', 'id'])
  })

  it('accepts stdin written incrementally', async () => {
    const stream = new KubectlClient().exec({ namespace: 'shop', pod: 'web-0', command: ['bun', 'repl'], stdin: 'pipe' })
    stream.stdin!.write('1 + ')
    stream.stdin!.write('1')
    await stream.stdin!.end()
    expect((await stream.collect()).stdout).toBe('ran: 1 + 1')
  })

  it('reads a bounded log to the end', async () => {
    const result = await new KubectlClient().logs({ namespace: 'shop', pod: 'web-0', tail: 2, timestamps: true }).collect()
    expect(result.code).toBe(0)
    // A multi-byte character survives whatever chunk boundary it lands on.
    expect(result.stdout).toBe('2026-11-11T10:00:00Z first\n2026-11-11T10:00:01Z caf\u00E9\n')
    expect(calls()[0]!.argv).toEqual(['logs', '--namespace', 'shop', '--tail', '2', '--timestamps', 'web-0'])
  })

  it('follows a log until aborted', async () => {
    const controller = new AbortController()
    const stream = new KubectlClient().logs({ namespace: 'shop', pod: 'web-0', follow: true, signal: controller.signal })
    let seen = ''
    for await (const chunk of stream) {
      seen += chunk.data
      if (seen.includes('tick 2')) controller.abort()
    }
    const exit = await stream.exited
    expect(seen).toContain('first\n')
    expect(seen).toContain('tick 2')
    expect(exit.code).not.toBe(0)
    expect(calls()[0]!.argv).toEqual(['logs', '--namespace', 'shop', '--follow', 'web-0'])
  })

  it('stops the process when the consumer leaves the loop', async () => {
    const stream = new KubectlClient().logs({ namespace: 'shop', pod: 'web-0', follow: true })
    for await (const chunk of stream) {
      if (chunk.data.includes('tick')) break
    }
    expect((await stream.exited).code).not.toBe(0)
  })

  it('feeds a stream registry and closes it with the exit', async () => {
    const registry = new RuntimeStreamRegistry()
    const ok = registry.create('exec', 'kubernetes:prod:shop%2Fweb-0')
    const done = await pumpProcessStream(registry, ok.id, new KubectlClient().exec({ namespace: 'shop', pod: 'web-0', command: ['sh'], stdin: 'echo hi' }))
    expect(done?.state).toBe('complete')
    const snapshot = registry.read(ok.id, ok.workloadId)!
    expect(snapshot.chunks.map((c) => [c.stream, c.data])).toContainEqual(['stdout', 'ran: echo hi'])
    expect(snapshot.chunks.map((c) => [c.stream, c.data])).toContainEqual(['stderr', 'warning: from the container\n'])

    const bad = registry.create('exec', 'w')
    const failed = await pumpProcessStream(registry, bad.id, new KubectlClient().exec({ namespace: 'shop', pod: 'web-0', command: ['sh'], stdin: 'exit 3' }))
    expect(failed?.state).toBe('failed')
    expect(failed?.error).toBe('exited 3')
  })

  it('cancelling the registry entry kills a followed log', async () => {
    const registry = new RuntimeStreamRegistry()
    const entry = registry.create('logs', 'w')
    const stream = new KubectlClient().logs({ namespace: 'shop', pod: 'web-0', follow: true })
    const pumping = pumpProcessStream(registry, entry.id, stream)
    const unsubscribe = registry.subscribe(entry.id, 'w', (snapshot) => {
      if (snapshot.state === 'open' && snapshot.chunks.some((c) => c.data.includes('tick'))) registry.cancel(entry.id, 'w')
    })
    await pumping
    unsubscribe?.()
    expect(registry.read(entry.id, 'w')?.state).toBe('cancelled')
    expect((await stream.exited).code).not.toBe(0)
  })
})

describe('kubectl over the SSH transport', () => {
  it('wraps the same argv in ssh -T with a checked host key', () => {
    const command = buildKubectlCommand({ via, kubeconfig: '/etc/rancher/k3s/k3s.yaml' }, ['get', 'pods'])
    expect(command).toEqual(['ssh', ...SSH_PREFIX, `exec 'kubectl' '--kubeconfig' '/etc/rancher/k3s/k3s.yaml' 'get' 'pods'`])
    expect(command.join(' ')).not.toContain('StrictHostKeyChecking=no')
  })

  it('delivers awkward arguments to the remote kubectl intact', async () => {
    // Each of these would change meaning if the remote shell ever read it.
    const awkward = ['sh', '-c', 'echo "$HOME"; ls *', 'it\'s', 'a b', '$(id)', '`id`', '', 'x\ny']
    const stream = new KubectlClient({ via, context: 'prod eu' }).exec({
      namespace: 'shop',
      pod: 'web-0',
      command: awkward,
      stdin: 'payload',
    })
    const result = await stream.collect()
    expect(result.stdout).toBe('ran: payload')
    expect(result.stderr).toBe('warning: from the container\n')
    const [ssh, kubectl] = calls()
    expect(ssh!.name).toBe('ssh')
    expect(ssh!.argv.slice(0, -1)).toEqual(SSH_PREFIX)
    // What the remote kubectl received is exactly what was asked for.
    expect(kubectl).toEqual({
      name: 'kubectl',
      argv: ['--context', 'prod eu', 'exec', '--stdin', '--namespace', 'shop', 'web-0', '--', ...awkward],
    })
  })

  it('lists pods and follows logs through the remote host', async () => {
    const client = new KubectlClient({ via })
    expect((await client.listPods({ allNamespaces: true })).map((pod) => pod.name)).toEqual(['web-5d4f7c9b8-x2k4p', 'worker-0'])
    expect(calls().map((call) => call.name)).toEqual(['ssh', 'kubectl'])
    expect(calls()[1]!.argv).toEqual(['get', 'pods', '--all-namespaces', '--output', 'json'])
  })

  it('propagates the remote exit code', async () => {
    const result = await new KubectlClient({ via }).exec({ namespace: 'shop', pod: 'web-0', command: ['sh'], stdin: 'exit 3' }).collect()
    expect(result.code).toBe(3)
  })
})
