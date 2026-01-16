/**
 * Compliance & Governance
 * AWS Config, CloudTrail, GuardDuty, and Security Hub integrations
 */

// AWS Config
export {
  AWSConfigManager,
  awsConfigManager,
} from './aws-config'

export type {
  ConfigRule,
  ConfigScope,
  ConfigRecorder,
  RecordingGroup,
  DeliveryChannel,
} from './aws-config'

// CloudTrail
export {
  CloudTrailManager,
  cloudTrailManager,
} from './cloudtrail'

export type {
  CloudTrailConfig,
  EventSelector,
  DataResource,
  InsightSelector,
  AdvancedEventSelector,
  FieldSelector,
} from './cloudtrail'

// GuardDuty
export {
  GuardDutyManager,
  guardDutyManager,
} from './guardduty'

export type {
  GuardDutyDetector,
  DataSourceConfigurations,
  DetectorFeature,
  ThreatIntelSet,
  IPSet,
  FindingFilter,
  FindingCriteria,
} from './guardduty'

// Security Hub
export {
  SecurityHubManager,
  securityHubManager,
} from './security-hub'

export type {
  SecurityHubConfig,
  SecurityStandard,
  AutomationRule,
  AutomationAction,
  AutomationCriteria,
  StringFilter,
  NumberFilter,
  MapFilter,
} from './security-hub'
