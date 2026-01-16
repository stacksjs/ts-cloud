/**
 * Preset Extension and Composition Tests
 */

import { describe, expect, it } from 'bun:test'
import {
  extendPreset,
  composePresets,
  withMonitoring,
  withSecurity,
  withDatabase,
  withCache,
  withCDN,
  withQueue,
} from './extend'
import type { CloudConfig } from '@ts-cloud/types'

describe('extendPreset', () => {
  it('should extend base preset with new properties', () => {
    const base: Partial<CloudConfig> = {
      project: {
        name: 'Base',
        slug: 'base',
        region: 'us-east-1',
      },
    }

    const extension: Partial<CloudConfig> = {
      infrastructure: {
        storage: {
          uploads: {},
        },
      },
    }

    const result = extendPreset(base, extension)

    expect(result.project).toEqual(base.project)
    expect(result.infrastructure?.storage).toEqual(extension.infrastructure?.storage)
  })

  it('should override base properties with extension properties', () => {
    const base: Partial<CloudConfig> = {
      project: {
        name: 'Base',
        slug: 'base',
        region: 'us-east-1',
      },
    }

    const extension: Partial<CloudConfig> = {
      project: {
        name: 'Base',
        slug: 'base',
        region: 'eu-west-1',
      },
    }

    const result = extendPreset(base, extension)

    expect(result.project?.name).toBe('Base')
    expect(result.project?.slug).toBe('base')
    expect(result.project?.region).toBe('eu-west-1')
  })

  it('should merge infrastructure configurations', () => {
    const base: Partial<CloudConfig> = {
      infrastructure: {
        storage: {
          uploads: {},
        },
      },
    }

    const extension: Partial<CloudConfig> = {
      infrastructure: {
        storage: {
          assets: {},
        },
      },
    }

    const result = extendPreset(base, extension)

    expect(result.infrastructure?.storage?.uploads).toBeDefined()
    expect(result.infrastructure?.storage?.assets).toBeDefined()
  })
})

describe('composePresets', () => {
  it('should compose multiple presets in order', () => {
    const preset1: Partial<CloudConfig> = {
      project: {
        name: 'Project',
        slug: 'project',
        region: 'us-west-2',
      },
    }

    const preset2: Partial<CloudConfig> = {
      project: {
        name: 'Project',
        slug: 'project',
        region: 'us-east-1',
      },
    }

    const preset3: Partial<CloudConfig> = {
      infrastructure: {
        storage: {},
      },
    }

    const result = composePresets(preset1, preset2, preset3)

    expect(result.project?.name).toBe('Project')
    expect(result.project?.slug).toBe('project')
    expect(result.project?.region).toBe('us-east-1')
    expect(result.infrastructure?.storage).toBeDefined()
  })

  it('should apply later presets over earlier ones', () => {
    const preset1: Partial<CloudConfig> = {
      project: {
        name: 'Project',
        slug: 'project',
        region: 'us-east-1',
      },
    }

    const preset2: Partial<CloudConfig> = {
      project: {
        name: 'Project',
        slug: 'project',
        region: 'eu-west-1',
      },
    }

    const result = composePresets(preset1, preset2)

    expect(result.project?.region).toBe('eu-west-1')
  })

  it('should handle empty presets', () => {
    const preset1: Partial<CloudConfig> = {
      project: {
        name: 'Test',
        slug: 'test',
        region: 'us-east-1',
      },
    }

    const result = composePresets(preset1, {}, {})

    expect(result.project?.name).toBe('Test')
  })
})

describe('withMonitoring', () => {
  it('should add monitoring configuration', () => {
    const base: Partial<CloudConfig> = {
      project: {
        name: 'Test',
        slug: 'test',
        region: 'us-east-1',
      },
    }

    const result = extendPreset(base, withMonitoring({
      alarms: [],
    }))

    expect(result.infrastructure?.monitoring).toBeDefined()
  })

  it('should preserve existing infrastructure', () => {
    const base: Partial<CloudConfig> = {
      infrastructure: {
        storage: {
          uploads: {},
        },
      },
    }

    const result = extendPreset(base, withMonitoring({
      alarms: [],
    }))

    expect(result.infrastructure?.storage?.uploads).toBeDefined()
    expect(result.infrastructure?.monitoring).toBeDefined()
  })
})

describe('withSecurity', () => {
  it('should add security configuration', () => {
    const base: Partial<CloudConfig> = {
      project: {
        name: 'Test',
        slug: 'test',
        region: 'us-east-1',
      },
    }

    const result = extendPreset(base, withSecurity({
      waf: { enabled: true },
    }))

    expect(result.infrastructure?.security).toBeDefined()
    expect(result.infrastructure?.security?.waf?.enabled).toBe(true)
  })
})

describe('withDatabase', () => {
  it('should add database configuration', () => {
    const base: Partial<CloudConfig> = {
      project: {
        name: 'Test',
        slug: 'test',
        region: 'us-east-1',
      },
    }

    const result = extendPreset(base, withDatabase({
      postgres: {
        instanceClass: 'db.t3.micro',
      },
    }))

    expect(result.infrastructure?.databases?.postgres).toBeDefined()
    expect(result.infrastructure?.databases?.postgres?.instanceClass).toBe('db.t3.micro')
  })
})

describe('withCache', () => {
  it('should add cache configuration', () => {
    const base: Partial<CloudConfig> = {
      project: {
        name: 'Test',
        slug: 'test',
        region: 'us-east-1',
      },
    }

    const result = extendPreset(base, withCache({
      redis: {
        nodeType: 'cache.t3.small',
      },
    }))

    expect(result.infrastructure?.cache?.redis).toBeDefined()
    expect(result.infrastructure?.cache?.redis?.nodeType).toBe('cache.t3.small')
  })
})

describe('withCDN', () => {
  it('should add CDN configuration', () => {
    const base: Partial<CloudConfig> = {
      project: {
        name: 'Test',
        slug: 'test',
        region: 'us-east-1',
      },
    }

    const result = extendPreset(base, withCDN({
      enabled: true,
      compress: true,
    }))

    expect(result.infrastructure?.cdn).toBeDefined()
    expect(result.infrastructure?.cdn?.enabled).toBe(true)
    expect(result.infrastructure?.cdn?.compress).toBe(true)
  })
})

describe('withQueue', () => {
  it('should add queue configuration', () => {
    const base: Partial<CloudConfig> = {
      project: {
        name: 'Test',
        slug: 'test',
        region: 'us-east-1',
      },
    }

    const result = extendPreset(base, withQueue({
      jobs: {
        fifo: false,
      },
    }))

    expect(result.infrastructure?.queues?.jobs).toBeDefined()
    expect(result.infrastructure?.queues?.jobs?.fifo).toBe(false)
  })
})
