import { describe, expect, it } from 'bun:test'
import { Storage } from '../src/modules/storage'
import { TemplateBuilder } from '../src/template-builder'

describe('Storage Module', () => {
  describe('createBucket', () => {
    it('should create a basic private bucket', () => {
      const { bucket, logicalId } = Storage.createBucket({
        name: 'test',
        slug: 'my-app',
        environment: 'production',
      })

      expect(bucket.Type).toBe('AWS::S3::Bucket')
      expect(bucket.Properties?.BucketName).toBe('my-app-production-s3-test')
      expect(logicalId).toBe('MyAppProductionS3Test')
      expect(bucket.Properties?.PublicAccessBlockConfiguration).toBeDefined()
      expect(bucket.Properties?.BucketEncryption).toBeDefined()
    })

    it('should create a public bucket with policy', () => {
      const { bucket, bucketPolicy, logicalId } = Storage.createBucket({
        name: 'website',
        slug: 'my-app',
        environment: 'production',
        public: true,
      })

      expect(bucket.Properties?.PublicAccessBlockConfiguration).toBeUndefined()
      expect(bucketPolicy).toBeDefined()
      expect(bucketPolicy?.Type).toBe('AWS::S3::BucketPolicy')
      expect(bucketPolicy?.Properties.PolicyDocument.Statement[0].Effect).toBe('Allow')
      expect(bucketPolicy?.Properties.PolicyDocument.Statement[0].Action).toContain('s3:GetObject')
    })

    it('should enable versioning when specified', () => {
      const { bucket } = Storage.createBucket({
        name: 'versioned',
        slug: 'my-app',
        environment: 'production',
        versioning: true,
      })

      expect(bucket.Properties?.VersioningConfiguration?.Status).toBe('Enabled')
    })

    it('should enable website hosting when specified', () => {
      const { bucket } = Storage.createBucket({
        name: 'website',
        slug: 'my-app',
        environment: 'production',
        website: true,
      })

      expect(bucket.Properties?.WebsiteConfiguration).toBeDefined()
      expect(bucket.Properties?.WebsiteConfiguration?.IndexDocument).toBe('index.html')
      expect(bucket.Properties?.WebsiteConfiguration?.ErrorDocument).toBe('error.html')
    })

    it('should configure CORS rules', () => {
      const { bucket } = Storage.createBucket({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
        cors: [
          {
            allowedOrigins: ['https://example.com'],
            allowedMethods: ['GET', 'POST'],
            allowedHeaders: ['*'],
            maxAge: 3600,
          },
        ],
      })

      expect(bucket.Properties?.CorsConfiguration?.CorsRules).toHaveLength(1)
      expect(bucket.Properties?.CorsConfiguration?.CorsRules[0].AllowedOrigins).toContain('https://example.com')
    })

    it('should configure lifecycle rules', () => {
      const { bucket } = Storage.createBucket({
        name: 'logs',
        slug: 'my-app',
        environment: 'production',
        lifecycleRules: [
          {
            id: 'DeleteOldLogs',
            enabled: true,
            expirationDays: 30,
          },
        ],
      })

      expect(bucket.Properties?.LifecycleConfiguration?.Rules).toHaveLength(1)
      expect(bucket.Properties?.LifecycleConfiguration?.Rules[0].ExpirationInDays).toBe(30)
      expect(bucket.Properties?.LifecycleConfiguration?.Rules[0].Status).toBe('Enabled')
    })
  })

  describe('enableVersioning', () => {
    it('should enable versioning on existing bucket', () => {
      const { bucket } = Storage.createBucket({
        name: 'test',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Storage.enableVersioning(bucket)

      expect(updated.Properties?.VersioningConfiguration?.Status).toBe('Enabled')
    })
  })

  describe('enableWebsiteHosting', () => {
    it('should enable website hosting with default documents', () => {
      const { bucket } = Storage.createBucket({
        name: 'test',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Storage.enableWebsiteHosting(bucket)

      expect(updated.Properties?.WebsiteConfiguration?.IndexDocument).toBe('index.html')
      expect(updated.Properties?.WebsiteConfiguration?.ErrorDocument).toBe('error.html')
    })

    it('should enable website hosting with custom documents', () => {
      const { bucket } = Storage.createBucket({
        name: 'test',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Storage.enableWebsiteHosting(bucket, 'main.html', '404.html')

      expect(updated.Properties?.WebsiteConfiguration?.IndexDocument).toBe('main.html')
      expect(updated.Properties?.WebsiteConfiguration?.ErrorDocument).toBe('404.html')
    })
  })

  describe('addLambdaNotification', () => {
    it('should add Lambda notification for object creation', () => {
      const { bucket } = Storage.createBucket({
        name: 'uploads',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Storage.addLambdaNotification(bucket, {
        functionArn: 'arn:aws:lambda:us-east-1:123456789:function:ProcessUpload',
        events: ['s3:ObjectCreated:*'],
      })

      expect(updated.Properties?.NotificationConfiguration).toBeDefined()
      expect(updated.Properties?.NotificationConfiguration?.LambdaConfigurations).toHaveLength(1)
      expect(updated.Properties?.NotificationConfiguration?.LambdaConfigurations?.[0].Event).toBe('s3:ObjectCreated:*')
      expect(updated.Properties?.NotificationConfiguration?.LambdaConfigurations?.[0].Function).toBe('arn:aws:lambda:us-east-1:123456789:function:ProcessUpload')
    })

    it('should add Lambda notification with prefix filter', () => {
      const { bucket } = Storage.createBucket({
        name: 'uploads',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Storage.addLambdaNotification(bucket, {
        functionArn: 'arn:aws:lambda:us-east-1:123456789:function:ProcessImage',
        events: ['s3:ObjectCreated:Put'],
        filter: {
          prefix: 'images/',
        },
      })

      const config = updated.Properties?.NotificationConfiguration?.LambdaConfigurations?.[0]
      expect(config?.Filter).toBeDefined()
      expect(config?.Filter?.S3Key?.Rules).toContainEqual({ Name: 'prefix', Value: 'images/' })
    })

    it('should add Lambda notification with suffix filter', () => {
      const { bucket } = Storage.createBucket({
        name: 'uploads',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Storage.addLambdaNotification(bucket, {
        functionArn: 'arn:aws:lambda:us-east-1:123456789:function:ProcessPDF',
        events: ['s3:ObjectCreated:*'],
        filter: {
          suffix: '.pdf',
        },
      })

      const config = updated.Properties?.NotificationConfiguration?.LambdaConfigurations?.[0]
      expect(config?.Filter).toBeDefined()
      expect(config?.Filter?.S3Key?.Rules).toContainEqual({ Name: 'suffix', Value: '.pdf' })
    })

    it('should add Lambda notification with both prefix and suffix filters', () => {
      const { bucket } = Storage.createBucket({
        name: 'uploads',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Storage.addLambdaNotification(bucket, {
        functionArn: 'arn:aws:lambda:us-east-1:123456789:function:ProcessDoc',
        events: ['s3:ObjectCreated:*'],
        filter: {
          prefix: 'documents/',
          suffix: '.docx',
        },
      })

      const config = updated.Properties?.NotificationConfiguration?.LambdaConfigurations?.[0]
      expect(config?.Filter?.S3Key?.Rules).toHaveLength(2)
      expect(config?.Filter?.S3Key?.Rules).toContainEqual({ Name: 'prefix', Value: 'documents/' })
      expect(config?.Filter?.S3Key?.Rules).toContainEqual({ Name: 'suffix', Value: '.docx' })
    })

    it('should add multiple Lambda notifications for multiple events', () => {
      const { bucket } = Storage.createBucket({
        name: 'monitored',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Storage.addLambdaNotification(bucket, {
        functionArn: 'arn:aws:lambda:us-east-1:123456789:function:Monitor',
        events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'],
      })

      expect(updated.Properties?.NotificationConfiguration?.LambdaConfigurations).toHaveLength(2)
      expect(updated.Properties?.NotificationConfiguration?.LambdaConfigurations?.[0].Event).toBe('s3:ObjectCreated:*')
      expect(updated.Properties?.NotificationConfiguration?.LambdaConfigurations?.[1].Event).toBe('s3:ObjectRemoved:*')
    })

    it('should support Fn::GetAtt for Lambda ARN', () => {
      const { bucket } = Storage.createBucket({
        name: 'uploads',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Storage.addLambdaNotification(bucket, {
        functionArn: { 'Fn::GetAtt': ['ProcessorFunction', 'Arn'] },
        events: ['s3:ObjectCreated:*'],
      })

      expect(updated.Properties?.NotificationConfiguration?.LambdaConfigurations?.[0].Function).toEqual({
        'Fn::GetAtt': ['ProcessorFunction', 'Arn'],
      })
    })
  })

  describe('Storage.Notifications helpers', () => {
    it('should create onObjectCreated notification config', () => {
      const config = Storage.Notifications.onObjectCreated('arn:aws:lambda:us-east-1:123456789:function:OnCreate')

      expect(config.functionArn).toBe('arn:aws:lambda:us-east-1:123456789:function:OnCreate')
      expect(config.events).toContain('s3:ObjectCreated:*')
    })

    it('should create onObjectRemoved notification config', () => {
      const config = Storage.Notifications.onObjectRemoved('arn:aws:lambda:us-east-1:123456789:function:OnDelete')

      expect(config.functionArn).toBe('arn:aws:lambda:us-east-1:123456789:function:OnDelete')
      expect(config.events).toContain('s3:ObjectRemoved:*')
    })

    it('should create onImageUpload notification config', () => {
      const config = Storage.Notifications.onImageUpload('arn:aws:lambda:us-east-1:123456789:function:ProcessImage', 'uploads/')

      expect(config.functionArn).toBe('arn:aws:lambda:us-east-1:123456789:function:ProcessImage')
      expect(config.events).toContain('s3:ObjectCreated:*')
      expect(config.filter?.prefix).toBe('uploads/')
      expect(config.filter?.suffix).toBe('.jpg')
    })

    it('should create onFileType notification config', () => {
      const config = Storage.Notifications.onFileType(
        'arn:aws:lambda:us-east-1:123456789:function:ProcessPDF',
        '.pdf',
        'documents/',
      )

      expect(config.functionArn).toBe('arn:aws:lambda:us-east-1:123456789:function:ProcessPDF')
      expect(config.events).toContain('s3:ObjectCreated:*')
      expect(config.filter?.prefix).toBe('documents/')
      expect(config.filter?.suffix).toBe('.pdf')
    })

    it('should create onFolderUpload notification config', () => {
      const config = Storage.Notifications.onFolderUpload('arn:aws:lambda:us-east-1:123456789:function:ProcessFolder', 'uploads')

      expect(config.functionArn).toBe('arn:aws:lambda:us-east-1:123456789:function:ProcessFolder')
      expect(config.events).toContain('s3:ObjectCreated:*')
      expect(config.filter?.prefix).toBe('uploads/')
    })

    it('should handle folder paths with trailing slash', () => {
      const config = Storage.Notifications.onFolderUpload('arn:aws:lambda:us-east-1:123456789:function:Process', 'uploads/')

      expect(config.filter?.prefix).toBe('uploads/')
    })

    it('should work with Fn::GetAtt in helper methods', () => {
      const config = Storage.Notifications.onObjectCreated({ 'Fn::GetAtt': ['MyFunction', 'Arn'] })

      expect(config.functionArn).toEqual({ 'Fn::GetAtt': ['MyFunction', 'Arn'] })
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should integrate with CloudFormation template', () => {
      const template = new TemplateBuilder('Test Infrastructure')

      const { bucket, bucketPolicy, logicalId } = Storage.createBucket({
        name: 'website',
        slug: 'my-app',
        environment: 'production',
        public: true,
        website: true,
        versioning: true,
      })

      template.addResource(logicalId, bucket)

      if (bucketPolicy) {
        template.addResource(`${logicalId}Policy`, bucketPolicy)
      }

      const result = template.build()

      expect(result.Resources[logicalId]).toBeDefined()
      expect(result.Resources[`${logicalId}Policy`]).toBeDefined()
      expect(result.AWSTemplateFormatVersion).toBe('2010-09-09')
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('Test S3')

      const { bucket, logicalId } = Storage.createBucket({
        name: 'data',
        slug: 'test',
        environment: 'development',
        encryption: true,
      })

      template.addResource(logicalId, bucket)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::S3::Bucket')
      expect(parsed.Resources[logicalId].Properties.BucketEncryption).toBeDefined()
    })
  })

  describe('createBackupPlan', () => {
    it('should create a backup plan with vault, plan, selection, and role', () => {
      const { bucket: bucket1, logicalId: bucketId1 } = Storage.createBucket({
        name: 'data1',
        slug: 'my-app',
        environment: 'production',
      })

      const { bucket: bucket2, logicalId: bucketId2 } = Storage.createBucket({
        name: 'data2',
        slug: 'my-app',
        environment: 'production',
      })

      const { vault, plan, selection, role, vaultLogicalId, planLogicalId, selectionLogicalId, roleLogicalId }
        = Storage.createBackupPlan({
          name: 's3-backup',
          slug: 'my-app',
          environment: 'production',
          bucketLogicalIds: [bucketId1, bucketId2],
          retentionDays: 30,
        })

      expect(vault.Type).toBe('AWS::Backup::BackupVault')
      expect(vault.Properties.BackupVaultName).toBe('my-app-production-backup-vault-s3-backup')
      expect(vaultLogicalId).toBe('MyAppProductionBackupVaultS3Backup')

      expect(plan.Type).toBe('AWS::Backup::BackupPlan')
      expect(plan.Properties.BackupPlan.BackupPlanName).toBe('my-app-production-backup-plan-s3-backup')
      expect(plan.Properties.BackupPlan.BackupPlanRule).toHaveLength(1)
      expect(plan.Properties.BackupPlan.BackupPlanRule[0].ScheduleExpression).toBe('cron(0 5 * * ? *)')
      expect(plan.Properties.BackupPlan.BackupPlanRule[0].Lifecycle.DeleteAfterDays).toBe(30)
      expect(planLogicalId).toBe('MyAppProductionBackupPlanS3Backup')

      expect(selection.Type).toBe('AWS::Backup::BackupSelection')
      expect(selection.Properties.BackupSelection.Resources).toHaveLength(2)
      expect(selectionLogicalId).toBe('MyAppProductionBackupSelectionS3Backup')

      expect(role.Type).toBe('AWS::IAM::Role')
      expect(role.Properties.ManagedPolicyArns).toContain('arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup')
      expect(role.Properties.ManagedPolicyArns).toContain('arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores')
      expect(roleLogicalId).toBe('MyAppProductionBackupRoleS3Backup')
    })

    it('should create backup plan with custom schedule', () => {
      const { bucket, logicalId } = Storage.createBucket({
        name: 'data',
        slug: 'my-app',
        environment: 'production',
      })

      const { plan } = Storage.createBackupPlan({
        name: 'hourly-backup',
        slug: 'my-app',
        environment: 'production',
        bucketLogicalIds: [logicalId],
        retentionDays: 7,
        schedule: Storage.BackupSchedules.HOURLY,
      })

      expect(plan.Properties.BackupPlan.BackupPlanRule[0].ScheduleExpression).toBe('cron(0 * * * ? *)')
    })

    it('should create backup plan with cold storage transition', () => {
      const { bucket, logicalId } = Storage.createBucket({
        name: 'data',
        slug: 'my-app',
        environment: 'production',
      })

      const { plan } = Storage.createBackupPlan({
        name: 'cold-storage',
        slug: 'my-app',
        environment: 'production',
        bucketLogicalIds: [logicalId],
        retentionDays: 90,
        moveToColdStorageAfterDays: 30,
      })

      expect(plan.Properties.BackupPlan.BackupPlanRule[0].Lifecycle.DeleteAfterDays).toBe(90)
      expect(plan.Properties.BackupPlan.BackupPlanRule[0].Lifecycle.MoveToColdStorageAfterDays).toBe(30)
    })

    it('should create backup plan with continuous backup enabled', () => {
      const { bucket, logicalId } = Storage.createBucket({
        name: 'data',
        slug: 'my-app',
        environment: 'production',
      })

      const { plan } = Storage.createBackupPlan({
        name: 'continuous',
        slug: 'my-app',
        environment: 'production',
        bucketLogicalIds: [logicalId],
        retentionDays: 7,
        enableContinuousBackup: true,
      })

      expect(plan.Properties.BackupPlan.BackupPlanRule[0].EnableContinuousBackup).toBe(true)
    })
  })
})
