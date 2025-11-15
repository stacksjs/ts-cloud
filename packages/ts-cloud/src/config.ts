import type { CloudConfig } from '@ts-cloud/types'

export const defaultConfig: Partial<CloudConfig> = {
  project: {
    name: 'my-project',
    slug: 'my-project',
    region: 'us-east-1',
  },
  mode: 'serverless',
  environments: {
    production: {
      type: 'production',
    },
  },
}

/**
 * Load cloud configuration from cloud.config.ts
 */
export async function loadCloudConfig(): Promise<CloudConfig> {
  try {
    const config = await import(`${process.cwd()}/cloud.config.ts`)
    return config.default || config
  }
  catch (error) {
    console.warn('No cloud.config.ts found, using default configuration')
    return defaultConfig as CloudConfig
  }
}
