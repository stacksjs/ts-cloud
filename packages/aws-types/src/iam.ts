import type { CloudFormationResource } from './index'

export interface IAMRole extends CloudFormationResource {
  Type: 'AWS::IAM::Role'
  Properties: {
    RoleName?: string
    MaxSessionDuration?: number
    AssumeRolePolicyDocument: {
      Version: '2012-10-17'
      Statement: Array<{
        Effect: 'Allow' | 'Deny'
        Principal: {
          Service?: string | string[]
          AWS?: string | string[]
          Federated?: string | string[]
        }
        Action: string | string[]
        Condition?: Record<string, unknown>
      }>
    }
    ManagedPolicyArns?: string[]
    Policies?: Array<{
      PolicyName: string
      PolicyDocument: {
        Version: '2012-10-17'
        Statement: Array<{
          Effect: 'Allow' | 'Deny'
          Action: string | string[]
          Resource: string | string[]
        }>
      }
    }>
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface IAMPolicy extends CloudFormationResource {
  Type: 'AWS::IAM::Policy'
  Properties: {
    PolicyName: string
    PolicyDocument: {
      Version: '2012-10-17'
      Statement: Array<{
        Sid?: string
        Effect: 'Allow' | 'Deny'
        Action: string | string[]
        Resource: string | string[]
        Condition?: Record<string, unknown>
      }>
    }
    Roles?: string[]
    Users?: string[]
    Groups?: string[]
  }
}

export interface IAMUser extends CloudFormationResource {
  Type: 'AWS::IAM::User'
  Properties: {
    UserName?: string
    ManagedPolicyArns?: string[]
    Groups?: string[]
    Policies?: Array<{
      PolicyName: string
      PolicyDocument: {
        Version: '2012-10-17'
        Statement: Array<{
          Effect: 'Allow' | 'Deny'
          Action: string | string[]
          Resource: string | string[]
        }>
      }
    }>
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface IAMManagedPolicy extends CloudFormationResource {
  Type: 'AWS::IAM::ManagedPolicy'
  Properties: {
    ManagedPolicyName?: string
    Description?: string
    Path?: string
    PolicyDocument: {
      Version: '2012-10-17'
      Statement: Array<{
        Sid?: string
        Effect: 'Allow' | 'Deny'
        Action: string | string[]
        Resource: string | string[]
        Condition?: Record<string, unknown>
      }>
    }
    Roles?: Array<string | { Ref: string }>
    Users?: Array<string | { Ref: string }>
    Groups?: Array<string | { Ref: string }>
  }
}

export interface IAMGroup extends CloudFormationResource {
  Type: 'AWS::IAM::Group'
  Properties: {
    GroupName?: string
    ManagedPolicyArns?: string[]
    Policies?: Array<{
      PolicyName: string
      PolicyDocument: {
        Version: '2012-10-17'
        Statement: Array<{
          Effect: 'Allow' | 'Deny'
          Action: string | string[]
          Resource: string | string[]
        }>
      }
    }>
    Path?: string
  }
}

export interface IAMAccessKey extends CloudFormationResource {
  Type: 'AWS::IAM::AccessKey'
  Properties: {
    UserName: string | { Ref: string }
    Status?: 'Active' | 'Inactive'
    Serial?: number
  }
}

export interface IAMInstanceProfile extends CloudFormationResource {
  Type: 'AWS::IAM::InstanceProfile'
  Properties: {
    InstanceProfileName?: string
    Path?: string
    Roles: Array<string | { Ref: string }>
  }
}
