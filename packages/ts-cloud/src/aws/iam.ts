/**
 * AWS IAM (Identity and Access Management) Operations
 * Direct API calls without AWS SDK dependency
 */

import { AWSClient } from './client'

// ============================================================================
// Types - Users
// ============================================================================

export interface IAMUser {
  UserName: string
  UserId: string
  Arn: string
  Path?: string
  CreateDate?: string
  PasswordLastUsed?: string
  PermissionsBoundary?: {
    PermissionsBoundaryType: string
    PermissionsBoundaryArn: string
  }
  Tags?: Array<{ Key: string; Value: string }>
}

export interface CreateUserParams {
  UserName: string
  Path?: string
  PermissionsBoundary?: string
  Tags?: Array<{ Key: string; Value: string }>
}

export interface GetUserParams {
  UserName?: string
}

export interface ListUsersParams {
  PathPrefix?: string
  Marker?: string
  MaxItems?: number
}

export interface UpdateUserParams {
  UserName: string
  NewUserName?: string
  NewPath?: string
}

export interface DeleteUserParams {
  UserName: string
}

// ============================================================================
// Types - Groups
// ============================================================================

export interface IAMGroup {
  GroupName: string
  GroupId: string
  Arn: string
  Path?: string
  CreateDate?: string
}

export interface CreateGroupParams {
  GroupName: string
  Path?: string
}

export interface GetGroupParams {
  GroupName: string
  Marker?: string
  MaxItems?: number
}

export interface ListGroupsParams {
  PathPrefix?: string
  Marker?: string
  MaxItems?: number
}

export interface UpdateGroupParams {
  GroupName: string
  NewGroupName?: string
  NewPath?: string
}

export interface DeleteGroupParams {
  GroupName: string
}

export interface AddUserToGroupParams {
  GroupName: string
  UserName: string
}

export interface RemoveUserFromGroupParams {
  GroupName: string
  UserName: string
}

export interface ListGroupsForUserParams {
  UserName: string
  Marker?: string
  MaxItems?: number
}

// ============================================================================
// Types - Roles
// ============================================================================

export interface IAMRole {
  RoleName: string
  RoleId: string
  Arn: string
  Path?: string
  CreateDate?: string
  AssumeRolePolicyDocument?: string
  Description?: string
  MaxSessionDuration?: number
  PermissionsBoundary?: {
    PermissionsBoundaryType: string
    PermissionsBoundaryArn: string
  }
  Tags?: Array<{ Key: string; Value: string }>
  RoleLastUsed?: {
    LastUsedDate?: string
    Region?: string
  }
}

export interface CreateRoleParams {
  RoleName: string
  AssumeRolePolicyDocument: string
  Path?: string
  Description?: string
  MaxSessionDuration?: number
  PermissionsBoundary?: string
  Tags?: Array<{ Key: string; Value: string }>
}

export interface GetRoleParams {
  RoleName: string
}

export interface ListRolesParams {
  PathPrefix?: string
  Marker?: string
  MaxItems?: number
}

export interface UpdateRoleParams {
  RoleName: string
  Description?: string
  MaxSessionDuration?: number
}

export interface UpdateRoleDescriptionParams {
  RoleName: string
  Description: string
}

export interface UpdateAssumeRolePolicyParams {
  RoleName: string
  PolicyDocument: string
}

export interface DeleteRoleParams {
  RoleName: string
}

export interface TagRoleParams {
  RoleName: string
  Tags: Array<{ Key: string; Value: string }>
}

export interface UntagRoleParams {
  RoleName: string
  TagKeys: string[]
}

export interface ListRoleTagsParams {
  RoleName: string
  Marker?: string
  MaxItems?: number
}

// ============================================================================
// Types - Policies
// ============================================================================

export interface IAMPolicy {
  PolicyName: string
  PolicyId: string
  Arn: string
  Path?: string
  DefaultVersionId?: string
  AttachmentCount?: number
  PermissionsBoundaryUsageCount?: number
  IsAttachable?: boolean
  Description?: string
  CreateDate?: string
  UpdateDate?: string
  Tags?: Array<{ Key: string; Value: string }>
}

export interface PolicyVersion {
  VersionId: string
  IsDefaultVersion: boolean
  CreateDate?: string
  Document?: string
}

export interface CreatePolicyParams {
  PolicyName: string
  PolicyDocument: string
  Path?: string
  Description?: string
  Tags?: Array<{ Key: string; Value: string }>
}

export interface GetPolicyParams {
  PolicyArn: string
}

export interface GetPolicyVersionParams {
  PolicyArn: string
  VersionId: string
}

export interface ListPoliciesParams {
  Scope?: 'All' | 'AWS' | 'Local'
  OnlyAttached?: boolean
  PathPrefix?: string
  PolicyUsageFilter?: 'PermissionsPolicy' | 'PermissionsBoundary'
  Marker?: string
  MaxItems?: number
}

export interface ListPolicyVersionsParams {
  PolicyArn: string
  Marker?: string
  MaxItems?: number
}

export interface CreatePolicyVersionParams {
  PolicyArn: string
  PolicyDocument: string
  SetAsDefault?: boolean
}

export interface DeletePolicyVersionParams {
  PolicyArn: string
  VersionId: string
}

export interface SetDefaultPolicyVersionParams {
  PolicyArn: string
  VersionId: string
}

export interface DeletePolicyParams {
  PolicyArn: string
}

export interface AttachUserPolicyParams {
  UserName: string
  PolicyArn: string
}

export interface DetachUserPolicyParams {
  UserName: string
  PolicyArn: string
}

export interface AttachGroupPolicyParams {
  GroupName: string
  PolicyArn: string
}

export interface DetachGroupPolicyParams {
  GroupName: string
  PolicyArn: string
}

export interface AttachRolePolicyParams {
  RoleName: string
  PolicyArn: string
}

export interface DetachRolePolicyParams {
  RoleName: string
  PolicyArn: string
}

export interface ListAttachedUserPoliciesParams {
  UserName: string
  PathPrefix?: string
  Marker?: string
  MaxItems?: number
}

export interface ListAttachedGroupPoliciesParams {
  GroupName: string
  PathPrefix?: string
  Marker?: string
  MaxItems?: number
}

export interface ListAttachedRolePoliciesParams {
  RoleName: string
  PathPrefix?: string
  Marker?: string
  MaxItems?: number
}

export interface ListEntitiesForPolicyParams {
  PolicyArn: string
  EntityFilter?: 'User' | 'Role' | 'Group' | 'LocalManagedPolicy' | 'AWSManagedPolicy'
  PathPrefix?: string
  PolicyUsageFilter?: 'PermissionsPolicy' | 'PermissionsBoundary'
  Marker?: string
  MaxItems?: number
}

// ============================================================================
// Types - Inline Policies
// ============================================================================

export interface PutUserPolicyParams {
  UserName: string
  PolicyName: string
  PolicyDocument: string
}

export interface GetUserPolicyParams {
  UserName: string
  PolicyName: string
}

export interface DeleteUserPolicyParams {
  UserName: string
  PolicyName: string
}

export interface ListUserPoliciesParams {
  UserName: string
  Marker?: string
  MaxItems?: number
}

export interface PutGroupPolicyParams {
  GroupName: string
  PolicyName: string
  PolicyDocument: string
}

export interface GetGroupPolicyParams {
  GroupName: string
  PolicyName: string
}

export interface DeleteGroupPolicyParams {
  GroupName: string
  PolicyName: string
}

export interface ListGroupPoliciesParams {
  GroupName: string
  Marker?: string
  MaxItems?: number
}

export interface PutRolePolicyParams {
  RoleName: string
  PolicyName: string
  PolicyDocument: string
}

export interface GetRolePolicyParams {
  RoleName: string
  PolicyName: string
}

export interface DeleteRolePolicyParams {
  RoleName: string
  PolicyName: string
}

export interface ListRolePoliciesParams {
  RoleName: string
  Marker?: string
  MaxItems?: number
}

// ============================================================================
// Types - Access Keys
// ============================================================================

export interface AccessKey {
  UserName: string
  AccessKeyId: string
  Status: 'Active' | 'Inactive'
  CreateDate?: string
}

export interface AccessKeyMetadata {
  UserName?: string
  AccessKeyId: string
  Status: 'Active' | 'Inactive'
  CreateDate?: string
}

export interface CreateAccessKeyParams {
  UserName?: string
}

export interface CreateAccessKeyResult {
  AccessKey: {
    UserName: string
    AccessKeyId: string
    Status: 'Active' | 'Inactive'
    SecretAccessKey: string
    CreateDate?: string
  }
}

export interface ListAccessKeysParams {
  UserName?: string
  Marker?: string
  MaxItems?: number
}

export interface UpdateAccessKeyParams {
  UserName?: string
  AccessKeyId: string
  Status: 'Active' | 'Inactive'
}

export interface DeleteAccessKeyParams {
  UserName?: string
  AccessKeyId: string
}

export interface GetAccessKeyLastUsedParams {
  AccessKeyId: string
}

// ============================================================================
// Types - Instance Profiles
// ============================================================================

export interface InstanceProfile {
  InstanceProfileName: string
  InstanceProfileId: string
  Arn: string
  Path?: string
  CreateDate?: string
  Roles?: IAMRole[]
  Tags?: Array<{ Key: string; Value: string }>
}

export interface CreateInstanceProfileParams {
  InstanceProfileName: string
  Path?: string
  Tags?: Array<{ Key: string; Value: string }>
}

export interface GetInstanceProfileParams {
  InstanceProfileName: string
}

export interface ListInstanceProfilesParams {
  PathPrefix?: string
  Marker?: string
  MaxItems?: number
}

export interface ListInstanceProfilesForRoleParams {
  RoleName: string
  Marker?: string
  MaxItems?: number
}

export interface AddRoleToInstanceProfileParams {
  InstanceProfileName: string
  RoleName: string
}

export interface RemoveRoleFromInstanceProfileParams {
  InstanceProfileName: string
  RoleName: string
}

export interface DeleteInstanceProfileParams {
  InstanceProfileName: string
}

// ============================================================================
// Types - Server Certificates
// ============================================================================

export interface ServerCertificate {
  ServerCertificateName: string
  ServerCertificateId: string
  Arn: string
  Path?: string
  UploadDate?: string
  Expiration?: string
}

export interface ServerCertificateMetadata {
  ServerCertificateName: string
  ServerCertificateId: string
  Arn: string
  Path?: string
  UploadDate?: string
  Expiration?: string
}

export interface UploadServerCertificateParams {
  ServerCertificateName: string
  CertificateBody: string
  PrivateKey: string
  CertificateChain?: string
  Path?: string
  Tags?: Array<{ Key: string; Value: string }>
}

export interface GetServerCertificateParams {
  ServerCertificateName: string
}

export interface ListServerCertificatesParams {
  PathPrefix?: string
  Marker?: string
  MaxItems?: number
}

export interface UpdateServerCertificateParams {
  ServerCertificateName: string
  NewServerCertificateName?: string
  NewPath?: string
}

export interface DeleteServerCertificateParams {
  ServerCertificateName: string
}

// ============================================================================
// Types - Account and Password Policy
// ============================================================================

export interface PasswordPolicy {
  MinimumPasswordLength?: number
  RequireSymbols?: boolean
  RequireNumbers?: boolean
  RequireUppercaseCharacters?: boolean
  RequireLowercaseCharacters?: boolean
  AllowUsersToChangePassword?: boolean
  ExpirePasswords?: boolean
  MaxPasswordAge?: number
  PasswordReusePrevention?: number
  HardExpiry?: boolean
}

export interface UpdateAccountPasswordPolicyParams {
  MinimumPasswordLength?: number
  RequireSymbols?: boolean
  RequireNumbers?: boolean
  RequireUppercaseCharacters?: boolean
  RequireLowercaseCharacters?: boolean
  AllowUsersToChangePassword?: boolean
  MaxPasswordAge?: number
  PasswordReusePrevention?: number
  HardExpiry?: boolean
}

export interface AccountSummary {
  Users?: number
  UsersQuota?: number
  Groups?: number
  GroupsQuota?: number
  ServerCertificates?: number
  ServerCertificatesQuota?: number
  UserPolicySizeQuota?: number
  GroupPolicySizeQuota?: number
  GroupsPerUserQuota?: number
  SigningCertificatesPerUserQuota?: number
  AccessKeysPerUserQuota?: number
  MFADevices?: number
  MFADevicesInUse?: number
  AccountMFAEnabled?: number
  AccountAccessKeysPresent?: number
  AccountSigningCertificatesPresent?: number
  AttachedPoliciesPerGroupQuota?: number
  AttachedPoliciesPerRoleQuota?: number
  AttachedPoliciesPerUserQuota?: number
  Policies?: number
  PoliciesQuota?: number
  PolicySizeQuota?: number
  PolicyVersionsInUse?: number
  PolicyVersionsInUseQuota?: number
  VersionsPerPolicyQuota?: number
  GlobalEndpointTokenVersion?: number
}

// ============================================================================
// Types - Policy Simulation
// ============================================================================

export interface SimulatePrincipalPolicyParams {
  PolicySourceArn: string
  ActionNames: string[]
  ResourceArns?: string[]
  ResourcePolicy?: string
  ResourceOwner?: string
  CallerArn?: string
  ContextEntries?: Array<{
    ContextKeyName: string
    ContextKeyValues: string[]
    ContextKeyType: string
  }>
  ResourceHandlingOption?: string
  MaxItems?: number
  Marker?: string
}

export interface EvaluationResult {
  EvalActionName: string
  EvalResourceName?: string
  EvalDecision: string
  MatchedStatements?: Array<{
    SourcePolicyId?: string
    SourcePolicyType?: string
  }>
  MissingContextValues?: string[]
}

export interface SimulatePolicyResponse {
  EvaluationResults: EvaluationResult[]
  IsTruncated: boolean
  Marker?: string
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build query string from parameters for IAM API
 */
function buildQueryParams(action: string, params: Record<string, unknown>): string {
  const queryParams: string[] = [`Action=${action}`, 'Version=2010-05-08']

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue

    if (Array.isArray(value)) {
      // Handle arrays (e.g., Tags, TagKeys)
      value.forEach((item, index) => {
        if (typeof item === 'object' && item !== null) {
          // Handle array of objects (e.g., Tags)
          for (const [subKey, subValue] of Object.entries(item as Record<string, unknown>)) {
            queryParams.push(`${key}.member.${index + 1}.${subKey}=${encodeURIComponent(String(subValue))}`)
          }
        } else {
          queryParams.push(`${key}.member.${index + 1}=${encodeURIComponent(String(item))}`)
        }
      })
    } else if (typeof value === 'object') {
      // Handle nested objects
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (subValue !== undefined && subValue !== null) {
          queryParams.push(`${key}.${subKey}=${encodeURIComponent(String(subValue))}`)
        }
      }
    } else {
      queryParams.push(`${key}=${encodeURIComponent(String(value))}`)
    }
  }

  return queryParams.join('&')
}

/**
 * Parse XML response from IAM API
 */
function parseXmlValue(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`)
  const match = xml.match(regex)
  return match ? match[1] : undefined
}

/**
 * Parse XML array from IAM API
 */
function parseXmlArray(xml: string, containerTag: string, itemTag: string): string[] {
  const containerRegex = new RegExp(`<${containerTag}>([\\s\\S]*?)</${containerTag}>`)
  const containerMatch = xml.match(containerRegex)
  if (!containerMatch) return []

  const items: string[] = []
  const itemRegex = new RegExp(`<${itemTag}>([\\s\\S]*?)</${itemTag}>`, 'g')
  let match
  while ((match = itemRegex.exec(containerMatch[1])) !== null) {
    items.push(match[1])
  }
  return items
}

// ============================================================================
// IAM Client
// ============================================================================

export class IAMClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.client = new AWSClient()
    this.region = region
  }

  /**
   * Make IAM API request
   */
  private async request(action: string, params: object = {}): Promise<any> {
    const body = buildQueryParams(action, params as Record<string, unknown>)

    const response = await this.client.request({
      service: 'iam',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })

    return response
  }

  // ==========================================================================
  // User Operations
  // ==========================================================================

  /**
   * Create a new IAM user
   */
  async createUser(params: CreateUserParams): Promise<IAMUser> {
    const response = await this.request('CreateUser', params)
    return this.parseUser(response)
  }

  /**
   * Get information about an IAM user
   */
  async getUser(params: GetUserParams = {}): Promise<IAMUser> {
    const response = await this.request('GetUser', params)
    return this.parseUser(response)
  }

  /**
   * List IAM users
   */
  async listUsers(params: ListUsersParams = {}): Promise<{ Users: IAMUser[]; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListUsers', params)
    const users = this.parseUsers(response)
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { Users: users, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * Update an IAM user
   */
  async updateUser(params: UpdateUserParams): Promise<void> {
    await this.request('UpdateUser', params)
  }

  /**
   * Delete an IAM user
   */
  async deleteUser(params: DeleteUserParams): Promise<void> {
    await this.request('DeleteUser', params)
  }

  /**
   * Parse user from XML response
   */
  private parseUser(xml: string): IAMUser {
    return {
      UserName: parseXmlValue(xml, 'UserName') || '',
      UserId: parseXmlValue(xml, 'UserId') || '',
      Arn: parseXmlValue(xml, 'Arn') || '',
      Path: parseXmlValue(xml, 'Path'),
      CreateDate: parseXmlValue(xml, 'CreateDate'),
      PasswordLastUsed: parseXmlValue(xml, 'PasswordLastUsed'),
    }
  }

  /**
   * Parse users array from XML response
   */
  private parseUsers(xml: string): IAMUser[] {
    const memberXmls = parseXmlArray(xml, 'Users', 'member')
    return memberXmls.map((memberXml) => ({
      UserName: parseXmlValue(memberXml, 'UserName') || '',
      UserId: parseXmlValue(memberXml, 'UserId') || '',
      Arn: parseXmlValue(memberXml, 'Arn') || '',
      Path: parseXmlValue(memberXml, 'Path'),
      CreateDate: parseXmlValue(memberXml, 'CreateDate'),
      PasswordLastUsed: parseXmlValue(memberXml, 'PasswordLastUsed'),
    }))
  }

  // ==========================================================================
  // Group Operations
  // ==========================================================================

  /**
   * Create a new IAM group
   */
  async createGroup(params: CreateGroupParams): Promise<IAMGroup> {
    const response = await this.request('CreateGroup', params)
    return this.parseGroup(response)
  }

  /**
   * Get information about an IAM group
   */
  async getGroup(params: GetGroupParams): Promise<{ Group: IAMGroup; Users: IAMUser[]; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('GetGroup', params)
    const group = this.parseGroup(response)
    const users = this.parseUsers(response)
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { Group: group, Users: users, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * List IAM groups
   */
  async listGroups(params: ListGroupsParams = {}): Promise<{ Groups: IAMGroup[]; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListGroups', params)
    const groups = this.parseGroups(response)
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { Groups: groups, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * Update an IAM group
   */
  async updateGroup(params: UpdateGroupParams): Promise<void> {
    await this.request('UpdateGroup', params)
  }

  /**
   * Delete an IAM group
   */
  async deleteGroup(params: DeleteGroupParams): Promise<void> {
    await this.request('DeleteGroup', params)
  }

  /**
   * Add a user to a group
   */
  async addUserToGroup(params: AddUserToGroupParams): Promise<void> {
    await this.request('AddUserToGroup', params)
  }

  /**
   * Remove a user from a group
   */
  async removeUserFromGroup(params: RemoveUserFromGroupParams): Promise<void> {
    await this.request('RemoveUserFromGroup', params)
  }

  /**
   * List groups for a user
   */
  async listGroupsForUser(params: ListGroupsForUserParams): Promise<{ Groups: IAMGroup[]; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListGroupsForUser', params)
    const groups = this.parseGroups(response)
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { Groups: groups, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * Parse group from XML response
   */
  private parseGroup(xml: string): IAMGroup {
    return {
      GroupName: parseXmlValue(xml, 'GroupName') || '',
      GroupId: parseXmlValue(xml, 'GroupId') || '',
      Arn: parseXmlValue(xml, 'Arn') || '',
      Path: parseXmlValue(xml, 'Path'),
      CreateDate: parseXmlValue(xml, 'CreateDate'),
    }
  }

  /**
   * Parse groups array from XML response
   */
  private parseGroups(xml: string): IAMGroup[] {
    const memberXmls = parseXmlArray(xml, 'Groups', 'member')
    return memberXmls.map((memberXml) => ({
      GroupName: parseXmlValue(memberXml, 'GroupName') || '',
      GroupId: parseXmlValue(memberXml, 'GroupId') || '',
      Arn: parseXmlValue(memberXml, 'Arn') || '',
      Path: parseXmlValue(memberXml, 'Path'),
      CreateDate: parseXmlValue(memberXml, 'CreateDate'),
    }))
  }

  // ==========================================================================
  // Role Operations
  // ==========================================================================

  /**
   * Create a new IAM role
   */
  async createRole(params: CreateRoleParams): Promise<IAMRole> {
    const response = await this.request('CreateRole', params)
    return this.parseRole(response)
  }

  /**
   * Get information about an IAM role
   */
  async getRole(params: GetRoleParams): Promise<IAMRole> {
    const response = await this.request('GetRole', params)
    return this.parseRole(response)
  }

  /**
   * List IAM roles
   */
  async listRoles(params: ListRolesParams = {}): Promise<{ Roles: IAMRole[]; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListRoles', params)
    const roles = this.parseRoles(response)
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { Roles: roles, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * Update an IAM role
   */
  async updateRole(params: UpdateRoleParams): Promise<void> {
    await this.request('UpdateRole', params)
  }

  /**
   * Update an IAM role description
   */
  async updateRoleDescription(params: UpdateRoleDescriptionParams): Promise<IAMRole> {
    const response = await this.request('UpdateRoleDescription', params)
    return this.parseRole(response)
  }

  /**
   * Update the assume role policy for a role
   */
  async updateAssumeRolePolicy(params: UpdateAssumeRolePolicyParams): Promise<void> {
    await this.request('UpdateAssumeRolePolicy', params)
  }

  /**
   * Delete an IAM role
   */
  async deleteRole(params: DeleteRoleParams): Promise<void> {
    await this.request('DeleteRole', params)
  }

  /**
   * Tag an IAM role
   */
  async tagRole(params: TagRoleParams): Promise<void> {
    await this.request('TagRole', params)
  }

  /**
   * Untag an IAM role
   */
  async untagRole(params: UntagRoleParams): Promise<void> {
    await this.request('UntagRole', params)
  }

  /**
   * List tags for an IAM role
   */
  async listRoleTags(params: ListRoleTagsParams): Promise<{ Tags: Array<{ Key: string; Value: string }>; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListRoleTags', params)
    const tags = this.parseTags(response)
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { Tags: tags, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * Parse role from XML response
   */
  private parseRole(xml: string): IAMRole {
    return {
      RoleName: parseXmlValue(xml, 'RoleName') || '',
      RoleId: parseXmlValue(xml, 'RoleId') || '',
      Arn: parseXmlValue(xml, 'Arn') || '',
      Path: parseXmlValue(xml, 'Path'),
      CreateDate: parseXmlValue(xml, 'CreateDate'),
      AssumeRolePolicyDocument: parseXmlValue(xml, 'AssumeRolePolicyDocument'),
      Description: parseXmlValue(xml, 'Description'),
      MaxSessionDuration: parseXmlValue(xml, 'MaxSessionDuration') ? Number.parseInt(parseXmlValue(xml, 'MaxSessionDuration')!, 10) : undefined,
    }
  }

  /**
   * Parse roles array from XML response
   */
  private parseRoles(xml: string): IAMRole[] {
    const memberXmls = parseXmlArray(xml, 'Roles', 'member')
    return memberXmls.map((memberXml) => ({
      RoleName: parseXmlValue(memberXml, 'RoleName') || '',
      RoleId: parseXmlValue(memberXml, 'RoleId') || '',
      Arn: parseXmlValue(memberXml, 'Arn') || '',
      Path: parseXmlValue(memberXml, 'Path'),
      CreateDate: parseXmlValue(memberXml, 'CreateDate'),
      AssumeRolePolicyDocument: parseXmlValue(memberXml, 'AssumeRolePolicyDocument'),
      Description: parseXmlValue(memberXml, 'Description'),
      MaxSessionDuration: parseXmlValue(memberXml, 'MaxSessionDuration') ? Number.parseInt(parseXmlValue(memberXml, 'MaxSessionDuration')!, 10) : undefined,
    }))
  }

  /**
   * Parse tags from XML response
   */
  private parseTags(xml: string): Array<{ Key: string; Value: string }> {
    const memberXmls = parseXmlArray(xml, 'Tags', 'member')
    return memberXmls.map((memberXml) => ({
      Key: parseXmlValue(memberXml, 'Key') || '',
      Value: parseXmlValue(memberXml, 'Value') || '',
    }))
  }

  // ==========================================================================
  // Managed Policy Operations
  // ==========================================================================

  /**
   * Create a new managed policy
   */
  async createPolicy(params: CreatePolicyParams): Promise<IAMPolicy> {
    const response = await this.request('CreatePolicy', params)
    return this.parsePolicy(response)
  }

  /**
   * Get information about a managed policy
   */
  async getPolicy(params: GetPolicyParams): Promise<IAMPolicy> {
    const response = await this.request('GetPolicy', params)
    return this.parsePolicy(response)
  }

  /**
   * Get a specific version of a managed policy
   */
  async getPolicyVersion(params: GetPolicyVersionParams): Promise<PolicyVersion> {
    const response = await this.request('GetPolicyVersion', params)
    return {
      VersionId: parseXmlValue(response, 'VersionId') || '',
      IsDefaultVersion: parseXmlValue(response, 'IsDefaultVersion') === 'true',
      CreateDate: parseXmlValue(response, 'CreateDate'),
      Document: parseXmlValue(response, 'Document'),
    }
  }

  /**
   * List managed policies
   */
  async listPolicies(params: ListPoliciesParams = {}): Promise<{ Policies: IAMPolicy[]; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListPolicies', params)
    const policies = this.parsePolicies(response)
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { Policies: policies, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * List versions of a managed policy
   */
  async listPolicyVersions(params: ListPolicyVersionsParams): Promise<{ Versions: PolicyVersion[]; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListPolicyVersions', params)
    const versions = this.parsePolicyVersions(response)
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { Versions: versions, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * Create a new version of a managed policy
   */
  async createPolicyVersion(params: CreatePolicyVersionParams): Promise<PolicyVersion> {
    const response = await this.request('CreatePolicyVersion', params)
    return {
      VersionId: parseXmlValue(response, 'VersionId') || '',
      IsDefaultVersion: parseXmlValue(response, 'IsDefaultVersion') === 'true',
      CreateDate: parseXmlValue(response, 'CreateDate'),
    }
  }

  /**
   * Delete a version of a managed policy
   */
  async deletePolicyVersion(params: DeletePolicyVersionParams): Promise<void> {
    await this.request('DeletePolicyVersion', params)
  }

  /**
   * Set the default version of a managed policy
   */
  async setDefaultPolicyVersion(params: SetDefaultPolicyVersionParams): Promise<void> {
    await this.request('SetDefaultPolicyVersion', params)
  }

  /**
   * Delete a managed policy
   */
  async deletePolicy(params: DeletePolicyParams): Promise<void> {
    await this.request('DeletePolicy', params)
  }

  /**
   * Attach a managed policy to a user
   */
  async attachUserPolicy(params: AttachUserPolicyParams): Promise<void> {
    await this.request('AttachUserPolicy', params)
  }

  /**
   * Detach a managed policy from a user
   */
  async detachUserPolicy(params: DetachUserPolicyParams): Promise<void> {
    await this.request('DetachUserPolicy', params)
  }

  /**
   * Attach a managed policy to a group
   */
  async attachGroupPolicy(params: AttachGroupPolicyParams): Promise<void> {
    await this.request('AttachGroupPolicy', params)
  }

  /**
   * Detach a managed policy from a group
   */
  async detachGroupPolicy(params: DetachGroupPolicyParams): Promise<void> {
    await this.request('DetachGroupPolicy', params)
  }

  /**
   * Attach a managed policy to a role
   */
  async attachRolePolicy(params: AttachRolePolicyParams): Promise<void> {
    await this.request('AttachRolePolicy', params)
  }

  /**
   * Detach a managed policy from a role
   */
  async detachRolePolicy(params: DetachRolePolicyParams): Promise<void> {
    await this.request('DetachRolePolicy', params)
  }

  /**
   * List managed policies attached to a user
   */
  async listAttachedUserPolicies(params: ListAttachedUserPoliciesParams): Promise<{ AttachedPolicies: Array<{ PolicyName: string; PolicyArn: string }>; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListAttachedUserPolicies', params)
    const policies = this.parseAttachedPolicies(response)
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { AttachedPolicies: policies, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * List managed policies attached to a group
   */
  async listAttachedGroupPolicies(params: ListAttachedGroupPoliciesParams): Promise<{ AttachedPolicies: Array<{ PolicyName: string; PolicyArn: string }>; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListAttachedGroupPolicies', params)
    const policies = this.parseAttachedPolicies(response)
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { AttachedPolicies: policies, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * List managed policies attached to a role
   */
  async listAttachedRolePolicies(params: ListAttachedRolePoliciesParams): Promise<{ AttachedPolicies: Array<{ PolicyName: string; PolicyArn: string }>; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListAttachedRolePolicies', params)
    const policies = this.parseAttachedPolicies(response)
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { AttachedPolicies: policies, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * Parse policy from XML response
   */
  private parsePolicy(xml: string): IAMPolicy {
    return {
      PolicyName: parseXmlValue(xml, 'PolicyName') || '',
      PolicyId: parseXmlValue(xml, 'PolicyId') || '',
      Arn: parseXmlValue(xml, 'Arn') || '',
      Path: parseXmlValue(xml, 'Path'),
      DefaultVersionId: parseXmlValue(xml, 'DefaultVersionId'),
      AttachmentCount: parseXmlValue(xml, 'AttachmentCount') ? Number.parseInt(parseXmlValue(xml, 'AttachmentCount')!, 10) : undefined,
      PermissionsBoundaryUsageCount: parseXmlValue(xml, 'PermissionsBoundaryUsageCount') ? Number.parseInt(parseXmlValue(xml, 'PermissionsBoundaryUsageCount')!, 10) : undefined,
      IsAttachable: parseXmlValue(xml, 'IsAttachable') === 'true',
      Description: parseXmlValue(xml, 'Description'),
      CreateDate: parseXmlValue(xml, 'CreateDate'),
      UpdateDate: parseXmlValue(xml, 'UpdateDate'),
    }
  }

  /**
   * Parse policies array from XML response
   */
  private parsePolicies(xml: string): IAMPolicy[] {
    const memberXmls = parseXmlArray(xml, 'Policies', 'member')
    return memberXmls.map((memberXml) => ({
      PolicyName: parseXmlValue(memberXml, 'PolicyName') || '',
      PolicyId: parseXmlValue(memberXml, 'PolicyId') || '',
      Arn: parseXmlValue(memberXml, 'Arn') || '',
      Path: parseXmlValue(memberXml, 'Path'),
      DefaultVersionId: parseXmlValue(memberXml, 'DefaultVersionId'),
      AttachmentCount: parseXmlValue(memberXml, 'AttachmentCount') ? Number.parseInt(parseXmlValue(memberXml, 'AttachmentCount')!, 10) : undefined,
      PermissionsBoundaryUsageCount: parseXmlValue(memberXml, 'PermissionsBoundaryUsageCount') ? Number.parseInt(parseXmlValue(memberXml, 'PermissionsBoundaryUsageCount')!, 10) : undefined,
      IsAttachable: parseXmlValue(memberXml, 'IsAttachable') === 'true',
      Description: parseXmlValue(memberXml, 'Description'),
      CreateDate: parseXmlValue(memberXml, 'CreateDate'),
      UpdateDate: parseXmlValue(memberXml, 'UpdateDate'),
    }))
  }

  /**
   * Parse policy versions from XML response
   */
  private parsePolicyVersions(xml: string): PolicyVersion[] {
    const memberXmls = parseXmlArray(xml, 'Versions', 'member')
    return memberXmls.map((memberXml) => ({
      VersionId: parseXmlValue(memberXml, 'VersionId') || '',
      IsDefaultVersion: parseXmlValue(memberXml, 'IsDefaultVersion') === 'true',
      CreateDate: parseXmlValue(memberXml, 'CreateDate'),
    }))
  }

  /**
   * Parse attached policies from XML response
   */
  private parseAttachedPolicies(xml: string): Array<{ PolicyName: string; PolicyArn: string }> {
    const memberXmls = parseXmlArray(xml, 'AttachedPolicies', 'member')
    return memberXmls.map((memberXml) => ({
      PolicyName: parseXmlValue(memberXml, 'PolicyName') || '',
      PolicyArn: parseXmlValue(memberXml, 'PolicyArn') || '',
    }))
  }

  // ==========================================================================
  // Inline Policy Operations
  // ==========================================================================

  /**
   * Add or update an inline policy for a user
   */
  async putUserPolicy(params: PutUserPolicyParams): Promise<void> {
    await this.request('PutUserPolicy', params)
  }

  /**
   * Get an inline policy for a user
   */
  async getUserPolicy(params: GetUserPolicyParams): Promise<{ UserName: string; PolicyName: string; PolicyDocument: string }> {
    const response = await this.request('GetUserPolicy', params)
    return {
      UserName: parseXmlValue(response, 'UserName') || '',
      PolicyName: parseXmlValue(response, 'PolicyName') || '',
      PolicyDocument: decodeURIComponent(parseXmlValue(response, 'PolicyDocument') || ''),
    }
  }

  /**
   * Delete an inline policy from a user
   */
  async deleteUserPolicy(params: DeleteUserPolicyParams): Promise<void> {
    await this.request('DeleteUserPolicy', params)
  }

  /**
   * List inline policies for a user
   */
  async listUserPolicies(params: ListUserPoliciesParams): Promise<{ PolicyNames: string[]; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListUserPolicies', params)
    const policyNames = parseXmlArray(response, 'PolicyNames', 'member')
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { PolicyNames: policyNames, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * Add or update an inline policy for a group
   */
  async putGroupPolicy(params: PutGroupPolicyParams): Promise<void> {
    await this.request('PutGroupPolicy', params)
  }

  /**
   * Get an inline policy for a group
   */
  async getGroupPolicy(params: GetGroupPolicyParams): Promise<{ GroupName: string; PolicyName: string; PolicyDocument: string }> {
    const response = await this.request('GetGroupPolicy', params)
    return {
      GroupName: parseXmlValue(response, 'GroupName') || '',
      PolicyName: parseXmlValue(response, 'PolicyName') || '',
      PolicyDocument: decodeURIComponent(parseXmlValue(response, 'PolicyDocument') || ''),
    }
  }

  /**
   * Delete an inline policy from a group
   */
  async deleteGroupPolicy(params: DeleteGroupPolicyParams): Promise<void> {
    await this.request('DeleteGroupPolicy', params)
  }

  /**
   * List inline policies for a group
   */
  async listGroupPolicies(params: ListGroupPoliciesParams): Promise<{ PolicyNames: string[]; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListGroupPolicies', params)
    const policyNames = parseXmlArray(response, 'PolicyNames', 'member')
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { PolicyNames: policyNames, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * Add or update an inline policy for a role
   */
  async putRolePolicy(params: PutRolePolicyParams): Promise<void> {
    await this.request('PutRolePolicy', params)
  }

  /**
   * Get an inline policy for a role
   */
  async getRolePolicy(params: GetRolePolicyParams): Promise<{ RoleName: string; PolicyName: string; PolicyDocument: string }> {
    const response = await this.request('GetRolePolicy', params)
    return {
      RoleName: parseXmlValue(response, 'RoleName') || '',
      PolicyName: parseXmlValue(response, 'PolicyName') || '',
      PolicyDocument: decodeURIComponent(parseXmlValue(response, 'PolicyDocument') || ''),
    }
  }

  /**
   * Delete an inline policy from a role
   */
  async deleteRolePolicy(params: DeleteRolePolicyParams): Promise<void> {
    await this.request('DeleteRolePolicy', params)
  }

  /**
   * List inline policies for a role
   */
  async listRolePolicies(params: ListRolePoliciesParams): Promise<{ PolicyNames: string[]; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListRolePolicies', params)
    const policyNames = parseXmlArray(response, 'PolicyNames', 'member')
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { PolicyNames: policyNames, IsTruncated: isTruncated, Marker: marker }
  }

  // ==========================================================================
  // Access Key Operations
  // ==========================================================================

  /**
   * Create an access key for a user
   */
  async createAccessKey(params: CreateAccessKeyParams = {}): Promise<CreateAccessKeyResult> {
    const response = await this.request('CreateAccessKey', params)

    // Handle both string (XML) and object (parsed) responses
    if (typeof response === 'object') {
      const accessKey = (response as any)?.CreateAccessKeyResult?.AccessKey
        || (response as any)?.AccessKey
      if (accessKey) {
        return {
          AccessKey: {
            UserName: accessKey.UserName || '',
            AccessKeyId: accessKey.AccessKeyId || '',
            Status: (accessKey.Status as 'Active' | 'Inactive') || 'Active',
            SecretAccessKey: accessKey.SecretAccessKey || '',
            CreateDate: accessKey.CreateDate,
          },
        }
      }
    }

    // Fallback to XML parsing for string responses
    return {
      AccessKey: {
        UserName: parseXmlValue(response as string, 'UserName') || '',
        AccessKeyId: parseXmlValue(response as string, 'AccessKeyId') || '',
        Status: (parseXmlValue(response as string, 'Status') as 'Active' | 'Inactive') || 'Active',
        SecretAccessKey: parseXmlValue(response as string, 'SecretAccessKey') || '',
        CreateDate: parseXmlValue(response as string, 'CreateDate'),
      },
    }
  }

  /**
   * List access keys for a user
   */
  async listAccessKeys(params: ListAccessKeysParams = {}): Promise<{ AccessKeyMetadata: AccessKeyMetadata[]; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListAccessKeys', params)
    const keys = this.parseAccessKeys(response)
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { AccessKeyMetadata: keys, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * Update an access key status
   */
  async updateAccessKey(params: UpdateAccessKeyParams): Promise<void> {
    await this.request('UpdateAccessKey', params)
  }

  /**
   * Delete an access key
   */
  async deleteAccessKey(params: DeleteAccessKeyParams): Promise<void> {
    await this.request('DeleteAccessKey', params)
  }

  /**
   * Get information about when an access key was last used
   */
  async getAccessKeyLastUsed(params: GetAccessKeyLastUsedParams): Promise<{ UserName: string; AccessKeyLastUsed: { LastUsedDate?: string; ServiceName?: string; Region?: string } }> {
    const response = await this.request('GetAccessKeyLastUsed', params)
    return {
      UserName: parseXmlValue(response, 'UserName') || '',
      AccessKeyLastUsed: {
        LastUsedDate: parseXmlValue(response, 'LastUsedDate'),
        ServiceName: parseXmlValue(response, 'ServiceName'),
        Region: parseXmlValue(response, 'Region'),
      },
    }
  }

  /**
   * Parse access keys from XML response
   */
  private parseAccessKeys(xml: string): AccessKeyMetadata[] {
    const memberXmls = parseXmlArray(xml, 'AccessKeyMetadata', 'member')
    return memberXmls.map((memberXml) => ({
      UserName: parseXmlValue(memberXml, 'UserName'),
      AccessKeyId: parseXmlValue(memberXml, 'AccessKeyId') || '',
      Status: (parseXmlValue(memberXml, 'Status') as 'Active' | 'Inactive') || 'Active',
      CreateDate: parseXmlValue(memberXml, 'CreateDate'),
    }))
  }

  // ==========================================================================
  // Instance Profile Operations
  // ==========================================================================

  /**
   * Create an instance profile
   */
  async createInstanceProfile(params: CreateInstanceProfileParams): Promise<InstanceProfile> {
    const response = await this.request('CreateInstanceProfile', params)
    return this.parseInstanceProfile(response)
  }

  /**
   * Get information about an instance profile
   */
  async getInstanceProfile(params: GetInstanceProfileParams): Promise<InstanceProfile> {
    const response = await this.request('GetInstanceProfile', params)
    return this.parseInstanceProfile(response)
  }

  /**
   * List instance profiles
   */
  async listInstanceProfiles(params: ListInstanceProfilesParams = {}): Promise<{ InstanceProfiles: InstanceProfile[]; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListInstanceProfiles', params)
    const profiles = this.parseInstanceProfiles(response)
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { InstanceProfiles: profiles, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * List instance profiles for a role
   */
  async listInstanceProfilesForRole(params: ListInstanceProfilesForRoleParams): Promise<{ InstanceProfiles: InstanceProfile[]; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListInstanceProfilesForRole', params)
    const profiles = this.parseInstanceProfiles(response)
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { InstanceProfiles: profiles, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * Add a role to an instance profile
   */
  async addRoleToInstanceProfile(params: AddRoleToInstanceProfileParams): Promise<void> {
    await this.request('AddRoleToInstanceProfile', params)
  }

  /**
   * Remove a role from an instance profile
   */
  async removeRoleFromInstanceProfile(params: RemoveRoleFromInstanceProfileParams): Promise<void> {
    await this.request('RemoveRoleFromInstanceProfile', params)
  }

  /**
   * Delete an instance profile
   */
  async deleteInstanceProfile(params: DeleteInstanceProfileParams): Promise<void> {
    await this.request('DeleteInstanceProfile', params)
  }

  /**
   * Parse instance profile from XML response
   */
  private parseInstanceProfile(xml: string): InstanceProfile {
    return {
      InstanceProfileName: parseXmlValue(xml, 'InstanceProfileName') || '',
      InstanceProfileId: parseXmlValue(xml, 'InstanceProfileId') || '',
      Arn: parseXmlValue(xml, 'Arn') || '',
      Path: parseXmlValue(xml, 'Path'),
      CreateDate: parseXmlValue(xml, 'CreateDate'),
    }
  }

  /**
   * Parse instance profiles from XML response
   */
  private parseInstanceProfiles(xml: string): InstanceProfile[] {
    const memberXmls = parseXmlArray(xml, 'InstanceProfiles', 'member')
    return memberXmls.map((memberXml) => ({
      InstanceProfileName: parseXmlValue(memberXml, 'InstanceProfileName') || '',
      InstanceProfileId: parseXmlValue(memberXml, 'InstanceProfileId') || '',
      Arn: parseXmlValue(memberXml, 'Arn') || '',
      Path: parseXmlValue(memberXml, 'Path'),
      CreateDate: parseXmlValue(memberXml, 'CreateDate'),
    }))
  }

  // ==========================================================================
  // Account Operations
  // ==========================================================================

  /**
   * Get account password policy
   */
  async getAccountPasswordPolicy(): Promise<PasswordPolicy> {
    const response = await this.request('GetAccountPasswordPolicy')
    return {
      MinimumPasswordLength: parseXmlValue(response, 'MinimumPasswordLength') ? Number.parseInt(parseXmlValue(response, 'MinimumPasswordLength')!, 10) : undefined,
      RequireSymbols: parseXmlValue(response, 'RequireSymbols') === 'true',
      RequireNumbers: parseXmlValue(response, 'RequireNumbers') === 'true',
      RequireUppercaseCharacters: parseXmlValue(response, 'RequireUppercaseCharacters') === 'true',
      RequireLowercaseCharacters: parseXmlValue(response, 'RequireLowercaseCharacters') === 'true',
      AllowUsersToChangePassword: parseXmlValue(response, 'AllowUsersToChangePassword') === 'true',
      ExpirePasswords: parseXmlValue(response, 'ExpirePasswords') === 'true',
      MaxPasswordAge: parseXmlValue(response, 'MaxPasswordAge') ? Number.parseInt(parseXmlValue(response, 'MaxPasswordAge')!, 10) : undefined,
      PasswordReusePrevention: parseXmlValue(response, 'PasswordReusePrevention') ? Number.parseInt(parseXmlValue(response, 'PasswordReusePrevention')!, 10) : undefined,
      HardExpiry: parseXmlValue(response, 'HardExpiry') === 'true',
    }
  }

  /**
   * Update account password policy
   */
  async updateAccountPasswordPolicy(params: UpdateAccountPasswordPolicyParams): Promise<void> {
    await this.request('UpdateAccountPasswordPolicy', params)
  }

  /**
   * Delete account password policy
   */
  async deleteAccountPasswordPolicy(): Promise<void> {
    await this.request('DeleteAccountPasswordPolicy')
  }

  /**
   * Get account summary
   */
  async getAccountSummary(): Promise<AccountSummary> {
    const response = await this.request('GetAccountSummary')
    const summary: AccountSummary = {}

    // Parse the SummaryMap entries
    const entries = parseXmlArray(response, 'SummaryMap', 'entry')
    for (const entry of entries) {
      const key = parseXmlValue(entry, 'key')
      const value = parseXmlValue(entry, 'value')
      if (key && value) {
        (summary as Record<string, number>)[key] = Number.parseInt(value, 10)
      }
    }

    return summary
  }

  /**
   * Get the account alias
   */
  async listAccountAliases(): Promise<{ AccountAliases: string[]; IsTruncated: boolean; Marker?: string }> {
    const response = await this.request('ListAccountAliases')
    const aliases = parseXmlArray(response, 'AccountAliases', 'member')
    const isTruncated = parseXmlValue(response, 'IsTruncated') === 'true'
    const marker = parseXmlValue(response, 'Marker')
    return { AccountAliases: aliases, IsTruncated: isTruncated, Marker: marker }
  }

  /**
   * Create an account alias
   */
  async createAccountAlias(params: { AccountAlias: string }): Promise<void> {
    await this.request('CreateAccountAlias', params)
  }

  /**
   * Delete an account alias
   */
  async deleteAccountAlias(params: { AccountAlias: string }): Promise<void> {
    await this.request('DeleteAccountAlias', params)
  }

  // ==========================================================================
  // Policy Simulation Operations
  // ==========================================================================

  /**
   * Simulate the effect of policies attached to a principal
   */
  async simulatePrincipalPolicy(params: SimulatePrincipalPolicyParams): Promise<SimulatePolicyResponse> {
    const response = await this.request('SimulatePrincipalPolicy', params)
    return this.parseSimulationResults(response)
  }

  /**
   * Parse simulation results from XML response
   */
  private parseSimulationResults(xml: string): SimulatePolicyResponse {
    const resultXmls = parseXmlArray(xml, 'EvaluationResults', 'member')
    const evaluationResults: EvaluationResult[] = resultXmls.map((resultXml) => {
      const matchedStatementXmls = parseXmlArray(resultXml, 'MatchedStatements', 'member')
      const matchedStatements = matchedStatementXmls.map((stmtXml) => ({
        SourcePolicyId: parseXmlValue(stmtXml, 'SourcePolicyId'),
        SourcePolicyType: parseXmlValue(stmtXml, 'SourcePolicyType'),
      }))

      return {
        EvalActionName: parseXmlValue(resultXml, 'EvalActionName') || '',
        EvalResourceName: parseXmlValue(resultXml, 'EvalResourceName'),
        EvalDecision: parseXmlValue(resultXml, 'EvalDecision') || '',
        MatchedStatements: matchedStatements.length > 0 ? matchedStatements : undefined,
      }
    })

    const isTruncated = parseXmlValue(xml, 'IsTruncated') === 'true'
    const marker = parseXmlValue(xml, 'Marker')
    return { EvaluationResults: evaluationResults, IsTruncated: isTruncated, Marker: marker }
  }
}
