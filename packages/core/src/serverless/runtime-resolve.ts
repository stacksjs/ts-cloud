/**
 * Resolves the Lambda runtime for a serverless app from its `kind` +
 * `runtimeVersion`, deciding between an AWS **managed** Node runtime (zero
 * config, no layer) and a **custom** `provided.al2023` runtime backed by a
 * ts-cloud-built layer (binary + bootstrap + Runtime API loop).
 *
 * This unifies all three runtimes under one model: PHP, Bun, and newer Node
 * versions all run on `provided.al2023` with a ts-cloud layer, while common Node
 * versions stay on the managed runtime for simplicity.
 */

import type { ServerlessAppConfig } from '../types'

/** Node major versions AWS provides a managed runtime for (`nodejs{N}.x`). */
export const MANAGED_NODE_VERSIONS = ['18', '20', '22'] as const

export type RuntimeLayerKind = 'node' | 'bun' | 'php'

export interface ResolvedRuntime {
  /** The Lambda `Runtime` value (e.g. `nodejs22.x` or `provided.al2023`). */
  lambdaRuntime: string
  /** Application kind. */
  kind: 'node' | 'bun' | 'php'
  /** Resolved version string (node major / bun release / php version). */
  version: string
  /** Whether a ts-cloud custom runtime layer is required. */
  usesLayer: boolean
  /** Which layer to build/attach when {@link usesLayer}. */
  layerKind?: RuntimeLayerKind
  /** Env var name the orchestrator reads for a fallback layer ARN. */
  layerEnvVar?: string
}

function normalizeNodeVersion(v: string | undefined): string {
  if (!v) return '22'
  // Accept '20', '20.x', 'nodejs20.x', '20.11.1' → major '20'.
  const m = String(v).match(/(\d+)/)
  return m ? m[1] : '22'
}

/**
 * Resolve the runtime for an app. Honors an explicit `runtime` override; falls
 * back to deriving from `kind`/`runtimeVersion`.
 */
export function resolveServerlessRuntime(app: ServerlessAppConfig): ResolvedRuntime {
  const kind = app.kind ?? 'node'

  if (kind === 'php') {
    return {
      lambdaRuntime: 'provided.al2023',
      kind: 'php',
      version: app.phpVersion ?? '8.3',
      usesLayer: true,
      layerKind: 'php',
      layerEnvVar: 'TSCLOUD_PHP_LAYER_ARN',
    }
  }

  if (kind === 'bun') {
    return {
      lambdaRuntime: 'provided.al2023',
      kind: 'bun',
      version: app.runtimeVersion ?? 'latest',
      usesLayer: true,
      layerKind: 'bun',
      layerEnvVar: 'TSCLOUD_BUN_LAYER_ARN',
    }
  }

  // node
  const version = normalizeNodeVersion(app.runtimeVersion)
  const explicitProvided = app.runtime === 'provided.al2023'
  const managed = !explicitProvided && (MANAGED_NODE_VERSIONS as readonly string[]).includes(version)

  if (managed) {
    return {
      lambdaRuntime: app.runtime && app.runtime.startsWith('nodejs') ? app.runtime : `nodejs${version}.x`,
      kind: 'node',
      version,
      usesLayer: false,
    }
  }

  // Newer Node (e.g. 24) or forced provided → custom runtime layer.
  return {
    lambdaRuntime: 'provided.al2023',
    kind: 'node',
    version,
    usesLayer: true,
    layerKind: 'node',
    layerEnvVar: 'TSCLOUD_NODE_LAYER_ARN',
  }
}
