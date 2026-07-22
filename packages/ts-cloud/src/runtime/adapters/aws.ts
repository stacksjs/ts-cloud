import type { LambdaFunctionConfiguration } from '../../aws/lambda'
import type { Service as EcsService, Task as EcsTask } from '../../aws/ecs'
import type { RuntimeDiscoveryContext, RuntimeWorkload } from '../model'
import { capabilities, runtimeId } from '../model'
import { ageSeconds, normalizeRuntimeStatus, redactRuntimeConfig } from '../normalize'

function arnName(value?: string): string { return value?.split('/').at(-1) ?? value?.split(':').at(-1) ?? 'unknown' }

export function ecsWorkloads(services: EcsService[], tasks: EcsTask[], context: RuntimeDiscoveryContext, sourceId = 'ecs:aws'): RuntimeWorkload[] {
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
    return {
      id: runtimeId('ecs', sourceId, service.serviceArn ?? name), provider: 'ecs', kind: 'service', name, status, rawStatus: service.status,
      health: status === 'running' ? 'healthy' : (status === 'failed' || status === 'degraded' ? 'unhealthy' : 'unknown'),
      desiredReplicas: service.desiredCount, runningReplicas: service.runningCount, image: undefined, runtime: service.launchType ?? 'ECS', version: arnName(service.taskDefinition),
      ageSeconds: ageSeconds(service.deployments?.[0]?.createdAt, now), restartCount: 0, tags: {},
      links: { project: context.project, environment: context.environment, service: name, providerId: service.serviceArn },
      replicas: serviceTasks.map((task) => {
        const taskStatus = normalizeRuntimeStatus(task.lastStatus)
        return {
          id: runtimeId('ecs', sourceId, task.taskArn ?? arnName(task.taskArn)), name: arnName(task.taskArn), status: taskStatus, rawStatus: task.lastStatus,
          createdAt: task.createdAt, startedAt: task.startedAt, stoppedAt: task.stoppedAt,
          containers: (task.containers ?? []).map(container => ({ id: container.containerArn ?? container.name ?? 'container', name: container.name ?? 'container', status: normalizeRuntimeStatus(container.lastStatus), rawStatus: container.lastStatus, exitCode: container.exitCode, reason: container.reason, runtime: 'ecs' })),
        }
      }),
      networks: [], mounts: [], capabilities: capabilities(['stop', 'restart', 'redeploy', 'scale', 'logs', 'exec', 'inspect'], 'ECS does not expose host file transfer through this runtime explorer'),
      config: redactRuntimeConfig({ clusterArn: service.clusterArn, taskDefinition: service.taskDefinition, launchType: service.launchType, pendingCount: service.pendingCount, deployments: service.deployments }),
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
      capabilities: capabilities(['redeploy', 'scale', 'logs', 'inspect'], 'Lambda has no persistent process to start, stop, exec, or browse files'),
      config: redactRuntimeConfig({ handler: fn.Handler, timeout: fn.Timeout, codeSize: fn.CodeSize, stateReason: fn.StateReason, environmentKeys: Object.keys(fn.Environment?.Variables ?? {}) }),
      discoveredAt: now.toISOString(), sourceId,
    }
  })
}
