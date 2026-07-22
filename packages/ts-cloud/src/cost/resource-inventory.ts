import { AWSClient } from '../aws/client'
import { resolveCredentials } from '../aws/credentials'
import { S3Client } from '../aws/s3'

export interface CloudResource {
  arn: string
  service: string
  type: string
  id: string
  name: string
  region?: string
  accountId?: string
  state?: string
  tags: Record<string, string>
  metadata: Record<string, string | number | boolean | undefined>
}

export interface ResourceInventoryResult {
  resources: CloudResource[]
  warnings: string[]
}

function list<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

export function parseResourceArn(arn: string, tags: Record<string, string> = {}): CloudResource {
  const [, , service = 'unknown', region = '', accountId = '', resource = arn] = arn.split(':')
  const separator = resource.includes('/') ? '/' : ':'
  const [type = service, ...idParts] = resource.split(separator)
  const id = idParts.join(separator) || resource
  return {
    arn,
    service,
    type,
    id,
    name: tags.Name || tags.name || id,
    region: region || undefined,
    accountId: accountId || undefined,
    tags,
    metadata: {},
  }
}

function matchesType(resource: CloudResource, filter?: string): boolean {
  if (!filter) return true
  const needle = filter.toLowerCase().replace(/^aws[:/]/, '')
  return [resource.service, resource.type, `${resource.service}:${resource.type}`].some(
    (value) => value.toLowerCase() === needle || value.toLowerCase().includes(needle),
  )
}

export function mergeResources(resources: CloudResource[], filter?: string): CloudResource[] {
  const merged = new Map<string, CloudResource>()
  for (const resource of resources) {
    const key = `${resource.service}:${resource.type}:${resource.id}`
    const existing = merged.get(key)
    merged.set(
      key,
      existing
        ? {
            ...existing,
            ...resource,
            arn: existing.accountId ? existing.arn : resource.arn,
            accountId: existing.accountId ?? resource.accountId,
            tags: { ...existing.tags, ...resource.tags },
            metadata: { ...existing.metadata, ...resource.metadata },
          }
        : resource,
    )
  }
  return [...merged.values()]
    .filter((resource) => matchesType(resource, filter))
    .sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name) || a.arn.localeCompare(b.arn))
}

export class ResourceInventoryClient {
  private client: AWSClient
  private profile?: string
  private region: string

  constructor(profile?: string, region: string = process.env.AWS_REGION || 'us-east-1') {
    this.profile = profile
    this.region = region
    this.client = new AWSClient(resolveCredentials(profile))
  }

  private async taggedResources(): Promise<CloudResource[]> {
    const resources: CloudResource[] = []
    let paginationToken: string | undefined
    do {
      const result = await this.client.request({
        service: 'tagging',
        region: this.region,
        method: 'POST',
        path: '/',
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': 'ResourceGroupsTaggingAPI_20170126.GetResources',
        },
        body: JSON.stringify(paginationToken ? { PaginationToken: paginationToken } : {}),
      })
      for (const mapping of result?.ResourceTagMappingList ?? []) {
        const tags = Object.fromEntries((mapping.Tags ?? []).map((tag: any) => [String(tag.Key), String(tag.Value)]))
        resources.push(parseResourceArn(String(mapping.ResourceARN), tags))
      }
      paginationToken = result?.PaginationToken || undefined
    } while (paginationToken)
    return resources
  }

  private async ec2Resources(): Promise<CloudResource[]> {
    const request = async (action: string): Promise<any> =>
      this.client.request({
        service: 'ec2',
        region: this.region,
        method: 'POST',
        path: '/',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ Action: action, Version: '2016-11-15' }).toString(),
      })
    const [instancesResult, volumesResult, addressesResult] = await Promise.all([
      request('DescribeInstances'),
      request('DescribeVolumes'),
      request('DescribeAddresses'),
    ])
    const resources: CloudResource[] = []
    for (const reservation of list(instancesResult?.reservationSet?.item)) {
      for (const instance of list((reservation as any)?.instancesSet?.item)) {
        const id = String((instance as any).instanceId)
        resources.push({
          ...parseResourceArn(`arn:aws:ec2:${this.region}::instance/${id}`),
          state: (instance as any).instanceState?.name,
          metadata: { instanceType: (instance as any).instanceType },
        })
      }
    }
    for (const volume of list(volumesResult?.volumeSet?.item)) {
      const id = String((volume as any).volumeId)
      resources.push({
        ...parseResourceArn(`arn:aws:ec2:${this.region}::volume/${id}`),
        state: (volume as any).status,
        metadata: {
          sizeGiB: Number((volume as any).size ?? 0),
          attached: list((volume as any).attachmentSet?.item).length > 0,
        },
      })
    }
    for (const address of list(addressesResult?.addressesSet?.item)) {
      const id = String((address as any).allocationId ?? (address as any).publicIp)
      resources.push({
        ...parseResourceArn(`arn:aws:ec2:${this.region}::elastic-ip/${id}`),
        state: (address as any).associationId ? 'associated' : 'available',
        metadata: { associated: Boolean((address as any).associationId), publicIp: (address as any).publicIp },
      })
    }
    return resources
  }

  private async rdsResources(): Promise<CloudResource[]> {
    const body = new URLSearchParams({ Action: 'DescribeDBInstances', Version: '2014-10-31' }).toString()
    const result = await this.client.request({
      service: 'rds',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    const root = result?.DescribeDBInstancesResult ?? result
    return list(root?.DBInstances?.DBInstance).map((instance: any) => ({
      ...parseResourceArn(
        instance.DBInstanceArn || `arn:aws:rds:${this.region}::db:${String(instance.DBInstanceIdentifier)}`,
      ),
      state: instance.DBInstanceStatus,
      metadata: { engine: instance.Engine, instanceClass: instance.DBInstanceClass },
    }))
  }

  private async lambdaResources(): Promise<CloudResource[]> {
    const resources: CloudResource[] = []
    let marker: string | undefined
    do {
      const result = await this.client.request({
        service: 'lambda',
        region: this.region,
        method: 'GET',
        path: '/2015-03-31/functions',
        queryParams: marker ? { Marker: marker } : undefined,
      })
      for (const fn of result?.Functions ?? []) {
        resources.push({
          ...parseResourceArn(fn.FunctionArn),
          state: fn.State,
          metadata: { runtime: fn.Runtime, memoryMiB: Number(fn.MemorySize ?? 0) },
        })
      }
      marker = result?.NextMarker || undefined
    } while (marker)
    return resources
  }

  private async s3Resources(): Promise<CloudResource[]> {
    const result = await new S3Client('us-east-1', this.profile).listBuckets()
    return result.Buckets.map((bucket) => ({
      ...parseResourceArn(`arn:aws:s3:::${bucket.Name}`),
      metadata: { creationDate: bucket.CreationDate },
    }))
  }

  async discover(options?: { type?: string }): Promise<ResourceInventoryResult> {
    const sources = [
      ['tagging:GetResources', () => this.taggedResources()],
      ['ec2:Describe*', () => this.ec2Resources()],
      ['rds:DescribeDBInstances', () => this.rdsResources()],
      ['lambda:ListFunctions', () => this.lambdaResources()],
      ['s3:ListAllMyBuckets', () => this.s3Resources()],
    ] as const
    const settled = await Promise.allSettled(sources.map(([, load]) => load()))
    const resources: CloudResource[] = []
    const warnings: string[] = []
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') resources.push(...result.value)
      else
        warnings.push(
          `${sources[index][0]} unavailable: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        )
    })
    return { resources: mergeResources(resources, options?.type), warnings }
  }
}
