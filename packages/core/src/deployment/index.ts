/**
 * Advanced Deployment Strategies
 * Blue/green, canary, and A/B testing implementations
*/

// Blue/Green Deployments
export {
  BlueGreenManager,
  blueGreenManager,
} from './blue-green'

export type {
  BlueGreenDeployment,
  Environment,
  RoutingConfig,
  HealthCheckConfig,
  DeploymentResult,
} from './blue-green'

// Canary Deployments
export {
  CanaryManager,
  canaryManager,
} from './canary'

export type {
  CanaryDeployment,
  DeploymentVersion,
  CanaryStage,
  AlarmThresholds,
  CustomMetric,
  CanaryMetrics,
  CanaryResult,
} from './canary'

// A/B Testing
export {
  ABTestManager,
  abTestManager,
} from './ab-testing'

export type {
  ABTest,
  ABVariant,
  RoutingStrategy,
  ABMetrics,
  VariantMetrics,
  ABTestResult,
} from './ab-testing'

// Progressive Deployments
export {
  ProgressiveDeploymentManager,
  progressiveDeploymentManager,
} from './progressive'

export type {
  ProgressiveRollout,
  FeatureFlag,
  DeploymentGate,
} from './progressive'
