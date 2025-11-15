import { describe, expect, it, beforeEach } from 'bun:test'
import {
  SecretsRotationManager,
  secretsRotationManager,
  SecretsManager,
  secretsManager,
  CertificateManager,
  certificateManager,
  SecurityScanningManager,
  securityScanningManager,
} from '.'

describe('Secrets Rotation Manager', () => {
  let manager: SecretsRotationManager

  beforeEach(() => {
    manager = new SecretsRotationManager()
  })

  describe('Rotation Configuration', () => {
    it('should enable RDS rotation', () => {
      const rotation = manager.enableRDSRotation({
        secretId: 'db-credentials',
        databaseIdentifier: 'production-db',
        engine: 'postgres',
        rotationDays: 30,
      })

      expect(rotation.id).toContain('rotation')
      expect(rotation.secretType).toBe('rds_credentials')
      expect(rotation.rotationEnabled).toBe(true)
      expect(rotation.rotationDays).toBe(30)
      expect(rotation.nextRotation).toBeDefined()
    })

    it('should enable API key rotation', () => {
      const rotation = manager.enableAPIKeyRotation({
        secretId: 'api-key-secret',
        rotationDays: 90,
      })

      expect(rotation.secretType).toBe('api_key')
      expect(rotation.rotationDays).toBe(90)
    })

    it('should enable OAuth token rotation', () => {
      const rotation = manager.enableOAuthRotation({
        secretId: 'oauth-token',
        rotationLambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:oauth-rotation',
      })

      expect(rotation.secretType).toBe('oauth_token')
      expect(rotation.rotationLambdaArn).toBeDefined()
    })

    it('should enable SSH key rotation', () => {
      const rotation = manager.enableSSHKeyRotation({
        secretId: 'ssh-key',
        rotationLambdaArn: 'arn:aws:lambda:us-east-1:123456789012:function:ssh-rotation',
        rotationDays: 180,
      })

      expect(rotation.secretType).toBe('ssh_key')
      expect(rotation.rotationDays).toBe(180)
    })
  })

  describe('Rotation Execution', () => {
    it('should execute rotation', async () => {
      const rotation = manager.enableAPIKeyRotation({
        secretId: 'test-secret',
      })

      const result = await manager.executeRotation(rotation.id)

      expect(result.success).toBe(true)
      expect(result.secretId).toBe('test-secret')
      expect(result.newVersion).toBeDefined()
    })

    it('should check if rotation needed', () => {
      const rotation = manager.enableAPIKeyRotation({
        secretId: 'test-secret',
        rotationDays: 30,
      })

      // New rotation should need rotation (never rotated)
      const needsRotation = manager.needsRotation(rotation.id)
      expect(needsRotation).toBe(true)
    })

    it('should get secrets needing rotation', async () => {
      manager.enableAPIKeyRotation({ secretId: 'secret1' })
      manager.enableAPIKeyRotation({ secretId: 'secret2' })

      const secrets = manager.getSecretsNeedingRotation()

      expect(secrets.length).toBeGreaterThan(0)
    })
  })

  describe('Rotation Schedules', () => {
    it('should create rotation schedule', () => {
      const schedule = manager.createSchedule({
        name: 'daily-rotation',
        secrets: ['secret1', 'secret2'],
        schedule: 'rate(1 day)',
        enabled: true,
      })

      expect(schedule.id).toContain('schedule')
      expect(schedule.name).toBe('daily-rotation')
      expect(schedule.secrets).toHaveLength(2)
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate rotation CloudFormation', () => {
      const rotation = manager.enableRDSRotation({
        secretId: 'db-creds',
        databaseIdentifier: 'prod-db',
        engine: 'postgres',
      })

      const cf = manager.generateRotationCF(rotation)

      expect(cf.RotationEnabled).toBe(true)
      expect(cf.RotationRules.AutomaticallyAfterDays).toBe(30)
    })

    it('should generate rotation Lambda CloudFormation', () => {
      const cf = manager.generateRotationLambdaCF({
        functionName: 'test-rotation',
        secretType: 'rds_credentials',
      })

      expect(cf.Type).toBe('AWS::Lambda::Function')
      expect(cf.Properties.Runtime).toBe('python3.11')
    })
  })

  it('should use global instance', () => {
    expect(secretsRotationManager).toBeInstanceOf(SecretsRotationManager)
  })
})

describe('Secrets Manager', () => {
  let manager: SecretsManager

  beforeEach(() => {
    manager = new SecretsManager()
  })

  describe('Version Management', () => {
    it('should create secret version', () => {
      const version = manager.createVersion({
        secretId: 'my-secret',
        versionId: 'v1',
        versionStages: ['AWSCURRENT'],
        createdAt: new Date(),
      })

      expect(version.id).toContain('version')
      expect(version.secretId).toBe('my-secret')
      expect(version.versionStages).toContain('AWSCURRENT')
    })

    it('should get version by stage', () => {
      manager.createVersion({
        secretId: 'my-secret',
        versionId: 'v1',
        versionStages: ['AWSCURRENT'],
        createdAt: new Date(),
      })

      const version = manager.getVersionByStage('my-secret', 'AWSCURRENT')

      expect(version).toBeDefined()
      expect(version?.versionId).toBe('v1')
    })

    it('should list versions for secret', () => {
      manager.createVersion({
        secretId: 'my-secret',
        versionId: 'v1',
        versionStages: ['AWSPREVIOUS'],
        createdAt: new Date(Date.now() - 1000),
      })

      manager.createVersion({
        secretId: 'my-secret',
        versionId: 'v2',
        versionStages: ['AWSCURRENT'],
        createdAt: new Date(),
      })

      const versions = manager.listVersions('my-secret')

      expect(versions).toHaveLength(2)
      expect(versions[0].versionId).toBe('v2') // Most recent first
    })

    it('should deprecate version', () => {
      const version = manager.createVersion({
        secretId: 'my-secret',
        versionId: 'v1',
        versionStages: ['AWSCURRENT'],
        createdAt: new Date(),
      })

      manager.deprecateVersion('v1')

      expect(version.deprecatedAt).toBeDefined()
      expect(version.versionStages).not.toContain('AWSCURRENT')
    })

    it('should restore version', () => {
      const oldVersion = manager.createVersion({
        secretId: 'my-secret',
        versionId: 'v1',
        versionStages: ['AWSPREVIOUS'],
        createdAt: new Date(Date.now() - 1000),
      })

      manager.createVersion({
        secretId: 'my-secret',
        versionId: 'v2',
        versionStages: ['AWSCURRENT'],
        createdAt: new Date(),
      })

      manager.restoreVersion('v1')

      expect(oldVersion.versionStages).toContain('AWSCURRENT')
      expect(oldVersion.deprecatedAt).toBeUndefined()
    })
  })

  describe('Audit Trail', () => {
    it('should audit secret action', () => {
      const audit = manager.auditAction({
        secretId: 'my-secret',
        action: 'READ',
        actor: 'user@example.com',
        success: true,
      })

      expect(audit.id).toContain('audit')
      expect(audit.action).toBe('READ')
      expect(audit.timestamp).toBeDefined()
    })

    it('should get audit trail', () => {
      manager.auditAction({
        secretId: 'my-secret',
        action: 'READ',
        actor: 'user1',
        success: true,
      })

      manager.auditAction({
        secretId: 'my-secret',
        action: 'UPDATE',
        actor: 'user2',
        success: true,
      })

      const trail = manager.getAuditTrail('my-secret')

      expect(trail).toHaveLength(2)
    })

    it('should get failed accesses', () => {
      manager.auditAction({
        secretId: 'my-secret',
        action: 'READ',
        actor: 'attacker',
        success: false,
      })

      const failures = manager.getFailedAccesses('my-secret')

      expect(failures).toHaveLength(1)
      expect(failures[0].success).toBe(false)
    })
  })

  describe('External Managers', () => {
    it('should register HashiCorp Vault', () => {
      const vault = manager.registerVault({
        name: 'production-vault',
        endpoint: 'https://vault.example.com',
        token: 'vault-token',
      })

      expect(vault.id).toContain('ext-manager')
      expect(vault.type).toBe('vault')
      expect(vault.endpoint).toBe('https://vault.example.com')
    })

    it('should register 1Password', () => {
      const onepassword = manager.registerOnePassword({
        name: 'team-1password',
        apiKey: '1password-api-key',
        syncEnabled: true,
      })

      expect(onepassword.type).toBe('onepassword')
      expect(onepassword.syncEnabled).toBe(true)
    })
  })

  describe('Secret Replication', () => {
    it('should enable replication', () => {
      const replication = manager.enableReplication({
        secretId: 'my-secret',
        sourceRegion: 'us-east-1',
        replicaRegions: ['us-west-2', 'eu-west-1'],
      })

      expect(replication.id).toContain('replication')
      expect(replication.replicaRegions).toHaveLength(2)
      expect(replication.status).toBe('replicating')
    })
  })

  describe('Secret Policies', () => {
    it('should create secret policy', () => {
      const policy = manager.createPolicy({
        secretId: 'my-secret',
        allowedPrincipals: ['arn:aws:iam::123456789012:role/MyRole'],
        allowedActions: ['secretsmanager:GetSecretValue'],
      })

      expect(policy.id).toContain('policy')
      expect(policy.policy.Statement).toHaveLength(1)
    })

    it('should create cross-account policy', () => {
      const policy = manager.createCrossAccountPolicy({
        secretId: 'my-secret',
        accountId: '987654321098',
        roleNames: ['AppRole', 'AdminRole'],
      })

      expect(policy.policy.Statement[0].Principal.AWS).toHaveLength(2)
    })
  })

  it('should use global instance', () => {
    expect(secretsManager).toBeInstanceOf(SecretsManager)
  })
})

describe('Certificate Manager', () => {
  let manager: CertificateManager

  beforeEach(() => {
    manager = new CertificateManager()
  })

  describe('Certificate Requests', () => {
    it('should request certificate', () => {
      const cert = manager.requestCertificate({
        domainName: 'example.com',
        validationMethod: 'DNS',
      })

      expect(cert.id).toContain('cert')
      expect(cert.domainName).toBe('example.com')
      expect(cert.status).toBe('PENDING_VALIDATION')
    })

    it('should request wildcard certificate', () => {
      const cert = manager.requestWildcardCertificate({
        domainName: '*.example.com',
        includeApex: true,
      })

      expect(cert.domainName).toBe('*.example.com')
      expect(cert.subjectAlternativeNames).toContain('example.com')
    })

    it('should request multi-domain certificate', () => {
      const cert = manager.requestMultiDomainCertificate({
        primaryDomain: 'example.com',
        additionalDomains: ['www.example.com', 'api.example.com'],
      })

      expect(cert.subjectAlternativeNames).toHaveLength(2)
    })
  })

  describe('Certificate Validation', () => {
    it('should validate certificate', () => {
      const cert = manager.requestCertificate({
        domainName: 'example.com',
        validationMethod: 'DNS',
      })

      const result = manager.validateCertificate(cert.id)

      expect(result.success).toBe(true)
      expect(cert.status).toBe('ISSUED')
      expect(cert.expiresAt).toBeDefined()
    })

    it('should create DNS validation records', () => {
      const cert = manager.requestCertificate({
        domainName: 'example.com',
        validationMethod: 'DNS',
      })

      const validation = manager.getValidation(cert.id)

      expect(validation).toBeDefined()
      expect(validation?.validationMethod).toBe('DNS')
      expect(validation?.resourceRecords).toBeDefined()
    })
  })

  describe('Certificate Renewal', () => {
    it('should enable auto-renewal', () => {
      const cert = manager.requestCertificate({
        domainName: 'example.com',
      })

      const renewal = manager.enableAutoRenewal({
        certificateArn: cert.arn,
        renewBeforeDays: 30,
      })

      expect(renewal.id).toContain('renewal')
      expect(renewal.autoRenew).toBe(true)
      expect(renewal.renewBeforeDays).toBe(30)
    })

    it('should renew certificate', async () => {
      const cert = manager.requestCertificate({
        domainName: 'example.com',
      })

      manager.validateCertificate(cert.id)

      const renewal = manager.enableAutoRenewal({
        certificateArn: cert.arn,
      })

      const result = await manager.renewCertificate(renewal.id)

      expect(result.success).toBe(true)
      expect(renewal.lastRenewal).toBeDefined()
    })
  })

  describe('Certificate Monitoring', () => {
    it('should create certificate monitor', () => {
      const monitor = manager.createMonitor({
        name: 'production-certs',
        certificates: ['cert-arn-1', 'cert-arn-2'],
        expirationThreshold: 30,
        alertEnabled: true,
      })

      expect(monitor.id).toContain('monitor')
      expect(monitor.certificates).toHaveLength(2)
    })

    it('should check expiration', () => {
      const cert = manager.requestCertificate({
        domainName: 'example.com',
      })

      manager.validateCertificate(cert.id)

      // Set expiration to 15 days from now
      cert.expiresAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000)

      const alerts = manager.checkExpiration()

      expect(alerts.length).toBeGreaterThan(0)
      expect(alerts[0].alertType).toBe('expiring_soon')
    })

    it('should get expiring certificates', () => {
      const cert1 = manager.requestCertificate({ domainName: 'example.com' })
      manager.validateCertificate(cert1.id)
      cert1.expiresAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000)

      const cert2 = manager.requestCertificate({ domainName: 'test.com' })
      manager.validateCertificate(cert2.id)
      cert2.expiresAt = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000)

      const expiring = manager.getExpiringCertificates(30)

      expect(expiring).toHaveLength(1)
      expect(expiring[0].domainName).toBe('example.com')
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate certificate CloudFormation', () => {
      const cert = manager.requestCertificate({
        domainName: 'example.com',
      })

      const cf = manager.generateCertificateCF(cert)

      expect(cf.Type).toBe('AWS::CertificateManager::Certificate')
      expect(cf.Properties.DomainName).toBe('example.com')
    })

    it('should generate expiration alarm', () => {
      const cert = manager.requestCertificate({
        domainName: 'example.com',
      })

      const cf = manager.generateExpirationAlarmCF({
        alarmName: 'cert-expiring',
        certificateArn: cert.arn,
        daysBeforeExpiration: 30,
      })

      expect(cf.Type).toBe('AWS::CloudWatch::Alarm')
      expect(cf.Properties.Threshold).toBe(30)
    })
  })

  it('should use global instance', () => {
    expect(certificateManager).toBeInstanceOf(CertificateManager)
  })
})

describe('Security Scanning Manager', () => {
  let manager: SecurityScanningManager

  beforeEach(() => {
    manager = new SecurityScanningManager()
  })

  describe('Scan Creation', () => {
    it('should create container scan', () => {
      const scan = manager.createContainerScan({
        name: 'app-image-scan',
        imageUri: 'my-repo/app:latest',
      })

      expect(scan.id).toContain('scan')
      expect(scan.scanType).toBe('container_image')
      expect(scan.target.type).toBe('ecr_image')
    })

    it('should create Lambda scan', () => {
      const scan = manager.createLambdaScan({
        name: 'lambda-scan',
        functionName: 'my-function',
      })

      expect(scan.scanType).toBe('vulnerability')
      expect(scan.target.type).toBe('lambda')
    })

    it('should create secrets detection scan', () => {
      const scan = manager.createSecretsDetectionScan({
        name: 'repo-secrets-scan',
        repositoryUrl: 'https://github.com/org/repo',
      })

      expect(scan.scanType).toBe('secrets_detection')
      expect(scan.target.type).toBe('repository')
    })
  })

  describe('Scan Execution', () => {
    it('should execute scan', async () => {
      const scan = manager.createContainerScan({
        name: 'test-scan',
        imageUri: 'test:latest',
      })

      const result = await manager.executeScan(scan.id)

      expect(result.status).toBe('completed')
      expect(result.summary).toBeDefined()
      expect(result.findings).toBeDefined()
    })

    it('should generate scan summary', async () => {
      const scan = manager.createContainerScan({
        name: 'test-scan',
        imageUri: 'test:latest',
      })

      await manager.executeScan(scan.id)

      expect(scan.summary?.totalFindings).toBeGreaterThanOrEqual(0)
      expect(scan.summary?.executionTime).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Findings Management', () => {
    it('should create finding', () => {
      const finding = manager.createFinding({
        severity: 'HIGH',
        title: 'SQL Injection vulnerability',
        description: 'User input not sanitized',
        affectedResource: 'app.js:42',
        remediation: 'Use parameterized queries',
        status: 'OPEN',
        firstDetected: new Date(),
        lastSeen: new Date(),
      })

      expect(finding.id).toContain('finding')
      expect(finding.severity).toBe('HIGH')
    })

    it('should suppress finding', () => {
      const finding = manager.createFinding({
        severity: 'MEDIUM',
        title: 'Test finding',
        description: 'Test',
        affectedResource: 'test',
        status: 'OPEN',
        firstDetected: new Date(),
        lastSeen: new Date(),
      })

      manager.suppressFinding(finding.id, 'False positive')

      expect(finding.status).toBe('SUPPRESSED')
    })

    it('should resolve finding', () => {
      const finding = manager.createFinding({
        severity: 'LOW',
        title: 'Test finding',
        description: 'Test',
        affectedResource: 'test',
        status: 'OPEN',
        firstDetected: new Date(),
        lastSeen: new Date(),
      })

      manager.resolveFinding(finding.id)

      expect(finding.status).toBe('RESOLVED')
    })

    it('should get open findings by severity', async () => {
      const scan = manager.createContainerScan({
        name: 'test',
        imageUri: 'test:latest',
      })

      await manager.executeScan(scan.id)

      const criticalFindings = manager.getOpenFindings('CRITICAL')
      const allOpenFindings = manager.getOpenFindings()

      expect(Array.isArray(criticalFindings)).toBe(true)
      expect(Array.isArray(allOpenFindings)).toBe(true)
    })
  })

  describe('Compliance Checks', () => {
    it('should run compliance check', () => {
      const checks = manager.runComplianceCheck({
        framework: 'CIS_AWS_FOUNDATIONS_1_4',
        resourceType: 'AWS::IAM::User',
        resourceId: 'user-123',
      })

      expect(checks.length).toBeGreaterThan(0)
      expect(checks[0].framework).toBe('CIS_AWS_FOUNDATIONS_1_4')
    })

    it('should get checks by status', () => {
      manager.runComplianceCheck({
        framework: 'CIS_AWS_FOUNDATIONS_1_4',
        resourceType: 'AWS::IAM::User',
        resourceId: 'user-123',
      })

      const passed = manager.getComplianceChecksByStatus('PASS')
      const failed = manager.getComplianceChecksByStatus('FAIL')

      expect(Array.isArray(passed)).toBe(true)
      expect(Array.isArray(failed)).toBe(true)
    })
  })

  describe('Security Posture', () => {
    it('should assess security posture', () => {
      manager.runComplianceCheck({
        framework: 'CIS_AWS_FOUNDATIONS_1_4',
        resourceType: 'AWS::IAM::User',
        resourceId: 'user-123',
      })

      const posture = manager.assessSecurityPosture({
        accountId: '123456789012',
        region: 'us-east-1',
      })

      expect(posture.id).toContain('posture')
      expect(posture.score).toBeGreaterThanOrEqual(0)
      expect(posture.score).toBeLessThanOrEqual(100)
      expect(posture.grade).toMatch(/^[ABCDF]$/)
      expect(posture.recommendations).toBeDefined()
    })
  })

  describe('Reports', () => {
    it('should generate vulnerability report', async () => {
      const scan = manager.createContainerScan({
        name: 'test',
        imageUri: 'test:latest',
      })

      await manager.executeScan(scan.id)

      const report = manager.generateReport({
        scanId: scan.id,
        reportType: 'detailed',
        format: 'pdf',
      })

      expect(report.id).toContain('report')
      expect(report.format).toBe('pdf')
      expect(report.s3Location).toBeDefined()
    })
  })

  it('should use global instance', () => {
    expect(securityScanningManager).toBeInstanceOf(SecurityScanningManager)
  })
})
