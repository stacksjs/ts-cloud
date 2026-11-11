/**
 * Kubernetes through the system `kubectl`.
 *
 * No client library and no API calls of our own: `kubectl` already knows how
 * to read a kubeconfig, refresh an exec-plugin credential, follow a proxy and
 * speak whichever API version the cluster is on, and it is what the operator
 * debugs with when this disagrees with them. This module only decides the
 * argv.
 *
 * Every invocation is a fixed argument vector. Names from the cluster and from
 * the caller (context, namespace, pod, container, the command to run) are
 * always whole arguments, never spliced into a string, and positional ones
 * are checked not to start with `-` so a pod cannot be named into a flag. The
 * command an `exec` runs sits after `--`, where kubectl stops parsing.
 *
 * The same commands run on another machine by setting `via`: the argv is then
 * quoted for the remote shell and sent over the deploy SSH transport (see
 * `process-stream.ts`), which is how a cluster reachable only from a bastion
 * or a k3s on the box itself is driven without a tunnel.
 *
 * Mirrors `adapters/docker.ts`: a parser for the tool's JSON, a mapping onto
 * {@link RuntimeWorkload}, and a discovery adapter over an injected reader.
 */
import type { RuntimeContainer, RuntimeDiscoveryAdapter, RuntimeDiscoveryContext, RuntimeWorkload, WorkloadStatus } from '../model'
import type { ProcessOutput, ProcessSpawner, ProcessStdinSource, ProcessStream, SshVia } from '../process-stream'
import { capabilities, runtimeId } from '../model'
import { ageSeconds, normalizeRuntimeStatus, redactRuntimeConfig } from '../normalize'
import { buildSshCommand, spawnProcessStream } from '../process-stream'

export interface KubectlOptions {
  /** The binary to run. @default 'kubectl' */
  binary?: string
  /** Passed as `--kubeconfig`. Unset: kubectl's own lookup (`$KUBECONFIG`, `~/.kube/config`). */
  kubeconfig?: string
  /** Passed as `--context`. Unset: the kubeconfig's current context. */
  context?: string
  /**
   * Run kubectl on this host over SSH instead of locally. `kubeconfig` is
   * then a path on THAT host.
   */
  via?: SshVia
  /** Passed as `--request-timeout` to the list calls, e.g. `'10s'`. Never to exec or logs. */
  requestTimeout?: string
  /** Environment for a local kubectl (e.g. `KUBECONFIG`, `PATH`). Ignored with `via`. */
  env?: Record<string, string | undefined>
  spawn?: ProcessSpawner
}

/** A value kubectl takes as a positional argument or a flag value. */
function operand(kind: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Kubernetes ${kind} is required`)
  if (value.startsWith('-')) throw new Error(`Invalid Kubernetes ${kind} '${value}': it cannot start with '-'`)
  if (/[\0\r\n]/.test(value)) throw new Error(`Invalid Kubernetes ${kind}: control characters are not allowed`)
  return value
}

/** The flags that select a cluster: `--kubeconfig` and `--context`, when set. */
export function kubectlGlobalArgs(options: Pick<KubectlOptions, 'kubeconfig' | 'context'>): string[] {
  return [
    ...(options.kubeconfig ? ['--kubeconfig', operand('kubeconfig path', options.kubeconfig)] : []),
    ...(options.context ? ['--context', operand('context', options.context)] : []),
  ]
}

/**
 * The full local argv for a kubectl call: the binary, the cluster flags, then
 * `args`. With `via`, the same thing wrapped in `ssh -T ... '<quoted>'`.
 */
export function buildKubectlCommand(options: KubectlOptions, args: readonly string[]): string[] {
  const argv = [options.binary ?? 'kubectl', ...kubectlGlobalArgs(options), ...args]
  return options.via ? buildSshCommand(options.via, argv) : argv
}

export interface KubernetesContext {
  name: string
  current: boolean
}

export interface KubernetesNamespace {
  name: string
  /** `Active` or `Terminating`. */
  phase?: string
  createdAt?: string
}

export interface KubernetesPodContainer {
  name: string
  image?: string
  /** `init` containers have finished (or are still blocking) before the others start. */
  type: 'container' | 'init' | 'ephemeral'
  ready: boolean
  restartCount: number
  /** `running`, `waiting` or `terminated`, as the kubelet reports it. */
  state?: 'running' | 'waiting' | 'terminated'
  /** `CrashLoopBackOff`, `ImagePullBackOff`, `Completed`, `OOMKilled`, ... */
  reason?: string
  exitCode?: number
  startedAt?: string
}

export interface KubernetesPod {
  name: string
  namespace: string
  uid?: string
  /** `Pending`, `Running`, `Succeeded`, `Failed`, `Unknown`. */
  phase?: string
  /** The reason a person would read: `CrashLoopBackOff` over `Running` when a container is looping. */
  status: string
  node?: string
  podIp?: string
  hostIp?: string
  createdAt?: string
  startedAt?: string
  labels: Record<string, string>
  /** `Deployment/web`-style owner, as far as the pod itself records it (`ReplicaSet/web-5d4f...`). */
  owner?: string
  containers: KubernetesPodContainer[]
  /** The container `exec` and `logs` use when none is named. */
  defaultContainer?: string
}

interface RawContainerState {
  running?: { startedAt?: string }
  waiting?: { reason?: string }
  terminated?: { reason?: string; exitCode?: number; startedAt?: string }
}

interface RawContainerStatus {
  name?: string
  image?: string
  ready?: boolean
  restartCount?: number
  state?: RawContainerState
}

/** One item of `kubectl get pods -o json`, reduced to the fields read here. */
export interface KubernetesPodRecord {
  metadata?: {
    name?: string
    namespace?: string
    uid?: string
    creationTimestamp?: string
    deletionTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    ownerReferences?: Array<{ kind?: string; name?: string }>
  }
  spec?: {
    nodeName?: string
    containers?: Array<{ name?: string; image?: string }>
    initContainers?: Array<{ name?: string; image?: string }>
    ephemeralContainers?: Array<{ name?: string; image?: string }>
  }
  status?: {
    phase?: string
    reason?: string
    podIP?: string
    hostIP?: string
    startTime?: string
    containerStatuses?: RawContainerStatus[]
    initContainerStatuses?: RawContainerStatus[]
    ephemeralContainerStatuses?: RawContainerStatus[]
  }
}

function parseList<T>(output: string, what: string): T[] {
  const trimmed = output.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as { items?: unknown }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items))
    throw new Error(`kubectl ${what} output must be a List with items`)
  return parsed.items as T[]
}

/** Parse `kubectl config get-contexts -o name`; `current` is `kubectl config current-context`. */
export function parseKubectlContexts(names: string, current: string = ''): KubernetesContext[] {
  const active = current.trim()
  return names
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({ name, current: name === active }))
}

/** Parse `kubectl get namespaces -o json`. */
export function parseKubectlNamespaces(output: string): KubernetesNamespace[] {
  return parseList<{ metadata?: { name?: string; creationTimestamp?: string }; status?: { phase?: string } }>(output, 'get namespaces')
    .filter((item) => typeof item?.metadata?.name === 'string')
    .map((item) => ({
      name: item.metadata!.name!,
      phase: item.status?.phase,
      createdAt: item.metadata?.creationTimestamp,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function containersOf(
  declared: Array<{ name?: string; image?: string }> | undefined,
  statuses: RawContainerStatus[] | undefined,
  type: KubernetesPodContainer['type'],
): KubernetesPodContainer[] {
  const byName = new Map((statuses ?? []).filter((status) => status?.name).map((status) => [status.name!, status]))
  return (declared ?? [])
    .filter((container) => typeof container?.name === 'string')
    .map((container) => {
      const status = byName.get(container.name!)
      const state = status?.state
      const kind = state?.running ? 'running' : state?.waiting ? 'waiting' : state?.terminated ? 'terminated' : undefined
      return {
        name: container.name!,
        image: container.image ?? status?.image,
        type,
        ready: status?.ready === true,
        restartCount: status?.restartCount ?? 0,
        state: kind,
        reason: state?.waiting?.reason ?? state?.terminated?.reason,
        exitCode: state?.terminated?.exitCode,
        startedAt: state?.running?.startedAt ?? state?.terminated?.startedAt,
      }
    })
}

/**
 * The status `kubectl get pods` prints in its STATUS column: the pod phase,
 * unless a container says something more specific. `Running` hides a
 * crash-looping container; this does not.
 */
function podStatus(record: KubernetesPodRecord, containers: KubernetesPodContainer[]): string {
  if (record.metadata?.deletionTimestamp) return 'Terminating'
  const init = containers.find((c) => c.type === 'init' && c.state !== 'terminated' && c.reason)
  if (init) return `Init:${init.reason}`
  const waiting = containers.find((c) => c.type !== 'init' && c.state === 'waiting' && c.reason && c.reason !== 'ContainerCreating')
  if (waiting) return waiting.reason!
  const failed = containers.find((c) => c.type === 'container' && c.state === 'terminated' && c.exitCode !== 0 && c.reason)
  if (failed && record.status?.phase !== 'Succeeded') return failed.reason!
  return record.status?.reason ?? record.status?.phase ?? 'Unknown'
}

/** Parse `kubectl get pods -o json`, sorted by namespace then name. */
export function parseKubectlPods(output: string): KubernetesPod[] {
  return parseList<KubernetesPodRecord>(output, 'get pods')
    .filter((record) => typeof record?.metadata?.name === 'string')
    .map((record) => {
      const containers = [
        ...containersOf(record.spec?.containers, record.status?.containerStatuses, 'container'),
        ...containersOf(record.spec?.initContainers, record.status?.initContainerStatuses, 'init'),
        ...containersOf(record.spec?.ephemeralContainers, record.status?.ephemeralContainerStatuses, 'ephemeral'),
      ]
      const owner = record.metadata?.ownerReferences?.[0]
      const annotated = record.metadata?.annotations?.['kubectl.kubernetes.io/default-container']
      return {
        name: record.metadata!.name!,
        namespace: record.metadata?.namespace ?? 'default',
        uid: record.metadata?.uid,
        phase: record.status?.phase,
        status: podStatus(record, containers),
        node: record.spec?.nodeName,
        podIp: record.status?.podIP,
        hostIp: record.status?.hostIP,
        createdAt: record.metadata?.creationTimestamp,
        startedAt: record.status?.startTime,
        labels: record.metadata?.labels ?? {},
        owner: owner?.kind && owner.name ? `${owner.kind}/${owner.name}` : undefined,
        containers,
        // kubectl's own rule: the annotation when it names a real container,
        // else the first one declared.
        defaultContainer:
          (annotated && containers.some((c) => c.name === annotated) ? annotated : undefined) ??
          containers.find((c) => c.type === 'container')?.name,
      }
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
}

export interface KubernetesPodQuery {
  /** Unset: the context's default namespace. */
  namespace?: string
  /** Every namespace. Wins over `namespace`. */
  allNamespaces?: boolean
  /** Label selector, e.g. `app=web,tier!=cache`. */
  selector?: string
}

/** `get pods` arguments (after the cluster flags). */
export function kubectlPodsArgs(query: KubernetesPodQuery = {}, requestTimeout?: string): string[] {
  return [
    'get',
    'pods',
    ...(query.allNamespaces ? ['--all-namespaces'] : query.namespace ? ['--namespace', operand('namespace', query.namespace)] : []),
    ...(query.selector ? ['--selector', operand('label selector', query.selector)] : []),
    ...(requestTimeout ? ['--request-timeout', operand('request timeout', requestTimeout)] : []),
    '--output',
    'json',
  ]
}

export interface KubernetesExecInput {
  namespace: string
  pod: string
  /** Unset: the pod's default container. */
  container?: string
  /** The command and its arguments, run in the container as-is (no shell unless you name one). */
  command: readonly string[]
  /**
   * What the command reads on stdin; `--stdin` is passed only when this is
   * set. Give the script here, not in `command`.
   */
  stdin?: ProcessStdinSource
  signal?: AbortSignal
}

/** `exec` arguments (after the cluster flags). Never `--tty`: output stays two separate pipes. */
export function kubectlExecArgs(input: Omit<KubernetesExecInput, 'stdin' | 'signal'> & { stdin?: boolean }): string[] {
  if (input.command.length === 0 || !input.command[0]) throw new Error('Kubernetes exec needs a command to run')
  return [
    'exec',
    ...(input.stdin ? ['--stdin'] : []),
    '--namespace',
    operand('namespace', input.namespace),
    ...(input.container ? ['--container', operand('container', input.container)] : []),
    operand('pod', input.pod),
    // Everything after `--` is the container's argv; kubectl parses none of it.
    '--',
    ...input.command,
  ]
}

export interface KubernetesLogsInput {
  namespace: string
  pod: string
  container?: string
  /** Every container in the pod, each line prefixed with its source. Wins over `container`. */
  allContainers?: boolean
  /** Keep the stream open and emit new lines as they are written. */
  follow?: boolean
  /** Lines of history to start with. Unset: all of it (kubectl's default). */
  tail?: number
  /** Only lines newer than this: a duration (`'5m'`) or a point in time. */
  since?: string | Date
  timestamps?: boolean
  /** The previous, crashed instance of the container. */
  previous?: boolean
  signal?: AbortSignal
}

/** `logs` arguments (after the cluster flags). */
export function kubectlLogsArgs(input: Omit<KubernetesLogsInput, 'signal'>): string[] {
  if (input.tail !== undefined && (!Number.isInteger(input.tail) || input.tail < 0))
    throw new Error(`Invalid log tail '${input.tail}': use a non-negative whole number of lines`)
  let since: string[] = []
  if (input.since instanceof Date) {
    if (!Number.isFinite(input.since.getTime())) throw new Error('Invalid log since: not a date')
    since = ['--since-time', input.since.toISOString()]
  } else if (input.since) {
    if (!/^\d+(?:\.\d+)?(?:ms|s|m|h)(?:\d+(?:\.\d+)?(?:ms|s|m|h))*$/.test(input.since))
      throw new Error(`Invalid log since '${input.since}': use a duration such as 30s, 5m or 2h`)
    since = ['--since', input.since]
  }
  return [
    'logs',
    '--namespace',
    operand('namespace', input.namespace),
    ...(input.allContainers
      ? ['--all-containers', '--prefix']
      : input.container
        ? ['--container', operand('container', input.container)]
        : []),
    ...(input.follow ? ['--follow'] : []),
    ...(input.tail !== undefined ? ['--tail', String(input.tail)] : []),
    ...since,
    ...(input.timestamps ? ['--timestamps'] : []),
    ...(input.previous ? ['--previous'] : []),
    operand('pod', input.pod),
  ]
}

/** kubectl's own message, without the `error: ` it leads with. */
function kubectlFailure(what: string, result: ProcessOutput): Error {
  const detail = result.stderr.trim().split('\n').filter(Boolean).slice(-3).join('\n') || `exited ${result.code}`
  return new Error(`kubectl ${what} failed: ${detail.replace(/^error:\s*/i, '')}`)
}

/**
 * kubectl against one cluster: a kubeconfig, a context, and optionally the
 * host it runs on.
 *
 * The list calls resolve with parsed records and reject with kubectl's own
 * error. `exec` and `logs` return the running process as a
 * {@link ProcessStream}; a non-zero exit is reported by `exited`, not thrown,
 * because the output up to that point is the thing the caller wanted.
 */
export class KubectlClient {
  private readonly spawn: ProcessSpawner

  constructor(private readonly options: KubectlOptions = {}) {
    this.spawn = options.spawn ?? spawnProcessStream
  }

  /** The same client pointed at another context (the picker's "switch cluster"). */
  withContext(context: string | undefined): KubectlClient {
    return new KubectlClient({ ...this.options, context })
  }

  /** The exact argv a call would run. */
  command(args: readonly string[]): string[] {
    return buildKubectlCommand(this.options, args)
  }

  private start(args: readonly string[], run: { stdin?: ProcessStdinSource; signal?: AbortSignal } = {}): ProcessStream {
    return this.spawn(this.command(args), {
      stdin: run.stdin,
      signal: run.signal,
      // A remote kubectl gets the remote login environment, not ours.
      ...(this.options.env && !this.options.via ? { env: this.options.env } : {}),
    })
  }

  private async read(what: string, args: readonly string[]): Promise<string> {
    const result = await this.start(args).collect()
    if (result.code !== 0) throw kubectlFailure(what, result)
    return result.stdout
  }

  private get timeout(): string[] {
    return this.options.requestTimeout ? ['--request-timeout', operand('request timeout', this.options.requestTimeout)] : []
  }

  /** Contexts in the kubeconfig, the current one flagged. Reads the file only; no cluster is contacted. */
  async listContexts(): Promise<KubernetesContext[]> {
    const names = await this.read('config get-contexts', ['config', 'get-contexts', '--output', 'name'])
    // No current context is a normal kubeconfig state (kubectl exits 1), not a failure of the listing.
    const current = this.options.context ?? (await this.start(['config', 'current-context']).collect().then((r) => (r.code === 0 ? r.stdout : '')))
    return parseKubectlContexts(names, current)
  }

  async listNamespaces(): Promise<KubernetesNamespace[]> {
    return parseKubectlNamespaces(await this.read('get namespaces', ['get', 'namespaces', ...this.timeout, '--output', 'json']))
  }

  /** Pods with their containers. */
  async listPods(query: KubernetesPodQuery = {}): Promise<KubernetesPod[]> {
    return parseKubectlPods(await this.podsJson(query))
  }

  /** Raw `get pods -o json`, for {@link KubernetesDiscoveryAdapter}. */
  async podsJson(query: KubernetesPodQuery = {}): Promise<string> {
    return this.read('get pods', kubectlPodsArgs(query, this.options.requestTimeout))
  }

  /** Run a command in a container, stdin piped through, stdout and stderr streamed apart. */
  exec(input: KubernetesExecInput): ProcessStream {
    const { stdin, signal, ...target } = input
    return this.start(kubectlExecArgs({ ...target, stdin: stdin !== undefined }), { stdin, signal })
  }

  /** A container's log. With `follow`, the stream stays open until killed or the pod goes away. */
  logs(input: KubernetesLogsInput): ProcessStream {
    const { signal, ...query } = input
    return this.start(kubectlLogsArgs(query), { signal })
  }
}

function containerStatus(container: KubernetesPodContainer): WorkloadStatus {
  if (container.state === 'running') return container.ready ? 'running' : 'starting'
  if (container.state === 'waiting') return /BackOff|Err|Invalid/.test(container.reason ?? '') ? 'failed' : 'starting'
  if (container.state === 'terminated') return container.exitCode === 0 ? 'stopped' : 'failed'
  return 'unknown'
}

function workloadStatus(pod: KubernetesPod): WorkloadStatus {
  if (pod.status === 'Terminating') return 'stopping'
  if (pod.phase === 'Succeeded') return 'stopped'
  if (pod.phase === 'Failed') return 'failed'
  const main = pod.containers.filter((c) => c.type === 'container').map(containerStatus)
  if (main.includes('failed')) return main.includes('running') ? 'degraded' : 'failed'
  if (pod.phase === 'Running') return main.every((status) => status === 'running') ? 'running' : 'starting'
  return normalizeRuntimeStatus(pod.phase)
}

/** Pods as {@link RuntimeWorkload}s, one replica each, so they list beside systemd units and containers. */
export function kubernetesWorkloads(
  pods: KubernetesPod[],
  context: RuntimeDiscoveryContext,
  sourceId: string = context.server ?? 'kubernetes',
): RuntimeWorkload[] {
  const now = context.now ?? new Date()
  return pods.map((pod) => {
    const nativeId = `${pod.namespace}/${pod.name}`
    const status = workloadStatus(pod)
    const restartCount = pod.containers.reduce((total, c) => total + c.restartCount, 0)
    const containers: RuntimeContainer[] = pod.containers.map((c) => ({
      id: `${nativeId}/${c.name}`,
      name: c.name,
      image: c.image,
      runtime: 'kubernetes',
      status: containerStatus(c),
      rawStatus: c.reason ?? c.state,
      exitCode: c.exitCode,
      reason: c.reason,
    }))
    const main = pod.containers.find((c) => c.name === pod.defaultContainer)
    return {
      id: runtimeId('kubernetes', sourceId, nativeId),
      provider: 'kubernetes',
      kind: 'pod',
      name: pod.name,
      status,
      rawStatus: pod.status,
      health: status === 'running' ? 'healthy' : status === 'failed' || status === 'degraded' ? 'unhealthy' : 'unknown',
      desiredReplicas: 1,
      runningReplicas: status === 'running' ? 1 : 0,
      image: main?.image,
      runtime: 'kubernetes',
      ageSeconds: ageSeconds(pod.startedAt ?? pod.createdAt, now),
      restartCount,
      tags: pod.labels,
      links: {
        project: context.project,
        environment: context.environment,
        server: pod.node,
        service: pod.labels['app.kubernetes.io/name'] ?? pod.labels.app ?? pod.owner ?? pod.name,
        release: pod.labels['app.kubernetes.io/version'],
        providerId: nativeId,
      },
      replicas: [
        {
          id: runtimeId('kubernetes', sourceId, `${nativeId}:0`),
          name: pod.name,
          status,
          rawStatus: pod.status,
          createdAt: pod.createdAt,
          startedAt: pod.startedAt,
          restartCount,
          host: pod.node,
          containers,
        },
      ],
      networks: pod.podIp ? [{ id: pod.namespace, name: pod.namespace, addresses: [pod.podIp] }] : [],
      mounts: [],
      capabilities: capabilities(['logs', 'exec', 'inspect'], 'Change the owning Deployment, StatefulSet or Job instead of the pod'),
      config: redactRuntimeConfig({
        namespace: pod.namespace,
        owner: pod.owner,
        node: pod.node,
        defaultContainer: pod.defaultContainer,
        containers: pod.containers.map((c) => ({ name: c.name, type: c.type, image: c.image })),
      }),
      discoveredAt: now.toISOString(),
      sourceId,
    }
  })
}

/** Discovery over injected `get pods -o json` output; pair with {@link KubectlClient.podsJson}. */
export class KubernetesDiscoveryAdapter implements RuntimeDiscoveryAdapter {
  readonly id: string
  readonly provider = 'kubernetes' as const
  constructor(
    private readonly pods: (context: RuntimeDiscoveryContext) => Promise<string>,
    id = 'kubernetes:local',
  ) {
    this.id = id
  }

  async discover(context: RuntimeDiscoveryContext): Promise<RuntimeWorkload[]> {
    return kubernetesWorkloads(parseKubectlPods(await this.pods(context)), context, this.id)
  }
}
