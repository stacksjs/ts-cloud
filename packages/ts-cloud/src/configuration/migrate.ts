import type { CloudConfig } from '@ts-cloud/core'
import type { DashboardControlPlane } from '../deploy/dashboard-control-plane'
import type { ConfigurationScope } from './model'
import { ConfigurationService } from './service'

export interface ConfigurationSyncResult { added: number; changed: number; removed: number; overridden: number }

export async function synchronizeConfiguredConfiguration(service: ConfigurationService, controlPlane: DashboardControlPlane, config: CloudConfig, actorId?: string): Promise<ConfigurationSyncResult> {
  const result: ConfigurationSyncResult = { added: 0, changed: 0, removed: 0, overridden: 0 }
  const synchronize = async (scope: ConfigurationScope, desired: Record<string, string>) => {
    const existing = service.store.list({ projectId: controlPlane.project.id, scope, kind: 'variable' }), keys = new Set(Object.keys(desired))
    for (const item of existing.filter(item => item.origin === 'config' && !keys.has(item.key))) { await service.remove({ entryId: item.id, expectedVersion: item.version, confirmed: true, actorId }); result.removed++ }
    for (const [key, value] of Object.entries(desired)) {
      const current = service.store.find(controlPlane.project.id, scope, key)
      if (current?.origin !== 'config') { if (current) result.overridden++; else { await service.set({ organizationId: controlPlane.organization.id, projectId: controlPlane.project.id, scope, key, kind: 'variable', value: String(value), origin: 'config', confirmed: true, actorId }); result.added++ } continue }
      if (current.value === String(value)) continue
      await service.set({ organizationId: controlPlane.organization.id, projectId: controlPlane.project.id, scope, key, kind: 'variable', value: String(value), origin: 'config', confirmed: true, actorId, expectedVersion: current.version }); result.changed++
    }
  }
  for (const [slug, configured] of Object.entries(config.environments ?? {})) {
    const environment = controlPlane.environments.get(slug as any)
    if (!environment) continue
    const environmentConfig = configured as Record<string, any>, variables = { ...(environmentConfig.variables ?? {}), ...(environmentConfig.app?.env ?? {}) }
    await synchronize({ type: 'environment', id: environment.id, environmentId: environment.id }, variables)
    for (const [siteSlug, site] of Object.entries(config.sites ?? {})) {
      const resource = controlPlane.store.listResources(controlPlane.project.id, environment.id).find(item => item.kind === 'application' && item.slug === siteSlug)
      if (resource) await synchronize({ type: 'service', id: resource.id, environmentId: environment.id, resourceId: resource.id }, { ...((site as Record<string, any>).env ?? {}) })
    }
  }
  return result
}
