/**
 * AWS Amazon Connect CloudFormation Types
 */

import type { ResourceBase, Tags } from './common'

/**
 * Amazon Connect Instance
 */
export interface ConnectInstance extends ResourceBase {
  Type: 'AWS::Connect::Instance'
  Properties: {
    InstanceAlias: string
    IdentityManagementType: 'SAML' | 'CONNECT_MANAGED' | 'EXISTING_DIRECTORY'
    Attributes: {
      InboundCalls: boolean
      OutboundCalls: boolean
      ContactflowLogs?: boolean
      ContactLens?: boolean
      AutoResolveBestVoices?: boolean
      UseCustomTTSVoices?: boolean
      EarlyMedia?: boolean
    }
    DirectoryId?: string
    Tags?: Tags
  }
}

/**
 * Amazon Connect Hours of Operation
 */
export interface ConnectHoursOfOperation extends ResourceBase {
  Type: 'AWS::Connect::HoursOfOperation'
  Properties: {
    InstanceArn: string
    Name: string
    TimeZone: string
    Config: Array<{
      Day: 'SUNDAY' | 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY'
      StartTime: { Hours: number; Minutes: number }
      EndTime: { Hours: number; Minutes: number }
    }>
    Description?: string
    Tags?: Tags
  }
}

/**
 * Amazon Connect Queue
 */
export interface ConnectQueue extends ResourceBase {
  Type: 'AWS::Connect::Queue'
  Properties: {
    InstanceArn: string
    Name: string
    HoursOfOperationArn: string
    Description?: string
    MaxContacts?: number
    OutboundCallerConfig?: {
      OutboundCallerIdName?: string
      OutboundCallerIdNumberId?: string
      OutboundFlowId?: string
    }
    QuickConnectArns?: string[]
    Status?: 'ENABLED' | 'DISABLED'
    Tags?: Tags
  }
}

/**
 * Amazon Connect Contact Flow
 */
export interface ConnectContactFlow extends ResourceBase {
  Type: 'AWS::Connect::ContactFlow'
  Properties: {
    InstanceArn: string
    Name: string
    Type: 'CONTACT_FLOW' | 'CUSTOMER_QUEUE' | 'CUSTOMER_HOLD' | 'CUSTOMER_WHISPER' | 'AGENT_HOLD' | 'AGENT_WHISPER' | 'OUTBOUND_WHISPER' | 'AGENT_TRANSFER' | 'QUEUE_TRANSFER'
    Content: string
    Description?: string
    State?: 'ACTIVE' | 'ARCHIVED'
    Tags?: Tags
  }
}

/**
 * Amazon Connect Contact Flow Module
 */
export interface ConnectContactFlowModule extends ResourceBase {
  Type: 'AWS::Connect::ContactFlowModule'
  Properties: {
    InstanceArn: string
    Name: string
    Content: string
    Description?: string
    State?: 'ACTIVE' | 'ARCHIVED'
    Tags?: Tags
  }
}

/**
 * Amazon Connect Phone Number
 */
export interface ConnectPhoneNumber extends ResourceBase {
  Type: 'AWS::Connect::PhoneNumber'
  Properties: {
    TargetArn: string
    Type: 'TOLL_FREE' | 'DID' | 'UIFN' | 'SHARED' | 'THIRD_PARTY_TF' | 'THIRD_PARTY_DID'
    CountryCode: string
    Description?: string
    Prefix?: string
    Tags?: Tags
  }
}

/**
 * Amazon Connect Routing Profile
 */
export interface ConnectRoutingProfile extends ResourceBase {
  Type: 'AWS::Connect::RoutingProfile'
  Properties: {
    InstanceArn: string
    Name: string
    DefaultOutboundQueueArn: string
    MediaConcurrencies: Array<{
      Channel: 'VOICE' | 'CHAT' | 'TASK'
      Concurrency: number
      CrossChannelBehavior?: {
        BehaviorType: 'ROUTE_CURRENT_CHANNEL_ONLY' | 'ROUTE_ANY_CHANNEL'
      }
    }>
    Description?: string
    QueueConfigs?: Array<{
      QueueReference: {
        QueueArn: string
        Channel: 'VOICE' | 'CHAT' | 'TASK'
      }
      Priority: number
      Delay: number
    }>
    Tags?: Tags
  }
}

/**
 * Amazon Connect User
 */
export interface ConnectUser extends ResourceBase {
  Type: 'AWS::Connect::User'
  Properties: {
    InstanceArn: string
    Username: string
    PhoneConfig: {
      PhoneType: 'SOFT_PHONE' | 'DESK_PHONE'
      AutoAccept?: boolean
      AfterContactWorkTimeLimit?: number
      DeskPhoneNumber?: string
    }
    RoutingProfileArn: string
    SecurityProfileArns: string[]
    DirectoryUserId?: string
    HierarchyGroupArn?: string
    IdentityInfo?: {
      Email?: string
      FirstName?: string
      LastName?: string
      Mobile?: string
      SecondaryEmail?: string
    }
    Password?: string
    Tags?: Tags
  }
}

/**
 * Amazon Connect Quick Connect
 */
export interface ConnectQuickConnect extends ResourceBase {
  Type: 'AWS::Connect::QuickConnect'
  Properties: {
    InstanceArn: string
    Name: string
    QuickConnectConfig: {
      QuickConnectType: 'USER' | 'QUEUE' | 'PHONE_NUMBER'
      UserConfig?: {
        ContactFlowArn: string
        UserArn: string
      }
      QueueConfig?: {
        ContactFlowArn: string
        QueueArn: string
      }
      PhoneConfig?: {
        PhoneNumber: string
      }
    }
    Description?: string
    Tags?: Tags
  }
}

/**
 * Amazon Connect Integration Association
 */
export interface ConnectIntegrationAssociation extends ResourceBase {
  Type: 'AWS::Connect::IntegrationAssociation'
  Properties: {
    InstanceId: string
    IntegrationArn: string
    IntegrationType: 'LEX_BOT' | 'LAMBDA_FUNCTION' | 'APPLICATION'
  }
}

/**
 * Amazon Connect Task Template
 */
export interface ConnectTaskTemplate extends ResourceBase {
  Type: 'AWS::Connect::TaskTemplate'
  Properties: {
    InstanceArn: string
    Name: string
    Fields?: Array<{
      Id: { Name: string }
      Type: 'NAME' | 'DESCRIPTION' | 'SCHEDULED_TIME' | 'QUICK_CONNECT' | 'URL' | 'NUMBER' | 'TEXT' | 'TEXT_AREA' | 'DATE_TIME' | 'BOOLEAN' | 'SINGLE_SELECT' | 'EMAIL'
      Description?: string
      SingleSelectOptions?: string[]
    }>
    Constraints?: {
      RequiredFields?: Array<{ Id: { Name: string } }>
      ReadOnlyFields?: Array<{ Id: { Name: string } }>
      InvisibleFields?: Array<{ Id: { Name: string } }>
    }
    Defaults?: Array<{
      Id: { Name: string }
      DefaultValue: string
    }>
    Description?: string
    ContactFlowArn?: string
    Status?: 'ACTIVE' | 'INACTIVE'
    ClientToken?: string
    Tags?: Tags
  }
}
