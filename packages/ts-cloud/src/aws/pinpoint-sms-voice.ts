/**
 * AWS Pinpoint SMS Voice V2 Operations
 * Modern API for SMS and Voice messaging with phone number management
 *
 * This is the recommended service for:
 * - Sending SMS messages
 * - Making voice calls
 * - Managing phone numbers (toll-free, long codes, short codes)
 * - Two-way SMS messaging
 * - Receiving inbound SMS via webhooks
 */

import { AWSClient } from './client'

export interface PhoneNumberInfo {
  PhoneNumberArn?: string
  PhoneNumberId?: string
  PhoneNumber?: string
  Status?: 'PENDING' | 'ACTIVE' | 'ASSOCIATING' | 'DISASSOCIATING' | 'DELETED'
  IsoCountryCode?: string
  MessageType?: 'TRANSACTIONAL' | 'PROMOTIONAL'
  NumberCapabilities?: Array<'SMS' | 'VOICE'>
  NumberType?: 'SHORT_CODE' | 'LONG_CODE' | 'TOLL_FREE' | 'TEN_DLC' | 'SIMULATOR'
  MonthlyLeasingPrice?: string
  TwoWayEnabled?: boolean
  TwoWayChannelArn?: string
  TwoWayChannelRole?: string
  SelfManagedOptOutsEnabled?: boolean
  OptOutListName?: string
  DeletionProtectionEnabled?: boolean
  PoolId?: string
  RegistrationId?: string
  CreatedTimestamp?: string
}

export interface PoolInfo {
  PoolArn?: string
  PoolId?: string
  Status?: 'CREATING' | 'ACTIVE' | 'DELETING'
  MessageType?: 'TRANSACTIONAL' | 'PROMOTIONAL'
  TwoWayEnabled?: boolean
  TwoWayChannelArn?: string
  TwoWayChannelRole?: string
  SelfManagedOptOutsEnabled?: boolean
  OptOutListName?: string
  SharedRoutesEnabled?: boolean
  DeletionProtectionEnabled?: boolean
  CreatedTimestamp?: string
}

export interface SendTextMessageResult {
  MessageId?: string
}

export interface SendVoiceMessageResult {
  MessageId?: string
}

export interface OptedOutNumberInfo {
  OptedOutNumber?: string
  OptedOutTimestamp?: string
  EndUserOptedOut?: boolean
}

/**
 * Pinpoint SMS Voice V2 client for SMS and Voice operations
 * This is the modern, recommended way to send SMS and make voice calls in AWS
 */
export class PinpointSmsVoiceClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Make a JSON RPC request to Pinpoint SMS Voice V2
   */
  private async request(action: string, params: Record<string, any> = {}): Promise<any> {
    return this.client.request({
      service: 'sms-voice',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'X-Amz-Target': `PinpointSMSVoiceV2.${action}`,
      },
      body: JSON.stringify(params),
    })
  }

  // ==================== SMS Operations ====================

  /**
   * Send a text message (SMS)
   */
  async sendTextMessage(params: {
    DestinationPhoneNumber: string
    MessageBody?: string
    MessageType?: 'TRANSACTIONAL' | 'PROMOTIONAL'
    OriginationIdentity?: string
    ConfigurationSetName?: string
    MaxPrice?: string
    TimeToLive?: number
    Context?: Record<string, string>
    DestinationCountryParameters?: Record<string, string>
    DryRun?: boolean
    ProtectConfigurationId?: string
  }): Promise<SendTextMessageResult> {
    return this.request('SendTextMessage', params)
  }

  /**
   * Send a simple SMS message (convenience method)
   */
  async sendSms(
    to: string,
    message: string,
    options?: {
      from?: string
      messageType?: 'TRANSACTIONAL' | 'PROMOTIONAL'
      configurationSet?: string
    },
  ): Promise<SendTextMessageResult> {
    return this.sendTextMessage({
      DestinationPhoneNumber: to,
      MessageBody: message,
      OriginationIdentity: options?.from,
      MessageType: options?.messageType || 'TRANSACTIONAL',
      ConfigurationSetName: options?.configurationSet,
    })
  }

  // ==================== Voice Operations ====================

  /**
   * Send a voice message (automated call with text-to-speech)
   */
  async sendVoiceMessage(params: {
    DestinationPhoneNumber: string
    OriginationIdentity: string
    MessageBody?: string
    MessageBodyTextType?: 'TEXT' | 'SSML'
    VoiceId?: string
    ConfigurationSetName?: string
    MaxPricePerMinute?: string
    TimeToLive?: number
    Context?: Record<string, string>
    DryRun?: boolean
    ProtectConfigurationId?: string
  }): Promise<SendVoiceMessageResult> {
    return this.request('SendVoiceMessage', params)
  }

  /**
   * Make a voice call with text-to-speech (convenience method)
   */
  async makeCall(
    to: string,
    from: string,
    message: string,
    options?: {
      voiceId?: string
      ssml?: boolean
      configurationSet?: string
    },
  ): Promise<SendVoiceMessageResult> {
    return this.sendVoiceMessage({
      DestinationPhoneNumber: to,
      OriginationIdentity: from,
      MessageBody: message,
      MessageBodyTextType: options?.ssml ? 'SSML' : 'TEXT',
      VoiceId: options?.voiceId || 'JOANNA', // Default to Joanna voice
      ConfigurationSetName: options?.configurationSet,
    })
  }

  // ==================== Phone Number Management ====================

  /**
   * Request a new phone number
   */
  async requestPhoneNumber(params: {
    IsoCountryCode: string
    MessageType: 'TRANSACTIONAL' | 'PROMOTIONAL'
    NumberCapabilities: Array<'SMS' | 'VOICE'>
    NumberType: 'LONG_CODE' | 'TOLL_FREE' | 'TEN_DLC' | 'SIMULATOR'
    PoolId?: string
    RegistrationId?: string
    DeletionProtectionEnabled?: boolean
    Tags?: Array<{ Key: string; Value: string }>
    ClientToken?: string
    OptOutListName?: string
  }): Promise<PhoneNumberInfo> {
    return this.request('RequestPhoneNumber', params)
  }

  /**
   * Request a US toll-free number (convenience method)
   */
  async requestTollFreeNumber(capabilities: Array<'SMS' | 'VOICE'> = ['SMS', 'VOICE']): Promise<PhoneNumberInfo> {
    return this.requestPhoneNumber({
      IsoCountryCode: 'US',
      MessageType: 'TRANSACTIONAL',
      NumberCapabilities: capabilities,
      NumberType: 'TOLL_FREE',
    })
  }

  /**
   * Request a simulator phone number for testing
   */
  async requestSimulatorNumber(): Promise<PhoneNumberInfo> {
    return this.requestPhoneNumber({
      IsoCountryCode: 'US',
      MessageType: 'TRANSACTIONAL',
      NumberCapabilities: ['SMS', 'VOICE'],
      NumberType: 'SIMULATOR',
    })
  }

  /**
   * Release a phone number
   */
  async releasePhoneNumber(phoneNumberId: string): Promise<PhoneNumberInfo> {
    return this.request('ReleasePhoneNumber', {
      PhoneNumberId: phoneNumberId,
    })
  }

  /**
   * List all phone numbers
   */
  async describePhoneNumbers(params?: {
    PhoneNumberIds?: string[]
    Filters?: Array<{
      Name: 'status' | 'iso-country-code' | 'message-type' | 'number-capability' | 'number-type' | 'two-way-enabled' | 'self-managed-opt-outs-enabled' | 'opt-out-list-name' | 'deletion-protection-enabled' | 'pool-id'
      Values: string[]
    }>
    NextToken?: string
    MaxResults?: number
  }): Promise<{ PhoneNumbers?: PhoneNumberInfo[]; NextToken?: string }> {
    return this.request('DescribePhoneNumbers', params || {})
  }

  /**
   * Update phone number settings
   */
  async updatePhoneNumber(params: {
    PhoneNumberId: string
    TwoWayEnabled?: boolean
    TwoWayChannelArn?: string
    TwoWayChannelRole?: string
    SelfManagedOptOutsEnabled?: boolean
    OptOutListName?: string
    DeletionProtectionEnabled?: boolean
  }): Promise<PhoneNumberInfo> {
    return this.request('UpdatePhoneNumber', params)
  }

  /**
   * Enable two-way SMS on a phone number
   */
  async enableTwoWaySms(
    phoneNumberId: string,
    snsTopicArn: string,
    roleArn?: string,
  ): Promise<PhoneNumberInfo> {
    return this.updatePhoneNumber({
      PhoneNumberId: phoneNumberId,
      TwoWayEnabled: true,
      TwoWayChannelArn: snsTopicArn,
      TwoWayChannelRole: roleArn,
    })
  }

  // ==================== Pool Management ====================

  /**
   * Create a phone number pool
   */
  async createPool(params: {
    OriginationIdentity: string
    IsoCountryCode: string
    MessageType: 'TRANSACTIONAL' | 'PROMOTIONAL'
    DeletionProtectionEnabled?: boolean
    Tags?: Array<{ Key: string; Value: string }>
    ClientToken?: string
  }): Promise<PoolInfo> {
    return this.request('CreatePool', params)
  }

  /**
   * Delete a pool
   */
  async deletePool(poolId: string): Promise<PoolInfo> {
    return this.request('DeletePool', { PoolId: poolId })
  }

  /**
   * List all pools
   */
  async describePools(params?: {
    PoolIds?: string[]
    Filters?: Array<{
      Name: string
      Values: string[]
    }>
    NextToken?: string
    MaxResults?: number
  }): Promise<{ Pools?: PoolInfo[]; NextToken?: string }> {
    return this.request('DescribePools', params || {})
  }

  /**
   * Associate a phone number with a pool
   */
  async associateOriginationIdentity(params: {
    PoolId: string
    OriginationIdentity: string
    IsoCountryCode: string
    ClientToken?: string
  }): Promise<{
    PoolArn?: string
    PoolId?: string
    OriginationIdentityArn?: string
    OriginationIdentity?: string
    IsoCountryCode?: string
  }> {
    return this.request('AssociateOriginationIdentity', params)
  }

  // ==================== Opt-Out Management ====================

  /**
   * Create an opt-out list
   */
  async createOptOutList(params: {
    OptOutListName: string
    Tags?: Array<{ Key: string; Value: string }>
    ClientToken?: string
  }): Promise<{
    OptOutListArn?: string
    OptOutListName?: string
    CreatedTimestamp?: string
  }> {
    return this.request('CreateOptOutList', params)
  }

  /**
   * Delete an opt-out list
   */
  async deleteOptOutList(optOutListName: string): Promise<void> {
    await this.request('DeleteOptOutList', { OptOutListName: optOutListName })
  }

  /**
   * List opt-out lists
   */
  async describeOptOutLists(params?: {
    OptOutListNames?: string[]
    NextToken?: string
    MaxResults?: number
  }): Promise<{
    OptOutLists?: Array<{
      OptOutListArn?: string
      OptOutListName?: string
      CreatedTimestamp?: string
    }>
    NextToken?: string
  }> {
    return this.request('DescribeOptOutLists', params || {})
  }

  /**
   * Add a phone number to opt-out list
   */
  async putOptedOutNumber(params: {
    OptOutListName: string
    OptedOutNumber: string
  }): Promise<OptedOutNumberInfo> {
    return this.request('PutOptedOutNumber', params)
  }

  /**
   * Remove a phone number from opt-out list
   */
  async deleteOptedOutNumber(params: {
    OptOutListName: string
    OptedOutNumber: string
  }): Promise<OptedOutNumberInfo> {
    return this.request('DeleteOptedOutNumber', params)
  }

  /**
   * List opted-out numbers
   */
  async describeOptedOutNumbers(params: {
    OptOutListName: string
    OptedOutNumbers?: string[]
    NextToken?: string
    MaxResults?: number
  }): Promise<{
    OptOutListArn?: string
    OptOutListName?: string
    OptedOutNumbers?: OptedOutNumberInfo[]
    NextToken?: string
  }> {
    return this.request('DescribeOptedOutNumbers', params)
  }

  // ==================== Configuration Sets ====================

  /**
   * Create a configuration set (for delivery receipts, etc.)
   */
  async createConfigurationSet(params: {
    ConfigurationSetName: string
    Tags?: Array<{ Key: string; Value: string }>
    ClientToken?: string
  }): Promise<{
    ConfigurationSetArn?: string
    ConfigurationSetName?: string
    CreatedTimestamp?: string
  }> {
    return this.request('CreateConfigurationSet', params)
  }

  /**
   * Delete a configuration set
   */
  async deleteConfigurationSet(configurationSetName: string): Promise<void> {
    await this.request('DeleteConfigurationSet', { ConfigurationSetName: configurationSetName })
  }

  /**
   * Set up event destination for a configuration set (e.g., CloudWatch, SNS, Kinesis)
   */
  async createEventDestination(params: {
    ConfigurationSetName: string
    EventDestinationName: string
    MatchingEventTypes: Array<
      | 'ALL'
      | 'TEXT_ALL'
      | 'TEXT_SENT'
      | 'TEXT_PENDING'
      | 'TEXT_QUEUED'
      | 'TEXT_SUCCESSFUL'
      | 'TEXT_DELIVERED'
      | 'TEXT_INVALID'
      | 'TEXT_INVALID_MESSAGE'
      | 'TEXT_UNREACHABLE'
      | 'TEXT_CARRIER_UNREACHABLE'
      | 'TEXT_BLOCKED'
      | 'TEXT_CARRIER_BLOCKED'
      | 'TEXT_SPAM'
      | 'TEXT_UNKNOWN'
      | 'TEXT_TTL_EXPIRED'
      | 'VOICE_ALL'
      | 'VOICE_INITIATED'
      | 'VOICE_RINGING'
      | 'VOICE_ANSWERED'
      | 'VOICE_COMPLETED'
      | 'VOICE_BUSY'
      | 'VOICE_NO_ANSWER'
      | 'VOICE_FAILED'
      | 'VOICE_TTL_EXPIRED'
    >
    CloudWatchLogsDestination?: {
      IamRoleArn: string
      LogGroupArn: string
    }
    KinesisFirehoseDestination?: {
      IamRoleArn: string
      DeliveryStreamArn: string
    }
    SnsDestination?: {
      TopicArn: string
    }
    ClientToken?: string
  }): Promise<{
    ConfigurationSetArn?: string
    ConfigurationSetName?: string
    EventDestination?: {
      EventDestinationName?: string
      Enabled?: boolean
      MatchingEventTypes?: string[]
    }
  }> {
    return this.request('CreateEventDestination', params)
  }

  // ==================== Sender IDs ====================

  /**
   * Request a sender ID (alphanumeric sender ID for supported countries)
   */
  async requestSenderId(params: {
    SenderId: string
    IsoCountryCode: string
    MessageTypes?: Array<'TRANSACTIONAL' | 'PROMOTIONAL'>
    DeletionProtectionEnabled?: boolean
    Tags?: Array<{ Key: string; Value: string }>
    ClientToken?: string
  }): Promise<{
    SenderIdArn?: string
    SenderId?: string
    IsoCountryCode?: string
    MessageTypes?: string[]
    MonthlyLeasingPrice?: string
    DeletionProtectionEnabled?: boolean
    Registered?: boolean
    RegistrationId?: string
  }> {
    return this.request('RequestSenderId', params)
  }

  /**
   * Release a sender ID
   */
  async releaseSenderId(params: {
    SenderId: string
    IsoCountryCode: string
  }): Promise<void> {
    await this.request('ReleaseSenderId', params)
  }

  /**
   * List sender IDs
   */
  async describeSenderIds(params?: {
    SenderIds?: Array<{ SenderId: string; IsoCountryCode: string }>
    Filters?: Array<{
      Name: string
      Values: string[]
    }>
    NextToken?: string
    MaxResults?: number
  }): Promise<{
    SenderIds?: Array<{
      SenderIdArn?: string
      SenderId?: string
      IsoCountryCode?: string
      MessageTypes?: string[]
      MonthlyLeasingPrice?: string
      DeletionProtectionEnabled?: boolean
      Registered?: boolean
      RegistrationId?: string
    }>
    NextToken?: string
  }> {
    return this.request('DescribeSenderIds', params || {})
  }

  // ==================== Account Management ====================

  /**
   * Get account attributes
   */
  async describeAccountAttributes(params?: {
    NextToken?: string
    MaxResults?: number
  }): Promise<{
    AccountAttributes?: Array<{
      Name?: string
      Value?: string
    }>
    NextToken?: string
  }> {
    return this.request('DescribeAccountAttributes', params || {})
  }

  /**
   * Get account limits
   */
  async describeAccountLimits(params?: {
    NextToken?: string
    MaxResults?: number
  }): Promise<{
    AccountLimits?: Array<{
      Name?: string
      Used?: number
      Max?: number
    }>
    NextToken?: string
  }> {
    return this.request('DescribeAccountLimits', params || {})
  }

  /**
   * Get spend limits
   */
  async describeSpendLimits(params?: {
    NextToken?: string
    MaxResults?: number
  }): Promise<{
    SpendLimits?: Array<{
      Name?: string
      EnforcedLimit?: number
      MaxLimit?: number
      Overridden?: boolean
    }>
    NextToken?: string
  }> {
    return this.request('DescribeSpendLimits', params || {})
  }

  /**
   * Set text message spend limit override
   */
  async setTextMessageSpendLimitOverride(monthlyLimit: number): Promise<{
    MonthlyLimit?: number
  }> {
    return this.request('SetTextMessageSpendLimitOverride', {
      MonthlyLimit: monthlyLimit,
    })
  }

  /**
   * Set voice message spend limit override
   */
  async setVoiceMessageSpendLimitOverride(monthlyLimit: number): Promise<{
    MonthlyLimit?: number
  }> {
    return this.request('SetVoiceMessageSpendLimitOverride', {
      MonthlyLimit: monthlyLimit,
    })
  }

  // ==================== Keywords ====================

  /**
   * Add a keyword (for two-way SMS auto-responses)
   */
  async putKeyword(params: {
    OriginationIdentity: string
    Keyword: string
    KeywordMessage: string
    KeywordAction?: 'AUTOMATIC_RESPONSE' | 'OPT_OUT' | 'OPT_IN'
  }): Promise<{
    OriginationIdentityArn?: string
    OriginationIdentity?: string
    Keyword?: string
    KeywordMessage?: string
    KeywordAction?: string
  }> {
    return this.request('PutKeyword', params)
  }

  /**
   * Delete a keyword
   */
  async deleteKeyword(params: {
    OriginationIdentity: string
    Keyword: string
  }): Promise<void> {
    await this.request('DeleteKeyword', params)
  }

  /**
   * List keywords for an origination identity
   */
  async describeKeywords(params: {
    OriginationIdentity: string
    Keywords?: string[]
    NextToken?: string
    MaxResults?: number
  }): Promise<{
    OriginationIdentityArn?: string
    OriginationIdentity?: string
    Keywords?: Array<{
      Keyword?: string
      KeywordMessage?: string
      KeywordAction?: string
    }>
    NextToken?: string
  }> {
    return this.request('DescribeKeywords', params)
  }

  // ==================== Validation ====================

  /**
   * Validate a phone number (check E.164 format, carrier info)
   */
  async sendDestinationNumberVerificationCode(params: {
    VerifiedDestinationNumberId: string
    VerificationChannel: 'TEXT' | 'VOICE'
    LanguageCode?: string
    OriginationIdentity?: string
    ConfigurationSetName?: string
    Context?: Record<string, string>
    DestinationCountryParameters?: Record<string, string>
  }): Promise<{
    MessageId?: string
  }> {
    return this.request('SendDestinationNumberVerificationCode', params)
  }

  /**
   * Verify a destination phone number with code
   */
  async verifyDestinationNumber(params: {
    VerifiedDestinationNumberId: string
    VerificationCode: string
  }): Promise<{
    VerifiedDestinationNumberArn?: string
    VerifiedDestinationNumberId?: string
    DestinationPhoneNumber?: string
    Status?: string
    CreatedTimestamp?: string
  }> {
    return this.request('VerifyDestinationNumber', params)
  }

  // ==================== Media (MMS) ====================

  /**
   * Send a media message (MMS)
   */
  async sendMediaMessage(params: {
    DestinationPhoneNumber: string
    OriginationIdentity: string
    MessageBody?: string
    MediaUrls?: string[]
    ConfigurationSetName?: string
    MaxPrice?: string
    TimeToLive?: number
    Context?: Record<string, string>
    DryRun?: boolean
    ProtectConfigurationId?: string
  }): Promise<{
    MessageId?: string
  }> {
    return this.request('SendMediaMessage', params)
  }

  /**
   * Send MMS with image (convenience method)
   */
  async sendMms(
    to: string,
    from: string,
    message: string,
    mediaUrls: string[],
    options?: {
      configurationSet?: string
    },
  ): Promise<{ MessageId?: string }> {
    return this.sendMediaMessage({
      DestinationPhoneNumber: to,
      OriginationIdentity: from,
      MessageBody: message,
      MediaUrls: mediaUrls,
      ConfigurationSetName: options?.configurationSet,
    })
  }
}
