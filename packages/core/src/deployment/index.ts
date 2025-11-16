/**
 * Advanced Deployment Strategies
 * Blue/green, canary, and A/B testing implementations
 */

// Blue/Green Deployments
export {
  BlueGreenDeployment,
  Environment,
  RoutingConfig,
  HealthCheckConfig,
  DeploymentResult,
  BlueGreenManager,
  blueGreenManager,
} from './blue-green'

// Canary Deployments
export {
  CanaryDeployment,
  DeploymentVersion,
  CanaryStage,
  AlarmThresholds,
  CustomMetric,
  CanaryMetrics,
  CanaryResult,
  CanaryManager,
  canaryManager,
} from './canary'

// A/B Testing
export {
  ABTest,
  ABVariant,
  RoutingStrategy,
  ABMetrics,
  VariantMetrics,
  ABTestResult,
  ABTestManager,
  abTestManager,
} from './ab-testing'

// Progressive Deployments
export {
  ProgressiveRollout,
  FeatureFlag,
  DeploymentGate,
  ProgressiveDeploymentManager,
  progressiveDeploymentManager,
} from './progressive'
