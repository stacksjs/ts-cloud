import type { CloudOptions } from '@ts-cloud/types'
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

export const config: CloudOptions = await loadConfig({
  name: 'cloud',
  defaultConfig,
})
