/**
 * AWS Pinpoint CloudFormation Types
 */

import type { ResourceBase, Tags } from './common'

/**
 * Pinpoint Application
 */
export interface PinpointApp extends ResourceBase {
  Type: 'AWS::Pinpoint::App'
  Properties: {
    Name: string
    Tags?: Record<string, string>
  }
}

/**
 * Pinpoint SMS Channel
 */
export interface PinpointSMSChannel extends ResourceBase {
  Type: 'AWS::Pinpoint::SMSChannel'
  Properties: {
    ApplicationId: string
    Enabled?: boolean
    SenderId?: string
    ShortCode?: string
  }
}

/**
 * Pinpoint Email Channel
 */
export interface PinpointEmailChannel extends ResourceBase {
  Type: 'AWS::Pinpoint::EmailChannel'
  Properties: {
    ApplicationId: string
    FromAddress: string
    Identity: string
    ConfigurationSet?: string
    Enabled?: boolean
    RoleArn?: string
  }
}

/**
 * Pinpoint Voice Channel
 */
export interface PinpointVoiceChannel extends ResourceBase {
  Type: 'AWS::Pinpoint::VoiceChannel'
  Properties: {
    ApplicationId: string
    Enabled?: boolean
  }
}

/**
 * Pinpoint APNs Channel (Apple Push Notifications)
 */
export interface PinpointAPNsChannel extends ResourceBase {
  Type: 'AWS::Pinpoint::APNsChannel'
  Properties: {
    ApplicationId: string
    BundleId?: string
    Certificate?: string
    DefaultAuthenticationMethod?: string
    Enabled?: boolean
    PrivateKey?: string
    TeamId?: string
    TokenKey?: string
    TokenKeyId?: string
  }
}

/**
 * Pinpoint GCM Channel (Google Cloud Messaging / Firebase)
 */
export interface PinpointGCMChannel extends ResourceBase {
  Type: 'AWS::Pinpoint::GCMChannel'
  Properties: {
    ApplicationId: string
    ApiKey?: string
    DefaultAuthenticationMethod?: string
    Enabled?: boolean
    ServiceJson?: string
  }
}

/**
 * Pinpoint Baidu Channel
 */
export interface PinpointBaiduChannel extends ResourceBase {
  Type: 'AWS::Pinpoint::BaiduChannel'
  Properties: {
    ApplicationId: string
    ApiKey: string
    SecretKey: string
    Enabled?: boolean
  }
}

/**
 * Pinpoint ADM Channel (Amazon Device Messaging)
 */
export interface PinpointADMChannel extends ResourceBase {
  Type: 'AWS::Pinpoint::ADMChannel'
  Properties: {
    ApplicationId: string
    ClientId: string
    ClientSecret: string
    Enabled?: boolean
  }
}

/**
 * Pinpoint Campaign
 */
export interface PinpointCampaign extends ResourceBase {
  Type: 'AWS::Pinpoint::Campaign'
  Properties: {
    ApplicationId: string
    Name: string
    SegmentId: string
    MessageConfiguration: {
      SMSMessage?: {
        Body?: string
        MessageType?: 'TRANSACTIONAL' | 'PROMOTIONAL'
        OriginationNumber?: string
        SenderId?: string
        EntityId?: string
        TemplateId?: string
      }
      EmailMessage?: {
        Body?: string
        FromAddress?: string
        HtmlBody?: string
        Title?: string
      }
      DefaultMessage?: {
        Body?: string
        Substitutions?: Record<string, string[]>
      }
      InAppMessage?: {
        Content?: Array<{
          BackgroundColor?: string
          BodyConfig?: {
            Alignment: 'LEFT' | 'CENTER' | 'RIGHT'
            Body: string
            TextColor: string
          }
          HeaderConfig?: {
            Alignment: 'LEFT' | 'CENTER' | 'RIGHT'
            Header: string
            TextColor: string
          }
          ImageUrl?: string
          PrimaryBtn?: {
            DefaultConfig: {
              BackgroundColor?: string
              BorderRadius?: number
              ButtonAction: 'LINK' | 'DEEP_LINK' | 'CLOSE'
              Link?: string
              Text: string
              TextColor?: string
            }
          }
          SecondaryBtn?: {
            DefaultConfig: {
              BackgroundColor?: string
              BorderRadius?: number
              ButtonAction: 'LINK' | 'DEEP_LINK' | 'CLOSE'
              Link?: string
              Text: string
              TextColor?: string
            }
          }
        }>
        Layout?: 'BOTTOM_BANNER' | 'TOP_BANNER' | 'OVERLAYS' | 'MOBILE_FEED' | 'MIDDLE_BANNER' | 'CAROUSEL'
      }
    }
    Schedule: {
      EndTime?: string
      EventFilter?: {
        Dimensions: {
          Attributes?: Record<string, { AttributeType: string; Values: string[] }>
          EventType?: { DimensionType: string; Values: string[] }
          Metrics?: Record<string, { ComparisonOperator: string; Value: number }>
        }
        FilterType: 'SYSTEM' | 'ENDPOINT'
      }
      Frequency?: 'ONCE' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'EVENT' | 'IN_APP_EVENT'
      IsLocalTime?: boolean
      QuietTime?: { End: string; Start: string }
      StartTime?: string
      Timezone?: string
    }
    AdditionalTreatments?: Array<{
      MessageConfiguration: any
      Schedule: any
      SizePercent: number
      TreatmentDescription?: string
      TreatmentName?: string
    }>
    CampaignHook?: {
      LambdaFunctionName?: string
      Mode?: 'DELIVERY' | 'FILTER'
      WebUrl?: string
    }
    CustomDeliveryConfiguration?: {
      DeliveryUri: string
      EndpointTypes?: string[]
    }
    Description?: string
    HoldoutPercent?: number
    IsPaused?: boolean
    Limits?: {
      Daily?: number
      MaximumDuration?: number
      MessagesPerSecond?: number
      Session?: number
      Total?: number
    }
    Priority?: number
    SegmentVersion?: number
    Tags?: Record<string, string>
    TemplateConfiguration?: {
      EmailTemplate?: { Name?: string; Version?: string }
      PushTemplate?: { Name?: string; Version?: string }
      SMSTemplate?: { Name?: string; Version?: string }
      VoiceTemplate?: { Name?: string; Version?: string }
    }
    TreatmentDescription?: string
    TreatmentName?: string
  }
}

/**
 * Pinpoint Segment
 */
export interface PinpointSegment extends ResourceBase {
  Type: 'AWS::Pinpoint::Segment'
  Properties: {
    ApplicationId: string
    Name: string
    Dimensions?: {
      Attributes?: Record<string, { AttributeType: string; Values: string[] }>
      Behavior?: {
        Recency?: {
          Duration: 'HR_24' | 'DAY_7' | 'DAY_14' | 'DAY_30'
          RecencyType: 'ACTIVE' | 'INACTIVE'
        }
      }
      Demographic?: {
        AppVersion?: { DimensionType: string; Values: string[] }
        Channel?: { DimensionType: string; Values: string[] }
        DeviceType?: { DimensionType: string; Values: string[] }
        Make?: { DimensionType: string; Values: string[] }
        Model?: { DimensionType: string; Values: string[] }
        Platform?: { DimensionType: string; Values: string[] }
      }
      Location?: {
        Country?: { DimensionType: string; Values: string[] }
        GPSPoint?: {
          Coordinates: { Latitude: number; Longitude: number }
          RangeInKilometers: number
        }
      }
      Metrics?: Record<string, { ComparisonOperator: string; Value: number }>
      UserAttributes?: Record<string, { AttributeType: string; Values: string[] }>
    }
    SegmentGroups?: {
      Groups?: Array<{
        Dimensions?: any[]
        SourceSegments?: Array<{ Id: string; Version?: number }>
        SourceType?: 'ALL' | 'ANY' | 'NONE'
        Type?: 'ALL' | 'ANY' | 'NONE'
      }>
      Include?: 'ALL' | 'ANY' | 'NONE'
    }
    Tags?: Record<string, string>
  }
}

/**
 * Pinpoint Email Template
 */
export interface PinpointEmailTemplate extends ResourceBase {
  Type: 'AWS::Pinpoint::EmailTemplate'
  Properties: {
    TemplateName: string
    Subject: string
    DefaultSubstitutions?: string
    HtmlPart?: string
    Tags?: Record<string, string>
    TemplateDescription?: string
    TextPart?: string
  }
}

/**
 * Pinpoint SMS Template
 */
export interface PinpointSmsTemplate extends ResourceBase {
  Type: 'AWS::Pinpoint::SmsTemplate'
  Properties: {
    TemplateName: string
    Body: string
    DefaultSubstitutions?: string
    Tags?: Record<string, string>
    TemplateDescription?: string
  }
}

/**
 * Pinpoint Push Template
 */
export interface PinpointPushTemplate extends ResourceBase {
  Type: 'AWS::Pinpoint::PushTemplate'
  Properties: {
    TemplateName: string
    ADM?: {
      Action?: 'OPEN_APP' | 'DEEP_LINK' | 'URL'
      Body?: string
      ImageIconUrl?: string
      ImageUrl?: string
      SmallImageIconUrl?: string
      Sound?: string
      Title?: string
      Url?: string
    }
    APNS?: {
      Action?: 'OPEN_APP' | 'DEEP_LINK' | 'URL'
      Body?: string
      MediaUrl?: string
      Sound?: string
      Title?: string
      Url?: string
    }
    Baidu?: {
      Action?: 'OPEN_APP' | 'DEEP_LINK' | 'URL'
      Body?: string
      ImageIconUrl?: string
      ImageUrl?: string
      SmallImageIconUrl?: string
      Sound?: string
      Title?: string
      Url?: string
    }
    Default?: {
      Action?: 'OPEN_APP' | 'DEEP_LINK' | 'URL'
      Body?: string
      Sound?: string
      Title?: string
      Url?: string
    }
    DefaultSubstitutions?: string
    GCM?: {
      Action?: 'OPEN_APP' | 'DEEP_LINK' | 'URL'
      Body?: string
      ImageIconUrl?: string
      ImageUrl?: string
      SmallImageIconUrl?: string
      Sound?: string
      Title?: string
      Url?: string
    }
    Tags?: Record<string, string>
    TemplateDescription?: string
  }
}

/**
 * Pinpoint In-App Template
 */
export interface PinpointInAppTemplate extends ResourceBase {
  Type: 'AWS::Pinpoint::InAppTemplate'
  Properties: {
    TemplateName: string
    Content?: Array<{
      BackgroundColor?: string
      BodyConfig?: {
        Alignment: 'LEFT' | 'CENTER' | 'RIGHT'
        Body: string
        TextColor: string
      }
      HeaderConfig?: {
        Alignment: 'LEFT' | 'CENTER' | 'RIGHT'
        Header: string
        TextColor: string
      }
      ImageUrl?: string
      PrimaryBtn?: any
      SecondaryBtn?: any
    }>
    CustomConfig?: Record<string, string>
    Layout?: 'BOTTOM_BANNER' | 'TOP_BANNER' | 'OVERLAYS' | 'MOBILE_FEED' | 'MIDDLE_BANNER' | 'CAROUSEL'
    Tags?: Record<string, string>
    TemplateDescription?: string
  }
}

/**
 * Pinpoint Event Stream
 */
export interface PinpointEventStream extends ResourceBase {
  Type: 'AWS::Pinpoint::EventStream'
  Properties: {
    ApplicationId: string
    DestinationStreamArn: string
    RoleArn: string
  }
}

/**
 * Pinpoint Application Settings
 */
export interface PinpointApplicationSettings extends ResourceBase {
  Type: 'AWS::Pinpoint::ApplicationSettings'
  Properties: {
    ApplicationId: string
    CampaignHook?: {
      LambdaFunctionName?: string
      Mode?: 'DELIVERY' | 'FILTER'
      WebUrl?: string
    }
    CloudWatchMetricsEnabled?: boolean
    Limits?: {
      Daily?: number
      MaximumDuration?: number
      MessagesPerSecond?: number
      Total?: number
    }
    QuietTime?: {
      End: string
      Start: string
    }
  }
}
