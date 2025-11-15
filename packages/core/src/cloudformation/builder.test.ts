/**
 * CloudFormation Builder Tests
 */

import { describe, expect, it } from 'bun:test'
import { CloudFormationBuilder } from './builder'
import { Fn } from './types'

describe('CloudFormationBuilder', () => {
  it('should initialize with empty template', () => {
    const builder = new CloudFormationBuilder({
      project: { name: 'Test', slug: 'test', region: 'us-east-1' },
    })

    const template = builder.build()

    expect(template.AWSTemplateFormatVersion).toBe('2010-09-09')
    expect(template.Description).toContain('Test')
    expect(template.Resources).toEqual({})
  })

  it('should add resources to template', () => {
    const builder = new CloudFormationBuilder({
      project: { name: 'Test', slug: 'test', region: 'us-east-1' },
    })

    builder.addResource('MyBucket', 'AWS::S3::Bucket', {
      BucketName: 'my-test-bucket',
    })

    const template = builder.build()

    expect(template.Resources.MyBucket).toBeDefined()
    expect(template.Resources.MyBucket.Type).toBe('AWS::S3::Bucket')
    expect(template.Resources.MyBucket.Properties.BucketName).toBe('my-test-bucket')
  })

  it('should add multiple resources', () => {
    const builder = new CloudFormationBuilder({
      project: { name: 'Test', slug: 'test', region: 'us-east-1' },
    })

    builder.addResource('Bucket1', 'AWS::S3::Bucket', { BucketName: 'bucket1' })
    builder.addResource('Bucket2', 'AWS::S3::Bucket', { BucketName: 'bucket2' })

    const template = builder.build()

    expect(template.Resources.Bucket1).toBeDefined()
    expect(template.Resources.Bucket2).toBeDefined()
  })

  it('should handle resource with DependsOn', () => {
    const builder = new CloudFormationBuilder({
      project: { name: 'Test', slug: 'test', region: 'us-east-1' },
    })

    builder.addResource('Bucket', 'AWS::S3::Bucket', { BucketName: 'bucket' })
    builder.addResource('BucketPolicy', 'AWS::S3::BucketPolicy', {
      Bucket: Fn.ref('Bucket'),
    }, {
      dependsOn: 'Bucket',
    })

    const template = builder.build()

    expect(template.Resources.BucketPolicy.DependsOn).toBe('Bucket')
  })

  it('should handle resource with multiple DependsOn', () => {
    const builder = new CloudFormationBuilder({
      project: { name: 'Test', slug: 'test', region: 'us-east-1' },
    })

    builder.addResource('Resource1', 'AWS::S3::Bucket', {})
    builder.addResource('Resource2', 'AWS::S3::Bucket', {})
    builder.addResource('Resource3', 'AWS::S3::Bucket', {}, {
      dependsOn: ['Resource1', 'Resource2'],
    })

    const template = builder.build()

    expect(template.Resources.Resource3.DependsOn).toEqual(['Resource1', 'Resource2'])
  })

  it('should handle deletion policy', () => {
    const builder = new CloudFormationBuilder({
      project: { name: 'Test', slug: 'test', region: 'us-east-1' },
    })

    builder.addResource('Database', 'AWS::RDS::DBInstance', {
      DBInstanceIdentifier: 'mydb',
    }, {
      deletionPolicy: 'Snapshot',
    })

    const template = builder.build()

    expect(template.Resources.Database.DeletionPolicy).toBe('Snapshot')
  })

  it('should include parameters in built template', () => {
    const builder = new CloudFormationBuilder({
      project: { name: 'Test', slug: 'test', region: 'us-east-1' },
    })

    const template = builder.build()

    expect(template.Parameters).toBeDefined()
    expect(template.Parameters?.Environment).toBeDefined()
  })

  it('should include conditions in built template', () => {
    const builder = new CloudFormationBuilder({
      project: { name: 'Test', slug: 'test', region: 'us-east-1' },
    })

    const template = builder.build()

    expect(template.Conditions).toBeDefined()
  })

  it('should throw error for circular dependencies', () => {
    const builder = new CloudFormationBuilder({
      project: { name: 'Test', slug: 'test', region: 'us-east-1' },
    })

    builder.addResource('Resource1', 'AWS::S3::Bucket', {}, { dependsOn: 'Resource2' })
    builder.addResource('Resource2', 'AWS::S3::Bucket', {}, { dependsOn: 'Resource1' })

    expect(() => builder.build()).toThrow('Circular dependency detected')
  })

  it('should detect complex circular dependencies', () => {
    const builder = new CloudFormationBuilder({
      project: { name: 'Test', slug: 'test', region: 'us-east-1' },
    })

    builder.addResource('A', 'AWS::S3::Bucket', {}, { dependsOn: 'B' })
    builder.addResource('B', 'AWS::S3::Bucket', {}, { dependsOn: 'C' })
    builder.addResource('C', 'AWS::S3::Bucket', {}, { dependsOn: 'A' })

    expect(() => builder.build()).toThrow('Circular dependency detected')
  })

  it('should handle valid dependency chains', () => {
    const builder = new CloudFormationBuilder({
      project: { name: 'Test', slug: 'test', region: 'us-east-1' },
    })

    builder.addResource('A', 'AWS::S3::Bucket', {})
    builder.addResource('B', 'AWS::S3::Bucket', {}, { dependsOn: 'A' })
    builder.addResource('C', 'AWS::S3::Bucket', {}, { dependsOn: 'B' })

    expect(() => builder.build()).not.toThrow()
  })

  it('should handle tags', () => {
    const builder = new CloudFormationBuilder({
      project: { name: 'Test', slug: 'test', region: 'us-east-1' },
    })

    builder.addResource('Bucket', 'AWS::S3::Bucket', {
      BucketName: 'bucket',
      Tags: [
        { Key: 'Environment', Value: 'production' },
        { Key: 'Project', Value: 'test' },
      ],
    })

    const template = builder.build()

    expect(template.Resources.Bucket.Properties.Tags).toHaveLength(2)
    expect(template.Resources.Bucket.Properties.Tags[0]).toEqual({
      Key: 'Environment',
      Value: 'production',
    })
  })
})

describe('CloudFormation Intrinsic Functions', () => {
  it('should create Ref function', () => {
    const ref = Fn.ref('MyBucket')

    expect(ref).toEqual({ Ref: 'MyBucket' })
  })

  it('should create GetAtt function', () => {
    const getAtt = Fn.getAtt('MyBucket', 'Arn')

    expect(getAtt).toEqual({ 'Fn::GetAtt': ['MyBucket', 'Arn'] })
  })

  it('should create Join function', () => {
    const join = Fn.join('-', ['prefix', 'middle', 'suffix'])

    expect(join).toEqual({ 'Fn::Join': ['-', ['prefix', 'middle', 'suffix']] })
  })

  it('should create Sub function with template only', () => {
    const sub = Fn.sub('arn:aws:s3:::${BucketName}')

    expect(sub).toEqual({ 'Fn::Sub': 'arn:aws:s3:::${BucketName}' })
  })

  it('should create Sub function with variables', () => {
    const sub = Fn.sub('arn:aws:s3:::${Bucket}', {
      Bucket: Fn.ref('MyBucket'),
    })

    expect(sub).toEqual({
      'Fn::Sub': ['arn:aws:s3:::${Bucket}', { Bucket: { Ref: 'MyBucket' } }],
    })
  })

  it('should create Select function', () => {
    const select = Fn.select(0, ['a', 'b', 'c'])

    expect(select).toEqual({ 'Fn::Select': [0, ['a', 'b', 'c']] })
  })

  it('should create Split function', () => {
    const split = Fn.split(',', 'a,b,c')

    expect(split).toEqual({ 'Fn::Split': [',', 'a,b,c'] })
  })

  it('should create If function', () => {
    const ifFunc = Fn.if('IsProduction', 'prod-value', 'dev-value')

    expect(ifFunc).toEqual({ 'Fn::If': ['IsProduction', 'prod-value', 'dev-value'] })
  })

  it('should create Equals function', () => {
    const equals = Fn.equals('value1', 'value2')

    expect(equals).toEqual({ 'Fn::Equals': ['value1', 'value2'] })
  })

  it('should create Not function', () => {
    const not = Fn.not(Fn.equals('a', 'b'))

    expect(not).toEqual({ 'Fn::Not': [{ 'Fn::Equals': ['a', 'b'] }] })
  })

  it('should create And function', () => {
    const and = Fn.and(
      Fn.equals('a', 'a'),
      Fn.equals('b', 'b'),
    )

    expect(and).toEqual({
      'Fn::And': [{ 'Fn::Equals': ['a', 'a'] }, { 'Fn::Equals': ['b', 'b'] }],
    })
  })

  it('should create Or function', () => {
    const or = Fn.or(
      Fn.equals('a', 'b'),
      Fn.equals('c', 'c'),
    )

    expect(or).toEqual({
      'Fn::Or': [{ 'Fn::Equals': ['a', 'b'] }, { 'Fn::Equals': ['c', 'c'] }],
    })
  })

  it('should create Base64 function', () => {
    const base64 = Fn.base64('user data script')

    expect(base64).toEqual({ 'Fn::Base64': 'user data script' })
  })

  it('should create Cidr function', () => {
    const cidr = Fn.cidr('10.0.0.0/16', 6, 8)

    expect(cidr).toEqual({ 'Fn::Cidr': ['10.0.0.0/16', 6, 8] })
  })

  it('should create GetAZs function', () => {
    const getAZs = Fn.getAZs('us-east-1')

    expect(getAZs).toEqual({ 'Fn::GetAZs': 'us-east-1' })
  })

  it('should create GetAZs for current region', () => {
    const getAZs = Fn.getAZs()

    expect(getAZs).toEqual({ 'Fn::GetAZs': '' })
  })

  it('should create ImportValue function', () => {
    const importValue = Fn.importValue('NetworkStackVpcId')

    expect(importValue).toEqual({ 'Fn::ImportValue': 'NetworkStackVpcId' })
  })

  it('should nest intrinsic functions', () => {
    const nested = Fn.join('-', [
      Fn.ref('AWS::StackName'),
      'bucket',
      Fn.select(0, Fn.getAZs()),
    ])

    expect(nested).toEqual({
      'Fn::Join': [
        '-',
        [
          { Ref: 'AWS::StackName' },
          'bucket',
          { 'Fn::Select': [0, { 'Fn::GetAZs': '' }] },
        ],
      ],
    })
  })
})
