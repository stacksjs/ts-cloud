/**
 * ts-cloud Core - CloudFormation Generator Engine
 */

// Core types
export * from '@ts-cloud/types'

// Legacy exports (Phase 1)
export * from './template-builder'
export * from './template-validator'
export * from './intrinsic-functions'
export * from './resource-naming'
export * from './dependency-graph'
export * from './stack-diff'
export * from './modules'

// CloudFormation builder (Phase 5)
export * from './cloudformation/builder'
export * from './cloudformation/types'

// Configuration presets (Phase 4)
export * from './presets/static-site'
export * from './presets/nodejs-server'
export * from './presets/nodejs-serverless'
export * from './presets/fullstack-app'
export * from './presets/api-backend'
export * from './presets/wordpress'
export * from './presets/jamstack'
export * from './presets/microservices'
export * from './presets/realtime-app'
export * from './presets/data-pipeline'
export * from './presets/ml-api'
export * from './presets/traditional-web-app'
export * from './presets/extend'

// AWS clients (Phase 5)
export * from './aws/signature'
export * from './aws/credentials'
export * from './aws/cloudformation'
export * from './aws/s3'
export * from './aws/cloudfront'

// Error handling (Phase 6)
export * from './errors'

// Validators (Phase 6)
export * from './validators/credentials'
export * from './validators/quotas'

// Utilities (Phase 6)
export * from './utils'

// Schema (Phase 6.5)
export * from './schema'

// Local development (Phase 6.6)
export * from './local/config'
export * from './local/mock-aws'

// Preview environments (Phase 6.7)
export * from './preview'

// Advanced CLI utilities (Phase 6.8)
export * from './cli'

// Multi-region support (Phase 7.1)
export * from './multi-region'

// Multi-account support (Phase 7.2)
export * from './multi-account'

// CI/CD integration (Phase 7.3)
export * from './cicd'

// Backup & Disaster Recovery (Phase 7.4)
export * from './backup'

// Compliance & Governance (Phase 7.5)
export * from './compliance'

// Advanced Deployment Strategies (Phase 7.6)
export * from './deployment'

// Observability (Phase 7.7)
export * from './observability'

// Database Advanced Features (Phase 7.8)
export * from './database'

// Secrets & Security Advanced (Phase 7.9)
export * from './security'

// Container Advanced Features (Phase 7.10)
export * from './containers'
