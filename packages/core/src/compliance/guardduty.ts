/**
 * AWS GuardDuty
 * Intelligent threat detection and continuous monitoring
*/

export interface GuardDutyDetector {
  id: string
  enable: boolean
  findingPublishingFrequency?: 'FIFTEEN_MINUTES' | 'ONE_HOUR' | 'SIX_HOURS'
  dataSources?: DataSourceConfigurations
  features?: DetectorFeature[]
}

export interface DataSourceConfigurations {
  s3Logs?: {
    enable: boolean
  }
  kubernetes?: {
    auditLogs: {
      enable: boolean
    }
  }
  malwareProtection?: {
    scanEc2InstanceWithFindings: {
      ebsVolumes: {
        enable: boolean
      }
    }
  }
}

export interface DetectorFeature {
  name: 'S3_DATA_EVENTS' | 'EKS_AUDIT_LOGS' | 'EBS_MALWARE_PROTECTION' | 'RDS_LOGIN_EVENTS' | 'LAMBDA_NETWORK_LOGS'
  status: 'ENABLED' | 'DISABLED'
  additionalConfiguration?: {
    name: string
    status: 'ENABLED' | 'DISABLED'
  }[]
}

export interface ThreatIntelSet {
  id: string
  detectorId: string
  name: string
  format: 'TXT' | 'STIX' | 'OTX_CSV' | 'ALIEN_VAULT' | 'PROOF_POINT' | 'FIRE_EYE'
  location: string // S3 URI
  activate: boolean
}

export interface IPSet {
  id: string
  detectorId: string
  name: string
  format: 'TXT' | 'STIX' | 'OTX_CSV' | 'ALIEN_VAULT' | 'PROOF_POINT' | 'FIRE_EYE'
  location: string // S3 URI
  activate: boolean
}

export interface FindingFilter {
  id: string
  detectorId: string
  name: string
  description?: string
  action: 'NOOP' | 'ARCHIVE'
  rank: number
  findingCriteria: FindingCriteria
}

export interface FindingCriteria {
  criterion: Record<string, {
    eq?: string[]
    neq?: string[]
    gt?: number
    gte?: number
    lt?: number
    lte?: number
  }>
}

/**
 * GuardDuty manager
*/
export class GuardDutyManager {
  private detectors: Map<string, GuardDutyDetector> = new Map()
  private threatIntelSets: Map<string, ThreatIntelSet> = new Map()
  private ipSets: Map<string, IPSet> = new Map()
  private filters: Map<string, FindingFilter> = new Map()
  private detectorCounter = 0
  private threatIntelCounter = 0
  private ipSetCounter = 0
  private filterCounter = 0

  /**
   * Create GuardDuty detector
  */
  createDetector(detector: Omit<GuardDutyDetector, 'id'>): GuardDutyDetector {
    const id = `detector-${Date.now()}-${this.detectorCounter++}`

    const guardDutyDetector: GuardDutyDetector = {
      id,
      ...detector,
    }

    this.detectors.set(id, guardDutyDetector)

    return guardDutyDetector
  }

  /**
   * Create comprehensive detector with all features
  */
  createComprehensiveDetector(): GuardDutyDetector {
    return this.createDetector({
      enable: true,
      findingPublishingFrequency: 'FIFTEEN_MINUTES',
      dataSources: {
        s3Logs: {
          enable: true,
        },
        kubernetes: {
          auditLogs: {
            enable: true,
          },
        },
        malwareProtection: {
          scanEc2InstanceWithFindings: {
            ebsVolumes: {
              enable: true,
            },
          },
        },
      },
      features: [
        { name: 'S3_DATA_EVENTS', status: 'ENABLED' },
        { name: 'EKS_AUDIT_LOGS', status: 'ENABLED' },
        { name: 'EBS_MALWARE_PROTECTION', status: 'ENABLED' },
        { name: 'RDS_LOGIN_EVENTS', status: 'ENABLED' },
        { name: 'LAMBDA_NETWORK_LOGS', status: 'ENABLED' },
      ],
    })
  }

  /**
   * Create basic detector
  */
  createBasicDetector(): GuardDutyDetector {
    return this.createDetector({
      enable: true,
      findingPublishingFrequency: 'SIX_HOURS',
    })
  }

  /**
   * Create threat intel set
  */
  createThreatIntelSet(set: Omit<ThreatIntelSet, 'id'>): ThreatIntelSet {
    const id = `threat-intel-${Date.now()}-${this.threatIntelCounter++}`

    const threatIntelSet: ThreatIntelSet = {
      id,
      ...set,
    }

    this.threatIntelSets.set(id, threatIntelSet)

    return threatIntelSet
  }

  /**
   * Create IP set
  */
  createIPSet(set: Omit<IPSet, 'id'>): IPSet {
    const id = `ip-set-${Date.now()}-${this.ipSetCounter++}`

    const ipSet: IPSet = {
      id,
      ...set,
    }

    this.ipSets.set(id, ipSet)

    return ipSet
  }

  /**
   * Create finding filter
  */
  createFindingFilter(filter: Omit<FindingFilter, 'id'>): FindingFilter {
    const id = `filter-${Date.now()}-${this.filterCounter++}`

    const findingFilter: FindingFilter = {
      id,
      ...filter,
    }

    this.filters.set(id, findingFilter)

    return findingFilter
  }

  /**
   * Create auto-archive filter for low severity findings
  */
  createLowSeverityArchiveFilter(detectorId: string): FindingFilter {
    return this.createFindingFilter({
      detectorId,
      name: 'archive-low-severity',
      description: 'Automatically archive low severity findings',
      action: 'ARCHIVE',
      rank: 1,
      findingCriteria: {
        criterion: {
          severity: {
            lt: 4,
          },
        },
      },
    })
  }

  /**
   * Create filter for specific finding types
  */
  createFindingTypeFilter(
    detectorId: string,
    findingTypes: string[],
    action: 'NOOP' | 'ARCHIVE',
  ): FindingFilter {
    return this.createFindingFilter({
      detectorId,
      name: `filter-finding-types-${action.toLowerCase()}`,
      description: `${action === 'ARCHIVE' ? 'Archive' : 'Keep'} specific finding types`,
      action,
      rank: 2,
      findingCriteria: {
        criterion: {
          type: {
            eq: findingTypes,
          },
        },
      },
    })
  }

  /**
   * Create filter for trusted IP addresses
  */
  createTrustedIPFilter(detectorId: string, ipAddresses: string[]): FindingFilter {
    return this.createFindingFilter({
      detectorId,
      name: 'trusted-ip-addresses',
      description: 'Archive findings from trusted IP addresses',
      action: 'ARCHIVE',
      rank: 3,
      findingCriteria: {
        criterion: {
          'resource.instanceDetails.networkInterfaces.privateIpAddress': {
            eq: ipAddresses,
          },
        },
      },
    })
  }

  /**
   * Get detector
  */
  getDetector(id: string): GuardDutyDetector | undefined {
    return this.detectors.get(id)
  }

  /**
   * List detectors
  */
  listDetectors(): GuardDutyDetector[] {
    return Array.from(this.detectors.values())
  }

  /**
   * Get threat intel set
  */
  getThreatIntelSet(id: string): ThreatIntelSet | undefined {
    return this.threatIntelSets.get(id)
  }

  /**
   * List threat intel sets
  */
  listThreatIntelSets(): ThreatIntelSet[] {
    return Array.from(this.threatIntelSets.values())
  }

  /**
   * Get IP set
  */
  getIPSet(id: string): IPSet | undefined {
    return this.ipSets.get(id)
  }

  /**
   * List IP sets
  */
  listIPSets(): IPSet[] {
    return Array.from(this.ipSets.values())
  }

  /**
   * Get finding filter
  */
  getFindingFilter(id: string): FindingFilter | undefined {
    return this.filters.get(id)
  }

  /**
   * List finding filters
  */
  listFindingFilters(): FindingFilter[] {
    return Array.from(this.filters.values())
  }

  /**
   * Generate CloudFormation for detector
  */
  generateDetectorCF(detector: GuardDutyDetector): any {
    const cf: any = {
      Type: 'AWS::GuardDuty::Detector',
      Properties: {
        Enable: detector.enable,
      },
    }

    if (detector.findingPublishingFrequency) {
      cf.Properties.FindingPublishingFrequency = detector.findingPublishingFrequency
    }

    if (detector.dataSources) {
      cf.Properties.DataSources = {}

      if (detector.dataSources.s3Logs) {
        cf.Properties.DataSources.S3Logs = {
          Enable: detector.dataSources.s3Logs.enable,
        }
      }

      if (detector.dataSources.kubernetes) {
        cf.Properties.DataSources.Kubernetes = {
          AuditLogs: {
            Enable: detector.dataSources.kubernetes.auditLogs.enable,
          },
        }
      }

      if (detector.dataSources.malwareProtection) {
        cf.Properties.DataSources.MalwareProtection = {
          ScanEc2InstanceWithFindings: {
            EbsVolumes: {
              Enable: detector.dataSources.malwareProtection.scanEc2InstanceWithFindings.ebsVolumes.enable,
            },
          },
        }
      }
    }

    if (detector.features) {
      cf.Properties.Features = detector.features.map(feature => ({
        Name: feature.name,
        Status: feature.status,
        ...(feature.additionalConfiguration && {
          AdditionalConfiguration: feature.additionalConfiguration,
        }),
      }))
    }

    return cf
  }

  /**
   * Generate CloudFormation for threat intel set
  */
  generateThreatIntelSetCF(set: ThreatIntelSet): any {
    return {
      Type: 'AWS::GuardDuty::ThreatIntelSet',
      Properties: {
        DetectorId: set.detectorId,
        Name: set.name,
        Format: set.format,
        Location: set.location,
        Activate: set.activate,
      },
    }
  }

  /**
   * Generate CloudFormation for IP set
  */
  generateIPSetCF(set: IPSet): any {
    return {
      Type: 'AWS::GuardDuty::IPSet',
      Properties: {
        DetectorId: set.detectorId,
        Name: set.name,
        Format: set.format,
        Location: set.location,
        Activate: set.activate,
      },
    }
  }

  /**
   * Generate CloudFormation for finding filter
  */
  generateFilterCF(filter: FindingFilter): any {
    return {
      Type: 'AWS::GuardDuty::Filter',
      Properties: {
        DetectorId: filter.detectorId,
        Name: filter.name,
        Description: filter.description,
        Action: filter.action,
        Rank: filter.rank,
        FindingCriteria: {
          Criterion: filter.findingCriteria.criterion,
        },
      },
    }
  }

  /**
   * Clear all data
  */
  clear(): void {
    this.detectors.clear()
    this.threatIntelSets.clear()
    this.ipSets.clear()
    this.filters.clear()
    this.detectorCounter = 0
    this.threatIntelCounter = 0
    this.ipSetCounter = 0
    this.filterCounter = 0
  }
}

/**
 * Global GuardDuty manager instance
*/
export const guardDutyManager: GuardDutyManager = new GuardDutyManager()
