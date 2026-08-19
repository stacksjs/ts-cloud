import type { JsonValue } from '../control-plane'
import type { ReleaseArtifact, ReleaseRecord, ReleaseStrategyCapability } from './types'
import { assertReleaseStrategy } from './strategy'

export interface ReleaseTrafficTransition {
  step: string
  trafficPercent: number
  waitSeconds: number
  requiresHealth: boolean
}
export interface ReleaseActivationContext {
  release: ReleaseRecord
  artifact: ReleaseArtifact
  previous?: ReleaseRecord
  transitions: ReleaseTrafficTransition[]
}
export interface ReleaseActivationResult {
  activated: boolean
  healthy: boolean
  providerVersion?: string
  resourceVersions: Record<string, string>
  transitions: Array<{ trafficPercent: number; healthy: boolean; observed: JsonValue }>
  error?: string
}
export interface ReleaseActivationDriver {
  name: string
  capability: (
    context: Pick<ReleaseActivationContext, 'release' | 'artifact' | 'previous'>,
  ) => ReleaseStrategyCapability
  activate: (context: ReleaseActivationContext) => Promise<ReleaseActivationResult>
  rollback: (context: ReleaseActivationContext) => Promise<ReleaseActivationResult>
}

export function releaseTrafficPlan(release: ReleaseRecord): ReleaseTrafficTransition[] {
  if (release.strategy === 'canary')
    return [5, 25, 50, 100].map((trafficPercent, index) => ({
      step: `canary-${trafficPercent}`,
      trafficPercent,
      waitSeconds: index === 3 ? release.drainSeconds : release.graceSeconds,
      requiresHealth: true,
    }))
  if (release.strategy === 'blue_green')
    return [
      { step: 'green-health', trafficPercent: 0, waitSeconds: release.graceSeconds, requiresHealth: true },
      { step: 'traffic-switch', trafficPercent: 100, waitSeconds: release.drainSeconds, requiresHealth: true },
    ]
  if (release.strategy === 'rolling')
    return [
      { step: 'rolling-replacement', trafficPercent: 50, waitSeconds: release.graceSeconds, requiresHealth: true },
      { step: 'rolling-complete', trafficPercent: 100, waitSeconds: release.drainSeconds, requiresHealth: true },
    ]
  return [
    {
      step: 'immutable-switch',
      trafficPercent: 100,
      waitSeconds: release.drainSeconds,
      requiresHealth: !!release.healthGate,
    },
  ]
}

export async function activateImmutableRelease(
  driver: ReleaseActivationDriver,
  input: Omit<ReleaseActivationContext, 'transitions'>,
): Promise<ReleaseActivationResult> {
  if (input.release.artifactId !== input.artifact.id) throw new Error('Release activation artifact identity changed')
  assertReleaseStrategy(
    {
      kind: input.release.kind,
      hasHealthGate: !!input.release.healthGate,
      replicas: Number((input.release.manifest as any)?.replicas) || undefined,
    },
    input.release.strategy,
  )
  const capability = driver.capability(input)
  if (!capability.supported)
    throw new Error(`${input.release.strategy} is unavailable in ${driver.name}: ${capability.explanation}`)
  return driver.activate({ ...input, transitions: releaseTrafficPlan(input.release) })
}

export async function rollbackImmutableRelease(
  driver: ReleaseActivationDriver,
  input: Omit<ReleaseActivationContext, 'transitions'>,
): Promise<ReleaseActivationResult> {
  if (!input.previous) throw new Error('Rollback requires the preserved previous release')
  return driver.rollback({
    ...input,
    transitions: [
      { step: 'rollback', trafficPercent: 0, waitSeconds: input.release.drainSeconds, requiresHealth: true },
    ],
  })
}
