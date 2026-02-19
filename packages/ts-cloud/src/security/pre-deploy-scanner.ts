/**
 * Pre-Deployment Security Scanner
 * Scans source code for leaked secrets, credentials, and sensitive data before deployment
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

export interface SecretPattern {
  name: string
  pattern: RegExp
  severity: 'critical' | 'high' | 'medium' | 'low'
  description: string
}

export interface SecurityFinding {
  file: string
  line: number
  column: number
  match: string
  pattern: SecretPattern
  context: string
}

export interface ScanResult {
  passed: boolean
  findings: SecurityFinding[]
  scannedFiles: number
  duration: number
  summary: {
    critical: number
    high: number
    medium: number
    low: number
  }
}

export interface ScanOptions {
  directory: string
  exclude?: string[]
  include?: string[]
  skipPatterns?: string[]
  maxFileSize?: number
  failOnSeverity?: 'critical' | 'high' | 'medium' | 'low'
}

/**
 * Common secret patterns to detect
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  // AWS Credentials
  {
    name: 'AWS Access Key ID',
    pattern: /(?:^|[^A-Z0-9])((AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16})(?:[^A-Z0-9]|$)/g,
    severity: 'critical',
    description: 'AWS Access Key ID detected',
  },
  {
    name: 'AWS Secret Access Key',
    pattern: /(?:aws_secret_access_key|aws_secret_key|secret_access_key|secretAccessKey)\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
    severity: 'critical',
    description: 'AWS Secret Access Key detected',
  },
  {
    name: 'AWS Secret Key (Generic)',
    pattern: /(?:^|['"`:=\s])([A-Za-z0-9/+=]{40})(?:['"`\s]|$)/g,
    severity: 'high',
    description: 'Potential AWS Secret Key (40-char base64)',
  },

  // API Keys (Generic)
  {
    name: 'Generic API Key',
    pattern: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[=:]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?/gi,
    severity: 'high',
    description: 'Generic API key detected',
  },

  // Private Keys
  {
    name: 'RSA Private Key',
    pattern: /-----BEGIN RSA PRIVATE KEY-----/g,
    severity: 'critical',
    description: 'RSA private key detected',
  },
  {
    name: 'OpenSSH Private Key',
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/g,
    severity: 'critical',
    description: 'OpenSSH private key detected',
  },
  {
    name: 'EC Private Key',
    pattern: /-----BEGIN EC PRIVATE KEY-----/g,
    severity: 'critical',
    description: 'EC private key detected',
  },
  {
    name: 'PGP Private Key',
    pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g,
    severity: 'critical',
    description: 'PGP private key detected',
  },

  // Tokens
  {
    name: 'GitHub Token',
    pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,
    severity: 'critical',
    description: 'GitHub personal access token detected',
  },
  {
    name: 'GitHub OAuth',
    pattern: /github[_-]?oauth[_-]?token\s*[=:]\s*['"]?([A-Za-z0-9_]{40})['"]?/gi,
    severity: 'critical',
    description: 'GitHub OAuth token detected',
  },
  {
    name: 'Slack Token',
    pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/g,
    severity: 'critical',
    description: 'Slack token detected',
  },
  {
    name: 'Slack Webhook',
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
    severity: 'high',
    description: 'Slack webhook URL detected',
  },
  {
    name: 'Discord Webhook',
    pattern: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
    severity: 'high',
    description: 'Discord webhook URL detected',
  },
  {
    name: 'JWT Token',
    pattern: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
    severity: 'high',
    description: 'JWT token detected',
  },

  // Cloud Provider Keys
  {
    name: 'Google API Key',
    pattern: /AIza[0-9A-Za-z_-]{35}/g,
    severity: 'critical',
    description: 'Google API key detected',
  },
  {
    name: 'Google OAuth ID',
    pattern: /[0-9]+-[A-Za-z0-9_]{32}\.apps\.googleusercontent\.com/g,
    severity: 'high',
    description: 'Google OAuth client ID detected',
  },
  {
    name: 'Firebase API Key',
    pattern: /(?:firebase[_-]?api[_-]?key)\s*[=:]\s*['"]?([A-Za-z0-9_-]{39})['"]?/gi,
    severity: 'critical',
    description: 'Firebase API key detected',
  },
  {
    name: 'Cloudflare API Token',
    pattern: /(?:cloudflare[_-]?api[_-]?token|cf[_-]?api[_-]?token)\s*[=:]\s*['"]?([A-Za-z0-9_-]{40})['"]?/gi,
    severity: 'critical',
    description: 'Cloudflare API token detected',
  },
  {
    name: 'Azure Client Secret',
    pattern: /(?:azure[_-]?client[_-]?secret|client[_-]?secret)\s*[=:]\s*['"]?([A-Za-z0-9~._-]{34,})['"]?/gi,
    severity: 'critical',
    description: 'Azure client secret detected',
  },
  {
    name: 'Heroku API Key',
    pattern: /(?:heroku[_-]?api[_-]?key)\s*[=:]\s*['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]?/gi,
    severity: 'critical',
    description: 'Heroku API key detected',
  },

  // Database Credentials
  {
    name: 'Database Connection String',
    pattern: /(?:mysql|postgres|postgresql|mongodb|redis|mongodb\+srv):\/\/[^:]+:[^@]+@[^/\s]+/gi,
    severity: 'critical',
    description: 'Database connection string with credentials detected',
  },
  {
    name: 'Database Password',
    pattern: /(?:db[_-]?password|database[_-]?password|mysql[_-]?password|postgres[_-]?password)\s*[=:]\s*['"]?([^'"\s]{8,})['"]?/gi,
    severity: 'critical',
    description: 'Database password detected',
  },

  // Payment/Financial
  {
    name: 'Stripe API Key',
    pattern: /(?:sk|pk)_(?:test|live)_[0-9a-zA-Z]{24,}/g,
    severity: 'critical',
    description: 'Stripe API key detected',
  },
  {
    name: 'PayPal Client ID',
    pattern: /(?:paypal[_-]?client[_-]?id)\s*[=:]\s*['"]?([A-Za-z0-9_-]{80})['"]?/gi,
    severity: 'high',
    description: 'PayPal client ID detected',
  },
  {
    name: 'Square Access Token',
    pattern: /sq0[a-z]{3}-[0-9A-Za-z_-]{22,}/g,
    severity: 'critical',
    description: 'Square access token detected',
  },

  // Communication Services
  {
    name: 'Twilio API Key',
    pattern: /SK[a-f0-9]{32}/g,
    severity: 'critical',
    description: 'Twilio API key detected',
  },
  {
    name: 'SendGrid API Key',
    pattern: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g,
    severity: 'critical',
    description: 'SendGrid API key detected',
  },
  {
    name: 'Mailgun API Key',
    pattern: /key-[0-9a-zA-Z]{32}/g,
    severity: 'critical',
    description: 'Mailgun API key detected',
  },

  // Authentication Secrets
  {
    name: 'Password in Code',
    pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"]([^'"]{8,})['"](?!\s*[,\]])/gi,
    severity: 'high',
    description: 'Hardcoded password detected',
  },
  {
    name: 'Secret/Token Assignment',
    pattern: /(?:secret|token|auth[_-]?token|access[_-]?token)\s*[=:]\s*['"]([A-Za-z0-9_\-/+=]{16,})['"](?!\s*[,\]])/gi,
    severity: 'high',
    description: 'Hardcoded secret or token detected',
  },

  // NPM/Package Registry
  {
    name: 'NPM Token',
    pattern: /(?:npm[_-]?token)\s*[=:]\s*['"]?([A-Za-z0-9_-]{36})['"]?/gi,
    severity: 'critical',
    description: 'NPM token detected',
  },

  // SSH/Git
  {
    name: 'SSH Private Key Path Exposed',
    pattern: /~\/\.ssh\/id_[a-z]+|\/home\/[^/]+\/\.ssh\/id_[a-z]+/g,
    severity: 'medium',
    description: 'SSH private key path exposed',
  },

  // Environment Variable Leaks
  {
    name: 'Env Variable with Secret',
    pattern: /(?:process\.env\.)((?=[A-Z_]*(?:SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL|AUTH))[A-Z_]+)\s*(?:===?\s*['"]([^'"]+)['"])?/g,
    severity: 'medium',
    description: 'Environment variable containing secret may be exposed',
  },
]

/**
 * File extensions to scan by default
 */
const DEFAULT_SCAN_EXTENSIONS = [
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.env',
  '.config',
  '.conf',
]

/**
 * Directories to exclude by default
 */
const DEFAULT_EXCLUDE_DIRS = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'coverage',
  '.nyc_output',
  '__pycache__',
  '.pytest_cache',
  'vendor',
  '.idea',
  '.vscode',
  '.turbo',
  '.next',
  '.nuxt',
]

/**
 * Files to exclude by default
 */
const DEFAULT_EXCLUDE_FILES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  '*.min.js',
  '*.min.css',
  '*.map',
]

/**
 * Pre-deployment security scanner
 */
export class PreDeployScanner {
  private patterns: SecretPattern[]
  private excludeDirs: string[]
  private excludeFiles: string[]
  private maxFileSize: number

  constructor(options?: {
    customPatterns?: SecretPattern[]
    excludeDirs?: string[]
    excludeFiles?: string[]
    maxFileSize?: number
  }) {
    this.patterns = [...SECRET_PATTERNS, ...(options?.customPatterns || [])]
    this.excludeDirs = [...DEFAULT_EXCLUDE_DIRS, ...(options?.excludeDirs || [])]
    this.excludeFiles = [...DEFAULT_EXCLUDE_FILES, ...(options?.excludeFiles || [])]
    this.maxFileSize = options?.maxFileSize || 1024 * 1024 // 1MB default
  }

  /**
   * Scan a directory for secrets
   */
  async scan(options: ScanOptions): Promise<ScanResult> {
    const startTime = Date.now()
    const findings: SecurityFinding[] = []
    let scannedFiles = 0

    const { directory, exclude = [], include, skipPatterns = [] } = options
    const failSeverity = options.failOnSeverity || 'critical'

    if (!existsSync(directory)) {
      throw new Error(`Directory not found: ${directory}`)
    }

    // Get all files to scan
    const files = this.getFilesToScan(directory, [...this.excludeDirs, ...exclude], include)

    // Scan each file
    for (const file of files) {
      const relativePath = relative(directory, file)

      // Skip excluded files
      if (this.shouldExcludeFile(relativePath)) {
        continue
      }

      try {
        const stat = statSync(file)

        // Skip files that are too large
        if (stat.size > this.maxFileSize) {
          continue
        }

        const content = readFileSync(file, 'utf-8')
        const fileFindings = this.scanContent(content, relativePath, skipPatterns)
        findings.push(...fileFindings)
        scannedFiles++
      }
      catch {
        // Skip files that can't be read (binary, etc.)
        continue
      }
    }

    // Calculate summary
    const summary = {
      critical: findings.filter(f => f.pattern.severity === 'critical').length,
      high: findings.filter(f => f.pattern.severity === 'high').length,
      medium: findings.filter(f => f.pattern.severity === 'medium').length,
      low: findings.filter(f => f.pattern.severity === 'low').length,
    }

    // Determine if scan passed based on severity threshold
    const severityOrder = ['low', 'medium', 'high', 'critical']
    const failIndex = severityOrder.indexOf(failSeverity)
    let passed = true

    for (let i = failIndex; i < severityOrder.length; i++) {
      if (summary[severityOrder[i] as keyof typeof summary] > 0) {
        passed = false
        break
      }
    }

    return {
      passed,
      findings,
      scannedFiles,
      duration: Date.now() - startTime,
      summary,
    }
  }

  /**
   * Scan content for secrets
   */
  private scanContent(content: string, filePath: string, skipPatterns: string[]): SecurityFinding[] {
    const findings: SecurityFinding[] = []
    const lines = content.split('\n')

    for (const pattern of this.patterns) {
      // Skip patterns if specified
      if (skipPatterns.includes(pattern.name)) {
        continue
      }

      // Reset regex lastIndex
      pattern.pattern.lastIndex = 0

      let match: RegExpExecArray | null
      while ((match = pattern.pattern.exec(content)) !== null) {
        // Find line number and column
        const beforeMatch = content.substring(0, match.index)
        const lineNumber = beforeMatch.split('\n').length
        const lastNewline = beforeMatch.lastIndexOf('\n')
        const column = match.index - lastNewline

        // Get context (the line containing the match)
        const contextLine = lines[lineNumber - 1] || ''

        // Skip if it looks like a test/example/placeholder
        if (this.isLikelyPlaceholder(match[0], contextLine)) {
          continue
        }

        findings.push({
          file: filePath,
          line: lineNumber,
          column,
          match: this.maskSecret(match[0]),
          pattern,
          context: this.maskSecret(contextLine.trim()),
        })
      }
    }

    return findings
  }

  /**
   * Check if a match is likely a placeholder/example
   */
  private isLikelyPlaceholder(match: string, context: string): boolean {
    const placeholderIndicators = [
      'example',
      'placeholder',
      'your_',
      'YOUR_',
      'xxx',
      'XXX',
      '***',
      'test',
      'TEST',
      'dummy',
      'DUMMY',
      'fake',
      'FAKE',
      'sample',
      'SAMPLE',
      '<your',
      '${',
      '{{',
      'process.env',
      'import.meta.env',
      'CHANGEME',
      'TODO',
      'FIXME',
    ]

    const lowerMatch = match.toLowerCase()
    const lowerContext = context.toLowerCase()

    for (const indicator of placeholderIndicators) {
      if (lowerMatch.includes(indicator.toLowerCase()) || lowerContext.includes(indicator.toLowerCase())) {
        return true
      }
    }

    // Check if it's in a comment
    const trimmedContext = context.trim()
    if (trimmedContext.startsWith('//') || trimmedContext.startsWith('#') || trimmedContext.startsWith('*') || trimmedContext.startsWith('/*')) {
      // Only skip if it's clearly documentation
      if (lowerContext.includes('example') || lowerContext.includes('format:') || lowerContext.includes('e.g.')) {
        return true
      }
    }

    return false
  }

  /**
   * Mask a secret for display
   */
  private maskSecret(value: string): string {
    if (value.length <= 8) {
      return '*'.repeat(value.length)
    }

    const visibleChars = Math.min(4, Math.floor(value.length * 0.2))
    return value.substring(0, visibleChars) + '*'.repeat(value.length - visibleChars * 2) + value.substring(value.length - visibleChars)
  }

  /**
   * Get all files to scan in a directory
   */
  private getFilesToScan(dir: string, excludeDirs: string[], includeExtensions?: string[]): string[] {
    const files: string[] = []
    const extensions = includeExtensions || DEFAULT_SCAN_EXTENSIONS

    const scan = (currentDir: string) => {
      const entries = readdirSync(currentDir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name)

        if (entry.isDirectory()) {
          // Skip excluded directories
          if (!excludeDirs.includes(entry.name)) {
            scan(fullPath)
          }
        }
        else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase()
          // Include files with matching extensions or no extension (like .env files)
          if (extensions.includes(ext) || entry.name.startsWith('.env') || entry.name.endsWith('.config')) {
            files.push(fullPath)
          }
        }
      }
    }

    scan(dir)
    return files
  }

  /**
   * Check if a file should be excluded
   */
  private shouldExcludeFile(filePath: string): boolean {
    const fileName = filePath.split('/').pop() || ''

    for (const pattern of this.excludeFiles) {
      if (pattern.startsWith('*')) {
        // Wildcard pattern
        const suffix = pattern.substring(1)
        if (fileName.endsWith(suffix)) {
          return true
        }
      }
      else if (fileName === pattern) {
        return true
      }
    }

    return false
  }

  /**
   * Add custom patterns
   */
  addPattern(pattern: SecretPattern): void {
    this.patterns.push(pattern)
  }

  /**
   * Get all registered patterns
   */
  getPatterns(): SecretPattern[] {
    return [...this.patterns]
  }
}

/**
 * Convenience function to scan a directory
 */
export async function scanForSecrets(options: ScanOptions): Promise<ScanResult> {
  const scanner = new PreDeployScanner()
  return scanner.scan(options)
}

/**
 * Format scan results for CLI output
 */
export function formatScanResults(result: ScanResult): string {
  const lines: string[] = []

  lines.push(`\nSecurity Scan Results`)
  lines.push('='.repeat(50))
  lines.push(`Files scanned: ${result.scannedFiles}`)
  lines.push(`Duration: ${result.duration}ms`)
  lines.push('')

  lines.push('Summary:')
  lines.push(`  Critical: ${result.summary.critical}`)
  lines.push(`  High: ${result.summary.high}`)
  lines.push(`  Medium: ${result.summary.medium}`)
  lines.push(`  Low: ${result.summary.low}`)
  lines.push('')

  if (result.findings.length > 0) {
    lines.push('Findings:')
    lines.push('-'.repeat(50))

    for (const finding of result.findings) {
      lines.push(`\n[${finding.pattern.severity.toUpperCase()}] ${finding.pattern.name}`)
      lines.push(`  File: ${finding.file}:${finding.line}:${finding.column}`)
      lines.push(`  Match: ${finding.match}`)
      lines.push(`  Context: ${finding.context}`)
      lines.push(`  Description: ${finding.pattern.description}`)
    }
  }

  lines.push('')
  lines.push(result.passed ? '✓ Security scan passed' : '✗ Security scan failed')

  return lines.join('\n')
}
