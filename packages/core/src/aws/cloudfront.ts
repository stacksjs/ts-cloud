/**
 * AWS CloudFront API Client
 * Direct API calls for CloudFront invalidations without AWS SDK
*/

import type { AWSCredentials } from './credentials'
import { resolveCredentials } from './credentials'
import { makeAWSRequest, parseXMLResponse } from './signature'

export interface InvalidationOptions {
  distributionId: string
  paths: string[]
  callerReference?: string
}

/**
 * CloudFront API Client
*/
export class CloudFrontClient {
  private credentials: AWSCredentials | null = null

  constructor(
    private readonly profile: string = 'default',
  ) {}

  /**
   * Initialize client with credentials
  */
  async init(): Promise<void> {
    this.credentials = await resolveCredentials(this.profile)
  }

  /**
   * Ensure credentials are loaded
  */
  private async ensureCredentials(): Promise<AWSCredentials> {
    if (!this.credentials) {
      await this.init()
    }
    return this.credentials!
  }

  /**
   * Create a cache invalidation
  */
  async createInvalidation(options: InvalidationOptions): Promise<string> {
    const credentials = await this.ensureCredentials()

    const callerReference = options.callerReference || `invalidation-${Date.now()}`

    const body = `<?xml version="1.0" encoding="UTF-8"?>
<InvalidationBatch>
  <Paths>
    <Quantity>${options.paths.length}</Quantity>
    <Items>
      ${options.paths.map(path => `<Path>${path}</Path>`).join('')}
    </Items>
  </Paths>
  <CallerReference>${callerReference}</CallerReference>
</InvalidationBatch>`

    const url = `https://cloudfront.amazonaws.com/2020-05-31/distribution/${options.distributionId}/invalidation`

    const response = await makeAWSRequest({
      method: 'POST',
      url,
      service: 'cloudfront',
      region: 'us-east-1', // CloudFront is global, but uses us-east-1
      headers: {
        'Content-Type': 'text/xml',
      },
      body,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    })

    const data = await parseXMLResponse(response)
    return data.Id
  }

  /**
   * Get invalidation status
  */
  async getInvalidation(distributionId: string, invalidationId: string): Promise<any> {
    const credentials = await this.ensureCredentials()

    const url = `https://cloudfront.amazonaws.com/2020-05-31/distribution/${distributionId}/invalidation/${invalidationId}`

    const response = await makeAWSRequest({
      method: 'GET',
      url,
      service: 'cloudfront',
      region: 'us-east-1',
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    })

    return await parseXMLResponse(response)
  }

  /**
   * List invalidations for a distribution
  */
  async listInvalidations(distributionId: string): Promise<any[]> {
    const credentials = await this.ensureCredentials()

    const url = `https://cloudfront.amazonaws.com/2020-05-31/distribution/${distributionId}/invalidation`

    const response = await makeAWSRequest({
      method: 'GET',
      url,
      service: 'cloudfront',
      region: 'us-east-1',
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    })

    const data = await parseXMLResponse(response)
    return data.Items || []
  }

  /**
   * Wait for invalidation to complete
  */
  async waitForInvalidation(
    distributionId: string,
    invalidationId: string,
    maxAttempts: number = 60,
    pollInterval: number = 5000,
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const invalidation = await this.getInvalidation(distributionId, invalidationId)

      if (invalidation.Status === 'Completed') {
        return
      }

      if (i < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, pollInterval))
      }
    }

    throw new Error(`Invalidation ${invalidationId} did not complete within the expected time`)
  }

  /**
   * Invalidate all files in a distribution
  */
  async invalidateAll(distributionId: string): Promise<string> {
    return await this.createInvalidation({
      distributionId,
      paths: ['/*'],
    })
  }
}
