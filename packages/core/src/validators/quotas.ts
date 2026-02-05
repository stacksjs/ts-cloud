/**
 * AWS Service Quota Checking
 * Check if deployment will exceed service limits
*/

import { DebugLogger } from '../errors'

export interface ServiceQuota {
  service: string
  quotaName: string
  currentValue: number
  limit: number
  percentage: number
  warning: boolean
}

/**
 * Common AWS service limits by region
*/
export const DEFAULT_SERVICE_LIMITS = {
  ec2: {
    'Running On-Demand Instances': 20,
    'Elastic IPs': 5,
    'VPCs': 5,
    'Internet Gateways': 5,
    'NAT Gateways': 5,
    'Security Groups': 500,
  },
  rds: {
    'DB Instances': 40,
    'DB Snapshots': 100,
    'DB Parameter Groups': 50,
  },
  lambda: {
    'Concurrent Executions': 1000,
    'Function Storage': 75 * 1024 * 1024 * 1024 as number, // 75 GB
  },
  s3: {
    'Buckets': 100,
  },
  cloudformation: {
    'Stacks': 200,
    'StackSets': 100,
  },
  elasticache: {
    'Nodes': 100,
    'Clusters': 100,
  },
  dynamodb: {
    'Tables': 256,
  },
  ecs: {
    'Clusters': 10000,
    'Services per Cluster': 2000,
  },
}

/**
 * Check service quotas for deployment
*/
export async function checkServiceQuotas(config: any): Promise<ServiceQuota[]> {
  const quotas: ServiceQuota[] = []

  DebugLogger.verbose('Checking AWS service quotas...')

  // Check EC2 quotas
  if (config.infrastructure?.compute?.server) {
    const instanceCount = config.infrastructure.compute.server.autoScaling?.max || 1

    quotas.push({
      service: 'EC2',
      quotaName: 'Running On-Demand Instances',
      currentValue: instanceCount,
      limit: DEFAULT_SERVICE_LIMITS.ec2['Running On-Demand Instances'],
      percentage: (instanceCount / DEFAULT_SERVICE_LIMITS.ec2['Running On-Demand Instances']) * 100,
      warning: instanceCount > DEFAULT_SERVICE_LIMITS.ec2['Running On-Demand Instances'] * 0.8,
    })
  }

  // Check VPC quotas
  if (config.infrastructure?.network?.vpc) {
    quotas.push({
      service: 'EC2',
      quotaName: 'VPCs',
      currentValue: 1,
      limit: DEFAULT_SERVICE_LIMITS.ec2.VPCs,
      percentage: (1 / DEFAULT_SERVICE_LIMITS.ec2.VPCs) * 100,
      warning: false,
    })
  }

  // Check RDS quotas
  if (config.infrastructure?.database?.postgres || config.infrastructure?.database?.mysql) {
    quotas.push({
      service: 'RDS',
      quotaName: 'DB Instances',
      currentValue: 1,
      limit: DEFAULT_SERVICE_LIMITS.rds['DB Instances'],
      percentage: (1 / DEFAULT_SERVICE_LIMITS.rds['DB Instances']) * 100,
      warning: false,
    })
  }

  // Check S3 quotas
  if (config.infrastructure?.storage) {
    const bucketCount = Object.keys(config.infrastructure.storage).length

    quotas.push({
      service: 'S3',
      quotaName: 'Buckets',
      currentValue: bucketCount,
      limit: DEFAULT_SERVICE_LIMITS.s3.Buckets,
      percentage: (bucketCount / DEFAULT_SERVICE_LIMITS.s3.Buckets) * 100,
      warning: bucketCount > DEFAULT_SERVICE_LIMITS.s3.Buckets * 0.8,
    })
  }

  // Check Lambda quotas
  if (config.infrastructure?.functions) {
    let functionCount = 0
    for (const category of Object.values(config.infrastructure.functions)) {
      if (Array.isArray(category)) {
        functionCount += category.length
      }
    }

    // Lambda doesn't have a function count limit, but we can check storage
    quotas.push({
      service: 'Lambda',
      quotaName: 'Functions (estimated)',
      currentValue: functionCount,
      limit: 1000, // Soft limit
      percentage: (functionCount / 1000) * 100,
      warning: functionCount > 800,
    })
  }

  // Check DynamoDB quotas
  if (config.infrastructure?.database?.dynamodb) {
    const tableCount = config.infrastructure.database.dynamodb.tables?.length || 0

    quotas.push({
      service: 'DynamoDB',
      quotaName: 'Tables',
      currentValue: tableCount,
      limit: DEFAULT_SERVICE_LIMITS.dynamodb.Tables,
      percentage: (tableCount / DEFAULT_SERVICE_LIMITS.dynamodb.Tables) * 100,
      warning: tableCount > DEFAULT_SERVICE_LIMITS.dynamodb.Tables * 0.8,
    })
  }

  // Log warnings
  const warnings = quotas.filter(q => q.warning)
  if (warnings.length > 0) {
    DebugLogger.warn('Service quota warnings detected:')
    for (const warning of warnings) {
      DebugLogger.warn(`  ${warning.service} - ${warning.quotaName}: ${warning.currentValue}/${warning.limit} (${warning.percentage.toFixed(1)}%)`)
    }
  }
  else {
    DebugLogger.verbose('All service quotas are within limits')
  }

  return quotas
}

/**
 * Get quota usage summary
*/
export function getQuotaUsageSummary(quotas: ServiceQuota[]): string {
  if (quotas.length === 0) {
    return 'No quotas to check'
  }

  let summary = 'Service Quota Usage:\n\n'

  const byService = quotas.reduce((acc, quota) => {
    if (!acc[quota.service]) {
      acc[quota.service] = []
    }
    acc[quota.service].push(quota)
    return acc
  }, {} as Record<string, ServiceQuota[]>)

  for (const [service, serviceQuotas] of Object.entries(byService)) {
    summary += `${service}:\n`
    for (const quota of serviceQuotas) {
      const indicator = quota.warning ? '⚠' : '✓'
      summary += `  ${indicator} ${quota.quotaName}: ${quota.currentValue}/${quota.limit} (${quota.percentage.toFixed(1)}%)\n`
    }
    summary += '\n'
  }

  return summary
}

/**
 * Suggest quota increase if needed
*/
export function suggestQuotaIncrease(quotas: ServiceQuota[]): string[] {
  const suggestions: string[] = []

  for (const quota of quotas) {
    if (quota.percentage >= 100) {
      suggestions.push(
        `Request quota increase for ${quota.service} - ${quota.quotaName} (currently ${quota.limit})`,
      )
    }
    else if (quota.warning) {
      suggestions.push(
        `Consider requesting quota increase for ${quota.service} - ${quota.quotaName} (${quota.percentage.toFixed(1)}% used)`,
      )
    }
  }

  return suggestions
}
