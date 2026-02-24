/**
 * CloudFormation Intrinsic Functions Helpers
 */

export interface IntrinsicFunctions {
  Ref: (logicalName: string) => { Ref: string }
  GetAtt: (logicalName: string, attributeName: string) => { 'Fn::GetAtt': [string, string] }
  Sub: (template: string, variables?: Record<string, any>) => { 'Fn::Sub': string | [string, Record<string, any>] }
  Join: (delimiter: string, values: any[]) => { 'Fn::Join': [string, any[]] }
  Select: (index: number | string, list: any[]) => { 'Fn::Select': [number | string, any[]] }
  Split: (delimiter: string, source: string) => { 'Fn::Split': [string, string] }
  GetAZs: (region?: string) => { 'Fn::GetAZs': string }
  ImportValue: (name: string) => { 'Fn::ImportValue': string }
  If: (condition: string, trueValue: any, falseValue: any) => { 'Fn::If': [string, any, any] }
  Equals: (value1: any, value2: any) => { 'Fn::Equals': [any, any] }
  And: (...conditions: any[]) => { 'Fn::And': any[] }
  Or: (...conditions: any[]) => { 'Fn::Or': any[] }
  Not: (condition: any) => { 'Fn::Not': [any] }
  Base64: (input: string) => { 'Fn::Base64': string }
}

export const Fn: IntrinsicFunctions = {
  Ref: (logicalName: string) => ({ Ref: logicalName }),
  GetAtt: (logicalName: string, attributeName: string) => ({
    'Fn::GetAtt': [logicalName, attributeName] as [string, string],
  }),
  Sub: (template: string, variables?: Record<string, any>) => {
    if (variables) {
      return { 'Fn::Sub': [template, variables] as [string, Record<string, any>] }
    }
    return { 'Fn::Sub': template }
  },
  Join: (delimiter: string, values: any[]) => ({
    'Fn::Join': [delimiter, values] as [string, any[]],
  }),
  Select: (index: number | string, list: any[]) => ({
    'Fn::Select': [index, list] as [number | string, any[]],
  }),
  Split: (delimiter: string, source: string) => ({
    'Fn::Split': [delimiter, source] as [string, string],
  }),
  GetAZs: (region: string = '') => ({
    'Fn::GetAZs': region,
  }),
  ImportValue: (name: string) => ({
    'Fn::ImportValue': name,
  }),
  If: (condition: string, trueValue: any, falseValue: any) => ({
    'Fn::If': [condition, trueValue, falseValue] as [string, any, any],
  }),
  Equals: (value1: any, value2: any) => ({
    'Fn::Equals': [value1, value2] as [any, any],
  }),
  And: (...conditions: any[]) => ({
    'Fn::And': conditions,
  }),
  Or: (...conditions: any[]) => ({
    'Fn::Or': conditions,
  }),
  Not: (condition: any) => ({
    'Fn::Not': [condition] as [any],
  }),
  Base64: (input: string) => ({
    'Fn::Base64': input,
  }),
}

/**
 * Pseudo Parameters - AWS CloudFormation provides several built-in parameters
 */
export const Pseudo = {
  AccountId: { Ref: 'AWS::AccountId' } as const,
  Region: { Ref: 'AWS::Region' } as const,
  StackId: { Ref: 'AWS::StackId' } as const,
  StackName: { Ref: 'AWS::StackName' } as const,
  NotificationARNs: { Ref: 'AWS::NotificationARNs' } as const,
  Partition: { Ref: 'AWS::Partition' } as const,
  URLSuffix: { Ref: 'AWS::URLSuffix' } as const,
  NoValue: { Ref: 'AWS::NoValue' } as const,
} as const
