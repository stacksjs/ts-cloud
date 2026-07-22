import type { EnvironmentType, SftpConfig } from '../types'

export interface SftpResources {
  resources: Record<string, any>
  serverLogicalId: string
}

function logicalPart(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9]/g, ' ').trim()
  const part = clean
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
  return part || 'User'
}

function normalizeHomeDirectory(value: string | undefined, username: string): string {
  const path = (value || username).replace(/^\/+|\/+$/g, '')
  if (!path || path.split('/').includes('..')) throw new Error(`sftp: invalid homeDirectory for user ${username}`)
  return path
}

/** Build an AWS Transfer Family SFTP server with service-managed users. */
export class Sftp {
  static create(options: SftpConfig & { slug: string; environment: EnvironmentType }): SftpResources {
    if (!options.bucket.trim()) throw new Error('sftp: bucket is required')

    const endpointType = options.endpointType ?? 'PUBLIC'
    if (endpointType === 'VPC' && (!options.endpointDetails?.vpcId || !options.endpointDetails.subnetIds.length))
      throw new Error('sftp: VPC endpoints require endpointDetails.vpcId and at least one subnet')

    const prefix = `${logicalPart(options.slug)}${logicalPart(options.environment)}Sftp`
    const serverLogicalId = `${prefix}Server`
    const resources: Record<string, any> = {}

    let loggingRoleArn: any
    if (options.logging !== false) {
      const loggingRoleLogicalId = `${prefix}LoggingRole`
      resources[loggingRoleLogicalId] = {
        Type: 'AWS::IAM::Role',
        Properties: {
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Principal: { Service: 'transfer.amazonaws.com' }, Action: 'sts:AssumeRole' },
            ],
          },
          Policies: [
            {
              PolicyName: 'TransferLogging',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: [
                      'logs:CreateLogGroup',
                      'logs:CreateLogStream',
                      'logs:DescribeLogStreams',
                      'logs:PutLogEvents',
                    ],
                    Resource: 'arn:aws:logs:*:*:log-group:/aws/transfer/*',
                  },
                ],
              },
            },
          ],
        },
      }
      loggingRoleArn = { 'Fn::GetAtt': [loggingRoleLogicalId, 'Arn'] }
    }

    resources[serverLogicalId] = {
      Type: 'AWS::Transfer::Server',
      Properties: {
        Domain: 'S3',
        EndpointType: endpointType,
        IdentityProviderType: 'SERVICE_MANAGED',
        Protocols: ['SFTP'],
        ...(endpointType === 'VPC'
          ? {
              EndpointDetails: {
                VpcId: options.endpointDetails!.vpcId,
                SubnetIds: options.endpointDetails!.subnetIds,
                ...(options.endpointDetails!.securityGroupIds?.length
                  ? { SecurityGroupIds: options.endpointDetails!.securityGroupIds }
                  : {}),
                ...(options.endpointDetails!.addressAllocationIds?.length
                  ? { AddressAllocationIds: options.endpointDetails!.addressAllocationIds }
                  : {}),
              },
            }
          : {}),
        ...(options.securityPolicyName ? { SecurityPolicyName: options.securityPolicyName } : {}),
        ...(loggingRoleArn ? { LoggingRole: loggingRoleArn } : {}),
        Tags: [
          { Key: 'Project', Value: options.slug },
          { Key: 'Environment', Value: options.environment },
          { Key: 'ManagedBy', Value: 'ts-cloud' },
        ],
      },
    }

    for (const [username, user] of Object.entries(options.users)) {
      if (!/^[a-zA-Z0-9_.@-]{3,100}$/.test(username)) throw new Error(`sftp: invalid username ${username}`)
      if (!user.sshPublicKeys.length) throw new Error(`sftp: user ${username} requires at least one SSH public key`)

      const userPart = logicalPart(username)
      const home = normalizeHomeDirectory(user.homeDirectory, username)
      const userLogicalId = `${prefix}${userPart}User`
      let roleArn: any = user.roleArn

      if (!roleArn) {
        const roleLogicalId = `${prefix}${userPart}Role`
        const bucketArn = `arn:aws:s3:::${options.bucket}`
        resources[roleLogicalId] = {
          Type: 'AWS::IAM::Role',
          Properties: {
            AssumeRolePolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                { Effect: 'Allow', Principal: { Service: 'transfer.amazonaws.com' }, Action: 'sts:AssumeRole' },
              ],
            },
            Policies: [
              {
                PolicyName: 'SftpHomeDirectory',
                PolicyDocument: {
                  Version: '2012-10-17',
                  Statement: [
                    {
                      Effect: 'Allow',
                      Action: ['s3:ListBucket', 's3:GetBucketLocation'],
                      Resource: bucketArn,
                      Condition: { StringLike: { 's3:prefix': [home, `${home}/*`] } },
                    },
                    {
                      Effect: 'Allow',
                      Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:GetObjectVersion'],
                      Resource: `${bucketArn}/${home}/*`,
                    },
                  ],
                },
              },
            ],
          },
        }
        roleArn = { 'Fn::GetAtt': [roleLogicalId, 'Arn'] }
      }

      resources[userLogicalId] = {
        Type: 'AWS::Transfer::User',
        DependsOn: [serverLogicalId],
        Properties: {
          ServerId: { Ref: serverLogicalId },
          UserName: username,
          Role: roleArn,
          HomeDirectoryType: 'PATH',
          HomeDirectory: `/${options.bucket}/${home}`,
          SshPublicKeys: user.sshPublicKeys,
        },
      }
    }

    return { resources, serverLogicalId }
  }
}
