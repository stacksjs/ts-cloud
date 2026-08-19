import type { EnvironmentType, SftpConfig, SftpPosixProfile } from '../types'

export interface SftpResources {
  resources: Record<string, any>
  serverLogicalId: string
  /** Storage backend the server was built with. */
  domain: 'S3' | 'EFS'
}

/**
 * An EFS file system ID: either a literal `fs-…` or a CloudFormation intrinsic
 * (`{ Ref: '…' }`) pointing at a file system created in the same stack.
 */
export type SftpFileSystemRef = string | Record<string, any>

/**
 * Storage the module resolved down to a concrete backend. The generator turns
 * `storageBucket`/`fileSystem` references into these before calling `create`.
 */
export type ResolvedSftpStorage =
  | { type: 's3'; bucket: string }
  | { type: 'efs'; fileSystemId: SftpFileSystemRef; posixProfile?: SftpPosixProfile }

export interface SftpCreateOptions extends Omit<SftpConfig, 'storage'> {
  slug: string
  environment: EnvironmentType
  storage?: SftpConfig['storage'] | ResolvedSftpStorage
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

/** Narrow the user-facing storage config down to one concrete backend. */
function resolveStorage(options: SftpCreateOptions): ResolvedSftpStorage {
  const storage = options.storage

  if (storage?.type === 'efs') {
    const fileSystemId = 'fileSystemId' in storage ? storage.fileSystemId : undefined
    if (!fileSystemId || (typeof fileSystemId === 'string' && !fileSystemId.trim()))
      throw new Error('sftp: EFS storage requires fileSystemId, or a fileSystem name defined in infrastructure.fileSystem')
    return { type: 'efs', fileSystemId, posixProfile: storage.posixProfile }
  }

  const bucket = (storage?.type === 's3' ? (storage.bucket ?? options.bucket) : options.bucket)?.trim()
  if (!bucket)
    throw new Error('sftp: S3 storage requires bucket, or a storageBucket name defined in infrastructure.storage')
  return { type: 's3', bucket }
}

function posixProfileFor(
  username: string,
  user: { posixProfile?: SftpPosixProfile },
  fallback: SftpPosixProfile | undefined,
): Record<string, any> {
  const profile = user.posixProfile ?? fallback
  if (!profile)
    throw new Error(`sftp: user ${username} requires a posixProfile (uid/gid) on an EFS-backed server`)

  for (const id of [profile.uid, profile.gid, ...(profile.secondaryGids ?? [])]) {
    if (!Number.isInteger(id) || id < 0 || id > 4294967295)
      throw new Error(`sftp: user ${username} has an invalid posixProfile id ${id}`)
  }

  return {
    Uid: profile.uid,
    Gid: profile.gid,
    ...(profile.secondaryGids?.length ? { SecondaryGids: profile.secondaryGids } : {}),
  }
}

/** `/fs-123/incoming/deploy`, kept as an intrinsic when the file system is in-stack. */
function efsHomeDirectory(fileSystemId: SftpFileSystemRef, home: string): any {
  return typeof fileSystemId === 'string'
    ? `/${fileSystemId}/${home}`
    : { 'Fn::Sub': [`/\${FileSystemId}/${home}`, { FileSystemId: fileSystemId }] }
}

function efsFileSystemArn(fileSystemId: SftpFileSystemRef): any {
  const template = 'arn:aws:elasticfilesystem:${AWS::Region}:${AWS::AccountId}:file-system/${FileSystemId}'
  return typeof fileSystemId === 'string'
    ? { 'Fn::Sub': template.replace('${FileSystemId}', fileSystemId) }
    : { 'Fn::Sub': [template, { FileSystemId: fileSystemId }] }
}

/** Build an AWS Transfer Family SFTP server with service-managed users. */
export class Sftp {
  static create(options: SftpCreateOptions): SftpResources {
    const storage = resolveStorage(options)
    const domain = storage.type === 'efs' ? 'EFS' : 'S3'

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
        Domain: domain,
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
        let statements: any[]

        if (storage.type === 'efs') {
          statements = [
            {
              Effect: 'Allow',
              Action: [
                'elasticfilesystem:ClientMount',
                'elasticfilesystem:ClientWrite',
                'elasticfilesystem:DescribeMountTargets',
              ],
              Resource: efsFileSystemArn(storage.fileSystemId),
            },
          ]
        }
        else {
          const bucketArn = `arn:aws:s3:::${storage.bucket}`
          statements = [
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
          ]
        }

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
                PolicyDocument: { Version: '2012-10-17', Statement: statements },
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
          HomeDirectory:
            storage.type === 'efs' ? efsHomeDirectory(storage.fileSystemId, home) : `/${storage.bucket}/${home}`,
          ...(storage.type === 'efs'
            ? { PosixProfile: posixProfileFor(username, user, storage.posixProfile) }
            : {}),
          SshPublicKeys: user.sshPublicKeys,
        },
      }
    }

    return { resources, serverLogicalId, domain }
  }
}
