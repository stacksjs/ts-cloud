import type { CloudFormationResource } from './index'

export interface IAMRole extends CloudFormationResource {
  Type: 'AWS::IAM::Role'
  Properties: {
    RoleName?: string
    AssumeRolePolicyDocument: {
      Version: '2012-10-17'
      Statement: Array<{
        Effect: 'Allow' | 'Deny'
        Principal: {
          Service?: string | string[]
          AWS?: string | string[]
        }
        Action: string | string[]
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
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}
