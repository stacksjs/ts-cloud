// Preset creators
export { createStaticSitePreset } from './static-site'
export { createNodeJsServerPreset } from './nodejs-server'
export { createNodeJsServerlessPreset } from './nodejs-serverless'
export { createFullStackAppPreset } from './fullstack-app'
export { createApiBackendPreset } from './api-backend'
export { createWordPressPreset } from './wordpress'
export { createJamstackPreset } from './jamstack'
export { createMicroservicesPreset } from './microservices'
export { createRealtimeAppPreset } from './realtime-app'
export { createDataPipelinePreset } from './data-pipeline'
export { createMLApiPreset } from './ml-api'
export { createTraditionalWebAppPreset } from './traditional-web-app'

// Preset extension utilities
export {
  extendPreset,
  composePresets,
  createPreset,
  mergeInfrastructure,
  withMonitoring,
  withSecurity,
  withDatabase,
  withCache,
  withCDN,
  withQueue,
} from './extend'
