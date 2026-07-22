import type { CallerIdentity } from '../aws/sts'
import type { EvaluationResult } from '../aws/iam'
import type { JsonValue } from '../control-plane'
import type { PreDeployScanner } from './pre-deploy-scanner'
import type { RecordSecurityScanInput, SecurityCheckStatus, SecurityFindingInput, SecurityScope } from './types'
import type { SecurityPostureStore } from './posture-store'
import { IAMClient } from '../aws/iam'
import { STSClient } from '../aws/sts'
import { PreDeployScanner as SourceSecretScanner } from './pre-deploy-scanner'

export interface SecurityScannerContext extends SecurityScope {
  artifactRoot?: string
  imageRef?: string
  signal: AbortSignal
}

export interface SecurityScannerResult {
  status: SecurityCheckStatus
  findings: SecurityFindingInput[]
  metadata?: JsonValue
  error?: string
}

export interface SecurityScanner {
  id: string
  version: string
  timeoutMs?: number
  scan: (context: SecurityScannerContext) => Promise<SecurityScannerResult>
}

export interface SecurityScannerRunnerOptions {
  defaultTimeoutMs?: number
  now?: () => Date
}

function timeoutResult(scanner: SecurityScanner, timeoutMs: number): SecurityScannerResult {
  return { status: 'unavailable', findings: [], error: `${scanner.id} exceeded its ${timeoutMs}ms timeout`, metadata: { timeoutMs } }
}

export class SecurityScannerRunner {
  private readonly defaultTimeoutMs: number
  private readonly nowFn: () => Date

  constructor(private readonly posture: SecurityPostureStore, options: SecurityScannerRunnerOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000
    this.nowFn = options.now ?? (() => new Date())
  }

  async run(scanner: SecurityScanner, scope: Omit<SecurityScannerContext, 'signal'>): Promise<ReturnType<SecurityPostureStore['recordScan']>> {
    const started = this.nowFn()
    const timeoutMs = Math.max(100, scanner.timeoutMs ?? this.defaultTimeoutMs)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<SecurityScannerResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(timeoutResult(scanner, timeoutMs))
      }, timeoutMs)
    })
    let result: SecurityScannerResult
    try {
      result = await Promise.race([scanner.scan({ ...scope, signal: controller.signal }), timeout])
    }
    catch (error) {
      result = { status: 'unavailable', findings: [], error: error instanceof Error ? error.message : String(error) }
    }
    finally {
      if (timer)
        clearTimeout(timer)
    }
    const completed = this.nowFn()
    const input: RecordSecurityScanInput = {
      ...scope,
      scannerId: scanner.id,
      scannerVersion: scanner.version,
      status: result.status,
      findings: result.findings,
      metadata: result.metadata,
      error: result.error,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - started.getTime()),
    }
    return this.posture.recordScan(input)
  }

  async runAll(scanners: SecurityScanner[], scope: Omit<SecurityScannerContext, 'signal'>): Promise<Array<ReturnType<SecurityPostureStore['recordScan']>>> {
    return Promise.all(scanners.map(scanner => this.run(scanner, scope)))
  }
}

export class SecretFindingScanner implements SecurityScanner {
  readonly id = 'source-secrets'
  readonly version = '1.0.0'
  readonly timeoutMs = 30_000

  constructor(private readonly scanner: PreDeployScanner = new SourceSecretScanner()) {}

  async scan(context: SecurityScannerContext): Promise<SecurityScannerResult> {
    if (!context.artifactRoot)
      return { status: 'skipped', findings: [], error: 'No artifact root was supplied' }
    const result = await this.scanner.scan({ directory: context.artifactRoot, failOnSeverity: 'critical' })
    return {
      status: result.passed ? 'passed' : 'failed',
      findings: result.findings.map(finding => ({
        ...context,
        ruleId: finding.pattern.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        severity: finding.pattern.severity,
        title: finding.pattern.name,
        description: finding.pattern.description,
        subject: `${finding.file}:${finding.line}`,
        evidence: { file: finding.file, line: finding.line, column: finding.column, match: finding.match, context: finding.context },
        remediation: 'Remove the credential, rotate it at its issuer, and use a managed secret or environment reference.',
      })),
      metadata: { scannedFiles: result.scannedFiles, summary: result.summary },
    }
  }
}

interface TrivyVulnerability {
  VulnerabilityID?: string
  PkgName?: string
  InstalledVersion?: string
  FixedVersion?: string
  Severity?: string
  Title?: string
  Description?: string
  PrimaryURL?: string
}

interface TrivyOutput {
  Results?: Array<{ Target?: string, Vulnerabilities?: TrivyVulnerability[] }>
}

function severity(value?: string): SecurityFindingInput['severity'] {
  const normalized = value?.toLowerCase()
  return normalized === 'critical' || normalized === 'high' || normalized === 'medium' || normalized === 'low' ? normalized : 'info'
}

/** Runs Trivy locally with a deliberately minimal environment and never uploads source or reports. */
export class TrivyImageScanner implements SecurityScanner {
  readonly id = 'trivy-image'
  readonly version: string
  readonly timeoutMs: number

  constructor(options: { version?: string, timeoutMs?: number, executable?: string } = {}) {
    this.version = options.version ?? 'local'
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.executable = options.executable ?? 'trivy'
  }

  private readonly executable: string

  async scan(context: SecurityScannerContext): Promise<SecurityScannerResult> {
    if (!context.imageRef)
      return { status: 'skipped', findings: [], error: 'No image reference was supplied' }
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = Bun.spawn([this.executable, 'image', '--format', 'json', '--quiet', '--scanners', 'vuln', context.imageRef], {
        stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', TRIVY_NO_PROGRESS: 'true' },
      })
    }
    catch (error) {
      return { status: 'unsupported', findings: [], error: error instanceof Error ? error.message : String(error) }
    }
    const abort = () => child.kill()
    context.signal.addEventListener('abort', abort, { once: true })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()])
    context.signal.removeEventListener('abort', abort)
    if (exitCode !== 0) {
      const missing = /not found|enoent/i.test(stderr)
      return { status: missing ? 'unsupported' : 'unavailable', findings: [], error: stderr.slice(0, 2_000) || `Trivy exited with ${exitCode}` }
    }
    const parsed = JSON.parse(stdout) as TrivyOutput
    const findings: SecurityFindingInput[] = []
    for (const result of parsed.Results ?? []) {
      for (const vulnerability of result.Vulnerabilities ?? []) {
        const cve = vulnerability.VulnerabilityID ?? 'unknown-vulnerability'
        findings.push({
          ...context, ruleId: cve, severity: severity(vulnerability.Severity), title: vulnerability.Title || cve,
          description: vulnerability.Description || `${cve} affects ${vulnerability.PkgName ?? 'an image package'}.`,
          subject: `${context.imageRef}:${vulnerability.PkgName ?? 'unknown'}:${vulnerability.InstalledVersion ?? 'unknown'}`,
          evidence: { image: context.imageRef, target: result.Target ?? '', cve, package: vulnerability.PkgName ?? '', installedVersion: vulnerability.InstalledVersion ?? '', fixedVersion: vulnerability.FixedVersion ?? '', reference: vulnerability.PrimaryURL ?? '' },
          remediation: vulnerability.FixedVersion ? `Upgrade ${vulnerability.PkgName} to ${vulnerability.FixedVersion} or later.` : 'Remove or replace the affected package and rescan the image.',
        })
      }
    }
    return { status: findings.length ? 'failed' : 'passed', findings, metadata: { imageRef: context.imageRef, vulnerabilityCount: findings.length, localOnly: true } }
  }
}

export interface AwsCapabilityClient {
  getCallerIdentity: () => Promise<CallerIdentity>
  simulatePrincipalPolicy: (input: { PolicySourceArn: string, ActionNames: string[], ResourceArns?: string[] }) => Promise<{ EvaluationResults: EvaluationResult[] }>
}

/** Validates the actual caller and required IAM actions instead of treating configured credentials as sufficient. */
export class AwsIamCapabilityScanner implements SecurityScanner {
  readonly id = 'aws-iam-capabilities'
  readonly version = '1.0.0'
  readonly timeoutMs = 30_000
  private readonly client: AwsCapabilityClient

  constructor(private readonly actions: string[], options: { region?: string, client?: AwsCapabilityClient, resourceArns?: string[] } = {}) {
    this.resourceArns = options.resourceArns ?? ['*']
    if (options.client) {
      this.client = options.client
    }
    else {
      const sts = new STSClient(options.region)
      const iam = new IAMClient(options.region)
      this.client = { getCallerIdentity: () => sts.getCallerIdentity(), simulatePrincipalPolicy: input => iam.simulatePrincipalPolicy(input) }
    }
  }

  private readonly resourceArns: string[]

  async scan(context: SecurityScannerContext): Promise<SecurityScannerResult> {
    const identity = await this.client.getCallerIdentity()
    if (!identity.Arn)
      return { status: 'unavailable', findings: [], error: 'AWS returned no caller ARN' }
    const principalArn = identity.Arn
    if (principalArn.includes(':assumed-role/')) {
      return {
        status: 'unsupported', findings: [],
        error: 'AWS policy simulation requires the underlying IAM role ARN; use an IAM role/user ARN or provider-native access analysis.',
        metadata: { account: identity.Account ?? '', principalType: 'assumed-role' },
      }
    }
    const result = await this.client.simulatePrincipalPolicy({ PolicySourceArn: principalArn, ActionNames: this.actions, ResourceArns: this.resourceArns })
    const denied = result.EvaluationResults.filter(item => item.EvalDecision !== 'allowed')
    const findings = denied.map(item => ({
      ...context, ruleId: `iam-${item.EvalActionName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, severity: 'high' as const,
      title: `Missing AWS capability: ${item.EvalActionName}`, description: `The active AWS principal is ${item.EvalDecision || 'not allowed'} for this deployment action.`,
      subject: `${principalArn}:${item.EvalActionName}`, evidence: { account: identity.Account ?? '', principalArn, action: item.EvalActionName, decision: item.EvalDecision, missingContext: item.MissingContextValues ?? [] },
      remediation: 'Grant the deployment principal the least-privilege action on the required resources, then rerun the capability check.',
    }))
    return { status: findings.length ? 'failed' : 'passed', findings, metadata: { account: identity.Account ?? '', principalArn, evaluatedActions: this.actions.length } }
  }
}
