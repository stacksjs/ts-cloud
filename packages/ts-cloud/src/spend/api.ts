/**
 * The billing and usage API.
 *
 * This exists so an *agent* can ask before it acts. The interesting question
 * is not "what did last month cost" - a dashboard answers that - but "if I
 * kick off this deploy, or this batch job, or this backfill, does it fit in
 * what is left?" A CI pipeline, a scheduled job, or a coding agent can read
 * `/api/v1/usage`, see the remaining headroom and the projection, and decide.
 *
 * Which is why every budget in the response carries `remainingCents`,
 * `projectedCents`, `projectionConfidence`, and `timeToCap` rather than just a
 * total: a caller deciding whether to proceed needs the forecast and how much
 * to trust it, not an invoice.
 *
 * Routing lives here rather than in the main handler's if/else chain so the
 * spend surface can be tested on its own.
 */
import type { ApiTokenPrincipal } from '../automation'
import type { AutomationApiService } from '../api/service'
import type { BudgetPeriod, EnforcementAction } from './model'
import type { SpendService } from './service'
import type { CreateBudgetInput, SpendStore } from './store'
import { ApiServiceError } from '../api/service'
import { isOperationAllowed } from './enforcement'
import { toFocusJsonl, toFocusRecords } from './focus'
import { DETECTABLE_SIGNALS } from './signals'

export interface SpendApiContext {
  store: SpendStore
  service: SpendService
  /** Reused for scope resolution and capability checks. */
  authorization: AutomationApiService
  now?: () => Date
}

function requireOrganization(principal: ApiTokenPrincipal): string {
  return principal.serviceAccount.organizationId
}

function period(value: string | null): BudgetPeriod | undefined {
  if (value == null) return undefined
  if (value === 'daily' || value === 'weekly' || value === 'monthly') return value
  throw new ApiServiceError('validation_error', 'period must be daily, weekly, or monthly.', 422)
}

function positiveInt(value: unknown, field: string): number | undefined {
  if (value == null) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed))
    throw new ApiServiceError('validation_error', `${field} must be a non-negative integer.`, 422)
  return parsed
}

/**
 * Scope a request, honouring the token's own scope.
 *
 * A project-scoped token asking for org-wide usage would otherwise see every
 * other project's spend, which is a billing-data leak between teams sharing an
 * organization.
 */
function scopeFor(
  context: SpendApiContext,
  principal: ApiTokenPrincipal,
  capability: 'billing:read' | 'billing:manage',
  projectId?: string,
  environmentId?: string,
): { organizationId: string; projectId?: string; environmentId?: string } {
  if (environmentId) context.authorization.authorize(principal, capability, { type: 'environment', id: environmentId })
  else if (projectId) context.authorization.authorize(principal, capability, { type: 'project', id: projectId })
  else context.authorization.authorize(principal, capability, { type: 'organization' })
  return { organizationId: requireOrganization(principal), projectId, environmentId }
}

export interface SpendApiRequest {
  method: string
  url: URL
  body?: () => Promise<Record<string, any>>
}

/**
 * Handle a spend route, or return undefined if the path is not one of ours.
 *
 * Returning undefined rather than a 404 lets the caller keep its own routing
 * fallthrough intact.
 */
export async function handleSpendRequest(
  context: SpendApiContext,
  principal: ApiTokenPrincipal,
  request: SpendApiRequest,
): Promise<Record<string, unknown> | undefined> {
  const { method, url } = request
  const now = context.now?.() ?? new Date()
  const projectId = url.searchParams.get('projectId') ?? undefined
  const environmentId = url.searchParams.get('environmentId') ?? undefined

  // GET /api/v1/usage - the question an agent asks before spending money.
  if (method === 'GET' && url.pathname === '/api/v1/usage') {
    const scope = scopeFor(context, principal, 'billing:read', projectId, environmentId)
    return context.service.usageReport({
      ...scope,
      period: period(url.searchParams.get('period')),
      timezone: url.searchParams.get('timezone') ?? undefined,
      now,
    })
  }

  // GET /api/v1/usage/rollups - the itemized detail behind the totals.
  if (method === 'GET' && url.pathname === '/api/v1/usage/rollups') {
    const scope = scopeFor(context, principal, 'billing:read', projectId, environmentId)
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (!from || !to) throw new ApiServiceError('validation_error', 'from and to are required.', 422)
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)))
      throw new ApiServiceError('validation_error', 'from and to must be ISO-8601 timestamps.', 422)
    const meters = url.searchParams.getAll('meter')
    return {
      data: context.store.listRollups(
        { ...scope, from, to, meters: meters.length > 0 ? meters : undefined },
        positiveInt(url.searchParams.get('limit'), 'limit') ?? 1000,
      ),
    }
  }

  /**
   * GET /api/v1/usage/focus
   *
   * The FinOps interchange export. Returns newline-delimited JSON so a year of
   * data streams rather than materializing, and so it drops into Vantage and
   * friends without a bespoke transformer.
   */
  if (method === 'GET' && url.pathname === '/api/v1/usage/focus') {
    const scope = scopeFor(context, principal, 'billing:read', projectId, environmentId)
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (!from || !to) throw new ApiServiceError('validation_error', 'from and to are required.', 422)
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)))
      throw new ApiServiceError('validation_error', 'from and to must be ISO-8601 timestamps.', 422)
    // FOCUS caps a query at one year; a wider range is a mistake, not a request.
    if (new Date(to).getTime() - new Date(from).getTime() > 366 * 86_400_000)
      throw new ApiServiceError('validation_error', 'The range must not exceed one year.', 422)
    const granularity = url.searchParams.get('granularity') === 'hourly' ? 'hourly' : 'daily'
    const rollups = context.store.listRollups({ ...scope, from, to }, 10_000)
    const records = toFocusRecords(rollups, {
      billingPeriodStart: from,
      billingPeriodEnd: to,
      currency: context.store.priceBook.currency,
      granularity,
    })
    return {
      contentType: 'application/x-ndjson',
      body: toFocusJsonl(records),
      recordCount: records.length,
    }
  }

  // GET /api/v1/spend/budgets
  if (method === 'GET' && url.pathname === '/api/v1/spend/budgets') {
    const scope = scopeFor(context, principal, 'billing:read', projectId, environmentId)
    return { data: context.store.listBudgets({ organizationId: scope.organizationId, projectId: scope.projectId }) }
  }

  // POST /api/v1/spend/budgets
  if (method === 'POST' && url.pathname === '/api/v1/spend/budgets') {
    const payload = (await request.body?.()) ?? {}
    const scope = scopeFor(context, principal, 'billing:manage', payload.projectId, payload.environmentId)
    const input: CreateBudgetInput = {
      organizationId: scope.organizationId,
      projectId: payload.projectId,
      environmentId: payload.environmentId,
      name: String(payload.name ?? '').trim(),
      period: period(payload.period ?? 'monthly') ?? 'monthly',
      timezone: payload.timezone,
      currency: payload.currency,
      softLimitCents: positiveInt(payload.softLimitCents, 'softLimitCents'),
      hardLimitCents: positiveInt(payload.hardLimitCents, 'hardLimitCents'),
      thresholds: payload.thresholds,
      meters: payload.meters,
      graceSeconds: positiveInt(payload.graceSeconds, 'graceSeconds'),
      hysteresisPercent: payload.hysteresisPercent,
      // A budget created through the API starts in dry run unless the caller
      // says otherwise. Enforcement that nobody chose is enforcement nobody
      // expects, and the first thing it does is stop deployments.
      dryRun: payload.dryRun !== false,
      enabled: payload.enabled,
    }
    try {
      return { data: context.store.createBudget(input) }
    } catch (error) {
      throw new ApiServiceError('validation_error', error instanceof Error ? error.message : String(error), 422)
    }
  }

  // PATCH /api/v1/spend/budgets/:id
  const budgetMatch = /^\/api\/v1\/spend\/budgets\/([^/]+)$/.exec(url.pathname)
  if (budgetMatch && (method === 'PATCH' || method === 'DELETE')) {
    const budget = context.store.getBudget(decodeURIComponent(budgetMatch[1]))
    if (!budget || budget.organizationId !== requireOrganization(principal))
      throw new ApiServiceError('not_found', 'Budget was not found.', 404)
    scopeFor(context, principal, 'billing:manage', budget.projectId, budget.environmentId)
    if (method === 'DELETE') return { data: { deleted: context.store.deleteBudget(budget.id) } }
    const payload = (await request.body?.()) ?? {}
    try {
      return {
        data: context.store.updateBudget(budget.id, payload, positiveInt(payload.expectedVersion, 'expectedVersion')),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ApiServiceError(message.includes('concurrently') ? 'conflict' : 'validation_error', message, message.includes('concurrently') ? 409 : 422)
    }
  }

  // GET /api/v1/spend/anomalies
  if (method === 'GET' && url.pathname === '/api/v1/spend/anomalies') {
    const scope = scopeFor(context, principal, 'billing:read', projectId, environmentId)
    return {
      data: context.store.listAnomalies({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        since: url.searchParams.get('since') ?? undefined,
        unacknowledgedOnly: url.searchParams.get('unacknowledged') === 'true',
        limit: positiveInt(url.searchParams.get('limit'), 'limit'),
      }),
    }
  }

  // POST /api/v1/spend/anomalies/:id/acknowledge
  const acknowledgeMatch = /^\/api\/v1\/spend\/anomalies\/([^/]+)\/acknowledge$/.exec(url.pathname)
  if (acknowledgeMatch && method === 'POST') {
    const anomaly = context.store.getAnomaly(decodeURIComponent(acknowledgeMatch[1]))
    if (!anomaly || anomaly.organizationId !== requireOrganization(principal))
      throw new ApiServiceError('not_found', 'Anomaly was not found.', 404)
    scopeFor(context, principal, 'billing:manage', anomaly.projectId, anomaly.environmentId)
    return { data: { acknowledged: context.store.acknowledgeAnomaly(anomaly.id) } }
  }

  // GET /api/v1/spend/signals - what can be detected, and how each behaves.
  if (method === 'GET' && url.pathname === '/api/v1/spend/signals') {
    scopeFor(context, principal, 'billing:read', projectId, environmentId)
    return { data: DETECTABLE_SIGNALS }
  }

  // GET/POST /api/v1/spend/anomaly-configs
  if (url.pathname === '/api/v1/spend/anomaly-configs') {
    if (method === 'GET') {
      const scope = scopeFor(context, principal, 'billing:read', projectId, environmentId)
      return { data: context.service.anomalyConfigs.list({ organizationId: scope.organizationId, projectId: scope.projectId }) }
    }
    if (method === 'POST') {
      const payload = (await request.body?.()) ?? {}
      const scope = scopeFor(context, principal, 'billing:manage', payload.projectId, payload.environmentId)
      try {
        return {
          data: context.service.anomalyConfigs.upsert({
            organizationId: scope.organizationId,
            projectId: payload.projectId,
            environmentId: payload.environmentId,
            signal: String(payload.signal ?? ''),
            enabled: payload.enabled,
            sensitivity: payload.sensitivity,
            seasonLength: payload.seasonLength == null ? undefined : Number(payload.seasonLength),
            minAbsoluteDelta: payload.minAbsoluteDelta == null ? undefined : Number(payload.minAbsoluteDelta),
            detectDrops: payload.detectDrops,
            severity: payload.severity,
          }),
        }
      } catch (error) {
        throw new ApiServiceError('validation_error', error instanceof Error ? error.message : String(error), 422)
      }
    }
  }

  const configMatch = /^\/api\/v1\/spend\/anomaly-configs\/([^/]+)$/.exec(url.pathname)
  if (configMatch && method === 'DELETE') {
    const config = context.service.anomalyConfigs.get(decodeURIComponent(configMatch[1]))
    if (!config || config.organizationId !== requireOrganization(principal))
      throw new ApiServiceError('not_found', 'Anomaly config was not found.', 404)
    scopeFor(context, principal, 'billing:manage', config.projectId, config.environmentId)
    return { data: { deleted: context.service.anomalyConfigs.delete(config.id) } }
  }

  // GET/POST /api/v1/spend/anomaly-silences
  if (url.pathname === '/api/v1/spend/anomaly-silences') {
    if (method === 'GET') {
      const scope = scopeFor(context, principal, 'billing:read', projectId, environmentId)
      return {
        data: context.service.anomalyConfigs.listSilences({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          includeExpired: url.searchParams.get('includeExpired') === 'true',
        }),
      }
    }
    if (method === 'POST') {
      const payload = (await request.body?.()) ?? {}
      const scope = scopeFor(context, principal, 'billing:manage', payload.projectId)
      try {
        return {
          data: context.service.anomalyConfigs.silence({
            organizationId: scope.organizationId,
            projectId: payload.projectId,
            signal: payload.signal,
            routePattern: payload.routePattern,
            statusCode: payload.statusCode == null ? undefined : Number(payload.statusCode),
            reason: String(payload.reason ?? ''),
            expiresAt: payload.expiresAt,
          }),
        }
      } catch (error) {
        throw new ApiServiceError('validation_error', error instanceof Error ? error.message : String(error), 422)
      }
    }
  }

  const silenceMatch = /^\/api\/v1\/spend\/anomaly-silences\/([^/]+)$/.exec(url.pathname)
  if (silenceMatch && method === 'DELETE') {
    scopeFor(context, principal, 'billing:manage', projectId)
    return { data: { deleted: context.service.anomalyConfigs.removeSilence(decodeURIComponent(silenceMatch[1])) } }
  }

  // GET /api/v1/spend/enforcement
  if (method === 'GET' && url.pathname === '/api/v1/spend/enforcement') {
    const scope = scopeFor(context, principal, 'billing:read', projectId, environmentId)
    return {
      data: context.store.listEnforcements({
        organizationId: scope.organizationId,
        activeOnly: url.searchParams.get('active') !== 'false',
      }),
    }
  }

  /**
   * GET /api/v1/spend/allowance?operation=deploy
   *
   * The single call a pipeline should make before doing something expensive.
   * One boolean, one reason - deliberately not a data dump, because the caller
   * is a script deciding whether to continue.
   */
  if (method === 'GET' && url.pathname === '/api/v1/spend/allowance') {
    const scope = scopeFor(context, principal, 'billing:read', projectId, environmentId)
    const operation = url.searchParams.get('operation') ?? 'deploy'
    if (!['build', 'deploy', 'function_invoke', 'request'].includes(operation))
      throw new ApiServiceError('validation_error', 'operation must be build, deploy, function_invoke, or request.', 422)
    const active = context.store.listEnforcements({ organizationId: scope.organizationId, activeOnly: true })
    const relevant = active.filter(
      (record) =>
        (!record.projectId || record.projectId === scope.projectId) &&
        (!record.environmentId || record.environmentId === scope.environmentId),
    )
    const verdict = isOperationAllowed(operation as 'build' | 'deploy' | 'function_invoke' | 'request', relevant)
    const budgets = context.store.budgetsForScope(scope.organizationId, scope.projectId, scope.environmentId)
    const statuses = budgets.map((budget) => context.service.status(budget, now))
    return {
      operation,
      allowed: verdict.allowed,
      blockedBy: (verdict.blockedBy as EnforcementAction | undefined) ?? null,
      reason: verdict.reason ?? null,
      budgets: statuses.map((status) => ({
        id: status.budget.id,
        name: status.budget.name,
        usedPercent: status.decision.usedPercent,
        projectedPercent: status.decision.projectedPercent,
        level: status.decision.level,
        timeToCap: status.timeToCap,
      })),
    }
  }

  return undefined
}

/** OpenAPI path entries for the spend surface, merged into the main document. */
export function spendOpenApiPaths(): Record<string, unknown> {
  const orgQuery = [
    { name: 'projectId', in: 'query', schema: { type: 'string' } },
    { name: 'environmentId', in: 'query', schema: { type: 'string' } },
  ]
  return {
    '/api/v1/usage': {
      get: {
        summary: 'Current usage, cost, and every budget governing the scope.',
        parameters: [
          ...orgQuery,
          { name: 'period', in: 'query', schema: { type: 'string', enum: ['daily', 'weekly', 'monthly'] } },
          { name: 'timezone', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Usage totals, per-meter breakdown, hourly series, and budget status.' } },
      },
    },
    '/api/v1/usage/rollups': {
      get: {
        summary: 'Itemized hourly usage rollups.',
        parameters: [
          ...orgQuery,
          { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
          { name: 'meter', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Hourly rollups, newest first.' } },
      },
    },
    '/api/v1/usage/focus': {
      get: {
        summary: 'Usage and cost in FOCUS v1.3 format, newline-delimited JSON.',
        parameters: [
          ...orgQuery,
          { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
          { name: 'granularity', in: 'query', schema: { type: 'string', enum: ['daily', 'hourly'] } },
        ],
        responses: { '200': { description: 'FOCUS records, one JSON object per line.' } },
      },
    },
    '/api/v1/spend/budgets': {
      get: { summary: 'Budgets governing a scope.', parameters: orgQuery, responses: { '200': { description: 'Budgets.' } } },
      post: {
        summary: 'Create a budget. Starts in dry run unless dryRun is explicitly false.',
        responses: { '201': { description: 'The created budget.' }, '422': { description: 'Validation error.' } },
      },
    },
    '/api/v1/spend/budgets/{budgetId}': {
      patch: {
        summary: 'Update a budget. Pass expectedVersion for optimistic concurrency.',
        responses: { '200': { description: 'The updated budget.' }, '409': { description: 'Version conflict.' } },
      },
      delete: { summary: 'Delete a budget.', responses: { '200': { description: 'Deletion result.' } } },
    },
    '/api/v1/spend/anomalies': {
      get: {
        summary: 'Detected spend anomalies.',
        parameters: [
          ...orgQuery,
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'unacknowledged', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { '200': { description: 'Anomalies, newest first.' } },
      },
    },
    '/api/v1/spend/anomalies/{anomalyId}/acknowledge': {
      post: { summary: 'Acknowledge an anomaly.', responses: { '200': { description: 'Acknowledgement result.' } } },
    },
    '/api/v1/spend/signals': {
      get: { summary: 'Signals anomaly detection can run on, with their gap and sample rules.', responses: { '200': { description: 'Signal catalog.' } } },
    },
    '/api/v1/spend/anomaly-configs': {
      get: { summary: 'Anomaly detection configuration.', parameters: orgQuery, responses: { '200': { description: 'Configs.' } } },
      post: { summary: 'Create or update the config for a signal.', responses: { '200': { description: 'The config.' } } },
    },
    '/api/v1/spend/anomaly-configs/{configId}': {
      delete: { summary: 'Delete an anomaly config, returning the signal to its default.', responses: { '200': { description: 'Result.' } } },
    },
    '/api/v1/spend/anomaly-silences': {
      get: { summary: 'Active anomaly silences.', parameters: orgQuery, responses: { '200': { description: 'Silences.' } } },
      post: { summary: 'Silence a signal, route, or status code. A reason is required.', responses: { '200': { description: 'The silence.' } } },
    },
    '/api/v1/spend/anomaly-silences/{silenceId}': {
      delete: { summary: 'Remove a silence.', responses: { '200': { description: 'Result.' } } },
    },
    '/api/v1/spend/enforcement': {
      get: {
        summary: 'Enforcement actions in force.',
        parameters: [...orgQuery, { name: 'active', in: 'query', schema: { type: 'boolean' } }],
        responses: { '200': { description: 'Enforcement records.' } },
      },
    },
    '/api/v1/spend/allowance': {
      get: {
        summary: 'Whether an operation is allowed under current spend enforcement.',
        parameters: [
          ...orgQuery,
          {
            name: 'operation',
            in: 'query',
            schema: { type: 'string', enum: ['build', 'deploy', 'function_invoke', 'request'] },
          },
        ],
        responses: { '200': { description: 'Allowance verdict and the budgets behind it.' } },
      },
    },
  }
}
