import type { CloudOptions } from '@stacksjs/ts-cloud-types'
import { loadConfig } from 'bunfig'

export const defaultConfig: CloudOptions = {
  project: {
    name: 'my-project',
    slug: 'my-project',
    region: 'us-east-1',
  },
  // mode is optional - auto-detected from infrastructure config
  environments: {
    production: {
      type: 'production',
    },
  },
}

// Lazy-loaded config to avoid top-level await (enables bun --compile)
let _config: CloudOptions | null = null

export async function getConfig(): Promise<CloudOptions> {
  if (!_config) {
    _config = await loadConfig({
  name: 'cloud',
  defaultConfig,
})
  }
  return _config
}

// Alias for CLI usage
export const loadCloudConfig: () => Promise<CloudOptions> = getConfig

// For backwards compatibility - synchronous access with default fallback
export const config: CloudOptions = defaultConfig
