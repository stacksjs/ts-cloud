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

/**
 * A destination number verified for the End User Messaging sandbox.
 *
 * Until an account leaves the sandbox, AWS only delivers to numbers that have
 * been added here and confirmed with the code it texts them - so an
 * unverified destination fails at send time with no obvious reason.
 */
export interface SandboxPhone {
  id: string
  phoneNumber: string
  status: 'PENDING' | 'VERIFIED'
  createdAt?: string
}

export interface AddSandboxPhoneResult {
  verifiedDestinationNumberId: string
  phoneNumber: string
  status: 'PENDING' | 'VERIFIED'
}

export interface VerifySandboxPhoneResult {
  success: boolean
  verifiedDestinationNumberId?: string
  phoneNumber?: string
  status?: 'PENDING' | 'VERIFIED'
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
/**
   * Add a destination number to the sandbox and trigger its verification text.
   *
   * Answers `VERIFIED` immediately when the number was already confirmed, so a
   * caller can treat "already done" and "code sent" the same way.
   */
  async addSandboxPhone(phoneNumber: string): Promise<AddSandboxPhoneResult> {
    const result = await this.client.request({
      service: 'sms-voice',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'PinpointSMSVoiceV2.CreateVerifiedDestinationNumber',
      },
      body: JSON.stringify({ DestinationPhoneNumber: phoneNumber }),
    }) as { VerifiedDestinationNumberId?: string, DestinationPhoneNumber?: string, Status?: string }

    return {
      verifiedDestinationNumberId: result?.VerifiedDestinationNumberId ?? '',
      phoneNumber: result?.DestinationPhoneNumber ?? phoneNumber,
      status: result?.Status === 'VERIFIED' ? 'VERIFIED' : 'PENDING',
    }
  }

  /** Confirm a sandbox number with the code AWS texted to it. */
  async verifySandboxPhone(verifiedDestinationNumberId: string, verificationCode: string): Promise<VerifySandboxPhoneResult> {
    const result = await this.client.request({
      service: 'sms-voice',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'PinpointSMSVoiceV2.VerifyDestinationNumber',
      },
      body: JSON.stringify({ VerifiedDestinationNumberId: verifiedDestinationNumberId, VerificationCode: verificationCode }),
    }) as { VerifiedDestinationNumberId?: string, DestinationPhoneNumber?: string, Status?: string }

    return {
      success: result?.Status === 'VERIFIED',
      verifiedDestinationNumberId: result?.VerifiedDestinationNumberId,
      phoneNumber: result?.DestinationPhoneNumber,
      status: result?.Status === 'VERIFIED' ? 'VERIFIED' : 'PENDING',
    }
  }

  /** Every destination number added to the sandbox, verified or pending. */
  async listSandboxPhones(): Promise<SandboxPhone[]> {
    const result = await this.client.request({
      service: 'sms-voice',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'PinpointSMSVoiceV2.DescribeVerifiedDestinationNumbers',
      },
      body: JSON.stringify({}),
    }) as { VerifiedDestinationNumbers?: Array<{ VerifiedDestinationNumberId?: string, DestinationPhoneNumber?: string, Status?: string, CreatedTimestamp?: string }> }

    return (result?.VerifiedDestinationNumbers ?? []).map(entry => ({
      id: entry.VerifiedDestinationNumberId ?? '',
      phoneNumber: entry.DestinationPhoneNumber ?? '',
      status: entry.Status === 'VERIFIED' ? 'VERIFIED' as const : 'PENDING' as const,
      createdAt: entry.CreatedTimestamp,
    }))
  }
}
