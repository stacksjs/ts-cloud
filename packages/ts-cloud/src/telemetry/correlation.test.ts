import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { telemetryRecordsFromLog } from '../deploy/telemetry-collection'
import { TelemetryStore } from '.'

const stores: ControlPlaneStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

describe('telemetry correlation journey', () => {
  it('links a synthetic failed request to its trace, logs, deployment, release, and workload', () => {
    const controlPlane = new ControlPlaneStore({ path: ':memory:' }); stores.push(controlPlane)
    const project = controlPlane.createProject({ slug: 'acme', name: 'Acme' })
    const environment = controlPlane.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
    const resource = controlPlane.createResource({ projectId: project.id, environmentId: environment.id, kind: 'application', slug: 'api', name: 'API' })
    const telemetry = new TelemetryStore(controlPlane)
    telemetry.appendMany(telemetryRecordsFromLog({ projectId: project.id, environmentId: environment.id, resourceId: resource.id, source: 'runtime:docker', name: 'api.log', workloadId: 'docker:api:1', timestamp: '2026-07-21T11:59:00Z', message: JSON.stringify({ level: 'error', method: 'POST', path: '/orders/123', statusCode: 503, durationMs: 91, requestId: 'request-1', traceId: 'trace-1', deploymentId: 'deployment-1', releaseId: 'release-1' }) }))
    telemetry.append({ projectId: project.id, environmentId: environment.id, resourceId: resource.id, kind: 'trace', source: 'xray', name: 'http.trace', timestamp: '2026-07-21T11:59:00Z', traceId: 'trace-1', requestId: 'request-1', deploymentId: 'deployment-1', releaseId: 'release-1', workloadId: 'docker:api:1', durationMs: 91, statusCode: 503 })
    const result = telemetry.query({ projectId: project.id, environmentId: environment.id, resourceIds: [resource.id], traceId: 'trace-1', from: '2026-07-21T11:58:00Z', to: '2026-07-21T12:00:00Z' })
    expect(new Set(result.records.map(item => item.kind))).toEqual(new Set(['log', 'request', 'metric', 'trace']))
    expect(result.records.every(item => item.releaseId === 'release-1' && item.deploymentId === 'deployment-1' && item.workloadId === 'docker:api:1')).toBeTrue()
  })
})
