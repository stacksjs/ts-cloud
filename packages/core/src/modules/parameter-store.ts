/**
 * Systems Manager Parameter Store Module
 * Clean API for AWS SSM Parameter Store
 */

import type { SSMParameter } from '@ts-cloud/aws-types'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface ParameterOptions {
  slug: string
  environment: string
  parameterName?: string
  value: string
  type?: 'String' | 'StringList' | 'SecureString'
  description?: string
  tier?: 'Standard' | 'Advanced' | 'Intelligent-Tiering'
  tags?: Record<string, string>
}

/**
 * Parameter Store Module
 */
export class ParameterStore {
  /**
   * Create a parameter
   */
  static createParameter(options: ParameterOptions): {
    parameter: SSMParameter
    logicalId: string
  } {
    const {
      slug,
      environment,
      parameterName,
      value,
      type = 'String',
      description,
      tier = 'Standard',
      tags,
    } = options

    const resourceName = parameterName || generateResourceName({
      slug,
      environment,
      resourceType: 'parameter',
    })

    const logicalId = generateLogicalId(resourceName)

    const parameter: SSMParameter = {
      Type: 'AWS::SSM::Parameter',
      Properties: {
        Name: `/${slug}/${environment}/${resourceName}`,
        Type: type,
        Value: value,
        Description: description,
        Tier: tier,
        Tags: {
          Name: resourceName,
          Environment: environment,
          ...tags,
        },
      },
    }

    return { parameter, logicalId }
  }

  /**
   * Create a string parameter
   */
  static createString(
    slug: string,
    environment: string,
    name: string,
    value: string,
    description?: string,
  ): {
    parameter: SSMParameter
    logicalId: string
  } {
    return ParameterStore.createParameter({
      slug,
      environment,
      parameterName: name,
      value,
      type: 'String',
      description,
    })
  }

  /**
   * Create a secure string parameter (encrypted)
   */
  static createSecureString(
    slug: string,
    environment: string,
    name: string,
    value: string,
    description?: string,
  ): {
    parameter: SSMParameter
    logicalId: string
  } {
    return ParameterStore.createParameter({
      slug,
      environment,
      parameterName: name,
      value,
      type: 'SecureString',
      description,
    })
  }

  /**
   * Create a string list parameter (comma-separated)
   */
  static createStringList(
    slug: string,
    environment: string,
    name: string,
    values: string[],
    description?: string,
  ): {
    parameter: SSMParameter
    logicalId: string
  } {
    return ParameterStore.createParameter({
      slug,
      environment,
      parameterName: name,
      value: values.join(','),
      type: 'StringList',
      description,
    })
  }

  /**
   * Common parameter patterns
   */
  static readonly Parameters = {
    /**
     * Database connection string
     */
    databaseUrl: (slug: string, environment: string, url: string) => {
      return ParameterStore.createSecureString(
        slug,
        environment,
        'database-url',
        url,
        'Database connection URL',
      )
    },

    /**
     * API endpoint
     */
    apiEndpoint: (slug: string, environment: string, endpoint: string) => {
      return ParameterStore.createString(
        slug,
        environment,
        'api-endpoint',
        endpoint,
        'API endpoint URL',
      )
    },

    /**
     * Application version
     */
    appVersion: (slug: string, environment: string, version: string) => {
      return ParameterStore.createString(
        slug,
        environment,
        'app-version',
        version,
        'Application version',
      )
    },

    /**
     * Feature flags (comma-separated list)
     */
    featureFlags: (slug: string, environment: string, flags: string[]) => {
      return ParameterStore.createStringList(
        slug,
        environment,
        'feature-flags',
        flags,
        'Enabled feature flags',
      )
    },

    /**
     * Third-party API key (secure)
     */
    apiKey: (slug: string, environment: string, serviceName: string, key: string) => {
      return ParameterStore.createSecureString(
        slug,
        environment,
        `${serviceName}-api-key`,
        key,
        `API key for ${serviceName}`,
      )
    },

    /**
     * OAuth credentials
     */
    oauthCredentials: (slug: string, environment: string, clientId: string, clientSecret: string) => {
      const clientIdParam = ParameterStore.createString(
        slug,
        environment,
        'oauth-client-id',
        clientId,
        'OAuth client ID',
      )

      const clientSecretParam = ParameterStore.createSecureString(
        slug,
        environment,
        'oauth-client-secret',
        clientSecret,
        'OAuth client secret',
      )

      return {
        clientId: clientIdParam,
        clientSecret: clientSecretParam,
      }
    },

    /**
     * SMTP credentials
     */
    smtpCredentials: (slug: string, environment: string, username: string, password: string, host: string, port: number) => {
      const usernameParam = ParameterStore.createString(
        slug,
        environment,
        'smtp-username',
        username,
        'SMTP username',
      )

      const passwordParam = ParameterStore.createSecureString(
        slug,
        environment,
        'smtp-password',
        password,
        'SMTP password',
      )

      const hostParam = ParameterStore.createString(
        slug,
        environment,
        'smtp-host',
        host,
        'SMTP host',
      )

      const portParam = ParameterStore.createString(
        slug,
        environment,
        'smtp-port',
        port.toString(),
        'SMTP port',
      )

      return {
        username: usernameParam,
        password: passwordParam,
        host: hostParam,
        port: portParam,
      }
    },

    /**
     * Redis connection
     */
    redisUrl: (slug: string, environment: string, url: string) => {
      return ParameterStore.createSecureString(
        slug,
        environment,
        'redis-url',
        url,
        'Redis connection URL',
      )
    },

    /**
     * S3 bucket name
     */
    s3Bucket: (slug: string, environment: string, bucketName: string) => {
      return ParameterStore.createString(
        slug,
        environment,
        's3-bucket',
        bucketName,
        'S3 bucket name',
      )
    },

    /**
     * CloudFront distribution ID
     */
    cloudFrontDistribution: (slug: string, environment: string, distributionId: string) => {
      return ParameterStore.createString(
        slug,
        environment,
        'cloudfront-distribution-id',
        distributionId,
        'CloudFront distribution ID',
      )
    },
  }
}
