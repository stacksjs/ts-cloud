import type { ReleaseDeployableKind, ReleaseStrategy, ReleaseStrategyCapability } from './types'

export function releaseStrategyCapabilities(input: { kind: ReleaseDeployableKind, provider?: string, hasHealthGate: boolean, replicas?: number }): ReleaseStrategyCapability[] {
  const atomic = ['static', 'compute', 'serverless_zip', 'serverless_image'].includes(input.kind)
  const rolling = ['container', 'compose'].includes(input.kind) && (input.replicas ?? 1) > 1
  const traffic = input.kind === 'container' || input.kind === 'serverless_zip' || input.kind === 'serverless_image'
  const requiresHealth = (strategy: ReleaseStrategy, otherwise: boolean) => otherwise && (strategy === 'atomic' || input.hasHealthGate)
  return [
    { strategy: 'atomic', supported: requiresHealth('atomic', atomic), explanation: atomic ? input.hasHealthGate || input.kind === 'static' ? 'Activate an immutable version with an atomic pointer/alias switch.' : 'Atomic activation needs a readiness gate for this runtime.' : 'This driver has no atomic pointer or alias primitive.', capacityMultiplier: 1, costImpact: 'none', rollback: 'Switch the pointer/alias back to the previous immutable release.' },
    { strategy: 'rolling', supported: requiresHealth('rolling', rolling), explanation: rolling ? input.hasHealthGate ? 'Replace healthy replicas within the configured capacity envelope.' : 'Rolling activation requires a health/readiness gate.' : 'Rolling activation requires a capable container/Compose driver and at least two replicas.', capacityMultiplier: 1.5, costImpact: 'temporary', rollback: 'Stop replacement and restore the prior task/service definition.' },
    { strategy: 'blue_green', supported: requiresHealth('blue_green', traffic), explanation: traffic ? input.hasHealthGate ? 'Provision a complete green target and switch traffic after health passes.' : 'Blue-green requires a health gate before traffic can switch.' : 'The provider does not expose two traffic-addressable revisions.', capacityMultiplier: 2, costImpact: 'temporary', rollback: 'Return all traffic to the preserved blue target.' },
    { strategy: 'canary', supported: requiresHealth('canary', traffic), explanation: traffic ? input.hasHealthGate ? 'Shift bounded traffic steps while evaluating health.' : 'Canary requires a health gate and measurable traffic target.' : 'The provider does not expose weighted traffic primitives.', capacityMultiplier: 1.25, costImpact: 'temporary', rollback: 'Set canary weight to zero and preserve its diagnostics.' },
  ]
}

export function assertReleaseStrategy(input: Parameters<typeof releaseStrategyCapabilities>[0], strategy: ReleaseStrategy): ReleaseStrategyCapability { const capability = releaseStrategyCapabilities(input).find(item => item.strategy === strategy)!; if (!capability.supported) throw new Error(`${strategy} is unavailable: ${capability.explanation}`); return capability }
