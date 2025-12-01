/**
 * AWS Pinpoint Operations
 * Direct API calls for SMS and push notifications
 */

import { AWSClient } from './client'

export interface PinpointApp {
  Id?: string
  Arn?: string
  Name?: string
  CreationDate?: string
  Tags?: Record<string, string>
}

export interface SmsChannelResponse {
  ApplicationId?: string
  CreationDate?: string
  Enabled?: boolean
  Id?: string
  IsArchived?: boolean
  LastModifiedDate?: string
  Platform?: string
  SenderId?: string
  ShortCode?: string
  Version?: number
}

export interface MessageResult {
  DeliveryStatus?: 'SUCCESSFUL' | 'THROTTLED' | 'TEMPORARY_FAILURE' | 'PERMANENT_FAILURE' | 'UNKNOWN_FAILURE' | 'OPT_OUT' | 'DUPLICATE'
  MessageId?: string
  StatusCode?: number
  StatusMessage?: string
  UpdatedToken?: string
}

export interface SendMessagesResponse {
  ApplicationId?: string
  RequestId?: string
  Result?: Record<string, MessageResult>
}

/**
 * AWS Pinpoint client for SMS and push notifications
 */
export class PinpointClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Create a Pinpoint application
   */
  async createApp(params: {
    Name: string
    Tags?: Record<string, string>
  }): Promise<PinpointApp> {
    const result = await this.client.request({
      service: 'pinpoint',
      region: this.region,
      method: 'POST',
      path: '/v1/apps',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        CreateApplicationRequest: {
          Name: params.Name,
          tags: params.Tags,
        },
      }),
    })

    return result.ApplicationResponse || result
  }

  /**
   * Delete a Pinpoint application
   */
  async deleteApp(applicationId: string): Promise<void> {
    await this.client.request({
      service: 'pinpoint',
      region: this.region,
      method: 'DELETE',
      path: `/v1/apps/${applicationId}`,
    })
  }

  /**
   * Get application details
   */
  async getApp(applicationId: string): Promise<PinpointApp> {
    const result = await this.client.request({
      service: 'pinpoint',
      region: this.region,
      method: 'GET',
      path: `/v1/apps/${applicationId}`,
    })

    return result.ApplicationResponse || result
  }

  /**
   * List all Pinpoint applications
   */
  async listApps(params?: {
    PageSize?: number
    Token?: string
  }): Promise<{ Item?: PinpointApp[], NextToken?: string }> {
    const queryParams: Record<string, string> = {}
    if (params?.PageSize) queryParams['page-size'] = String(params.PageSize)
    if (params?.Token) queryParams.token = params.Token

    const result = await this.client.request({
      service: 'pinpoint',
      region: this.region,
      method: 'GET',
      path: '/v1/apps',
      queryParams,
    })

    return result.ApplicationsResponse || result
  }

  /**
   * Update SMS channel settings
   */
  async updateSmsChannel(params: {
    ApplicationId: string
    Enabled?: boolean
    SenderId?: string
    ShortCode?: string
  }): Promise<SmsChannelResponse> {
    const body: Record<string, any> = {}
    if (params.Enabled !== undefined) body.Enabled = params.Enabled
    if (params.SenderId) body.SenderId = params.SenderId
    if (params.ShortCode) body.ShortCode = params.ShortCode

    const result = await this.client.request({
      service: 'pinpoint',
      region: this.region,
      method: 'PUT',
      path: `/v1/apps/${params.ApplicationId}/channels/sms`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ SMSChannelRequest: body }),
    })

    return result.SMSChannelResponse || result
  }

  /**
   * Get SMS channel settings
   */
  async getSmsChannel(applicationId: string): Promise<SmsChannelResponse> {
    const result = await this.client.request({
      service: 'pinpoint',
      region: this.region,
      method: 'GET',
      path: `/v1/apps/${applicationId}/channels/sms`,
    })

    return result.SMSChannelResponse || result
  }

  /**
   * Send SMS messages
   */
  async sendMessages(params: {
    ApplicationId: string
    MessageRequest: {
      Addresses?: Record<string, {
        ChannelType?: 'SMS' | 'EMAIL' | 'PUSH'
        Context?: Record<string, string>
        RawContent?: string
        Substitutions?: Record<string, string[]>
        TitleOverride?: string
        BodyOverride?: string
      }>
      MessageConfiguration?: {
        SMSMessage?: {
          Body?: string
          Keyword?: string
          MediaUrl?: string
          MessageType?: 'TRANSACTIONAL' | 'PROMOTIONAL'
          OriginationNumber?: string
          SenderId?: string
          Substitutions?: Record<string, string[]>
        }
      }
    }
  }): Promise<SendMessagesResponse> {
    const result = await this.client.request({
      service: 'pinpoint',
      region: this.region,
      method: 'POST',
      path: `/v1/apps/${params.ApplicationId}/messages`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ MessageRequest: params.MessageRequest }),
    })

    return result.MessageResponse || result
  }

  /**
   * Send a simple SMS message
   */
  async sendSms(params: {
    ApplicationId: string
    PhoneNumber: string
    Message: string
    MessageType?: 'TRANSACTIONAL' | 'PROMOTIONAL'
    SenderId?: string
    OriginationNumber?: string
  }): Promise<MessageResult> {
    const response = await this.sendMessages({
      ApplicationId: params.ApplicationId,
      MessageRequest: {
        Addresses: {
          [params.PhoneNumber]: {
            ChannelType: 'SMS',
          },
        },
        MessageConfiguration: {
          SMSMessage: {
            Body: params.Message,
            MessageType: params.MessageType || 'TRANSACTIONAL',
            SenderId: params.SenderId,
            OriginationNumber: params.OriginationNumber,
          },
        },
      },
    })

    return response.Result?.[params.PhoneNumber] || {}
  }

  /**
   * Validate a phone number
   */
  async phoneNumberValidate(params: {
    PhoneNumber: string
    IsoCountryCode?: string
  }): Promise<{
    Carrier?: string
    City?: string
    CleansedPhoneNumberE164?: string
    CleansedPhoneNumberNational?: string
    Country?: string
    CountryCodeIso2?: string
    CountryCodeNumeric?: string
    County?: string
    OriginalCountryCodeIso2?: string
    OriginalPhoneNumber?: string
    PhoneType?: string
    PhoneTypeCode?: number
    Timezone?: string
    ZipCode?: string
  }> {
    const body: Record<string, any> = {
      PhoneNumber: params.PhoneNumber,
    }
    if (params.IsoCountryCode) body.IsoCountryCode = params.IsoCountryCode

    const result = await this.client.request({
      service: 'pinpoint',
      region: this.region,
      method: 'POST',
      path: '/v1/phone/number/validate',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ NumberValidateRequest: body }),
    })

    return result.NumberValidateResponse || result
  }

  /**
   * Check if an application exists
   */
  async appExists(applicationId: string): Promise<boolean> {
    try {
      await this.getApp(applicationId)
      return true
    }
    catch {
      return false
    }
  }
}
