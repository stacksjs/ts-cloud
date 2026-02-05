/**
 * AWS STS Operations
 * Direct API calls without AWS CLI dependency
*/

import { AWSClient } from './client'

export interface CallerIdentity {
  UserId?: string
  Account?: string
  Arn?: string
}

/**
 * STS (Security Token Service) management using direct API calls
*/
export class STSClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1', profile?: string) {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Get information about the IAM identity whose credentials are used to call the operation
  */
  async getCallerIdentity(): Promise<CallerIdentity> {
    const result = await this.client.request({
      service: 'sts',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'Action=GetCallerIdentity&Version=2011-06-15',
    })

    // Parse XML response
    // The response will be in XML format like:
    // <GetCallerIdentityResponse>
    //   <GetCallerIdentityResult>
    //     <Account>123456789012</Account>
    //     <UserId>AIDAI...</UserId>
    //     <Arn>arn:aws:iam::...</Arn>
    //   </GetCallerIdentityResult>
    // </GetCallerIdentityResponse>

    if (typeof result === 'string') {
      const accountMatch = result.match(/<Account>(\d+)<\/Account>/)
      const userIdMatch = result.match(/<UserId>([^<]+)<\/UserId>/)
      const arnMatch = result.match(/<Arn>([^<]+)<\/Arn>/)

      return {
        Account: accountMatch?.[1],
        UserId: userIdMatch?.[1],
        Arn: arnMatch?.[1],
      }
    }

    // Handle parsed XML response - the structure can be either:
    // 1. { GetCallerIdentityResponse: { GetCallerIdentityResult: { Account, UserId, Arn } } }
    // 2. { GetCallerIdentityResult: { Account, UserId, Arn } }  (more common)
    const identityResult = result?.GetCallerIdentityResponse?.GetCallerIdentityResult
      || result?.GetCallerIdentityResult

    if (identityResult) {
      return {
        Account: String(identityResult.Account),
        UserId: identityResult.UserId,
        Arn: identityResult.Arn,
      }
    }

    // Direct object structure
    if (result?.Account) {
      return {
        Account: String(result.Account),
        UserId: result.UserId,
        Arn: result.Arn,
      }
    }

    return {
      Account: undefined,
      UserId: undefined,
      Arn: undefined,
    }
  }
}
