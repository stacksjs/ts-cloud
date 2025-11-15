import type { CloudFormationResource } from './index'

export interface LambdaFunction extends CloudFormationResource {
  Type: 'AWS::Lambda::Function'
  Properties: {
    FunctionName?: string
    Runtime: string
    Role: string | { 'Fn::GetAtt': [string, string] }
    Handler: string
    Code: {
      S3Bucket?: string
      S3Key?: string
      ZipFile?: string
    }
    Timeout?: number
    MemorySize?: number
    Environment?: {
      Variables: Record<string, string>
    }
    VpcConfig?: {
      SecurityGroupIds: string[]
      SubnetIds: string[]
    }
    Layers?: string[]
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface LambdaPermission extends CloudFormationResource {
  Type: 'AWS::Lambda::Permission'
  Properties: {
    FunctionName: string | { Ref: string }
    Action: string
    Principal: string
    SourceArn?: string
    SourceAccount?: string
  }
}
