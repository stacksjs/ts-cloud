import type { CloudFormationResource, CloudFormationTemplate } from 'ts-cloud-aws-types'

export class TemplateBuilder {
  private template: CloudFormationTemplate

  constructor(description?: string) {
    this.template = {
      AWSTemplateFormatVersion: '2010-09-09',
      Description: description,
      Resources: {},
    }
  }

  /**
   * Add a resource to the template
   */
  addResource(logicalId: string, resource: CloudFormationResource): this {
    this.template.Resources[logicalId] = resource
    return this
  }

  /**
   * Add multiple resources to the template
   */
  addResources(resources: Record<string, CloudFormationResource>): this {
    Object.assign(this.template.Resources, resources)
    return this
  }

  /**
   * Add a parameter to the template
   */
  addParameter(name: string, parameter: NonNullable<CloudFormationTemplate['Parameters']>[string]): this {
    if (!this.template.Parameters) {
      this.template.Parameters = {}
    }
    this.template.Parameters[name] = parameter
    return this
  }

  /**
   * Add an output to the template
   */
  addOutput(name: string, output: NonNullable<CloudFormationTemplate['Outputs']>[string]): this {
    if (!this.template.Outputs) {
      this.template.Outputs = {}
    }
    this.template.Outputs[name] = output
    return this
  }

  /**
   * Get resources from the template
   */
  getResources(): Record<string, CloudFormationResource> {
    return this.template.Resources
  }

  /**
   * Build and return the CloudFormation template
   */
  build(): CloudFormationTemplate {
    return this.template
  }

  /**
   * Convert template to JSON string
   */
  toJSON(pretty = true): string {
    return JSON.stringify(this.template, null, pretty ? 2 : 0)
  }

  /**
   * Convert template to YAML string (simple implementation)
   */
  toYAML(): string {
    // Simple YAML conversion - for production, use a proper YAML library
    return this.convertToYAML(this.template)
  }

  private convertToYAML(obj: any, indent = 0): string {
    const spaces = '  '.repeat(indent)
    let yaml = ''

    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined)
        continue

      if (typeof value === 'object' && !Array.isArray(value)) {
        yaml += `${spaces}${key}:\n${this.convertToYAML(value, indent + 1)}`
      }
      else if (Array.isArray(value)) {
        yaml += `${spaces}${key}:\n`
        for (const item of value) {
          if (typeof item === 'object') {
            yaml += `${spaces}  -\n${this.convertToYAML(item, indent + 2)}`
          }
          else {
            yaml += `${spaces}  - ${item}\n`
          }
        }
      }
      else {
        yaml += `${spaces}${key}: ${value}\n`
      }
    }

    return yaml
  }
}
