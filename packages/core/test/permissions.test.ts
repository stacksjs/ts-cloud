import { describe, expect, it } from 'bun:test'
import { Permissions } from '../src/modules/permissions'
import { TemplateBuilder } from '../src/template-builder'

describe('Permissions Module', () => {
  describe('createUser', () => {
    it('should create IAM user with default settings', () => {
      const { user, logicalId } = Permissions.createUser({
        slug: 'my-app',
        environment: 'production',
      })

      expect(user.Type).toBe('AWS::IAM::User')
      expect(user.Properties.UserName).toBeDefined()
      expect(user.Properties.Tags).toHaveLength(2)
      expect(logicalId).toBeDefined()
    })

    it('should support custom user name', () => {
      const { user } = Permissions.createUser({
        slug: 'my-app',
        environment: 'production',
        userName: 'john-doe',
      })

      expect(user.Properties.UserName).toBe('john-doe')
    })

    it('should support groups', () => {
      const { user } = Permissions.createUser({
        slug: 'my-app',
        environment: 'production',
        groups: ['Developers', 'Admins'],
      })

      expect(user.Properties.Groups).toEqual(['Developers', 'Admins'])
    })

    it('should support managed policy ARNs', () => {
      const { user } = Permissions.createUser({
        slug: 'my-app',
        environment: 'production',
        managedPolicyArns: [Permissions.ManagedPolicies.S3ReadOnlyAccess],
      })

      expect(user.Properties.ManagedPolicyArns).toContain(Permissions.ManagedPolicies.S3ReadOnlyAccess)
    })
  })

  describe('createRole', () => {
    it('should create IAM role with service principal', () => {
      const { role, logicalId } = Permissions.createRole({
        slug: 'my-app',
        environment: 'production',
        servicePrincipal: Permissions.ServicePrincipals.Lambda,
      })

      expect(role.Type).toBe('AWS::IAM::Role')
      expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service).toBe('lambda.amazonaws.com')
      expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Action).toBe('sts:AssumeRole')
      expect(logicalId).toBeDefined()
    })

    it('should support custom role name', () => {
      const { role } = Permissions.createRole({
        slug: 'my-app',
        environment: 'production',
        roleName: 'CustomRole',
        servicePrincipal: Permissions.ServicePrincipals.EC2,
      })

      expect(role.Properties.RoleName).toBe('CustomRole')
    })

    it('should support multiple service principals', () => {
      const { role } = Permissions.createRole({
        slug: 'my-app',
        environment: 'production',
        servicePrincipal: [Permissions.ServicePrincipals.Lambda, Permissions.ServicePrincipals.ECS],
      })

      expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service).toEqual([
        'lambda.amazonaws.com',
        'ecs.amazonaws.com',
      ])
    })

    it('should support AWS principals', () => {
      const { role } = Permissions.createRole({
        slug: 'my-app',
        environment: 'production',
        awsPrincipal: 'arn:aws:iam::123456789012:root',
      })

      expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal.AWS).toBe('arn:aws:iam::123456789012:root')
    })

    it('should support managed policy ARNs', () => {
      const { role } = Permissions.createRole({
        slug: 'my-app',
        environment: 'production',
        servicePrincipal: Permissions.ServicePrincipals.Lambda,
        managedPolicyArns: [
          Permissions.ManagedPolicies.LambdaBasicExecutionRole,
          Permissions.ManagedPolicies.S3ReadOnlyAccess,
        ],
      })

      expect(role.Properties.ManagedPolicyArns).toHaveLength(2)
      expect(role.Properties.ManagedPolicyArns).toContain(Permissions.ManagedPolicies.LambdaBasicExecutionRole)
    })
  })

  describe('createGroup', () => {
    it('should create IAM group', () => {
      const { group, logicalId } = Permissions.createGroup({
        slug: 'my-app',
        environment: 'production',
      })

      expect(group.Type).toBe('AWS::IAM::Group')
      expect(group.Properties.GroupName).toBeDefined()
      expect(logicalId).toBeDefined()
    })

    it('should support custom group name', () => {
      const { group } = Permissions.createGroup({
        slug: 'my-app',
        environment: 'production',
        groupName: 'Developers',
      })

      expect(group.Properties.GroupName).toBe('Developers')
    })

    it('should support managed policy ARNs', () => {
      const { group } = Permissions.createGroup({
        slug: 'my-app',
        environment: 'production',
        managedPolicyArns: [Permissions.ManagedPolicies.ReadOnlyAccess],
      })

      expect(group.Properties.ManagedPolicyArns).toContain(Permissions.ManagedPolicies.ReadOnlyAccess)
    })
  })

  describe('createPolicy', () => {
    it('should create managed policy', () => {
      const { policy, logicalId } = Permissions.createPolicy({
        slug: 'my-app',
        environment: 'production',
        statements: [
          {
            actions: ['s3:GetObject'],
            resources: ['arn:aws:s3:::my-bucket/*'],
          },
        ],
      })

      expect(policy.Type).toBe('AWS::IAM::ManagedPolicy')
      expect(policy.Properties.PolicyDocument.Statement).toHaveLength(1)
      expect(policy.Properties.PolicyDocument.Statement[0].Effect).toBe('Allow')
      expect(policy.Properties.PolicyDocument.Statement[0].Action).toEqual(['s3:GetObject'])
      expect(policy.Properties.PolicyDocument.Statement[0].Resource).toEqual(['arn:aws:s3:::my-bucket/*'])
      expect(logicalId).toBeDefined()
    })

    it('should support custom policy name', () => {
      const { policy } = Permissions.createPolicy({
        slug: 'my-app',
        environment: 'production',
        policyName: 'CustomPolicy',
        statements: [
          {
            actions: 's3:*',
            resources: '*',
          },
        ],
      })

      expect(policy.Properties.ManagedPolicyName).toBe('CustomPolicy')
    })

    it('should support description', () => {
      const { policy } = Permissions.createPolicy({
        slug: 'my-app',
        environment: 'production',
        description: 'Custom policy for S3 access',
        statements: [
          {
            actions: 's3:GetObject',
            resources: '*',
          },
        ],
      })

      expect(policy.Properties.Description).toBe('Custom policy for S3 access')
    })

    it('should support multiple statements', () => {
      const { policy } = Permissions.createPolicy({
        slug: 'my-app',
        environment: 'production',
        statements: [
          {
            sid: 'S3Access',
            actions: ['s3:GetObject', 's3:PutObject'],
            resources: ['arn:aws:s3:::my-bucket/*'],
          },
          {
            sid: 'DynamoDBAccess',
            actions: 'dynamodb:*',
            resources: 'arn:aws:dynamodb:*:*:table/MyTable',
          },
        ],
      })

      expect(policy.Properties.PolicyDocument.Statement).toHaveLength(2)
      expect(policy.Properties.PolicyDocument.Statement[0].Sid).toBe('S3Access')
      expect(policy.Properties.PolicyDocument.Statement[1].Sid).toBe('DynamoDBAccess')
    })

    it('should support deny effect', () => {
      const { policy } = Permissions.createPolicy({
        slug: 'my-app',
        environment: 'production',
        statements: [
          {
            effect: 'Deny',
            actions: 's3:DeleteBucket',
            resources: '*',
          },
        ],
      })

      expect(policy.Properties.PolicyDocument.Statement[0].Effect).toBe('Deny')
    })
  })

  describe('attachPolicyToRole', () => {
    it('should attach managed policy to role', () => {
      const { role } = Permissions.createRole({
        slug: 'my-app',
        environment: 'production',
        servicePrincipal: Permissions.ServicePrincipals.Lambda,
      })

      Permissions.attachPolicyToRole(role, Permissions.ManagedPolicies.S3FullAccess)

      expect(role.Properties.ManagedPolicyArns).toContain(Permissions.ManagedPolicies.S3FullAccess)
    })

    it('should not duplicate policies', () => {
      const { role } = Permissions.createRole({
        slug: 'my-app',
        environment: 'production',
        servicePrincipal: Permissions.ServicePrincipals.Lambda,
      })

      Permissions.attachPolicyToRole(role, Permissions.ManagedPolicies.S3FullAccess)
      Permissions.attachPolicyToRole(role, Permissions.ManagedPolicies.S3FullAccess)

      expect(role.Properties.ManagedPolicyArns).toHaveLength(1)
    })
  })

  describe('attachPolicyToUser', () => {
    it('should attach managed policy to user', () => {
      const { user } = Permissions.createUser({
        slug: 'my-app',
        environment: 'production',
      })

      Permissions.attachPolicyToUser(user, Permissions.ManagedPolicies.DynamoDBReadOnlyAccess)

      expect(user.Properties.ManagedPolicyArns).toContain(Permissions.ManagedPolicies.DynamoDBReadOnlyAccess)
    })
  })

  describe('attachPolicyToGroup', () => {
    it('should attach managed policy to group', () => {
      const { group } = Permissions.createGroup({
        slug: 'my-app',
        environment: 'production',
      })

      Permissions.attachPolicyToGroup(group, Permissions.ManagedPolicies.ReadOnlyAccess)

      expect(group.Properties.ManagedPolicyArns).toContain(Permissions.ManagedPolicies.ReadOnlyAccess)
    })
  })

  describe('addInlinePolicyToRole', () => {
    it('should add inline policy to role', () => {
      const { role } = Permissions.createRole({
        slug: 'my-app',
        environment: 'production',
        servicePrincipal: Permissions.ServicePrincipals.Lambda,
      })

      Permissions.addInlinePolicyToRole(role, 's3-access', [
        {
          actions: ['s3:GetObject', 's3:PutObject'],
          resources: ['arn:aws:s3:::my-bucket/*'],
        },
      ])

      expect(role.Properties.Policies).toHaveLength(1)
      expect(role.Properties.Policies![0].PolicyName).toBe('s3-access')
      expect(role.Properties.Policies![0].PolicyDocument.Statement[0].Action).toEqual(['s3:GetObject', 's3:PutObject'])
    })
  })

  describe('addInlinePolicyToUser', () => {
    it('should add inline policy to user', () => {
      const { user } = Permissions.createUser({
        slug: 'my-app',
        environment: 'production',
      })

      Permissions.addInlinePolicyToUser(user, 'dynamodb-access', [
        {
          actions: 'dynamodb:Query',
          resources: 'arn:aws:dynamodb:*:*:table/MyTable',
        },
      ])

      expect(user.Properties.Policies).toHaveLength(1)
      expect(user.Properties.Policies![0].PolicyName).toBe('dynamodb-access')
    })
  })

  describe('createAccessKey', () => {
    it('should create access key for user', () => {
      const { accessKey, logicalId } = Permissions.createAccessKey('user-id', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(accessKey.Type).toBe('AWS::IAM::AccessKey')
      expect(accessKey.Properties.Status).toBe('Active')
      expect(logicalId).toBeDefined()
    })

    it('should support inactive status', () => {
      const { accessKey } = Permissions.createAccessKey('user-id', {
        slug: 'my-app',
        environment: 'production',
        status: 'Inactive',
      })

      expect(accessKey.Properties.Status).toBe('Inactive')
    })
  })

  describe('createInstanceProfile', () => {
    it('should create instance profile', () => {
      const { instanceProfile, logicalId } = Permissions.createInstanceProfile('role-id', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(instanceProfile.Type).toBe('AWS::IAM::InstanceProfile')
      expect(instanceProfile.Properties.InstanceProfileName).toBeDefined()
      expect(logicalId).toBeDefined()
    })

    it('should support custom profile name', () => {
      const { instanceProfile } = Permissions.createInstanceProfile('role-id', {
        slug: 'my-app',
        environment: 'production',
        profileName: 'CustomProfile',
      })

      expect(instanceProfile.Properties.InstanceProfileName).toBe('CustomProfile')
    })
  })

  describe('ManagedPolicies', () => {
    it('should provide AWS managed policy ARNs', () => {
      expect(Permissions.ManagedPolicies.AdministratorAccess).toBe('arn:aws:iam::aws:policy/AdministratorAccess')
      expect(Permissions.ManagedPolicies.S3FullAccess).toBe('arn:aws:iam::aws:policy/AmazonS3FullAccess')
      expect(Permissions.ManagedPolicies.LambdaBasicExecutionRole).toBe('arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')
    })
  })

  describe('ServicePrincipals', () => {
    it('should provide service principal strings', () => {
      expect(Permissions.ServicePrincipals.Lambda).toBe('lambda.amazonaws.com')
      expect(Permissions.ServicePrincipals.EC2).toBe('ec2.amazonaws.com')
      expect(Permissions.ServicePrincipals.ECS).toBe('ecs.amazonaws.com')
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should create user with access key', () => {
      const template = new TemplateBuilder('IAM User')

      const { user, logicalId: userId } = Permissions.createUser({
        slug: 'my-app',
        environment: 'production',
        userName: 'developer',
      })

      const { accessKey, logicalId: keyId } = Permissions.createAccessKey(userId, {
        slug: 'my-app',
        environment: 'production',
      })

      template.addResource(userId, user)
      template.addResource(keyId, accessKey)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(2)
      expect(result.Resources[userId].Type).toBe('AWS::IAM::User')
      expect(result.Resources[keyId].Type).toBe('AWS::IAM::AccessKey')
    })

    it('should create Lambda execution role', () => {
      const template = new TemplateBuilder('Lambda Role')

      const { role, logicalId } = Permissions.createRole({
        slug: 'my-app',
        environment: 'production',
        servicePrincipal: Permissions.ServicePrincipals.Lambda,
        managedPolicyArns: [
          Permissions.ManagedPolicies.LambdaBasicExecutionRole,
          Permissions.ManagedPolicies.LambdaVPCAccessExecutionRole,
        ],
      })

      template.addResource(logicalId, role)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(1)
      expect(result.Resources[logicalId]!.Properties!.ManagedPolicyArns).toHaveLength(2)
    })

    it('should create custom policy and attach to role', () => {
      const template = new TemplateBuilder('Custom Policy')

      const { policy, logicalId: policyId } = Permissions.createPolicy({
        slug: 'my-app',
        environment: 'production',
        policyName: 'S3BucketAccess',
        statements: [
          {
            actions: ['s3:GetObject', 's3:PutObject'],
            resources: ['arn:aws:s3:::my-bucket/*'],
          },
        ],
      })

      const { role, logicalId: roleId } = Permissions.createRole({
        slug: 'my-app',
        environment: 'production',
        servicePrincipal: Permissions.ServicePrincipals.Lambda,
      })

      template.addResource(policyId, policy)
      template.addResource(roleId, role)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(2)
      expect(result.Resources[policyId].Type).toBe('AWS::IAM::ManagedPolicy')
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('Permissions Test')

      const { user, logicalId } = Permissions.createUser({
        slug: 'test',
        environment: 'development',
      })

      template.addResource(logicalId, user)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::IAM::User')
      expect(parsed.Resources[logicalId].Properties.UserName).toBeDefined()
    })
  })
})
