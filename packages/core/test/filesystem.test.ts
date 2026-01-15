import { describe, expect, it } from 'bun:test'
import { FileSystem } from '../src/modules/filesystem'
import { TemplateBuilder } from '../src/template-builder'

describe('FileSystem Module', () => {
  describe('createFileSystem', () => {
    it('should create EFS with default settings', () => {
      const { fileSystem, logicalId } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
      })

      expect(fileSystem.Type).toBe('AWS::EFS::FileSystem')
      expect(fileSystem.Properties?.Encrypted).toBe(true)
      expect(fileSystem.Properties?.PerformanceMode).toBe('generalPurpose')
      expect(fileSystem.Properties?.ThroughputMode).toBe('bursting')
      expect(fileSystem.Properties?.BackupPolicy?.Status).toBe('ENABLED')
      expect(logicalId).toBeDefined()
    })

    it('should create unencrypted file system', () => {
      const { fileSystem } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
        encrypted: false,
      })

      expect(fileSystem.Properties?.Encrypted).toBe(false)
    })

    it('should support custom KMS key', () => {
      const { fileSystem } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
        encrypted: true,
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789:key/abc',
      })

      expect(fileSystem.Properties?.KmsKeyId).toBe('arn:aws:kms:us-east-1:123456789:key/abc')
    })

    it('should support max I/O performance mode', () => {
      const { fileSystem } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
        performanceMode: 'maxIO',
      })

      expect(fileSystem.Properties?.PerformanceMode).toBe('maxIO')
    })

    it('should support provisioned throughput', () => {
      const { fileSystem } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
        throughputMode: 'provisioned',
        provisionedThroughput: 100,
      })

      expect(fileSystem.Properties?.ThroughputMode).toBe('provisioned')
      expect(fileSystem.Properties?.ProvisionedThroughputInMibps).toBe(100)
    })

    it('should support elastic throughput', () => {
      const { fileSystem } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
        throughputMode: 'elastic',
      })

      expect(fileSystem.Properties?.ThroughputMode).toBe('elastic')
    })

    it('should disable backup when requested', () => {
      const { fileSystem } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
        enableBackup: false,
      })

      expect(fileSystem.Properties?.BackupPolicy).toBeUndefined()
    })
  })

  describe('createMountTarget', () => {
    it('should create mount target', () => {
      const { mountTarget, logicalId } = FileSystem.createMountTarget('fs-id', {
        slug: 'my-app',
        environment: 'production',
        subnetId: 'subnet-123',
        securityGroups: ['sg-123', 'sg-456'],
      })

      expect(mountTarget.Type).toBe('AWS::EFS::MountTarget')
      expect(mountTarget.Properties.FileSystemId).toMatchObject({ Ref: 'fs-id' })
      expect(mountTarget.Properties.SubnetId).toBe('subnet-123')
      expect(mountTarget.Properties.SecurityGroups).toEqual(['sg-123', 'sg-456'])
      expect(logicalId).toBeDefined()
    })

    it('should support custom IP address', () => {
      const { mountTarget } = FileSystem.createMountTarget('fs-id', {
        slug: 'my-app',
        environment: 'production',
        subnetId: 'subnet-123',
        securityGroups: ['sg-123'],
        ipAddress: '10.0.1.100',
      })

      expect(mountTarget.Properties.IpAddress).toBe('10.0.1.100')
    })
  })

  describe('createAccessPoint', () => {
    it('should create access point with default settings', () => {
      const { accessPoint, logicalId } = FileSystem.createAccessPoint('fs-id', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(accessPoint.Type).toBe('AWS::EFS::AccessPoint')
      expect(accessPoint.Properties.FileSystemId).toMatchObject({ Ref: 'fs-id' })
      expect(accessPoint.Properties.PosixUser?.Uid).toBe('1000')
      expect(accessPoint.Properties.PosixUser?.Gid).toBe('1000')
      expect(accessPoint.Properties.RootDirectory?.Path).toBe('/')
      expect(accessPoint.Properties.RootDirectory?.CreationInfo?.Permissions).toBe('755')
      expect(logicalId).toBeDefined()
    })

    it('should create access point with custom path', () => {
      const { accessPoint } = FileSystem.createAccessPoint('fs-id', {
        slug: 'my-app',
        environment: 'production',
        path: '/data',
      })

      expect(accessPoint.Properties.RootDirectory?.Path).toBe('/data')
    })

    it('should create access point with custom POSIX user', () => {
      const { accessPoint } = FileSystem.createAccessPoint('fs-id', {
        slug: 'my-app',
        environment: 'production',
        uid: '2000',
        gid: '2000',
      })

      expect(accessPoint.Properties.PosixUser?.Uid).toBe('2000')
      expect(accessPoint.Properties.PosixUser?.Gid).toBe('2000')
      expect(accessPoint.Properties.RootDirectory?.CreationInfo?.OwnerUid).toBe('2000')
      expect(accessPoint.Properties.RootDirectory?.CreationInfo?.OwnerGid).toBe('2000')
    })

    it('should create access point with custom permissions', () => {
      const { accessPoint } = FileSystem.createAccessPoint('fs-id', {
        slug: 'my-app',
        environment: 'production',
        permissions: '750',
      })

      expect(accessPoint.Properties.RootDirectory?.CreationInfo?.Permissions).toBe('750')
    })
  })

  describe('setLifecyclePolicy', () => {
    it('should set lifecycle policy to transition to IA after 30 days', () => {
      const { fileSystem } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
      })

      const updated = FileSystem.setLifecyclePolicy(fileSystem, {
        transitionToIA: 30,
      })

      expect(updated.Properties?.LifecyclePolicies).toHaveLength(1)
      expect(updated.Properties?.LifecyclePolicies?.[0].TransitionToIA).toBe('AFTER_30_DAYS')
    })

    it('should support 7, 14, 60, 90 day transitions', () => {
      const days = [7, 14, 60, 90] as const

      for (const transitionDays of days) {
        const { fileSystem } = FileSystem.createFileSystem({
          slug: 'my-app',
          environment: 'production',
        })

        const updated = FileSystem.setLifecyclePolicy(fileSystem, {
          transitionToIA: transitionDays,
        })

        expect(updated.Properties?.LifecyclePolicies?.[0].TransitionToIA).toBe(`AFTER_${transitionDays}_DAYS`)
      }
    })

    it('should set transition back to primary storage', () => {
      const { fileSystem } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
      })

      const updated = FileSystem.setLifecyclePolicy(fileSystem, {
        transitionToIA: 30,
        transitionToPrimary: true,
      })

      expect(updated.Properties?.LifecyclePolicies).toHaveLength(2)
      expect(updated.Properties?.LifecyclePolicies?.[1].TransitionToPrimaryStorageClass).toBe('AFTER_1_ACCESS')
    })
  })

  describe('enableBackup', () => {
    it('should enable automatic backups', () => {
      const { fileSystem } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
        enableBackup: false,
      })

      const updated = FileSystem.enableBackup(fileSystem)

      expect(updated.Properties?.BackupPolicy?.Status).toBe('ENABLED')
    })
  })

  describe('disableBackup', () => {
    it('should disable automatic backups', () => {
      const { fileSystem } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
      })

      const updated = FileSystem.disableBackup(fileSystem)

      expect(updated.Properties?.BackupPolicy?.Status).toBe('DISABLED')
    })
  })

  describe('setProvisionedThroughput', () => {
    it('should set provisioned throughput mode', () => {
      const { fileSystem } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
      })

      const updated = FileSystem.setProvisionedThroughput(fileSystem, 256)

      expect(updated.Properties?.ThroughputMode).toBe('provisioned')
      expect(updated.Properties?.ProvisionedThroughputInMibps).toBe(256)
    })
  })

  describe('setElasticThroughput', () => {
    it('should set elastic throughput mode', () => {
      const { fileSystem } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
      })

      const updated = FileSystem.setElasticThroughput(fileSystem)

      expect(updated.Properties?.ThroughputMode).toBe('elastic')
    })
  })

  describe('enableMaxIO', () => {
    it('should enable max I/O performance mode', () => {
      const { fileSystem } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
      })

      const updated = FileSystem.enableMaxIO(fileSystem)

      expect(updated.Properties?.PerformanceMode).toBe('maxIO')
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should create complete EFS infrastructure with multi-AZ mount targets', () => {
      const template = new TemplateBuilder('EFS Infrastructure')

      // Create file system with lifecycle policy
      const { fileSystem, logicalId: fsId } = FileSystem.createFileSystem({
        slug: 'my-app',
        environment: 'production',
        encrypted: true,
        throughputMode: 'elastic',
      })

      // Add lifecycle policy for cost optimization
      FileSystem.setLifecyclePolicy(fileSystem, {
        transitionToIA: 30,
        transitionToPrimary: true,
      })

      template.addResource(fsId, fileSystem)

      // Create mount targets in 2 AZs
      const subnets = ['subnet-1a', 'subnet-1b']
      const securityGroups = ['sg-efs']

      for (const subnetId of subnets) {
        const { mountTarget, logicalId: mtId } = FileSystem.createMountTarget(fsId, {
          slug: 'my-app',
          environment: 'production',
          subnetId,
          securityGroups,
        })
        template.addResource(mtId, mountTarget)
      }

      // Create access points for different applications
      const { accessPoint: ap1, logicalId: ap1Id } = FileSystem.createAccessPoint(fsId, {
        slug: 'my-app',
        environment: 'production',
        path: '/app1',
        uid: '1001',
        gid: '1001',
        permissions: '755',
      })
      template.addResource(ap1Id, ap1)

      const { accessPoint: ap2, logicalId: ap2Id } = FileSystem.createAccessPoint(fsId, {
        slug: 'my-app',
        environment: 'production',
        path: '/app2',
        uid: '1002',
        gid: '1002',
        permissions: '750',
      })
      template.addResource(ap2Id, ap2)

      const result = template.build()

      // FileSystem + 2 MountTargets + 2 AccessPoints = 5 resources
      expect(Object.keys(result.Resources)).toHaveLength(5)
      expect(result.Resources[fsId].Type).toBe('AWS::EFS::FileSystem')
      expect(result.Resources[fsId]!.Properties!.LifecyclePolicies).toHaveLength(2)
    })

    it('should create high-performance EFS for database workloads', () => {
      const template = new TemplateBuilder('High-Performance EFS')

      const { fileSystem, logicalId } = FileSystem.createFileSystem({
        slug: 'db-storage',
        environment: 'production',
        encrypted: true,
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789:key/abc',
        performanceMode: 'maxIO',
        throughputMode: 'provisioned',
        provisionedThroughput: 1024,
      })

      template.addResource(logicalId, fileSystem)

      const result = template.build()

      expect(result.Resources[logicalId]!.Properties!.PerformanceMode).toBe('maxIO')
      expect(result.Resources[logicalId]!.Properties!.ThroughputMode).toBe('provisioned')
      expect(result.Resources[logicalId]!.Properties!.ProvisionedThroughputInMibps).toBe(1024)
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('FileSystem Test')

      const { fileSystem, logicalId } = FileSystem.createFileSystem({
        slug: 'test',
        environment: 'development',
      })

      template.addResource(logicalId, fileSystem)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::EFS::FileSystem')
      expect(parsed.Resources[logicalId].Properties.Encrypted).toBe(true)
    })
  })
})
