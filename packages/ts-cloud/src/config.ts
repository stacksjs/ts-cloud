import type { CloudOptions } from '@ts-cloud/core'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setStateDir } from '@ts-cloud/core'
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

function isDefaultConfig(config: CloudOptions): boolean {
  return (
    config.project?.slug === defaultConfig.project?.slug &&
    Object.keys(config.environments ?? {}).length === 1 &&
    !!config.environments?.production
  )
}

async function loadStacksCloudConfig(): Promise<CloudOptions | null> {
  const candidates = [join(process.cwd(), 'config', 'cloud.ts'), join(process.cwd(), 'config', 'cloud.js')]

  for (const file of candidates) {
    if (!existsSync(file)) continue
    const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`)
    const config = mod.tsCloud ?? mod.default?.tsCloud ?? mod.default ?? mod.cloud ?? mod.config
    if (config) return config as CloudOptions
  }

  return null
}

export async function getConfig(): Promise<CloudOptions> {
  if (!_config) {
    _config = await loadConfig({
      name: 'cloud',
      defaultConfig,
    })
    if (isDefaultConfig(_config)) {
      _config = (await loadStacksCloudConfig()) ?? _config
    }
    // Publish `stateDir` to the resolver the state helpers read. They are
    // called from module scope in places that never see the config object, so
    // the value has to live somewhere global once we know it.
    setStateDir(_config.stateDir)
  }
  return _config
}

// Alias for CLI usage
export const loadCloudConfig: () => Promise<CloudOptions> = getConfig

// For backwards compatibility - synchronous access with default fallback
export const config: CloudOptions = defaultConfig
