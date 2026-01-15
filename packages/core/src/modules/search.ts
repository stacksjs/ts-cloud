/**
 * Search Module (OpenSearch/Elasticsearch)
 * Clean API for AWS OpenSearch Service
 */

import type { OpenSearchDomain } from '@ts-cloud/aws-types'
import type { EnvironmentType } from '@ts-cloud/types'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface SearchDomainOptions {
  slug: string
  environment: string
  domainName?: string
  engineVersion?: string // e.g., 'OpenSearch_2.11'
  instanceType?: string // e.g., 't3.small.search', 'm6g.large.search'
  instanceCount?: number
  volumeSize?: number // in GiB
  volumeType?: 'gp2' | 'gp3' | 'io1'
  dedicatedMaster?: boolean
  dedicatedMasterType?: string
  dedicatedMasterCount?: number
  multiAz?: boolean
  availabilityZoneCount?: number
  vpc?: {
    subnetIds: Array<string | { Ref: string }>
    securityGroupIds: Array<string | { Ref: string }>
  }
  encryption?: {
    atRest?: boolean
    kmsKeyId?: string | { Ref: string }
    nodeToNode?: boolean
  }
  enforceHttps?: boolean
  tlsSecurityPolicy?: 'Policy-Min-TLS-1-0-2019-07' | 'Policy-Min-TLS-1-2-2019-07'
  advancedSecurity?: {
    enabled: boolean
    internalUserDatabase?: boolean
    masterUserName?: string
    masterUserPassword?: string
    masterUserArn?: string | { Ref: string }
  }
  autoSnapshotHour?: number
  autoTune?: boolean
  tags?: Record<string, string>
}

export interface AccessPolicyOptions {
  ipAddresses?: string[]
  iamPrincipalArns?: Array<string | { Ref: string }>
  allowAll?: boolean
  vpcEndpoint?: boolean
}

/**
 * Search class for OpenSearch/Elasticsearch operations
 */
export class Search {
  /**
   * Create an OpenSearch domain
   */
  static createDomain(options: SearchDomainOptions): {
    domain: OpenSearchDomain
    logicalId: string
  } {
    const {
      slug,
      environment,
      domainName,
      engineVersion = 'OpenSearch_2.11',
      instanceType = 't3.small.search',
      instanceCount = 1,
      volumeSize = 10,
      volumeType = 'gp3',
      dedicatedMaster = false,
      dedicatedMasterType,
      dedicatedMasterCount = 3,
      multiAz = false,
      availabilityZoneCount = 2,
      vpc,
      encryption,
      enforceHttps = true,
      tlsSecurityPolicy = 'Policy-Min-TLS-1-2-2019-07',
      advancedSecurity,
      autoSnapshotHour = 0,
      autoTune = true,
      tags = {},
    } = options

    const resourceName = domainName || generateResourceName({
      slug,
      environment: environment as EnvironmentType,
      resourceType: 'search',
    })
    const logicalId = generateLogicalId(resourceName)

    const domain: OpenSearchDomain = {
      Type: 'AWS::OpenSearchService::Domain',
      Properties: {
        DomainName: resourceName,
        EngineVersion: engineVersion,

        ClusterConfig: {
          InstanceType: instanceType,
          InstanceCount: instanceCount,
          DedicatedMasterEnabled: dedicatedMaster,
          ...(dedicatedMaster && {
            DedicatedMasterType: dedicatedMasterType || instanceType,
            DedicatedMasterCount: dedicatedMasterCount,
          }),
          ZoneAwarenessEnabled: multiAz,
          ...(multiAz && {
            ZoneAwarenessConfig: {
              AvailabilityZoneCount: availabilityZoneCount,
            },
          }),
        },

        EBSOptions: {
          EBSEnabled: true,
          VolumeType: volumeType,
          VolumeSize: volumeSize,
        },

        DomainEndpointOptions: {
          EnforceHTTPS: enforceHttps,
          TLSSecurityPolicy: tlsSecurityPolicy,
        },

        SnapshotOptions: {
          AutomatedSnapshotStartHour: autoSnapshotHour,
        },

        ...(vpc && {
          VPCOptions: {
            SubnetIds: vpc.subnetIds,
            SecurityGroupIds: vpc.securityGroupIds,
          },
        }),

        ...(encryption && {
          EncryptionAtRestOptions: {
            Enabled: encryption.atRest ?? true,
            ...(encryption.kmsKeyId && { KmsKeyId: encryption.kmsKeyId }),
          },
          NodeToNodeEncryptionOptions: {
            Enabled: encryption.nodeToNode ?? true,
          },
        }),

        ...(advancedSecurity && {
          AdvancedSecurityOptions: {
            Enabled: advancedSecurity.enabled,
            InternalUserDatabaseEnabled: advancedSecurity.internalUserDatabase ?? true,
            ...(advancedSecurity.masterUserName && advancedSecurity.masterUserPassword && {
              MasterUserOptions: {
                MasterUserName: advancedSecurity.masterUserName,
                MasterUserPassword: advancedSecurity.masterUserPassword,
              },
            }),
            ...(advancedSecurity.masterUserArn && {
              MasterUserOptions: {
                MasterUserARN: advancedSecurity.masterUserArn,
              },
            }),
          },
        }),

        ...(autoTune && {
          AutoTuneOptions: {
            DesiredState: 'ENABLED',
          },
        }),

        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
          ...Object.entries(tags).map(([key, value]) => ({ Key: key, Value: value })),
        ],
      },
    }

    return { domain, logicalId }
  }

  /**
   * Create access policy for OpenSearch domain
   */
  static createAccessPolicy(
    domainArn: string | { 'Fn::GetAtt': [string, string] },
    options: AccessPolicyOptions,
  ): Record<string, any> {
    const { ipAddresses, iamPrincipalArns, allowAll, vpcEndpoint } = options

    if (allowAll) {
      return {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              AWS: '*',
            },
            Action: 'es:*',
            Resource: domainArn,
          },
        ],
      }
    }

    const statements: any[] = []

    if (iamPrincipalArns && iamPrincipalArns.length > 0) {
      statements.push({
        Effect: 'Allow',
        Principal: {
          AWS: iamPrincipalArns,
        },
        Action: 'es:*',
        Resource: domainArn,
      })
    }

    if (ipAddresses && ipAddresses.length > 0) {
      statements.push({
        Effect: 'Allow',
        Principal: {
          AWS: '*',
        },
        Action: 'es:*',
        Resource: domainArn,
        Condition: {
          IpAddress: {
            'aws:SourceIp': ipAddresses,
          },
        },
      })
    }

    if (vpcEndpoint) {
      // VPC endpoint doesn't require access policy (handled by security groups)
      return {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              AWS: '*',
            },
            Action: 'es:*',
            Resource: domainArn,
          },
        ],
      }
    }

    return {
      Version: '2012-10-17',
      Statement: statements,
    }
  }

  /**
   * Common domain configurations
   */
  static readonly DomainPresets = {
    /**
     * Development domain (small, single node)
     */
    development: (slug: string, environment: string): { domain: OpenSearchDomain; logicalId: string } => {
      return Search.createDomain({
        slug,
        environment,
        instanceType: 't3.small.search',
        instanceCount: 1,
        volumeSize: 10,
        multiAz: false,
        dedicatedMaster: false,
        encryption: {
          atRest: true,
          nodeToNode: true,
        },
        autoTune: false,
      })
    },

    /**
     * Production domain (HA, multi-AZ)
     */
    production: (slug: string, environment: string, vpc?: SearchDomainOptions['vpc']): { domain: OpenSearchDomain; logicalId: string } => {
      return Search.createDomain({
        slug,
        environment,
        instanceType: 'm6g.large.search',
        instanceCount: 3,
        volumeSize: 100,
        volumeType: 'gp3',
        multiAz: true,
        availabilityZoneCount: 3,
        dedicatedMaster: true,
        dedicatedMasterType: 'm6g.large.search',
        dedicatedMasterCount: 3,
        vpc,
        encryption: {
          atRest: true,
          nodeToNode: true,
        },
        advancedSecurity: {
          enabled: true,
          internalUserDatabase: true,
        },
        autoTune: true,
      })
    },

    /**
     * Cost-optimized domain (bursting workloads)
     */
    costOptimized: (slug: string, environment: string): { domain: OpenSearchDomain; logicalId: string } => {
      return Search.createDomain({
        slug,
        environment,
        instanceType: 't3.medium.search',
        instanceCount: 2,
        volumeSize: 20,
        volumeType: 'gp3',
        multiAz: true,
        dedicatedMaster: false,
        encryption: {
          atRest: true,
          nodeToNode: true,
        },
        autoTune: true,
      })
    },

    /**
     * High-performance domain (analytics, large datasets)
     */
    highPerformance: (slug: string, environment: string, vpc: SearchDomainOptions['vpc']): { domain: OpenSearchDomain; logicalId: string } => {
      return Search.createDomain({
        slug,
        environment,
        instanceType: 'r6g.2xlarge.search',
        instanceCount: 6,
        volumeSize: 500,
        volumeType: 'gp3',
        multiAz: true,
        availabilityZoneCount: 3,
        dedicatedMaster: true,
        dedicatedMasterType: 'c6g.xlarge.search',
        dedicatedMasterCount: 3,
        vpc,
        encryption: {
          atRest: true,
          nodeToNode: true,
        },
        advancedSecurity: {
          enabled: true,
          internalUserDatabase: false,
        },
        autoTune: true,
      })
    },
  }

  /**
   * Common instance types
   */
  static readonly InstanceTypes = {
    // T3 - Burstable performance (cost-effective for development/testing)
    't3.small.search': 't3.small.search', // 2 vCPU, 2 GiB
    't3.medium.search': 't3.medium.search', // 2 vCPU, 4 GiB

    // M6g - General purpose (ARM-based, cost-effective)
    'm6g.large.search': 'm6g.large.search', // 2 vCPU, 8 GiB
    'm6g.xlarge.search': 'm6g.xlarge.search', // 4 vCPU, 16 GiB
    'm6g.2xlarge.search': 'm6g.2xlarge.search', // 8 vCPU, 32 GiB

    // R6g - Memory optimized (ARM-based, best for search/analytics)
    'r6g.large.search': 'r6g.large.search', // 2 vCPU, 16 GiB
    'r6g.xlarge.search': 'r6g.xlarge.search', // 4 vCPU, 32 GiB
    'r6g.2xlarge.search': 'r6g.2xlarge.search', // 8 vCPU, 64 GiB
    'r6g.4xlarge.search': 'r6g.4xlarge.search', // 16 vCPU, 128 GiB

    // C6g - Compute optimized (ARM-based, best for dedicated masters)
    'c6g.large.search': 'c6g.large.search', // 2 vCPU, 4 GiB
    'c6g.xlarge.search': 'c6g.xlarge.search', // 4 vCPU, 8 GiB
    'c6g.2xlarge.search': 'c6g.2xlarge.search', // 8 vCPU, 16 GiB
  }

  /**
   * Common engine versions
   */
  static readonly EngineVersions = {
    'OpenSearch_2.11': 'OpenSearch_2.11',
    'OpenSearch_2.9': 'OpenSearch_2.9',
    'OpenSearch_2.7': 'OpenSearch_2.7',
    'OpenSearch_1.3': 'OpenSearch_1.3',
    'Elasticsearch_7.10': 'Elasticsearch_7.10',
  }
}
