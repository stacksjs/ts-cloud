/**
 * CloudFormation Intrinsic Functions Helpers
*/

export const Fn = {
  /**
   * Ref - Returns the value of the specified parameter or resource
  */
  Ref: (logicalName: string): { Ref: string } => ({ Ref: logicalName }),

  /**
   * GetAtt - Returns the value of an attribute from a resource
  */
  GetAtt: (logicalName: string, attributeName: string): { 'Fn::GetAtt': [string, string] } => ({
    'Fn::GetAtt': [logicalName, attributeName] as [string, string],
  }),

  /**
   * Sub - Substitutes variables in an input string with values
  */
  Sub: (template: string, variables?: Record<string, any>): { 'Fn::Sub': string | [string, Record<string, any>] } => {
    if (variables) {
      return { 'Fn::Sub': [template, variables] as [string, Record<string, any>] }
    }
    return { 'Fn::Sub': template }
  },

  /**
   * Join - Appends a set of values into a single value, separated by delimiter
  */
  Join: (delimiter: string, values: any[]): { 'Fn::Join': [string, any[]] } => ({
    'Fn::Join': [delimiter, values] as [string, any[]],
  }),

  /**
   * Select - Returns a single object from a list of objects by index
  */
  Select: (index: number | string, list: any[]): { 'Fn::Select': [number | string, any[]] } => ({
    'Fn::Select': [index, list] as [number | string, any[]],
  }),

  /**
   * Split - Splits a string into a list of string values
  */
  Split: (delimiter: string, source: string): { 'Fn::Split': [string, string] } => ({
    'Fn::Split': [delimiter, source] as [string, string],
  }),

  /**
   * GetAZs - Returns an array of Availability Zones for a region
  */
  GetAZs: (region: string = ''): { 'Fn::GetAZs': string } => ({
    'Fn::GetAZs': region,
  }),

  /**
   * ImportValue - Returns the value of an output exported by another stack
  */
  ImportValue: (name: string): { 'Fn::ImportValue': string } => ({
    'Fn::ImportValue': name,
  }),

  /**
   * If - Returns one value if condition is true, another if false
  */
  If: (condition: string, trueValue: any, falseValue: any): { 'Fn::If': [string, any, any] } => ({
    'Fn::If': [condition, trueValue, falseValue] as [string, any, any],
  }),

  /**
   * Equals - Compares if two values are equal
  */
  Equals: (value1: any, value2: any): { 'Fn::Equals': [any, any] } => ({
    'Fn::Equals': [value1, value2] as [any, any],
  }),

  /**
   * And - Returns true if all conditions are true
  */
  And: (...conditions: any[]): { 'Fn::And': any[] } => ({
    'Fn::And': conditions,
  }),

  /**
   * Or - Returns true if any condition is true
  */
  Or: (...conditions: any[]): { 'Fn::Or': any[] } => ({
    'Fn::Or': conditions,
  }),

  /**
   * Not - Returns true if condition is false
  */
  Not: (condition: any): { 'Fn::Not': [any] } => ({
    'Fn::Not': [condition] as [any],
  }),

  /**
   * Base64 - Returns the Base64 representation of the input string
  */
  Base64: (input: string): { 'Fn::Base64': string } => ({
    'Fn::Base64': input,
  }),
} as const

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
