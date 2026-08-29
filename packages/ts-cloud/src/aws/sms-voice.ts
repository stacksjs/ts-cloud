/**
 * AWS End User Messaging (pinpoint-sms-voice-v2) client.
 *
 * Distinct from `SmsClient`, which sends through SNS. This is the service that
 * owns the phone numbers themselves - the origination numbers, their status,
 * and the pools they sit in - and it is the only place that inventory can be
 * read from.
 *
 * Added because consumers were reaching for a `PinpointSmsVoiceClient` that
 * this package never exported: the name resolved to `undefined`, and `new
 * undefined(...)` threw at the first call.
 */
import { AWSClient } from './client'

/** A phone number as End User Messaging reports it. */
export interface OriginationPhoneNumber {
  PhoneNumberId?: string
  PhoneNumberArn?: string
  PhoneNumber?: string
  Status?: 'PENDING' | 'ACTIVE' | 'ASSOCIATING' | 'DISASSOCIATING' | 'DELETED'
  IsoCountryCode?: string
  MessageType?: 'TRANSACTIONAL' | 'PROMOTIONAL'
  NumberCapabilities?: Array<'SMS' | 'VOICE' | 'MMS'>
  NumberType?: string
  MonthlyLeasingPrice?: string
  TwoWayEnabled?: boolean
  OptOutListName?: string
  CreatedTimestamp?: string
}

export interface DescribePhoneNumbersParams {
  /** Restrict to specific numbers. Omit to list every number on the account. */
  PhoneNumberIds?: string[]
  Filters?: Array<{ Name: string, Values: string[] }>
  NextToken?: string
  MaxResults?: number
}

export interface DescribePhoneNumbersResult {
  PhoneNumbers: OriginationPhoneNumber[]
  NextToken?: string
}

export class SmsVoiceClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.client = new AWSClient()
    this.region = region
  }

  /**
   * List the origination phone numbers on the account.
   *
   * The `Status` on each is what says whether a number can actually send:
   * a number still `PENDING` registration will be rejected at send time.
   */
  async describePhoneNumbers(params: DescribePhoneNumbersParams = {}): Promise<DescribePhoneNumbersResult> {
    const result = await this.client.request({
      service: 'sms-voice',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'PinpointSMSVoiceV2.DescribePhoneNumbers',
      },
      body: JSON.stringify(params),
    }) as { PhoneNumbers?: OriginationPhoneNumber[], NextToken?: string }

    return {
      PhoneNumbers: result?.PhoneNumbers ?? [],
      NextToken: result?.NextToken,
    }
  }
}
