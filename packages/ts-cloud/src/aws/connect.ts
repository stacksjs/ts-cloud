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

  // ==================== Outbound Calls ====================

  /**
   * Start an outbound voice contact (make a call)
  */
  async startOutboundVoiceContact(params: {
    InstanceId: string
    ContactFlowId: string
    DestinationPhoneNumber: string
    SourcePhoneNumber?: string
    QueueId?: string
    Attributes?: Record<string, string>
    AnswerMachineDetectionConfig?: {
      EnableAnswerMachineDetection?: boolean
      AwaitAnswerMachinePrompt?: boolean
    }
    CampaignId?: string
    TrafficType?: 'GENERAL' | 'CAMPAIGN'
    ClientToken?: string
  }): Promise<{ ContactId?: string }> {
    const body: Record<string, any> = {
      ContactFlowId: params.ContactFlowId,
      DestinationPhoneNumber: params.DestinationPhoneNumber,
    }

    if (params.SourcePhoneNumber) body.SourcePhoneNumber = params.SourcePhoneNumber
    if (params.QueueId) body.QueueId = params.QueueId
    if (params.Attributes) body.Attributes = params.Attributes
    if (params.AnswerMachineDetectionConfig) body.AnswerMachineDetectionConfig = params.AnswerMachineDetectionConfig
    if (params.CampaignId) body.CampaignId = params.CampaignId
    if (params.TrafficType) body.TrafficType = params.TrafficType
    if (params.ClientToken) body.ClientToken = params.ClientToken

    const result = await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'PUT',
      path: `/contact/outbound-voice/${params.InstanceId}`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    return result
  }

  /**
   * Make a simple outbound call (convenience method)
  */
  async makeCall(params: {
    instanceId: string
    contactFlowId: string
    to: string
    from?: string
    attributes?: Record<string, string>
  }): Promise<{ ContactId?: string }> {
    return this.startOutboundVoiceContact({
      InstanceId: params.instanceId,
      ContactFlowId: params.contactFlowId,
      DestinationPhoneNumber: params.to,
      SourcePhoneNumber: params.from,
      Attributes: params.attributes,
    })
  }

  /**
   * Stop a contact (end a call)
  */
  async stopContact(params: {
    InstanceId: string
    ContactId: string
  }): Promise<void> {
    await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'POST',
      path: `/contact/stop/${params.InstanceId}/${params.ContactId}`,
    })
  }

  /**
   * Get contact details
  */
  async describeContact(params: {
    InstanceId: string
    ContactId: string
  }): Promise<{
    Contact?: {
      Arn?: string
      Id?: string
      InitialContactId?: string
      PreviousContactId?: string
      InitiationMethod?: 'INBOUND' | 'OUTBOUND' | 'TRANSFER' | 'QUEUE_TRANSFER' | 'CALLBACK' | 'API' | 'DISCONNECT' | 'MONITOR' | 'EXTERNAL_OUTBOUND'
      Name?: string
      Description?: string
      Channel?: 'VOICE' | 'CHAT' | 'TASK'
      QueueInfo?: {
        Id?: string
        EnqueueTimestamp?: string
      }
      AgentInfo?: {
        Id?: string
        ConnectedToAgentTimestamp?: string
      }
      InitiationTimestamp?: string
      DisconnectTimestamp?: string
      ScheduledTimestamp?: string
    }
  }> {
    return this.client.request({
      service: 'connect',
      region: this.region,
      method: 'GET',
      path: `/contacts/${params.InstanceId}/${params.ContactId}`,
    })
  }

  /**
   * Update contact attributes
  */
  async updateContactAttributes(params: {
    InstanceId: string
    InitialContactId: string
    Attributes: Record<string, string>
  }): Promise<void> {
    await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'POST',
      path: `/contact/attributes/${params.InstanceId}`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        InitialContactId: params.InitialContactId,
        Attributes: params.Attributes,
      }),
    })
  }

  // ==================== Users/Agents ====================

  /**
   * Create a user (agent)
  */
  async createUser(params: {
    InstanceId: string
    Username: string
    Password?: string
    IdentityInfo?: {
      FirstName?: string
      LastName?: string
      Email?: string
      SecondaryEmail?: string
      Mobile?: string
    }
    PhoneConfig: {
      PhoneType: 'SOFT_PHONE' | 'DESK_PHONE'
      AutoAccept?: boolean
      AfterContactWorkTimeLimit?: number
      DeskPhoneNumber?: string
    }
    DirectoryUserId?: string
    SecurityProfileIds: string[]
    RoutingProfileId: string
    HierarchyGroupId?: string
    Tags?: Record<string, string>
  }): Promise<{ UserId?: string, UserArn?: string }> {
    const body: Record<string, any> = {
      Username: params.Username,
      PhoneConfig: params.PhoneConfig,
      SecurityProfileIds: params.SecurityProfileIds,
      RoutingProfileId: params.RoutingProfileId,
    }

    if (params.Password) body.Password = params.Password
    if (params.IdentityInfo) body.IdentityInfo = params.IdentityInfo
    if (params.DirectoryUserId) body.DirectoryUserId = params.DirectoryUserId
    if (params.HierarchyGroupId) body.HierarchyGroupId = params.HierarchyGroupId
    if (params.Tags) body.Tags = params.Tags

    return this.client.request({
      service: 'connect',
      region: this.region,
      method: 'PUT',
      path: `/users/${params.InstanceId}`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  }

  /**
   * Delete a user
  */
  async deleteUser(params: {
    InstanceId: string
    UserId: string
  }): Promise<void> {
    await this.client.request({
      service: 'connect',
      region: this.region,
      method: 'DELETE',
      path: `/users/${params.InstanceId}/${params.UserId}`,
    })
  }

  /**
   * List users
  */
  async listUsers(params: {
    InstanceId: string
    NextToken?: string
    MaxResults?: number
  }): Promise<{
    UserSummaryList?: Array<{
      Id?: string
      Arn?: string
      Username?: string
    }>
    NextToken?: string
  }> {
    const queryParams: Record<string, string> = {}
    if (params.NextToken) queryParams.nextToken = params.NextToken
    if (params.MaxResults) queryParams.maxResults = String(params.MaxResults)

    return this.client.request({
      service: 'connect',
      region: this.region,
      method: 'GET',
      path: `/users-summary/${params.InstanceId}`,
      queryParams,
    })
  }

  // ==================== Prompts ====================

  /**
   * Create a prompt (audio file for IVR)
  */
  async createPrompt(params: {
    InstanceId: string
    Name: string
    S3Uri: string
    Description?: string
    Tags?: Record<string, string>
  }): Promise<{ PromptId?: string, PromptArn?: string }> {
    const body: Record<string, any> = {
      Name: params.Name,
      S3Uri: params.S3Uri,
    }

    if (params.Description) body.Description = params.Description
    if (params.Tags) body.Tags = params.Tags

    return this.client.request({
      service: 'connect',
      region: this.region,
      method: 'PUT',
      path: `/prompts/${params.InstanceId}`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  }

  /**
   * List prompts
  */
  async listPrompts(params: {
    InstanceId: string
    NextToken?: string
    MaxResults?: number
  }): Promise<{
    PromptSummaryList?: Array<{
      Id?: string
      Arn?: string
      Name?: string
    }>
    NextToken?: string
  }> {
    const queryParams: Record<string, string> = {}
    if (params.NextToken) queryParams.nextToken = params.NextToken
    if (params.MaxResults) queryParams.maxResults = String(params.MaxResults)

    return this.client.request({
      service: 'connect',
      region: this.region,
      method: 'GET',
      path: `/prompts-summary/${params.InstanceId}`,
      queryParams,
    })
  }

  // ==================== Quick Connects ====================

  /**
   * Create a quick connect (for transfers)
  */
  async createQuickConnect(params: {
    InstanceId: string
    Name: string
    Description?: string
    QuickConnectConfig: {
      QuickConnectType: 'USER' | 'QUEUE' | 'PHONE_NUMBER'
      UserConfig?: {
        UserId: string
        ContactFlowId: string
      }
      QueueConfig?: {
        QueueId: string
        ContactFlowId: string
      }
      PhoneConfig?: {
        PhoneNumber: string
      }
    }
    Tags?: Record<string, string>
  }): Promise<{ QuickConnectId?: string, QuickConnectArn?: string }> {
    const body: Record<string, any> = {
      Name: params.Name,
      QuickConnectConfig: params.QuickConnectConfig,
    }

    if (params.Description) body.Description = params.Description
    if (params.Tags) body.Tags = params.Tags

    return this.client.request({
      service: 'connect',
      region: this.region,
      method: 'PUT',
      path: `/quick-connects/${params.InstanceId}`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  }

  // ==================== Chat/Tasks ====================

  /**
   * Start a chat contact
  */
  async startChatContact(params: {
    InstanceId: string
    ContactFlowId: string
    ParticipantDetails: {
      DisplayName: string
    }
    Attributes?: Record<string, string>
    InitialMessage?: {
      ContentType: string
      Content: string
    }
    ClientToken?: string
    ChatDurationInMinutes?: number
    SupportedMessagingContentTypes?: string[]
  }): Promise<{
    ContactId?: string
    ParticipantId?: string
    ParticipantToken?: string
  }> {
    return this.client.request({
      service: 'connect',
      region: this.region,
      method: 'PUT',
      path: `/contact/chat/${params.InstanceId}`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Start a task contact
  */
  async startTaskContact(params: {
    InstanceId: string
    ContactFlowId?: string
    PreviousContactId?: string
    Attributes?: Record<string, string>
    Name: string
    Description?: string
    References?: Record<string, {
      Value: string
      Type: 'URL' | 'ATTACHMENT' | 'NUMBER' | 'STRING' | 'DATE' | 'EMAIL'
    }>
    ClientToken?: string
    ScheduledTime?: string
    TaskTemplateId?: string
    QuickConnectId?: string
    RelatedContactId?: string
  }): Promise<{ ContactId?: string }> {
    return this.client.request({
      service: 'connect',
      region: this.region,
      method: 'PUT',
      path: `/contact/task/${params.InstanceId}`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })
  }

  // ==================== Contact Flow Modules ====================

  /**
   * Create a simple IVR contact flow for outbound calls
  */
  createOutboundIvrFlow(params: {
    message: string
    voiceId?: string
  }): string {
    const voiceId = params.voiceId || 'Joanna'
    return JSON.stringify({
      Version: '2019-10-30',
      StartAction: 'play-prompt',
      Actions: {
        'play-prompt': {
          Type: 'MessageParticipant',
          Parameters: {
            Text: params.message,
            TextToSpeechVoice: voiceId,
            TextToSpeechEngine: 'neural',
          },
          Transitions: {
            NextAction: 'disconnect',
            Errors: [
              { NextAction: 'disconnect', ErrorType: 'NoMatchingError' },
            ],
          },
        },
        'disconnect': {
          Type: 'DisconnectParticipant',
          Parameters: {},
          Transitions: {},
        },
      },
    })
  }

  /**
   * Create a contact flow with input collection
  */
  createInputCollectionFlow(params: {
    promptMessage: string
    inputTimeout?: number
    maxDigits?: number
    successNextAction?: string
    voiceId?: string
  }): string {
    const voiceId = params.voiceId || 'Joanna'
    const timeout = params.inputTimeout || 5
    const maxDigits = params.maxDigits || 1

    return JSON.stringify({
      Version: '2019-10-30',
      StartAction: 'get-input',
      Actions: {
        'get-input': {
          Type: 'GetParticipantInput',
          Parameters: {
            Text: params.promptMessage,
            TextToSpeechVoice: voiceId,
            TextToSpeechEngine: 'neural',
            InputTimeLimitSeconds: String(timeout),
            MaxDigits: maxDigits,
            EncryptEntry: false,
          },
          Transitions: {
            NextAction: params.successNextAction || 'disconnect',
            Conditions: [],
            Errors: [
              { NextAction: 'disconnect', ErrorType: 'NoMatchingCondition' },
              { NextAction: 'disconnect', ErrorType: 'NoMatchingError' },
            ],
          },
        },
        'disconnect': {
          Type: 'DisconnectParticipant',
          Parameters: {},
          Transitions: {},
        },
      },
    })
  }

  // ==================== Metrics ====================

  /**
   * Get current metric data
  */
  async getCurrentMetricData(params: {
    InstanceId: string
    Filters: {
      Queues?: string[]
      Channels?: Array<'VOICE' | 'CHAT' | 'TASK'>
      RoutingProfiles?: string[]
    }
    CurrentMetrics: Array<{
      Name: 'AGENTS_ONLINE' | 'AGENTS_AVAILABLE' | 'AGENTS_ON_CALL' | 'AGENTS_NON_PRODUCTIVE' | 'AGENTS_AFTER_CONTACT_WORK' | 'AGENTS_ERROR' | 'AGENTS_STAFFED' | 'CONTACTS_IN_QUEUE' | 'OLDEST_CONTACT_AGE' | 'CONTACTS_SCHEDULED' | 'AGENTS_ON_CONTACT' | 'SLOTS_ACTIVE' | 'SLOTS_AVAILABLE'
      Unit?: 'SECONDS' | 'COUNT' | 'PERCENT'
    }>
    Groupings?: Array<'QUEUE' | 'CHANNEL' | 'ROUTING_PROFILE'>
    MaxResults?: number
    NextToken?: string
  }): Promise<{
    MetricResults?: Array<{
      Dimensions?: {
        Queue?: { Id?: string; Arn?: string }
        Channel?: 'VOICE' | 'CHAT' | 'TASK'
      }
      Collections?: Array<{
        Metric?: { Name?: string; Unit?: string }
        Value?: number
      }>
    }>
    NextToken?: string
    ApproximateTotalCount?: number
  }> {
    return this.client.request({
      service: 'connect',
      region: this.region,
      method: 'POST',
      path: `/metrics/current/${params.InstanceId}`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })
  }
}
