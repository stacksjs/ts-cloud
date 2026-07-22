import type { LambdaFunctionConfiguration } from '../../aws/lambda'
import type { Service as EcsService, Task as EcsTask } from '../../aws/ecs'
import type { RuntimeDiscoveryContext, RuntimeWorkload } from '../model'
import { capabilities, runtimeId } from '../model'
import { ageSeconds, normalizeRuntimeStatus, redactRuntimeConfig } from '../normalize'

function arnName(value?: string): string { return value?.split('/').at(-1) ?? value?.split(':').at(-1) ?? 'unknown' }

export function ecsWorkloads(services: EcsService[], tasks: EcsTask[], context: RuntimeDiscoveryContext, sourceId = 'ecs:aws', taskDefinitions: any[] = []): RuntimeWorkload[] {
  const now = context.now ?? new Date()
  return services.map((service) => {
    const name = service.serviceName ?? arnName(service.serviceArn)
    const clusterTasks = tasks.filter(task => !service.clusterArn || task.clusterArn === service.clusterArn)
    const serviceTasks = clusterTasks.some(task => !!task.group)
      ? clusterTasks.filter(task => task.group === `service:${name}`)
      : clusterTasks
    const status = service.status === 'ACTIVE'
      ? ((service.runningCount ?? 0) < (service.desiredCount ?? 0) ? 'degraded' : 'running')
      : normalizeRuntimeStatus(service.status)
    const definition = taskDefinitions.find(item => item.taskDefinitionArn === service.taskDefinition)
    const containers = Array.isArray(definition?.containerDefinitions) ? definition.containerDefinitions : []
    const logGroups = [...new Set(containers.map((container: any) => container.logConfiguration?.options?.['awslogs-group']).filter((value: unknown): value is string => typeof value === 'string'))]
    const mounts = containers.flatMap((container: any) => (container.mountPoints ?? []).map((mount: any) => ({ source: mount.sourceVolume, target: mount.containerPath, type: 'volume', readOnly: !!mount.readOnly })))
    const networks = containers.flatMap((container: any) => (container.portMappings ?? []).map((port: any, index: number) => ({ id: `${container.name ?? 'container'}:${index}`, name: container.name, mode: definition?.networkMode, ports: [{ container: port.containerPort, host: port.hostPort, protocol: port.protocol }] })))
    const serviceName = context.project && context.environment && name.startsWith(`${context.project}-${context.environment}-`) ? name.slice(`${context.project}-${context.environment}-`.length) : name
    return {
      id: runtimeId('ecs', sourceId, service.serviceArn ?? name), provider: 'ecs', kind: 'service', name, status, rawStatus: service.status,
      health: status === 'running' ? 'healthy' : (status === 'failed' || status === 'degraded' ? 'unhealthy' : 'unknown'),
      desiredReplicas: service.desiredCount, runningReplicas: service.runningCount, image: containers[0]?.image, runtime: service.launchType ?? 'ECS', version: arnName(service.taskDefinition),
      ageSeconds: ageSeconds(service.deployments?.[0]?.createdAt, now), restartCount: 0, tags: {},
      links: { project: context.project, environment: context.environment, service: serviceName, release: arnName(service.taskDefinition), providerId: service.serviceArn },
      replicas: serviceTasks.map((task) => {
        const taskStatus = normalizeRuntimeStatus(task.lastStatus)
        return {
          id: runtimeId('ecs', sourceId, task.taskArn ?? arnName(task.taskArn)), name: arnName(task.taskArn), status: taskStatus, rawStatus: task.lastStatus,
          createdAt: task.createdAt, startedAt: task.startedAt, stoppedAt: task.stoppedAt,
          host: (task as any).containerInstanceArn,
          containers: (task.containers ?? []).map(container => ({ id: container.containerArn ?? container.name ?? 'container', name: container.name ?? 'container', image: containers.find((item: any) => item.name === container.name)?.image, imageDigest: (container as any).imageDigest, status: normalizeRuntimeStatus(container.lastStatus), rawStatus: container.lastStatus, exitCode: container.exitCode, reason: container.reason, runtime: 'ecs' })),
        }
      }),
      networks, mounts, capabilities: capabilities(['start', 'stop', 'restart', 'redeploy', 'scale', 'inspect', ...(logGroups.length ? ['logs' as const] : [])], 'This ECS runtime does not expose exec or file transfer; logs require an awslogs task-definition driver'),
      config: redactRuntimeConfig({ clusterArn: service.clusterArn, taskDefinition: service.taskDefinition, launchType: service.launchType, pendingCount: service.pendingCount, deployments: service.deployments, logGroups, executionRoleArn: definition?.executionRoleArn, taskRoleArn: definition?.taskRoleArn, cpu: definition?.cpu, memory: definition?.memory }),
      discoveredAt: now.toISOString(), sourceId,
    }
  })
}

export function lambdaWorkloads(functions: LambdaFunctionConfiguration[], context: RuntimeDiscoveryContext, sourceId = 'lambda:aws'): RuntimeWorkload[] {
  const now = context.now ?? new Date()
  return functions.map((fn) => {
    const name = fn.FunctionName ?? arnName(fn.FunctionArn)
    const status = fn.State === 'Active' ? 'running' : normalizeRuntimeStatus(fn.State)
    return {
      id: runtimeId('lambda', sourceId, fn.FunctionArn ?? name), provider: 'lambda', kind: 'function', name, status, rawStatus: fn.State,
      health: status === 'running' ? 'healthy' : (status === 'failed' ? 'unhealthy' : 'unknown'), desiredReplicas: undefined, runningReplicas: undefined,
      image: undefined, runtime: fn.Runtime, version: fn.Version, architecture: fn.Architectures?.join(', '), ageSeconds: ageSeconds(fn.LastModified, now), restartCount: 0,
      tags: {}, links: { project: context.project, environment: context.environment, service: name, providerId: fn.FunctionArn },
      resources: { memoryLimitBytes: fn.MemorySize == null ? undefined : fn.MemorySize * 1024 * 1024 }, replicas: [], networks: [], mounts: [],
      capabilities: capabilities(['logs', 'inspect'], 'Lambda has no persistent process to start, stop, restart, exec, or browse files; deploy a release to replace code'),
      config: redactRuntimeConfig({ handler: fn.Handler, timeout: fn.Timeout, codeSize: fn.CodeSize, stateReason: fn.StateReason, environmentKeys: Object.keys(fn.Environment?.Variables ?? {}) }),
      discoveredAt: now.toISOString(), sourceId,
    }
  })
}
