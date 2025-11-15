import type { CloudFormationResource } from './index'

export interface KMSKey extends CloudFormationResource {
  Type: 'AWS::KMS::Key'
  Properties: {
    Description?: string
    Enabled?: boolean
    EnableKeyRotation?: boolean
    KeyPolicy: {
      Version: '2012-10-17'
      Statement: Array<{
        Sid?: string
        Effect: 'Allow' | 'Deny'
        Principal: unknown
        Action: string | string[]
        Resource: string | string[]
      }>
    }
    KeySpec?: 'SYMMETRIC_DEFAULT' | 'RSA_2048' | 'RSA_3072' | 'RSA_4096' | 'ECC_NIST_P256' | 'ECC_NIST_P384' | 'ECC_NIST_P521' | 'ECC_SECG_P256K1'
    KeyUsage?: 'ENCRYPT_DECRYPT' | 'SIGN_VERIFY'
    MultiRegion?: boolean
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface KMSAlias extends CloudFormationResource {
  Type: 'AWS::KMS::Alias'
  Properties: {
    AliasName: string
    TargetKeyId: string | { Ref: string }
  }
}
