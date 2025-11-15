import type { CloudFormationResource } from './index'

export interface ECRRepository extends CloudFormationResource {
  Type: 'AWS::ECR::Repository'
  Properties?: {
    RepositoryName?: string
    ImageTagMutability?: 'MUTABLE' | 'IMMUTABLE'
    ImageScanningConfiguration?: {
      ScanOnPush?: boolean
    }
    EncryptionConfiguration?: {
      EncryptionType: 'AES256' | 'KMS'
      KmsKey?: string
    }
    LifecyclePolicy?: {
      LifecyclePolicyText?: string
      RegistryId?: string
    }
    RepositoryPolicyText?: {
      Version: string
      Statement: Array<{
        Sid?: string
        Effect: 'Allow' | 'Deny'
        Principal: '*' | { AWS: string | string[] } | { Service: string | string[] }
        Action: string | string[]
        Condition?: Record<string, any>
      }>
    }
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface ECRLifecyclePolicy {
  rules: Array<{
    rulePriority: number
    description?: string
    selection: {
      tagStatus: 'tagged' | 'untagged' | 'any'
      tagPrefixList?: string[]
      countType: 'imageCountMoreThan' | 'sinceImagePushed'
      countNumber: number
      countUnit?: 'days'
    }
    action: {
      type: 'expire'
    }
  }>
}

export interface ECRReplicationConfiguration extends CloudFormationResource {
  Type: 'AWS::ECR::ReplicationConfiguration'
  Properties: {
    ReplicationConfiguration: {
      Rules: Array<{
        Destinations: Array<{
          Region: string
          RegistryId: string
        }>
        RepositoryFilters?: Array<{
          Filter: string
          FilterType: 'PREFIX_MATCH'
        }>
      }>
    }
  }
}

export interface ECRRegistryPolicy extends CloudFormationResource {
  Type: 'AWS::ECR::RegistryPolicy'
  Properties: {
    PolicyText: {
      Version: string
      Statement: Array<{
        Sid?: string
        Effect: 'Allow' | 'Deny'
        Principal: '*' | { AWS: string | string[] }
        Action: string | string[]
        Resource?: string | string[]
      }>
    }
  }
}

export interface ECRPullThroughCacheRule extends CloudFormationResource {
  Type: 'AWS::ECR::PullThroughCacheRule'
  Properties: {
    EcrRepositoryPrefix?: string
    UpstreamRegistryUrl?: string
  }
}

export interface ECRPublicRepository extends CloudFormationResource {
  Type: 'AWS::ECR::PublicRepository'
  Properties?: {
    RepositoryName?: string
    RepositoryCatalogData?: {
      UsageText?: string
      AboutText?: string
      OperatingSystems?: string[]
      Architectures?: string[]
      RepositoryDescription?: string
    }
    RepositoryPolicyText?: {
      Version: string
      Statement: Array<{
        Sid?: string
        Effect: 'Allow' | 'Deny'
        Principal: '*' | { AWS: string | string[] }
        Action: string | string[]
      }>
    }
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}
