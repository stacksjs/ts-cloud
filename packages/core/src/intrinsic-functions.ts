/**
 * CloudFormation Intrinsic Functions Helpers
 */

export const Fn = {
  /**
   * Ref - Returns the value of the specified parameter or resource
   */
  Ref: (logicalName: string) => ({ Ref: logicalName }),

  /**
   * GetAtt - Returns the value of an attribute from a resource
   */
  GetAtt: (logicalName: string, attributeName: string) => ({
    'Fn::GetAtt': [logicalName, attributeName],
  }),

  /**
   * Sub - Substitutes variables in an input string with values
   */
  Sub: (template: string, variables?: Record<string, any>) => {
    if (variables) {
      return { 'Fn::Sub': [template, variables] }
    }
    return { 'Fn::Sub': template }
  },

  /**
   * Join - Appends a set of values into a single value, separated by delimiter
   */
  Join: (delimiter: string, values: any[]) => ({
    'Fn::Join': [delimiter, values],
  }),

  /**
   * Select - Returns a single object from a list of objects by index
   */
  Select: (index: number | string, list: any[]) => ({
    'Fn::Select': [index, list],
  }),

  /**
   * Split - Splits a string into a list of string values
   */
  Split: (delimiter: string, source: string) => ({
    'Fn::Split': [delimiter, source],
  }),

  /**
   * GetAZs - Returns an array of Availability Zones for a region
   */
  GetAZs: (region = '') => ({
    'Fn::GetAZs': region,
  }),

  /**
   * ImportValue - Returns the value of an output exported by another stack
   */
  ImportValue: (name: string) => ({
    'Fn::ImportValue': name,
  }),

  /**
   * If - Returns one value if condition is true, another if false
   */
  If: (condition: string, trueValue: any, falseValue: any) => ({
    'Fn::If': [condition, trueValue, falseValue],
  }),

  /**
   * Equals - Compares if two values are equal
   */
  Equals: (value1: any, value2: any) => ({
    'Fn::Equals': [value1, value2],
  }),

  /**
   * And - Returns true if all conditions are true
   */
  And: (...conditions: any[]) => ({
    'Fn::And': conditions,
  }),

  /**
   * Or - Returns true if any condition is true
   */
  Or: (...conditions: any[]) => ({
    'Fn::Or': conditions,
  }),

  /**
   * Not - Returns true if condition is false
   */
  Not: (condition: any) => ({
    'Fn::Not': [condition],
  }),

  /**
   * Base64 - Returns the Base64 representation of the input string
   */
  Base64: (input: string) => ({
    'Fn::Base64': input,
  }),
}

/**
 * Pseudo Parameters - AWS CloudFormation provides several built-in parameters
 */
export const Pseudo = {
  AccountId: { Ref: 'AWS::AccountId' },
  Region: { Ref: 'AWS::Region' },
  StackId: { Ref: 'AWS::StackId' },
  StackName: { Ref: 'AWS::StackName' },
  NotificationARNs: { Ref: 'AWS::NotificationARNs' },
  Partition: { Ref: 'AWS::Partition' },
  URLSuffix: { Ref: 'AWS::URLSuffix' },
  NoValue: { Ref: 'AWS::NoValue' },
}
