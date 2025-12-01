/**
 * AWS Amazon Connect Operations
 * Direct API calls without AWS SDK dependency
 */

import { AWSClient } from './client'

export interface ConnectInstance {
  Id?: string
  Arn?: string
  IdentityManagementType?: 'SAML' | 'CONNECT_MANAGED' | 'EXISTING_DIRECTORY'
  InstanceAlias?: string
  CreatedTime?: string
  ServiceRole?: string
  InstanceStatus?: 'CREATION_IN_PROGRESS' | 'ACTIVE' | 'CREATION_FAILED'
  InboundCallsEnabled?: boolean
  OutboundCallsEnabled?: boolean
}

export interface PhoneNumber {
  PhoneNumberId?: string
  PhoneNumberArn?: string
  PhoneNumber?: string
  PhoneNumberCountryCode?: string
  PhoneNumberType?: 'TOLL_FREE' | 'DID' | 'UIFN' | 'SHARED' | 'THIRD_PARTY_TF' | 'THIRD_PARTY_DID'
  PhoneNumberDescription?: string
  TargetArn?: string
  InstanceId?: string
  Tags?: Record<string, string>
}

export interface ContactFlow {
  Id?: string
  Arn?: string
  Name?: string
  Type?: 'CONTACT_FLOW' | 'CUSTOMER_QUEUE' | 'CUSTOMER_HOLD' | 'CUSTOMER_WHISPER' | 'AGENT_HOLD' | 'AGENT_WHISPER' | 'OUTBOUND_WHISPER' | 'AGENT_TRANSFER' | 'QUEUE_TRANSFER'
  State?: 'ACTIVE' | 'ARCHIVED'
  Description?: string
  Content?: string
  Tags?: Record<string, string>
}

export interface Queue {
  QueueId?: string
  QueueArn?: string
  Name?: string
  Description?: string
  HoursOfOperationId?: string
  MaxContacts?: number
  Status?: 'ENABLED' | 'DISABLED'
  Tags?: Record<string, string>
}

export interface AvailablePhoneNumber {
  PhoneNumber?: string
  PhoneNumberCountryCode?: string
  PhoneNumberType?: string
}

/**
 * Amazon Connect client for phone/voice operations
 */
export class ConnectClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Create a new Amazon Connect instance
   */
  async createInstance(params: {
    InstanceAlias: string
    IdentityManagementType?: 'SAML' | 'CONNECT_MANAGED' | 'EXISTING_DIRECTORY'
    InboundCallsEnabled?: boolean
    OutboundCallsEnabled?: boolean
    DirectoryId?: string
    ClientToken?: string
    Tags?: Record<string, string>
  }): Promise<{ Id?: string, Arn?: string }> {
    const body: Record<string, any> = {
      InstanceAlias: params.InstanceAlias,
      IdentityManagementType: params.IdentityManagementType || 'CONNECT_MANAGED',
      InboundCallsEnabled: params.InboundCallsEnabled ?? true,
      OutboundCallsEnabled: params.OutboundCallsEnabled ?? true,
    }

    if (params.DirectoryId) body.DirectoryId = params.DirectoryId
    if (params.ClientToken) body.ClientToken = params.ClientToken
    if (params.Tags) body.Tags = params.Tags

    const result = await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'PUT',
      path: '/instance',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    return result
  }

  /**
   * Delete an Amazon Connect instance
   */
  async deleteInstance(instanceId: string): Promise<void> {
    await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'DELETE',
      path: `/instance/${instanceId}`,
    })
  }

  /**
   * Get instance details
   */
  async describeInstance(instanceId: string): Promise<ConnectInstance> {
    const result = await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'GET',
      path: `/instance/${instanceId}`,
    })

    return result.Instance || result
  }

  /**
   * List all Connect instances
   */
  async listInstances(params?: {
    MaxResults?: number
    NextToken?: string
  }): Promise<{ InstanceSummaryList?: ConnectInstance[], NextToken?: string }> {
    const queryParams: Record<string, string> = {}
    if (params?.MaxResults) queryParams.maxResults = String(params.MaxResults)
    if (params?.NextToken) queryParams.nextToken = params.NextToken

    const result = await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'GET',
      path: '/instance',
      queryParams,
    })

    return result
  }

  /**
   * Search for available phone numbers
   */
  async searchAvailablePhoneNumbers(params: {
    TargetArn: string
    PhoneNumberCountryCode: string
    PhoneNumberType: 'TOLL_FREE' | 'DID' | 'UIFN'
    PhoneNumberPrefix?: string
    MaxResults?: number
    NextToken?: string
  }): Promise<{ AvailableNumbersList?: AvailablePhoneNumber[], NextToken?: string }> {
    const body: Record<string, any> = {
      TargetArn: params.TargetArn,
      PhoneNumberCountryCode: params.PhoneNumberCountryCode,
      PhoneNumberType: params.PhoneNumberType,
    }

    if (params.PhoneNumberPrefix) body.PhoneNumberPrefix = params.PhoneNumberPrefix
    if (params.MaxResults) body.MaxResults = params.MaxResults
    if (params.NextToken) body.NextToken = params.NextToken

    const result = await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'POST',
      path: '/phone-number/search-available',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    return result
  }

  /**
   * Claim a phone number
   */
  async claimPhoneNumber(params: {
    TargetArn: string
    PhoneNumber: string
    PhoneNumberDescription?: string
    Tags?: Record<string, string>
    ClientToken?: string
  }): Promise<{ PhoneNumberId?: string, PhoneNumberArn?: string }> {
    const body: Record<string, any> = {
      TargetArn: params.TargetArn,
      PhoneNumber: params.PhoneNumber,
    }

    if (params.PhoneNumberDescription) body.PhoneNumberDescription = params.PhoneNumberDescription
    if (params.Tags) body.Tags = params.Tags
    if (params.ClientToken) body.ClientToken = params.ClientToken

    const result = await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'POST',
      path: '/phone-number/claim',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    return result
  }

  /**
   * Release a phone number
   */
  async releasePhoneNumber(phoneNumberId: string, clientToken?: string): Promise<void> {
    const queryParams: Record<string, string> = {}
    if (clientToken) queryParams.clientToken = clientToken

    await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'DELETE',
      path: `/phone-number/${phoneNumberId}`,
      queryParams,
    })
  }

  /**
   * List phone numbers for an instance
   */
  async listPhoneNumbers(params: {
    TargetArn?: string
    InstanceId?: string
    PhoneNumberTypes?: string[]
    PhoneNumberCountryCodes?: string[]
    MaxResults?: number
    NextToken?: string
  }): Promise<{ ListPhoneNumbersSummaryList?: PhoneNumber[], NextToken?: string }> {
    const body: Record<string, any> = {}

    if (params.TargetArn) body.TargetArn = params.TargetArn
    if (params.InstanceId) body.InstanceId = params.InstanceId
    if (params.PhoneNumberTypes) body.PhoneNumberTypes = params.PhoneNumberTypes
    if (params.PhoneNumberCountryCodes) body.PhoneNumberCountryCodes = params.PhoneNumberCountryCodes
    if (params.MaxResults) body.MaxResults = params.MaxResults
    if (params.NextToken) body.NextToken = params.NextToken

    const result = await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'POST',
      path: '/phone-number/list',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    return result
  }

  /**
   * Create a contact flow
   */
  async createContactFlow(params: {
    InstanceId: string
    Name: string
    Type: 'CONTACT_FLOW' | 'CUSTOMER_QUEUE' | 'CUSTOMER_HOLD' | 'CUSTOMER_WHISPER' | 'AGENT_HOLD' | 'AGENT_WHISPER' | 'OUTBOUND_WHISPER' | 'AGENT_TRANSFER' | 'QUEUE_TRANSFER'
    Content: string
    Description?: string
    Tags?: Record<string, string>
  }): Promise<{ ContactFlowId?: string, ContactFlowArn?: string }> {
    const body: Record<string, any> = {
      Name: params.Name,
      Type: params.Type,
      Content: params.Content,
    }

    if (params.Description) body.Description = params.Description
    if (params.Tags) body.Tags = params.Tags

    const result = await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'PUT',
      path: `/contact-flows/${params.InstanceId}`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    return result
  }

  /**
   * Update contact flow content
   */
  async updateContactFlowContent(params: {
    InstanceId: string
    ContactFlowId: string
    Content: string
  }): Promise<void> {
    await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'POST',
      path: `/contact-flows/${params.InstanceId}/${params.ContactFlowId}/content`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ Content: params.Content }),
    })
  }

  /**
   * List contact flows
   */
  async listContactFlows(params: {
    InstanceId: string
    ContactFlowTypes?: string[]
    MaxResults?: number
    NextToken?: string
  }): Promise<{ ContactFlowSummaryList?: ContactFlow[], NextToken?: string }> {
    const queryParams: Record<string, string> = {}
    if (params.ContactFlowTypes) queryParams.contactFlowTypes = params.ContactFlowTypes.join(',')
    if (params.MaxResults) queryParams.maxResults = String(params.MaxResults)
    if (params.NextToken) queryParams.nextToken = params.NextToken

    const result = await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'GET',
      path: `/contact-flows-summary/${params.InstanceId}`,
      queryParams,
    })

    return result
  }

  /**
   * Create a queue
   */
  async createQueue(params: {
    InstanceId: string
    Name: string
    Description?: string
    HoursOfOperationId: string
    MaxContacts?: number
    OutboundCallerConfig?: {
      OutboundCallerIdName?: string
      OutboundCallerIdNumberId?: string
      OutboundFlowId?: string
    }
    Tags?: Record<string, string>
  }): Promise<{ QueueId?: string, QueueArn?: string }> {
    const body: Record<string, any> = {
      Name: params.Name,
      HoursOfOperationId: params.HoursOfOperationId,
    }

    if (params.Description) body.Description = params.Description
    if (params.MaxContacts) body.MaxContacts = params.MaxContacts
    if (params.OutboundCallerConfig) body.OutboundCallerConfig = params.OutboundCallerConfig
    if (params.Tags) body.Tags = params.Tags

    const result = await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'PUT',
      path: `/queues/${params.InstanceId}`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    return result
  }

  /**
   * Create hours of operation
   */
  async createHoursOfOperation(params: {
    InstanceId: string
    Name: string
    TimeZone: string
    Config: Array<{
      Day: 'SUNDAY' | 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY'
      StartTime: { Hours: number, Minutes: number }
      EndTime: { Hours: number, Minutes: number }
    }>
    Description?: string
    Tags?: Record<string, string>
  }): Promise<{ HoursOfOperationId?: string, HoursOfOperationArn?: string }> {
    const body: Record<string, any> = {
      Name: params.Name,
      TimeZone: params.TimeZone,
      Config: params.Config,
    }

    if (params.Description) body.Description = params.Description
    if (params.Tags) body.Tags = params.Tags

    const result = await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'PUT',
      path: `/hours-of-operations/${params.InstanceId}`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    return result
  }

  /**
   * Associate phone number with contact flow
   */
  async associatePhoneNumberContactFlow(params: {
    PhoneNumberId: string
    InstanceId: string
    ContactFlowId: string
  }): Promise<void> {
    await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'PUT',
      path: `/phone-number/${params.PhoneNumberId}/contact-flow`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        InstanceId: params.InstanceId,
        ContactFlowId: params.ContactFlowId,
      }),
    })
  }

  /**
   * Create a routing profile
   */
  async createRoutingProfile(params: {
    InstanceId: string
    Name: string
    Description?: string
    DefaultOutboundQueueId: string
    MediaConcurrencies: Array<{
      Channel: 'VOICE' | 'CHAT' | 'TASK'
      Concurrency: number
      CrossChannelBehavior?: {
        BehaviorType: 'ROUTE_CURRENT_CHANNEL_ONLY' | 'ROUTE_ANY_CHANNEL'
      }
    }>
    QueueConfigs?: Array<{
      QueueReference: {
        QueueId: string
        Channel: 'VOICE' | 'CHAT' | 'TASK'
      }
      Priority: number
      Delay: number
    }>
    Tags?: Record<string, string>
  }): Promise<{ RoutingProfileId?: string, RoutingProfileArn?: string }> {
    const body: Record<string, any> = {
      Name: params.Name,
      DefaultOutboundQueueId: params.DefaultOutboundQueueId,
      MediaConcurrencies: params.MediaConcurrencies,
    }

    if (params.Description) body.Description = params.Description
    if (params.QueueConfigs) body.QueueConfigs = params.QueueConfigs
    if (params.Tags) body.Tags = params.Tags

    const result = await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'PUT',
      path: `/routing-profiles/${params.InstanceId}`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    return result
  }

  /**
   * Check if an instance exists by alias
   */
  async instanceExists(instanceAlias: string): Promise<boolean> {
    try {
      const result = await this.listInstances({ MaxResults: 100 })
      return result.InstanceSummaryList?.some(
        instance => instance.InstanceAlias === instanceAlias
      ) || false
    }
    catch {
      return false
    }
  }
}
