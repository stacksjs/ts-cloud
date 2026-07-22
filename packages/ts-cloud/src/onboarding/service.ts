import type { ControlPlaneOperation, ControlPlaneResource, ControlPlaneStore, JsonValue } from '../control-plane'
import type { ApplicationDraftStore } from './store'
import type { ApplicationPlan } from './types'
import { planApplication } from './plan'

export interface ApplyApplicationResult { plan: ApplicationPlan, resource: ControlPlaneResource, operation: ControlPlaneOperation }

export function applyApplicationDraft(input: { controlPlane: ControlPlaneStore, drafts: ApplicationDraftStore, draftId: string, expectedVersion: number, confirmEnvironment: string, actorId?: string }): ApplyApplicationResult {
  const draft = input.drafts.get(input.draftId)
  if (!draft || draft.version !== input.expectedVersion) throw new Error(`Application draft ${input.draftId} changed since version ${input.expectedVersion}`)
  if (draft.status === 'applied') throw new Error('Application draft was already applied')
  const project = input.controlPlane.getProject(draft.projectId); const environment = project ? input.controlPlane.listEnvironments(project.id).find(item => item.id === draft.input.environmentId) : undefined
  if (!project || !environment || environment.projectId !== project.id || project.organizationId !== draft.organizationId) throw new Error('Draft deployment scope was not found')
  if (input.confirmEnvironment !== environment.slug) throw new Error(`Type ${environment.slug} to confirm this deployment target`)
  const plan = planApplication(draft.input, draft.suppliedSecretNames)
  if (!plan.valid) throw new Error(`Application plan is invalid: ${[...plan.issues.map(item => item.message), ...plan.missingSecrets.map(name => `Missing secret ${name}`)].join('; ')}`)
  const existing = input.controlPlane.listResources(project.id, environment.id).find(resource => resource.kind === 'application' && resource.slug === draft.input.slug)
  const desiredState = JSON.parse(JSON.stringify({ manifest: plan.manifest, configPatch: plan.configPatch })) as JsonValue
  const resource = existing
    ? input.controlPlane.updateResource(existing.id, existing.version, { name: draft.input.name, desiredState })
    : input.controlPlane.createResource({ projectId: project.id, environmentId: environment.id, kind: 'application', slug: draft.input.slug, name: draft.input.name, desiredState, metadata: { source: 'application-onboarding', draftId: draft.id } })
  const operation = input.controlPlane.createOperation({ projectId: project.id, environmentId: environment.id, resourceId: resource.id, actorId: input.actorId, kind: 'application.create', idempotencyKey: `application-draft:${draft.id}:v${draft.version}`, correlationId: `application-draft:${draft.id}`, input: desiredState })
  input.drafts.markApplied(draft.id, draft.version, input.actorId)
  input.controlPlane.appendEvent({ organizationId: draft.organizationId, projectId: project.id, resourceId: resource.id, operationId: operation.id, actorId: input.actorId, type: 'application.create.queued', payload: { draftId: draft.id, environment: environment.slug, strategy: draft.input.build.kind, costDrivers: plan.costDrivers } })
  return { plan, resource, operation }
}
