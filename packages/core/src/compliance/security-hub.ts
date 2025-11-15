/**
 * AWS Security Hub
 * Centralized security and compliance view across AWS accounts
 */

export interface SecurityHubConfig {
  id: string
  enable: boolean
  controlFindingGenerator?: 'STANDARD_CONTROL' | 'SECURITY_CONTROL'
  enableDefaultStandards?: boolean
  standards?: SecurityStandard[]
  automationRules?: AutomationRule[]
}

export interface SecurityStandard {
  id: string
  arn: string
  name: string
  description: string
  enabled: boolean
  disabledControls?: string[]
}

export interface AutomationRule {
  id: string
  ruleName: string
  description?: string
  actions: AutomationAction[]
  criteria: AutomationCriteria
  ruleStatus: 'ENABLED' | 'DISABLED'
  ruleOrder: number
}

export interface AutomationAction {
  type: 'FINDING_FIELDS_UPDATE'
  findingFieldsUpdate: {
    note?: {
      text: string
      updatedBy: string
    }
    severity?: {
      label: 'INFORMATIONAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
    }
    workflow?: {
      status: 'NEW' | 'NOTIFIED' | 'RESOLVED' | 'SUPPRESSED'
    }
    relatedFindings?: Array<{
      productArn: string
      id: string
    }>
    userDefinedFields?: Record<string, string>
  }
}

export interface AutomationCriteria {
  productName?: StringFilter[]
  companyName?: StringFilter[]
  severityLabel?: StringFilter[]
  resourceType?: StringFilter[]
  resourceId?: StringFilter[]
  recordState?: StringFilter[]
  workflowStatus?: StringFilter[]
  complianceStatus?: StringFilter[]
  verificationState?: StringFilter[]
  confidence?: NumberFilter[]
  criticality?: NumberFilter[]
  title?: StringFilter[]
  description?: StringFilter[]
  sourceUrl?: StringFilter[]
  productFields?: MapFilter[]
  resourceTags?: MapFilter[]
  userDefinedFields?: MapFilter[]
}

export interface StringFilter {
  value: string
  comparison: 'EQUALS' | 'PREFIX' | 'NOT_EQUALS' | 'PREFIX_NOT_EQUALS'
}

export interface NumberFilter {
  gte?: number
  lte?: number
  eq?: number
  gt?: number
  lt?: number
}

export interface MapFilter {
  key: string
  value?: string
  comparison: 'EQUALS' | 'NOT_EQUALS'
}

/**
 * Security Hub manager
 */
export class SecurityHubManager {
  private hubs: Map<string, SecurityHubConfig> = new Map()
  private hubCounter = 0
  private ruleCounter = 0

  /**
   * Available security standards
   */
  static readonly Standards = {
    AWS_FOUNDATIONAL_SECURITY: {
      arn: 'arn:aws:securityhub:::ruleset/aws-foundational-security-best-practices/v/1.0.0',
      name: 'AWS Foundational Security Best Practices',
      description: 'AWS recommended security best practices',
    },
    CIS_AWS_FOUNDATIONS_1_2: {
      arn: 'arn:aws:securityhub:::ruleset/cis-aws-foundations-benchmark/v/1.2.0',
      name: 'CIS AWS Foundations Benchmark v1.2.0',
      description: 'CIS AWS Foundations Benchmark v1.2.0',
    },
    CIS_AWS_FOUNDATIONS_1_4: {
      arn: 'arn:aws:securityhub:::ruleset/cis-aws-foundations-benchmark/v/1.4.0',
      name: 'CIS AWS Foundations Benchmark v1.4.0',
      description: 'CIS AWS Foundations Benchmark v1.4.0',
    },
    PCI_DSS: {
      arn: 'arn:aws:securityhub:us-east-1::standards/pci-dss/v/3.2.1',
      name: 'PCI DSS v3.2.1',
      description: 'Payment Card Industry Data Security Standard',
    },
    NIST_800_53: {
      arn: 'arn:aws:securityhub:us-east-1::standards/nist-800-53/v/5.0.0',
      name: 'NIST SP 800-53 Rev. 5',
      description: 'NIST Special Publication 800-53 Revision 5',
    },
  }

  /**
   * Create Security Hub
   */
  createHub(hub: Omit<SecurityHubConfig, 'id'>): SecurityHubConfig {
    const id = `hub-${Date.now()}-${this.hubCounter++}`

    const securityHub: SecurityHubConfig = {
      id,
      ...hub,
    }

    this.hubs.set(id, securityHub)

    return securityHub
  }

  /**
   * Create comprehensive Security Hub with all standards
   */
  createComprehensiveHub(): SecurityHubConfig {
    return this.createHub({
      enable: true,
      controlFindingGenerator: 'SECURITY_CONTROL',
      enableDefaultStandards: true,
      standards: [
        {
          id: 'aws-foundational',
          ...SecurityHubManager.Standards.AWS_FOUNDATIONAL_SECURITY,
          enabled: true,
        },
        {
          id: 'cis-1-4',
          ...SecurityHubManager.Standards.CIS_AWS_FOUNDATIONS_1_4,
          enabled: true,
        },
        {
          id: 'pci-dss',
          ...SecurityHubManager.Standards.PCI_DSS,
          enabled: true,
        },
      ],
    })
  }

  /**
   * Create basic Security Hub
   */
  createBasicHub(): SecurityHubConfig {
    return this.createHub({
      enable: true,
      controlFindingGenerator: 'STANDARD_CONTROL',
      enableDefaultStandards: true,
      standards: [
        {
          id: 'aws-foundational',
          ...SecurityHubManager.Standards.AWS_FOUNDATIONAL_SECURITY,
          enabled: true,
        },
      ],
    })
  }

  /**
   * Create automation rule for low severity findings
   */
  createLowSeveritySuppressionRule(): AutomationRule {
    return {
      id: `rule-${Date.now()}-${this.ruleCounter++}`,
      ruleName: 'Suppress Low Severity Informational Findings',
      description: 'Automatically suppress informational findings',
      actions: [
        {
          type: 'FINDING_FIELDS_UPDATE',
          findingFieldsUpdate: {
            workflow: {
              status: 'SUPPRESSED',
            },
            note: {
              text: 'Automatically suppressed low severity finding',
              updatedBy: 'SecurityHub Automation',
            },
          },
        },
      ],
      criteria: {
        severityLabel: [
          {
            value: 'INFORMATIONAL',
            comparison: 'EQUALS',
          },
        ],
        recordState: [
          {
            value: 'ACTIVE',
            comparison: 'EQUALS',
          },
        ],
      },
      ruleStatus: 'ENABLED',
      ruleOrder: 1,
    }
  }

  /**
   * Create automation rule for specific resource types
   */
  createResourceTypeNotificationRule(resourceTypes: string[]): AutomationRule {
    return {
      id: `rule-${Date.now()}-${this.ruleCounter++}`,
      ruleName: 'Notify on Critical Resource Findings',
      description: 'Set findings for critical resources to NOTIFIED status',
      actions: [
        {
          type: 'FINDING_FIELDS_UPDATE',
          findingFieldsUpdate: {
            workflow: {
              status: 'NOTIFIED',
            },
            note: {
              text: 'Critical resource finding requires attention',
              updatedBy: 'SecurityHub Automation',
            },
          },
        },
      ],
      criteria: {
        resourceType: resourceTypes.map(type => ({
          value: type,
          comparison: 'EQUALS' as const,
        })),
        severityLabel: [
          {
            value: 'HIGH',
            comparison: 'EQUALS',
          },
          {
            value: 'CRITICAL',
            comparison: 'EQUALS',
          },
        ],
        workflowStatus: [
          {
            value: 'NEW',
            comparison: 'EQUALS',
          },
        ],
      },
      ruleStatus: 'ENABLED',
      ruleOrder: 2,
    }
  }

  /**
   * Create automation rule for compliance failures
   */
  createComplianceFailureRule(): AutomationRule {
    return {
      id: `rule-${Date.now()}-${this.ruleCounter++}`,
      ruleName: 'Flag Compliance Failures',
      description: 'Increase severity for compliance failures',
      actions: [
        {
          type: 'FINDING_FIELDS_UPDATE',
          findingFieldsUpdate: {
            severity: {
              label: 'HIGH',
            },
            workflow: {
              status: 'NOTIFIED',
            },
            note: {
              text: 'Compliance failure detected - requires immediate attention',
              updatedBy: 'SecurityHub Automation',
            },
          },
        },
      ],
      criteria: {
        complianceStatus: [
          {
            value: 'FAILED',
            comparison: 'EQUALS',
          },
        ],
        recordState: [
          {
            value: 'ACTIVE',
            comparison: 'EQUALS',
          },
        ],
      },
      ruleStatus: 'ENABLED',
      ruleOrder: 3,
    }
  }

  /**
   * Create automation rule for false positives
   */
  createFalsePositiveSuppressionRule(productName: string, titlePatterns: string[]): AutomationRule {
    return {
      id: `rule-${Date.now()}-${this.ruleCounter++}`,
      ruleName: `Suppress False Positives - ${productName}`,
      description: `Automatically suppress known false positives from ${productName}`,
      actions: [
        {
          type: 'FINDING_FIELDS_UPDATE',
          findingFieldsUpdate: {
            workflow: {
              status: 'SUPPRESSED',
            },
            note: {
              text: 'Known false positive - automatically suppressed',
              updatedBy: 'SecurityHub Automation',
            },
          },
        },
      ],
      criteria: {
        productName: [
          {
            value: productName,
            comparison: 'EQUALS',
          },
        ],
        title: titlePatterns.map(pattern => ({
          value: pattern,
          comparison: 'PREFIX' as const,
        })),
      },
      ruleStatus: 'ENABLED',
      ruleOrder: 10,
    }
  }

  /**
   * Get Security Hub
   */
  getHub(id: string): SecurityHubConfig | undefined {
    return this.hubs.get(id)
  }

  /**
   * List Security Hubs
   */
  listHubs(): SecurityHubConfig[] {
    return Array.from(this.hubs.values())
  }

  /**
   * Generate CloudFormation for Security Hub
   */
  generateHubCF(hub: SecurityHubConfig): any {
    const cf: any = {
      Type: 'AWS::SecurityHub::Hub',
      Properties: {},
    }

    if (hub.controlFindingGenerator) {
      cf.Properties.ControlFindingGenerator = hub.controlFindingGenerator
    }

    if (hub.enableDefaultStandards !== undefined) {
      cf.Properties.EnableDefaultStandards = hub.enableDefaultStandards
    }

    return cf
  }

  /**
   * Generate CloudFormation for security standard subscription
   */
  generateStandardCF(standard: SecurityStandard): any {
    const cf: any = {
      Type: 'AWS::SecurityHub::Standard',
      Properties: {
        StandardsArn: standard.arn,
      },
    }

    if (standard.disabledControls && standard.disabledControls.length > 0) {
      cf.Properties.DisabledStandardsControls = standard.disabledControls.map(controlId => ({
        StandardsControlArn: controlId,
        Reason: 'Disabled by configuration',
      }))
    }

    return cf
  }

  /**
   * Generate CloudFormation for automation rule
   */
  generateAutomationRuleCF(rule: AutomationRule): any {
    return {
      Type: 'AWS::SecurityHub::AutomationRule',
      Properties: {
        RuleName: rule.ruleName,
        Description: rule.description,
        Actions: rule.actions.map(action => ({
          Type: action.type,
          FindingFieldsUpdate: action.findingFieldsUpdate,
        })),
        Criteria: rule.criteria,
        RuleStatus: rule.ruleStatus,
        RuleOrder: rule.ruleOrder,
      },
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.hubs.clear()
    this.hubCounter = 0
    this.ruleCounter = 0
  }
}

/**
 * Global Security Hub manager instance
 */
export const securityHubManager = new SecurityHubManager()
