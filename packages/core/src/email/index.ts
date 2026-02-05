/**
 * Email Advanced Features
 * Bounce handling, analytics, reputation monitoring, and template management
*/

export * from './bounce-handling'
export * from './analytics'
export * from './reputation'
export * from './templates'

// Advanced features (namespaced to avoid conflicts)
export * as EmailAdvanced from './advanced'

// Handlers (namespaced)
export * as EmailHandlers from './handlers/inbound'
