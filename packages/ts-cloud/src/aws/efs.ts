/**
 * AWS EFS (Elastic File System) Client
 * Manages EFS file systems using direct API calls
 */

import { AWSClient } from './client'

export interface FileSystem {
  FileSystemId?: string
  Name?: string
  CreationTime?: string
  LifeCycleState?: 'creating' | 'available' | 'updating' | 'deleting' | 'deleted' | 'error'
  NumberOfMountTargets?: number
  SizeInBytes?: {
    Value?: number
    Timestamp?: string
  }
  PerformanceMode?: 'generalPurpose' | 'maxIO'
  Encrypted?: boolean
  ThroughputMode?: 'bursting' | 'provisioned' | 'elastic'
  Tags?: { Key?: string, Value?: string }[]
}

export class EFSClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Describe EFS file systems
   */
  async describeFileSystems(options?: {
    FileSystemId?: string
    CreationToken?: string
  }): Promise<{
    FileSystems?: FileSystem[]
  }> {
    const queryParams: string[] = []

    if (options?.FileSystemId) {
      queryParams.push(`FileSystemId=${encodeURIComponent(options.FileSystemId)}`)
    }
    if (options?.CreationToken) {
      queryParams.push(`CreationToken=${encodeURIComponent(options.CreationToken)}`)
    }

    const path = `/2015-02-01/file-systems${queryParams.length > 0 ? `?${queryParams.join('&')}` : ''}`

    const result = await this.client.request({
      service: 'elasticfilesystem',
      region: this.region,
      method: 'GET',
      path,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    return {
      FileSystems: (result.FileSystems || []).map((fs: any) => ({
        FileSystemId: fs.FileSystemId,
        Name: fs.Name,
        CreationTime: fs.CreationTime,
        LifeCycleState: fs.LifeCycleState,
        NumberOfMountTargets: fs.NumberOfMountTargets,
        SizeInBytes: fs.SizeInBytes ? {
          Value: fs.SizeInBytes.Value,
          Timestamp: fs.SizeInBytes.Timestamp,
        } : undefined,
        PerformanceMode: fs.PerformanceMode,
        Encrypted: fs.Encrypted,
        ThroughputMode: fs.ThroughputMode,
        Tags: fs.Tags,
      })),
    }
  }
}
