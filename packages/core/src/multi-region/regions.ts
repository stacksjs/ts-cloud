/**
 * AWS Region utilities
 * Region selection, validation, and configuration
 */

export interface RegionInfo {
  code: string
  name: string
  location: string
  launchYear: number
  availabilityZones: number
  localZones?: number
  wavelengthZones?: number
  services: {
    compute: boolean
    storage: boolean
    database: boolean
    networking: boolean
    ml: boolean
    analytics: boolean
  }
  pricing: {
    tier: 'standard' | 'reduced' | 'premium'
    multiplier: number
  }
  compliance: string[]
}

/**
 * AWS Region database
 */
export const AWS_REGIONS: RegionInfo[] = [
  {
    code: 'us-east-1',
    name: 'US East (N. Virginia)',
    location: 'Virginia, USA',
    launchYear: 2006,
    availabilityZones: 6,
    localZones: 16,
    services: {
      compute: true,
      storage: true,
      database: true,
      networking: true,
      ml: true,
      analytics: true,
    },
    pricing: {
      tier: 'standard',
      multiplier: 1.0,
    },
    compliance: ['PCI-DSS', 'HIPAA', 'SOC', 'ISO', 'FedRAMP'],
  },
  {
    code: 'us-east-2',
    name: 'US East (Ohio)',
    location: 'Ohio, USA',
    launchYear: 2016,
    availabilityZones: 3,
    services: {
      compute: true,
      storage: true,
      database: true,
      networking: true,
      ml: true,
      analytics: true,
    },
    pricing: {
      tier: 'standard',
      multiplier: 1.0,
    },
    compliance: ['PCI-DSS', 'HIPAA', 'SOC', 'ISO'],
  },
  {
    code: 'us-west-1',
    name: 'US West (N. California)',
    location: 'California, USA',
    launchYear: 2009,
    availabilityZones: 3,
    services: {
      compute: true,
      storage: true,
      database: true,
      networking: true,
      ml: true,
      analytics: true,
    },
    pricing: {
      tier: 'premium',
      multiplier: 1.1,
    },
    compliance: ['PCI-DSS', 'HIPAA', 'SOC', 'ISO'],
  },
  {
    code: 'us-west-2',
    name: 'US West (Oregon)',
    location: 'Oregon, USA',
    launchYear: 2011,
    availabilityZones: 4,
    localZones: 2,
    services: {
      compute: true,
      storage: true,
      database: true,
      networking: true,
      ml: true,
      analytics: true,
    },
    pricing: {
      tier: 'standard',
      multiplier: 1.0,
    },
    compliance: ['PCI-DSS', 'HIPAA', 'SOC', 'ISO'],
  },
  {
    code: 'eu-west-1',
    name: 'Europe (Ireland)',
    location: 'Dublin, Ireland',
    launchYear: 2007,
    availabilityZones: 3,
    services: {
      compute: true,
      storage: true,
      database: true,
      networking: true,
      ml: true,
      analytics: true,
    },
    pricing: {
      tier: 'standard',
      multiplier: 1.05,
    },
    compliance: ['PCI-DSS', 'GDPR', 'SOC', 'ISO'],
  },
  {
    code: 'eu-central-1',
    name: 'Europe (Frankfurt)',
    location: 'Frankfurt, Germany',
    launchYear: 2014,
    availabilityZones: 3,
    services: {
      compute: true,
      storage: true,
      database: true,
      networking: true,
      ml: true,
      analytics: true,
    },
    pricing: {
      tier: 'premium',
      multiplier: 1.1,
    },
    compliance: ['PCI-DSS', 'GDPR', 'SOC', 'ISO'],
  },
  {
    code: 'ap-southeast-1',
    name: 'Asia Pacific (Singapore)',
    location: 'Singapore',
    launchYear: 2010,
    availabilityZones: 3,
    services: {
      compute: true,
      storage: true,
      database: true,
      networking: true,
      ml: true,
      analytics: true,
    },
    pricing: {
      tier: 'premium',
      multiplier: 1.12,
    },
    compliance: ['PCI-DSS', 'SOC', 'ISO', 'MTCS'],
  },
  {
    code: 'ap-northeast-1',
    name: 'Asia Pacific (Tokyo)',
    location: 'Tokyo, Japan',
    launchYear: 2011,
    availabilityZones: 4,
    services: {
      compute: true,
      storage: true,
      database: true,
      networking: true,
      ml: true,
      analytics: true,
    },
    pricing: {
      tier: 'premium',
      multiplier: 1.15,
    },
    compliance: ['PCI-DSS', 'SOC', 'ISO'],
  },
]

/**
 * Get region by code
 */
export function getRegion(code: string): RegionInfo | undefined {
  return AWS_REGIONS.find(r => r.code === code)
}

/**
 * Get all regions
 */
export function getAllRegions(): RegionInfo[] {
  return AWS_REGIONS
}

/**
 * Get regions by location
 */
export function getRegionsByLocation(location: string): RegionInfo[] {
  const lowerLocation = location.toLowerCase()
  return AWS_REGIONS.filter(r => r.location.toLowerCase().includes(lowerLocation))
}

/**
 * Get regions with specific compliance
 */
export function getRegionsByCompliance(compliance: string): RegionInfo[] {
  return AWS_REGIONS.filter(r => r.compliance.includes(compliance))
}

/**
 * Get regions by pricing tier
 */
export function getRegionsByPricingTier(tier: 'standard' | 'reduced' | 'premium'): RegionInfo[] {
  return AWS_REGIONS.filter(r => r.pricing.tier === tier)
}

/**
 * Validate region code
 */
export function isValidRegion(code: string): boolean {
  return AWS_REGIONS.some(r => r.code === code)
}

/**
 * Get closest region to user location
 */
export function getClosestRegion(userLocation: {
  continent?: string
  country?: string
}): RegionInfo {
  // Simple heuristic based on location
  if (userLocation.continent === 'North America') {
    return getRegion('us-east-1')!
  }

  if (userLocation.continent === 'Europe') {
    return getRegion('eu-west-1')!
  }

  if (userLocation.continent === 'Asia') {
    return getRegion('ap-southeast-1')!
  }

  // Default to us-east-1
  return getRegion('us-east-1')!
}

/**
 * Suggest regions based on requirements
 */
export interface RegionRequirements {
  compliance?: string[]
  pricingSensitive?: boolean
  lowLatency?: boolean
  userLocations?: string[]
  requiredServices?: Array<keyof RegionInfo['services']>
}

export function suggestRegions(requirements: RegionRequirements): RegionInfo[] {
  let candidates = [...AWS_REGIONS]

  // Filter by compliance
  if (requirements.compliance) {
    candidates = candidates.filter(r =>
      requirements.compliance!.every(c => r.compliance.includes(c)),
    )
  }

  // Filter by required services
  if (requirements.requiredServices) {
    candidates = candidates.filter(r =>
      requirements.requiredServices!.every(s => r.services[s]),
    )
  }

  // Sort by pricing if price sensitive
  if (requirements.pricingSensitive) {
    candidates.sort((a, b) => a.pricing.multiplier - b.pricing.multiplier)
  }

  return candidates.slice(0, 5) // Return top 5
}

/**
 * Calculate region pairs for failover
 */
export interface RegionPairSuggestion {
  primary: RegionInfo
  secondary: RegionInfo
  distance: number
  sameContinent: boolean
}

export function suggestRegionPairs(primaryRegion: string): RegionPairSuggestion[] {
  const primary = getRegion(primaryRegion)

  if (!primary) {
    throw new Error(`Invalid region: ${primaryRegion}`)
  }

  const suggestions: RegionPairSuggestion[] = []

  for (const region of AWS_REGIONS) {
    if (region.code === primaryRegion) continue

    // Calculate geographic distance (simplified)
    const distance = calculateDistance(primary, region)
    const sameContinent = isSameContinent(primary, region)

    suggestions.push({
      primary,
      secondary: region,
      distance,
      sameContinent,
    })
  }

  // Sort by distance (prefer geographically distributed)
  suggestions.sort((a, b) => {
    // Prefer different continents
    if (a.sameContinent !== b.sameContinent) {
      return a.sameContinent ? 1 : -1
    }
    // Then by distance
    return a.distance - b.distance
  })

  return suggestions.slice(0, 3) // Return top 3
}

/**
 * Calculate simplified distance between regions
 */
function calculateDistance(region1: RegionInfo, region2: RegionInfo): number {
  // Simplified distance calculation
  // In real implementation, would use actual lat/lon coordinates
  const continents = {
    'North America': 0,
    'South America': 1,
    'Europe': 2,
    'Asia': 3,
    'Africa': 4,
    'Oceania': 5,
  }

  const continent1 = getContinentFromLocation(region1.location)
  const continent2 = getContinentFromLocation(region2.location)

  return Math.abs(
    (continents[continent1 as keyof typeof continents] || 0)
      - (continents[continent2 as keyof typeof continents] || 0),
  )
}

/**
 * Check if regions are on the same continent
 */
function isSameContinent(region1: RegionInfo, region2: RegionInfo): boolean {
  return getContinentFromLocation(region1.location) === getContinentFromLocation(region2.location)
}

/**
 * Get continent from location string
 */
function getContinentFromLocation(location: string): string {
  if (location.includes('USA') || location.includes('Canada')) {
    return 'North America'
  }
  if (location.includes('Europe') || location.includes('Ireland') || location.includes('Germany')) {
    return 'Europe'
  }
  if (location.includes('Asia') || location.includes('Singapore') || location.includes('Japan')) {
    return 'Asia'
  }
  if (location.includes('Brazil')) {
    return 'South America'
  }
  if (location.includes('Australia')) {
    return 'Oceania'
  }
  return 'Unknown'
}

/**
 * Format region for display
 */
export function formatRegion(region: RegionInfo): string {
  return `${region.name} (${region.code})`
}

/**
 * Format region list for display
 */
export function formatRegionList(regions: RegionInfo[]): string {
  return regions.map(r => formatRegion(r)).join('\n')
}

/**
 * Get region statistics
 */
export function getRegionStats(): {
  total: number
  byContinent: Record<string, number>
  byPricingTier: Record<string, number>
} {
  const stats = {
    total: AWS_REGIONS.length,
    byContinent: {} as Record<string, number>,
    byPricingTier: {} as Record<string, number>,
  }

  for (const region of AWS_REGIONS) {
    const continent = getContinentFromLocation(region.location)
    stats.byContinent[continent] = (stats.byContinent[continent] || 0) + 1
    stats.byPricingTier[region.pricing.tier] = (stats.byPricingTier[region.pricing.tier] || 0) + 1
  }

  return stats
}
