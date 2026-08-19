/**
 * Deployment-mode detection: the single source of truth for whether a project
 * is a SERVER deployment (`infrastructure.compute` - an EC2/Fargate box) or a
 * SERVERLESS deployment (`environments.<env>.app` - Lambda functions).
 *
 * The two are mutually exclusive: a project may not declare both a server and a
 * serverless app. {@link detectDeploymentTargets} reports what is configured and
 * {@link resolveDeploymentMode} picks the effective mode (honoring an explicit
 * `config.mode`); {@link deploymentCoexistenceError} returns a message when both
 * are configured so callers can abort with a clear contract.
 */
import type { CloudConfig, DeploymentMode } from './types'

export interface DeploymentTargets {
  /** A server box is configured (`infrastructure.compute`). */
  server: boolean
  /** A serverless Lambda app is configured (`environments.<env>.app`). */
  serverless: boolean
}

/** What deployment targets the config declares. Pure and side-effect free. */
export function detectDeploymentTargets(
  config: Pick<CloudConfig, 'infrastructure' | 'environments'>,
): DeploymentTargets {
  const server = config.infrastructure?.compute != null
  const serverless = Object.values(config.environments ?? {}).some(
    (env) => (env as { app?: unknown } | undefined)?.app != null,
  )
  return { server, serverless }
}

/**
 * The effective deployment mode. An explicit `config.mode` wins (it pins the
 * detection); otherwise a configured serverless app implies `serverless`, and a
 * configured compute box (or nothing else) implies `server`. When both targets
 * are configured this still returns a value, but {@link deploymentCoexistenceError}
 * is non-null and callers should abort first.
 */
export function resolveDeploymentMode(
  config: Pick<CloudConfig, 'infrastructure' | 'environments' | 'mode'>,
): DeploymentMode {
  if (config.mode === 'server' || config.mode === 'serverless') return config.mode
  const { serverless } = detectDeploymentTargets(config)
  return serverless ? 'serverless' : 'server'
}

/**
 * A human-readable error when a project declares BOTH a server and a serverless
 * app (they cannot coexist), or when an explicit `config.mode` contradicts the
 * configured resources. Returns null when the config is consistent.
 */
export function deploymentCoexistenceError(
  config: Pick<CloudConfig, 'infrastructure' | 'environments' | 'mode'>,
): string | null {
  const { server, serverless } = detectDeploymentTargets(config)
  if (server && serverless) {
    return (
      'A project cannot be both a server and a serverless deployment. ' +
      'Found `infrastructure.compute` (server) AND `environments.<env>.app` (serverless Lambda). ' +
      'Keep one: remove `infrastructure.compute` for a serverless app, or remove `environments.<env>.app` for a server.'
    )
  }
  if (config.mode === 'server' && serverless && !server) {
    return (
      "Config sets `mode: 'server'` but declares a serverless app (`environments.<env>.app`). " +
      'Remove the app or change the mode.'
    )
  }
  if (config.mode === 'serverless' && server && !serverless) {
    return (
      "Config sets `mode: 'serverless'` but declares a server (`infrastructure.compute`). " +
      'Remove the compute block or change the mode.'
    )
  }
  return null
}
