import type { InstanceSize } from '@ts-cloud/core'

/**
 * Map ts-cloud instance size shorthands to Hetzner Cloud server types.
 * @see https://www.hetzner.com/cloud
 */
export const HETZNER_INSTANCE_TYPES: Record<Exclude<InstanceSize, string & {}> | 'micro' | 'small' | 'medium' | 'large' | 'xlarge' | '2xlarge', string> = {
  micro: 'cpx11',
  small: 'cx22',
  medium: 'cx32',
  large: 'cx42',
  xlarge: 'cx52',
  '2xlarge': 'ccx33',
}

export function resolveHetznerServerType(size?: string): string {
  if (!size) return HETZNER_INSTANCE_TYPES.micro
  if (size in HETZNER_INSTANCE_TYPES) {
    return HETZNER_INSTANCE_TYPES[size as keyof typeof HETZNER_INSTANCE_TYPES]
  }
  return size
}

export const TS_CLOUD_LABEL_PREFIX = 'ts-cloud'

export function tsCloudLabels(slug: string, environment: string, role = 'app'): Record<string, string> {
  return {
    [`${TS_CLOUD_LABEL_PREFIX}/project`]: slug,
    [`${TS_CLOUD_LABEL_PREFIX}/environment`]: environment,
    [`${TS_CLOUD_LABEL_PREFIX}/role`]: role,
    [`${TS_CLOUD_LABEL_PREFIX}/managed-by`]: 'ts-cloud',
  }
}

export function matchesTsCloudLabels(
  labels: Record<string, string> | undefined,
  slug: string,
  environment: string,
  role = 'app',
): boolean {
  if (!labels) return false
  return labels[`${TS_CLOUD_LABEL_PREFIX}/project`] === slug
    && labels[`${TS_CLOUD_LABEL_PREFIX}/environment`] === environment
    && labels[`${TS_CLOUD_LABEL_PREFIX}/role`] === role
}
