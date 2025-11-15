import { describe, expect, it } from 'bun:test'
import type { CloudFormationTemplate } from '@ts-cloud/aws-types'
import {
  validateTemplate,
  validateTemplateSize,
  validateResourceLimits,
} from '../src/template-validator'

describe('Template Validator', () => {
  describe('validateTemplate', () => {
    it('should validate a correct template', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Description: 'Test template',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {
              BucketName: 'my-test-bucket',
            },
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should require AWSTemplateFormatVersion', () => {
      const template: any = {
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.path === 'AWSTemplateFormatVersion')).toBe(true)
    })

    it('should require correct AWSTemplateFormatVersion', () => {
      const template: any = {
        AWSTemplateFormatVersion: '2000-01-01',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e =>
        e.path === 'AWSTemplateFormatVersion' && e.message.includes('2010-09-09'),
      )).toBe(true)
    })

    it('should require at least one resource', () => {
      const template: any = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {},
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e =>
        e.path === 'Resources' && e.message.includes('at least one'),
      )).toBe(true)
    })

    it('should validate logical ID format', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          'My-Bucket': {
            Type: 'AWS::S3::Bucket',
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('alphanumeric'))).toBe(true)
    })

    it('should require resource Type', () => {
      const template: any = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Properties: {},
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('Type is required'))).toBe(true)
    })

    it('should validate resource Type format', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Type: 'InvalidType',
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('AWS::'))).toBe(true)
    })

    it('should validate DeletionPolicy values', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
            DeletionPolicy: 'InvalidPolicy' as any,
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('DeletionPolicy'))).toBe(true)
    })

    it('should warn about missing DeletionPolicy on data resources', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyDatabase: {
            Type: 'AWS::RDS::DBInstance',
            Properties: {
              Engine: 'postgres',
            },
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.warnings.some(w =>
        w.message.includes('DeletionPolicy') && w.message.includes('data loss'),
      )).toBe(true)
    })

    it('should detect invalid Ref', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {
              BucketName: { Ref: 'NonExistentResource' },
            },
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('non-existent'))).toBe(true)
    })

    it('should allow valid Ref to resource', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyVpc: {
            Type: 'AWS::EC2::VPC',
          },
          MySubnet: {
            Type: 'AWS::EC2::Subnet',
            Properties: {
              VpcId: { Ref: 'MyVpc' },
            },
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(true)
    })

    it('should allow valid Ref to parameter', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Parameters: {
          VpcId: {
            Type: 'String',
          },
        },
        Resources: {
          MySubnet: {
            Type: 'AWS::EC2::Subnet',
            Properties: {
              VpcId: { Ref: 'VpcId' },
            },
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(true)
    })

    it('should allow pseudo-parameters', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {
              Tags: [
                { Key: 'Region', Value: { Ref: 'AWS::Region' } },
                { Key: 'AccountId', Value: { Ref: 'AWS::AccountId' } },
              ],
            },
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(true)
    })

    it('should detect invalid GetAtt', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {
              BucketName: { 'Fn::GetAtt': ['NonExistent', 'Arn'] },
            },
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('GetAtt'))).toBe(true)
    })

    it('should detect circular dependencies', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          ResourceA: {
            Type: 'AWS::S3::Bucket',
            DependsOn: 'ResourceB',
          },
          ResourceB: {
            Type: 'AWS::S3::Bucket',
            DependsOn: 'ResourceA',
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('Circular dependency'))).toBe(true)
    })

    it('should detect circular dependencies via Ref', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          ResourceA: {
            Type: 'AWS::S3::Bucket',
            Properties: {
              BucketName: { Ref: 'ResourceB' },
            },
          },
          ResourceB: {
            Type: 'AWS::S3::Bucket',
            DependsOn: 'ResourceA',
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('Circular'))).toBe(true)
    })

    it('should validate parameter Type', () => {
      const template: any = {
        AWSTemplateFormatVersion: '2010-09-09',
        Parameters: {
          MyParam: {
            // Missing Type
            Default: 'value',
          },
        },
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e =>
        e.path.includes('Parameters') && e.message.includes('Type'),
      )).toBe(true)
    })

    it('should validate output Value', () => {
      const template: any = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
          },
        },
        Outputs: {
          BucketName: {
            // Missing Value
            Description: 'Bucket name',
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e =>
        e.path.includes('Outputs') && e.message.includes('Value'),
      )).toBe(true)
    })

    it('should warn about missing encryption on S3', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.warnings.some(w => w.message.includes('encryption'))).toBe(true)
    })

    it('should warn about missing encryption on RDS', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyDB: {
            Type: 'AWS::RDS::DBInstance',
            Properties: {},
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.warnings.some(w => w.message.includes('encryption'))).toBe(true)
    })

    it('should info about missing tags', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.info.some(i => i.message.includes('Tags'))).toBe(true)
    })

    it('should info about missing description', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
          },
        },
      }

      const result = validateTemplate(template)
      expect(result.info.some(i => i.path === 'Description')).toBe(true)
    })
  })

  describe('validateTemplateSize', () => {
    it('should pass for small templates', () => {
      const template = JSON.stringify({
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
          },
        },
      })

      const result = validateTemplateSize(template)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should warn for templates over 50KB', () => {
      const largeTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {} as any,
      }

      // Create a template larger than 50KB
      for (let i = 0; i < 500; i++) {
        largeTemplate.Resources[`Resource${i}`] = {
          Type: 'AWS::S3::Bucket',
          Properties: {
            BucketName: `bucket-${i}`,
            Tags: Array.from({ length: 20 }, (_, j) => ({
              Key: `Tag${j}`,
              Value: `Value${j}`,
            })),
          },
        }
      }

      const templateJson = JSON.stringify(largeTemplate)
      const result = validateTemplateSize(templateJson)

      expect(result.warnings.some(w => w.message.includes('50 KB'))).toBe(true)
    })

    it('should error for templates over 450KB', () => {
      const hugeTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {} as any,
      }

      // Create a template larger than 450KB
      for (let i = 0; i < 5000; i++) {
        hugeTemplate.Resources[`Resource${i}`] = {
          Type: 'AWS::S3::Bucket',
          Properties: {
            BucketName: `bucket-${i}`,
            Tags: Array.from({ length: 30 }, (_, j) => ({
              Key: `Tag${j}`,
              Value: `Value${j}`.repeat(10),
            })),
          },
        }
      }

      const templateJson = JSON.stringify(hugeTemplate)
      const result = validateTemplateSize(templateJson)

      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('450 KB'))).toBe(true)
    })
  })

  describe('validateResourceLimits', () => {
    it('should pass for templates within limits', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
          },
        },
        Parameters: {
          MyParam: {
            Type: 'String',
          },
        },
        Outputs: {
          MyOutput: {
            Value: { Ref: 'MyBucket' },
          },
        },
      }

      const result = validateResourceLimits(template)
      expect(result.valid).toBe(true)
    })

    it('should error for too many resources', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {},
      }

      // Create 501 resources
      for (let i = 0; i < 501; i++) {
        template.Resources[`Resource${i}`] = {
          Type: 'AWS::S3::Bucket',
        }
      }

      const result = validateResourceLimits(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('500'))).toBe(true)
    })

    it('should error for too many parameters', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
          },
        },
        Parameters: {},
      }

      // Create 201 parameters
      for (let i = 0; i < 201; i++) {
        template.Parameters![`Param${i}`] = {
          Type: 'String',
        }
      }

      const result = validateResourceLimits(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('200') && e.path === 'Parameters')).toBe(true)
    })

    it('should error for too many outputs', () => {
      const template: CloudFormationTemplate = {
        AWSTemplateFormatVersion: '2010-09-09',
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
          },
        },
        Outputs: {},
      }

      // Create 201 outputs
      for (let i = 0; i < 201; i++) {
        template.Outputs![`Output${i}`] = {
          Value: 'test',
        }
      }

      const result = validateResourceLimits(template)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.message.includes('200') && e.path === 'Outputs')).toBe(true)
    })
  })
})
