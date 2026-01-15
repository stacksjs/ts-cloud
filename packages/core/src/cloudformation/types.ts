/**
 * CloudFormation Template Types
 * Based on AWS CloudFormation Resource Specification
 */

export interface CloudFormationTemplate {
  AWSTemplateFormatVersion: '2010-09-09'
  Description?: string
  Metadata?: Record<string, any>
  Parameters?: Record<string, CloudFormationParameter>
  Mappings?: Record<string, Record<string, Record<string, string>>>
  Conditions?: Record<string, CloudFormationCondition>
  Resources: Record<string, CloudFormationResource>
  Outputs?: Record<string, CloudFormationOutput>
}

export interface CloudFormationParameter {
  Type: 'String' | 'Number' | 'List<Number>' | 'CommaDelimitedList' | 'AWS::EC2::AvailabilityZone::Name' | 'AWS::EC2::Image::Id' | 'AWS::EC2::Instance::Id' | 'AWS::EC2::KeyPair::KeyName' | 'AWS::EC2::SecurityGroup::GroupName' | 'AWS::EC2::SecurityGroup::Id' | 'AWS::EC2::Subnet::Id' | 'AWS::EC2::Volume::Id' | 'AWS::EC2::VPC::Id' | 'AWS::Route53::HostedZone::Id' | 'List<AWS::EC2::AvailabilityZone::Name>' | 'List<AWS::EC2::Image::Id>' | 'List<AWS::EC2::Instance::Id>' | 'List<AWS::EC2::SecurityGroup::GroupName>' | 'List<AWS::EC2::SecurityGroup::Id>' | 'List<AWS::EC2::Subnet::Id>' | 'List<AWS::EC2::Volume::Id>' | 'List<AWS::EC2::VPC::Id>' | 'List<AWS::Route53::HostedZone::Id>'
  Default?: string | number
  Description?: string
  AllowedValues?: string[]
  AllowedPattern?: string
  MinLength?: number
  MaxLength?: number
  MinValue?: number
  MaxValue?: number
  ConstraintDescription?: string
  NoEcho?: boolean
}

export interface CloudFormationResource {
  Type: string
  Properties?: Record<string, any>
  DependsOn?: string | string[]
  Condition?: string
  Metadata?: Record<string, any>
  CreationPolicy?: Record<string, any>
  UpdatePolicy?: Record<string, any>
  DeletionPolicy?: 'Delete' | 'Retain' | 'Snapshot'
  UpdateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot'
}

export interface CloudFormationOutput {
  Value: any
  Description?: string
  Export?: {
    Name: any
  }
  Condition?: string
}

export type CloudFormationCondition =
  | CloudFormationIntrinsicFunction
  | boolean

/**
 * CloudFormation Intrinsic Functions
 */
export type CloudFormationIntrinsicFunction =
  | { Ref: string }
  | { 'Fn::GetAtt': [string, string] }
  | { 'Fn::Join': [string, any[]] }
  | { 'Fn::Sub': string | [string, Record<string, any>] }
  | { 'Fn::Select': [number, any[] | CloudFormationIntrinsicFunction] }
  | { 'Fn::Split': [string, string] }
  | { 'Fn::GetAZs': string }
  | { 'Fn::ImportValue': any }
  | { 'Fn::FindInMap': [string, any, any] }
  | { 'Fn::Base64': any }
  | { 'Fn::Cidr': [any, number, number] }
  | { 'Fn::Equals': [any, any] }
  | { 'Fn::If': [string, any, any] }
  | { 'Fn::Not': [any] }
  | { 'Fn::And': any[] }
  | { 'Fn::Or': any[] }

/**
 * Helper functions for creating CloudFormation intrinsic functions
 */
export const Fn = {
  ref: (logicalId: string) => ({ Ref: logicalId }),

  getAtt: (logicalId: string, attribute: string) => ({ 'Fn::GetAtt': [logicalId, attribute] }),

  join: (delimiter: string, values: any[]) => ({ 'Fn::Join': [delimiter, values] }),

  sub: (template: string, variables?: Record<string, any>) =>
    variables ? { 'Fn::Sub': [template, variables] } : { 'Fn::Sub': template },

  select: (index: number, list: any[] | CloudFormationIntrinsicFunction) => ({ 'Fn::Select': [index, list] }),

  split: (delimiter: string, source: string) => ({ 'Fn::Split': [delimiter, source] }),

  getAZs: (region: string = '') => ({ 'Fn::GetAZs': region }),

  importValue: (name: any) => ({ 'Fn::ImportValue': name }),

  findInMap: (mapName: string, topLevelKey: any, secondLevelKey: any) =>
    ({ 'Fn::FindInMap': [mapName, topLevelKey, secondLevelKey] }),

  base64: (value: any) => ({ 'Fn::Base64': value }),

  cidr: (ipBlock: any, count: number, cidrBits: number): { 'Fn::Cidr': [any, number, number] } =>
    ({ 'Fn::Cidr': [ipBlock, count, cidrBits] }),

  equals: (value1: any, value2: any): { 'Fn::Equals': [any, any] } => ({ 'Fn::Equals': [value1, value2] }),

  if: (conditionName: string, trueValue: any, falseValue: any): { 'Fn::If': [string, any, any] } =>
    ({ 'Fn::If': [conditionName, trueValue, falseValue] }),

  not: (condition: any): { 'Fn::Not': [any] } => ({ 'Fn::Not': [condition] }),

  and: (...conditions: any[]) => ({ 'Fn::And': conditions }),

  or: (...conditions: any[]) => ({ 'Fn::Or': conditions }),
}

/**
 * Common AWS resource ARN patterns
 */
export const Arn = {
  s3Bucket: (bucketName: any) =>
    Fn.sub(`arn:aws:s3:::${bucketName}`),

  s3Object: (bucketName: any, key: string = '*') =>
    Fn.sub(`arn:aws:s3:::${bucketName}/${key}`),

  lambda: (functionName: string, region?: string, account?: string) =>
    Fn.sub(
      `arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${functionName}`,
      region && account ? { 'AWS::Region': region, 'AWS::AccountId': account } : undefined,
    ),

  dynamodb: (tableName: string) =>
    Fn.sub(`arn:aws:dynamodb:\${AWS::Region}:\${AWS::AccountId}:table/${tableName}`),

  sqs: (queueName: string) =>
    Fn.sub(`arn:aws:sqs:\${AWS::Region}:\${AWS::AccountId}:${queueName}`),

  sns: (topicName: string) =>
    Fn.sub(`arn:aws:sns:\${AWS::Region}:\${AWS::AccountId}:${topicName}`),

  kinesis: (streamName: string) =>
    Fn.sub(`arn:aws:kinesis:\${AWS::Region}:\${AWS::AccountId}:stream/${streamName}`),

  iam: (resourceType: 'role' | 'policy' | 'user' | 'group', name: string) =>
    Fn.sub(`arn:aws:iam::\${AWS::AccountId}:${resourceType}/${name}`),

  secretsManager: (secretName: string) =>
    Fn.sub(`arn:aws:secretsmanager:\${AWS::Region}:\${AWS::AccountId}:secret:${secretName}`),

  cloudwatch: (logGroup: string) =>
    Fn.sub(`arn:aws:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:${logGroup}`),
}

/**
 * Common CloudFormation pseudo parameters
 */
export const AWS_PSEUDO_PARAMETERS = {
  ACCOUNT_ID: { Ref: 'AWS::AccountId' },
  NOTIFICATION_ARNS: { Ref: 'AWS::NotificationARNs' },
  NO_VALUE: { Ref: 'AWS::NoValue' },
  PARTITION: { Ref: 'AWS::Partition' },
  REGION: { Ref: 'AWS::Region' },
  STACK_ID: { Ref: 'AWS::StackId' },
  STACK_NAME: { Ref: 'AWS::StackName' },
  URL_SUFFIX: { Ref: 'AWS::URLSuffix' },
}
