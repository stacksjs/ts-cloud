/**
 * AWS OpenSearch Service Client
 * Direct API calls for OpenSearch operations
*/

import { AWSClient } from './client'

export interface DomainStatus {
  DomainId: string
  DomainName: string
  ARN: string
  Created: boolean
  Deleted: boolean
  Endpoint?: string
  Endpoints?: Record<string, string>
  Processing: boolean
  EngineVersion: string
  ClusterConfig: {
    InstanceType: string
    InstanceCount: number
    DedicatedMasterEnabled: boolean
    ZoneAwarenessEnabled: boolean
    DedicatedMasterType?: string
    DedicatedMasterCount?: number
  }
  EBSOptions?: {
    EBSEnabled: boolean
    VolumeType?: string
    VolumeSize?: number
  }
}

/**
 * OpenSearch client for direct API calls
*/
export class OpenSearchClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Create an OpenSearch domain
  */
  async createDomain(params: {
    DomainName: string
    EngineVersion?: string
    ClusterConfig?: {
      InstanceType?: string
      InstanceCount?: number
      DedicatedMasterEnabled?: boolean
      DedicatedMasterType?: string
      DedicatedMasterCount?: number
      ZoneAwarenessEnabled?: boolean
    }
    EBSOptions?: {
      EBSEnabled: boolean
      VolumeType?: string
      VolumeSize?: number
    }
    AccessPolicies?: string
    EncryptionAtRestOptions?: {
      Enabled: boolean
      KmsKeyId?: string
    }
    NodeToNodeEncryptionOptions?: {
      Enabled: boolean
    }
    AdvancedSecurityOptions?: {
      Enabled: boolean
      InternalUserDatabaseEnabled?: boolean
      MasterUserOptions?: {
        MasterUserName?: string
        MasterUserPassword?: string
      }
    }
    DomainEndpointOptions?: {
      EnforceHTTPS?: boolean
      TLSSecurityPolicy?: string
    }
    Tags?: Array<{ Key: string; Value: string }>
  }): Promise<{ DomainStatus: DomainStatus }> {
    return this.client.request({
      service: 'es',
      region: this.region,
      method: 'POST',
      path: `/2021-01-01/opensearch/domain`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
  }

  /**
   * Delete an OpenSearch domain
  */
  async deleteDomain(domainName: string): Promise<{ DomainStatus: DomainStatus }> {
    return this.client.request({
      service: 'es',
      region: this.region,
      method: 'DELETE',
      path: `/2021-01-01/opensearch/domain/${domainName}`,
    })
  }

  /**
   * Describe an OpenSearch domain
  */
  async describeDomain(domainName: string): Promise<{ DomainStatus: DomainStatus }> {
    return this.client.request({
      service: 'es',
      region: this.region,
      method: 'GET',
      path: `/2021-01-01/opensearch/domain/${domainName}`,
    })
  }

  /**
   * List all OpenSearch domains
  */
  async listDomainNames(): Promise<{ DomainNames: Array<{ DomainName: string; EngineType: string }> }> {
    return this.client.request({
      service: 'es',
      region: this.region,
      method: 'GET',
      path: '/2021-01-01/domain',
    })
  }

  /**
   * Update domain config
  */
  async updateDomainConfig(params: {
    DomainName: string
    ClusterConfig?: {
      InstanceType?: string
      InstanceCount?: number
    }
    EBSOptions?: {
      EBSEnabled: boolean
      VolumeType?: string
      VolumeSize?: number
    }
    AccessPolicies?: string
  }): Promise<{ DomainConfig: any }> {
    const { DomainName, ...config } = params
    return this.client.request({
      service: 'es',
      region: this.region,
      method: 'POST',
      path: `/2021-01-01/opensearch/domain/${DomainName}/config`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
  }
}
