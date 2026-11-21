import type { CloudOptions, EnvironmentType } from '@ts-cloud/core'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setStateDir } from '@ts-cloud/core'
import { loadConfig, loadConfigWithResult } from 'bunfig'

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

// Lazy-loaded per deployment target to avoid top-level await and keep the
// Stacks production and staging blueprints independent.
const configs = new Map<EnvironmentType | undefined, CloudOptions>()

function isDefaultConfig(config: CloudOptions): boolean {
  return (
    config.project?.slug === defaultConfig.project?.slug &&
    Object.keys(config.environments ?? {}).length === 1 &&
    !!config.environments?.production
  )
}

function stacksConfigFiles(): string[] {
  return [join(process.cwd(), 'config', 'cloud.ts'), join(process.cwd(), 'config', 'cloud.js')]
}

async function loadStacksCloudConfig(environment?: EnvironmentType): Promise<CloudOptions | null> {
  for (const file of stacksConfigFiles()) {
    if (!existsSync(file)) continue
    // Buddy loads the deployment blueprint from a filesystem specifier with
    // an env query. Bun can reuse the unscoped module for a file URL import.
    const specifier = environment ? `${file}?env=${environment}` : `${pathToFileURL(file).href}?t=${Date.now()}`
    const mod = await import(specifier)
    const config = mod.tsCloud ?? mod.default?.tsCloud ?? mod.default ?? mod.cloud ?? mod.config
    if (config) return config as CloudOptions
  }

  return null
}

export async function getConfig(environment?: EnvironmentType): Promise<CloudOptions> {
  let selected = configs.get(environment)
  if (!selected) {
    const options = { name: 'cloud', defaultConfig }
    const loaded = environment ? await loadConfigWithResult(options).catch(() => undefined) : undefined
    selected = loaded?.config ?? await loadConfig(options)
    const loadedPath = loaded?.path ?? loaded?.source.path
    if (isDefaultConfig(selected) || (loadedPath && stacksConfigFiles().includes(loadedPath))) {
      selected = (await loadStacksCloudConfig(environment)) ?? selected
    }
    configs.set(environment, selected)
  }
  // State helpers read this outside the configuration loader, including when
  // a caller returns to a cached environment after loading another target.
  setStateDir(selected.stateDir)
  return selected
}

// Alias for CLI usage
export const loadCloudConfig: (environment?: EnvironmentType) => Promise<CloudOptions> = getConfig

// For backwards compatibility - synchronous access with default fallback
export const config: CloudOptions = defaultConfig
