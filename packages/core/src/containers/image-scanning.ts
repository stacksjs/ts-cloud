/**
 * Container Image Scanning
 * Vulnerability scanning with Trivy, Snyk, and other tools
 */

export interface ImageScanConfig {
  id: string
  repository: string
  imageTag: string
  scanner: ScannerType
  scanOnPush: boolean
  scanSchedule?: string
  failOnSeverity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  ignoreUnfixed?: boolean
}

export type ScannerType = 'trivy' | 'snyk' | 'clair' | 'anchore' | 'ecr'

export interface ImageScanResult {
  id: string
  imageUri: string
  scannerType: ScannerType
  scanDate: Date
  vulnerabilities: ImageVulnerability[]
  summary: VulnerabilitySummary
  passed: boolean
}

export interface ImageVulnerability {
  id: string
  cve: string
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
  packageName: string
  installedVersion: string
  fixedVersion?: string
  title: string
  description: string
  references: string[]
  cvss?: number
}

export interface VulnerabilitySummary {
  total: number
  critical: number
  high: number
  medium: number
  low: number
  unknown: number
}

export interface ScanPolicy {
  id: string
  name: string
  allowedSeverities: string[]
  maxCritical: number
  maxHigh: number
  blockOnFailure: boolean
  exemptions: string[] // CVE IDs to ignore
}

/**
 * Image scanning manager
 */
export class ImageScanningManager {
  private configs: Map<string, ImageScanConfig> = new Map()
  private results: Map<string, ImageScanResult> = new Map()
  private policies: Map<string, ScanPolicy> = new Map()
  private configCounter = 0
  private resultCounter = 0
  private policyCounter = 0

  /**
   * Configure image scanning
   */
  configureScan(config: Omit<ImageScanConfig, 'id'>): ImageScanConfig {
    const id = `scan-config-${Date.now()}-${this.configCounter++}`

    const scanConfig: ImageScanConfig = {
      id,
      ...config,
    }

    this.configs.set(id, scanConfig)

    return scanConfig
  }

  /**
   * Configure Trivy scanning
   */
  configureTrivyScan(options: {
    repository: string
    imageTag: string
    scanOnPush?: boolean
    ignoreUnfixed?: boolean
  }): ImageScanConfig {
    return this.configureScan({
      repository: options.repository,
      imageTag: options.imageTag,
      scanner: 'trivy',
      scanOnPush: options.scanOnPush ?? true,
      ignoreUnfixed: options.ignoreUnfixed ?? false,
      failOnSeverity: 'HIGH',
    })
  }

  /**
   * Configure Snyk scanning
   */
  configureSnykScan(options: {
    repository: string
    imageTag: string
    scanOnPush?: boolean
  }): ImageScanConfig {
    return this.configureScan({
      repository: options.repository,
      imageTag: options.imageTag,
      scanner: 'snyk',
      scanOnPush: options.scanOnPush ?? true,
      failOnSeverity: 'HIGH',
    })
  }

  /**
   * Configure ECR scanning
   */
  configureECRScan(options: {
    repository: string
    scanOnPush?: boolean
  }): ImageScanConfig {
    return this.configureScan({
      repository: options.repository,
      imageTag: 'latest',
      scanner: 'ecr',
      scanOnPush: options.scanOnPush ?? true,
      failOnSeverity: 'CRITICAL',
    })
  }

  /**
   * Scan image
   */
  async scanImage(configId: string): Promise<ImageScanResult> {
    const config = this.configs.get(configId)

    if (!config) {
      throw new Error(`Scan config not found: ${configId}`)
    }

    const imageUri = `${config.repository}:${config.imageTag}`

    console.log(`\nScanning image: ${imageUri}`)
    console.log(`Scanner: ${config.scanner}`)

    const id = `scan-result-${Date.now()}-${this.resultCounter++}`

    // Simulate scanning
    const vulnerabilities = this.simulateVulnerabilities(config)

    const summary: VulnerabilitySummary = {
      total: vulnerabilities.length,
      critical: vulnerabilities.filter(v => v.severity === 'CRITICAL').length,
      high: vulnerabilities.filter(v => v.severity === 'HIGH').length,
      medium: vulnerabilities.filter(v => v.severity === 'MEDIUM').length,
      low: vulnerabilities.filter(v => v.severity === 'LOW').length,
      unknown: vulnerabilities.filter(v => v.severity === 'UNKNOWN').length,
    }

    const passed = this.evaluateScanResult(config, summary)

    const result: ImageScanResult = {
      id,
      imageUri,
      scannerType: config.scanner,
      scanDate: new Date(),
      vulnerabilities,
      summary,
      passed,
    }

    this.results.set(id, result)

    console.log('\nScan Results:')
    console.log(`  Total vulnerabilities: ${summary.total}`)
    console.log(`  Critical: ${summary.critical}`)
    console.log(`  High: ${summary.high}`)
    console.log(`  Medium: ${summary.medium}`)
    console.log(`  Low: ${summary.low}`)
    console.log(`  Status: ${passed ? '✓ PASSED' : '✗ FAILED'}`)

    return result
  }

  /**
   * Simulate vulnerabilities (in production, call actual scanner)
   */
  private simulateVulnerabilities(config: ImageScanConfig): ImageVulnerability[] {
    const vulnerabilities: ImageVulnerability[] = []

    if (config.scanner === 'trivy' || config.scanner === 'ecr') {
      vulnerabilities.push({
        id: 'vuln-1',
        cve: 'CVE-2024-1234',
        severity: 'HIGH',
        packageName: 'openssl',
        installedVersion: '1.1.1k',
        fixedVersion: '1.1.1l',
        title: 'OpenSSL buffer overflow',
        description: 'Buffer overflow vulnerability in OpenSSL',
        references: ['https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2024-1234'],
        cvss: 7.5,
      })

      vulnerabilities.push({
        id: 'vuln-2',
        cve: 'CVE-2024-5678',
        severity: 'MEDIUM',
        packageName: 'curl',
        installedVersion: '7.68.0',
        fixedVersion: '7.79.0',
        title: 'curl remote code execution',
        description: 'Remote code execution in curl',
        references: ['https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2024-5678'],
        cvss: 5.3,
      })
    }

    return vulnerabilities
  }

  /**
   * Evaluate scan result
   */
  private evaluateScanResult(config: ImageScanConfig, summary: VulnerabilitySummary): boolean {
    if (!config.failOnSeverity) {
      return true
    }

    switch (config.failOnSeverity) {
      case 'CRITICAL':
        return summary.critical === 0
      case 'HIGH':
        return summary.critical === 0 && summary.high === 0
      case 'MEDIUM':
        return summary.critical === 0 && summary.high === 0 && summary.medium === 0
      case 'LOW':
        return summary.total === 0
      default:
        return true
    }
  }

  /**
   * Create scan policy
   */
  createPolicy(policy: Omit<ScanPolicy, 'id'>): ScanPolicy {
    const id = `policy-${Date.now()}-${this.policyCounter++}`

    const scanPolicy: ScanPolicy = {
      id,
      ...policy,
    }

    this.policies.set(id, scanPolicy)

    return scanPolicy
  }

  /**
   * Create strict policy
   */
  createStrictPolicy(name: string): ScanPolicy {
    return this.createPolicy({
      name,
      allowedSeverities: [],
      maxCritical: 0,
      maxHigh: 0,
      blockOnFailure: true,
      exemptions: [],
    })
  }

  /**
   * Create permissive policy
   */
  createPermissivePolicy(name: string): ScanPolicy {
    return this.createPolicy({
      name,
      allowedSeverities: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
      maxCritical: 5,
      maxHigh: 10,
      blockOnFailure: false,
      exemptions: [],
    })
  }

  /**
   * Get config
   */
  getConfig(id: string): ImageScanConfig | undefined {
    return this.configs.get(id)
  }

  /**
   * List configs
   */
  listConfigs(): ImageScanConfig[] {
    return Array.from(this.configs.values())
  }

  /**
   * Get result
   */
  getResult(id: string): ImageScanResult | undefined {
    return this.results.get(id)
  }

  /**
   * List results
   */
  listResults(): ImageScanResult[] {
    return Array.from(this.results.values())
  }

  /**
   * Generate CloudFormation for ECR scanning
   */
  generateECRScanCF(config: ImageScanConfig): any {
    return {
      Type: 'AWS::ECR::Repository',
      Properties: {
        RepositoryName: config.repository,
        ImageScanningConfiguration: {
          ScanOnPush: config.scanOnPush,
        },
        ImageTagMutability: 'IMMUTABLE',
        EncryptionConfiguration: {
          EncryptionType: 'AES256',
        },
      },
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.configs.clear()
    this.results.clear()
    this.policies.clear()
    this.configCounter = 0
    this.resultCounter = 0
    this.policyCounter = 0
  }
}

/**
 * Global image scanning manager instance
 */
export const imageScanningManager: ImageScanningManager = new ImageScanningManager()
