/**
 * Compliance & Governance
 * AWS Config, CloudTrail, GuardDuty, and Security Hub integrations
 */

// AWS Config
export {
  ConfigRule,
  ConfigScope,
  ConfigRecorder,
  RecordingGroup,
  DeliveryChannel,
  AWSConfigManager,
  awsConfigManager,
} from './aws-config'

// CloudTrail
export {
  CloudTrailConfig,
  EventSelector,
  DataResource,
  InsightSelector,
  AdvancedEventSelector,
  FieldSelector,
  CloudTrailManager,
  cloudTrailManager,
} from './cloudtrail'

// GuardDuty
export {
  GuardDutyDetector,
  DataSourceConfigurations,
  DetectorFeature,
  ThreatIntelSet,
  IPSet,
  FindingFilter,
  FindingCriteria,
  GuardDutyManager,
  guardDutyManager,
} from './guardduty'

// Security Hub
export {
  SecurityHubConfig,
  SecurityStandard,
  AutomationRule,
  AutomationAction,
  AutomationCriteria,
  StringFilter,
  NumberFilter,
  MapFilter,
  SecurityHubManager,
  securityHubManager,
} from './security-hub'
