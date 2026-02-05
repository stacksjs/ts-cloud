import type { CloudConfig } from '@stacksjs/ts-cloud-types'

/**
 * Deep merge utility for combining CloudConfig objects
*/
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target }

  for (const key in source) {
    const sourceValue = source[key]
    const targetValue = result[key]

    if (sourceValue === undefined) {
      continue
    }

    if (Array.isArray(sourceValue) && Array.isArray(targetValue)) {
      // Merge arrays by concatenating
      result[key] = [...targetValue, ...sourceValue] as any
    }
    else if (
      typeof sourceValue === 'object'
      && sourceValue !== null
      && !Array.isArray(sourceValue)
      && typeof targetValue === 'object'
      && targetValue !== null
      && !Array.isArray(targetValue)
    ) {
      // Recursively merge objects
      result[key] = deepMerge(targetValue, sourceValue)
    }
    else {
      // Override primitive values
      result[key] = sourceValue as any
    }
  }

  return result
}

/**
 * Extend a base preset with custom configuration
 *
 * @example
 * ```typescript
 * const myPreset = extendPreset(
 *   createNodeJsServerPreset({ name: 'My App', slug: 'my-app' }),
 *   {
 *     infrastructure: {
 *       compute: {
 *         server: {
 *           instanceType: 't3.large', // Override instance type
 *           autoScaling: {
 *             max: 20, // Increase max instances
 *           },
 *         },
 *       },
 *       database: {
 *         postgres: {
 *           instanceClass: 'db.r6g.xlarge', // Upgrade database
 *         },
 *       },
 *     },
 *   }
 * )
 * ```
*/
export function extendPreset(
  basePreset: Partial<CloudConfig>,
  extensions: Partial<CloudConfig>,
): Partial<CloudConfig> {
  return deepMerge(basePreset as Record<string, any>, extensions as Record<string, any>) as Partial<CloudConfig>
}

/**
 * Compose multiple presets together
 * Later presets override earlier ones
 *
 * @example
 * ```typescript
 * const composedPreset = composePresets(
 *   createStaticSitePreset({ name: 'Site', slug: 'site', domain: 'example.com' }),
 *   createApiBackendPreset({ name: 'API', slug: 'api' }),
 *   {
 *     // Custom overrides
 *     infrastructure: {
 *       monitoring: {
 *         alarms: [{ metric: 'CustomMetric', threshold: 100 }],
 *       },
 *     },
 *   }
 * )
 * ```
*/
export function composePresets(
  ...presets: Partial<CloudConfig>[]
): Partial<CloudConfig> {
  return presets.reduce(
    (acc, preset) => deepMerge(acc as Record<string, any>, preset as Record<string, any>),
    {} as Record<string, any>,
  ) as Partial<CloudConfig>
}

/**
 * Create a custom preset by extending an existing one
 *
 * @example
 * ```typescript
 * const createMyCustomPreset = createPreset(
 *   (options) => createNodeJsServerPreset(options),
 *   {
 *     infrastructure: {
 *       monitoring: {
 *         dashboard: {
 *           name: 'custom-dashboard',
 *           widgets: [{ type: 'metric', metrics: ['CustomMetric'] }],
 *         },
 *       },
 *     },
 *   }
 * )
 *
 * // Use it
 * const myPreset = createMyCustomPreset({ name: 'App', slug: 'app' })
 * ```
*/
export function createPreset<TOptions extends Record<string, any>>(
  basePresetFn: (options: TOptions) => Partial<CloudConfig>,
  extensions: Partial<CloudConfig> | ((config: Partial<CloudConfig>, options: TOptions) => Partial<CloudConfig>),
): (options: TOptions) => Partial<CloudConfig> {
  return (options: TOptions) => {
    const baseConfig = basePresetFn(options)

    if (typeof extensions === 'function') {
      return extendPreset(baseConfig, extensions(baseConfig, options))
    }

    return extendPreset(baseConfig, extensions)
  }
}

/**
 * Merge infrastructure configurations selectively
 * Useful for adding specific infrastructure to existing presets
 *
 * @example
 * ```typescript
 * const withRedis = mergeInfrastructure({
 *   cache: {
 *     redis: {
 *       nodeType: 'cache.t3.small',
 *       numCacheNodes: 2,
 *     },
 *   },
 * })
 *
 * const myPreset = extendPreset(
 *   createApiBackendPreset({ name: 'API', slug: 'api' }),
 *   withRedis
 * )
 * ```
*/
export function mergeInfrastructure(
  infrastructure: Partial<CloudConfig['infrastructure']>,
): Partial<CloudConfig> {
  return {
    infrastructure,
  }
}

/**
 * Add monitoring configuration to any preset
 *
 * @example
 * ```typescript
 * const myPreset = extendPreset(
 *   createStaticSitePreset({ name: 'Site', slug: 'site' }),
 *   withMonitoring({
 *     dashboard: { name: 'my-dashboard' },
 *     alarms: [{ metric: 'Errors', threshold: 10 }],
 *   })
 * )
 * ```
*/
export function withMonitoring(
  monitoring: NonNullable<CloudConfig['infrastructure']>['monitoring'],
): Partial<CloudConfig> {
  return mergeInfrastructure({ monitoring })
}

/**
 * Add security configuration to any preset
 *
 * @example
 * ```typescript
 * const myPreset = extendPreset(
 *   createApiBackendPreset({ name: 'API', slug: 'api' }),
 *   withSecurity({
 *     waf: { enabled: true, rules: ['rateLimit', 'sqlInjection'] },
 *   })
 * )
 * ```
*/
export function withSecurity(
  security: NonNullable<CloudConfig['infrastructure']>['security'],
): Partial<CloudConfig> {
  return mergeInfrastructure({ security })
}

/**
 * Add database configuration to any preset
 *
 * @example
 * ```typescript
 * const myPreset = extendPreset(
 *   createNodeJsServerlessPreset({ name: 'App', slug: 'app' }),
 *   withDatabase({
 *     postgres: {
 *       engine: 'postgres',
 *       version: '15',
 *       instanceClass: 'db.t3.medium',
 *       multiAZ: true,
 *     },
 *   })
 * )
 * ```
*/
export function withDatabase(
  databases: NonNullable<CloudConfig['infrastructure']>['databases'],
): Partial<CloudConfig> {
  return mergeInfrastructure({ databases })
}

/**
 * Add cache configuration to any preset
 *
 * @example
 * ```typescript
 * const myPreset = extendPreset(
 *   createApiBackendPreset({ name: 'API', slug: 'api' }),
 *   withCache({
 *     redis: {
 *       nodeType: 'cache.t3.small',
 *       numCacheNodes: 2,
 *     },
 *   })
 * )
 * ```
*/
export function withCache(
  cache: NonNullable<CloudConfig['infrastructure']>['cache'],
): Partial<CloudConfig> {
  return mergeInfrastructure({ cache })
}

/**
 * Add CDN configuration to any preset
 *
 * @example
 * ```typescript
 * const myPreset = extendPreset(
 *   createNodeJsServerPreset({ name: 'App', slug: 'app' }),
 *   withCDN({
 *     enabled: true,
 *     compress: true,
 *     http3: true,
 *   })
 * )
 * ```
*/
export function withCDN(
  cdn: NonNullable<CloudConfig['infrastructure']>['cdn'],
): Partial<CloudConfig> {
  return mergeInfrastructure({ cdn })
}

/**
 * Add queue configuration to any preset
 *
 * @example
 * ```typescript
 * const myPreset = extendPreset(
 *   createNodeJsServerlessPreset({ name: 'App', slug: 'app' }),
 *   withQueue({
 *     jobs: {
 *       fifo: false,
 *       deadLetterQueue: true,
 *     },
 *   })
 * )
 * ```
*/
export function withQueue(
  queues: NonNullable<CloudConfig['infrastructure']>['queues'],
): Partial<CloudConfig> {
  return mergeInfrastructure({ queues })
}
