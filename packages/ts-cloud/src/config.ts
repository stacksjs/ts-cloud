import type { CloudConfig } from './types'
import { loadConfig } from 'bunfig'

export const defaultConfig: CloudConfig = {
  verbose: true,
}

// eslint-disable-next-line antfu/no-top-level-await
export const config: CloudConfig = await loadConfig({
  name: 'binary',
  defaultConfig,
})
