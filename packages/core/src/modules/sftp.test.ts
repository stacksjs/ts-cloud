import { describe, expect, it } from 'bun:test'
import { Sftp } from './sftp'

describe('Sftp', () => {
  it('creates a public SFTP server and a least-privilege S3 user role', () => {
    const result = Sftp.create({
      slug: 'demo',
      environment: 'production',
      bucket: 'demo-uploads',
      users: {
        deploy: {
          sshPublicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest deploy@example.com'],
          homeDirectory: 'incoming/deploy',
        },
      },
    })

    const server = result.resources.DemoProductionSftpServer
    const user = result.resources.DemoProductionSftpDeployUser
    const role = result.resources.DemoProductionSftpDeployRole

    expect(server.Properties).toMatchObject({ Domain: 'S3', EndpointType: 'PUBLIC', Protocols: ['SFTP'] })
    expect(user.Properties.HomeDirectory).toBe('/demo-uploads/incoming/deploy')
    expect(user.Properties.ServerId).toEqual({ Ref: 'DemoProductionSftpServer' })
    expect(role.Properties.Policies[0].PolicyDocument.Statement[1].Resource).toBe(
      'arn:aws:s3:::demo-uploads/incoming/deploy/*',
    )
  })

  it('uses an existing role without creating another role', () => {
    const result = Sftp.create({
      slug: 'demo',
      environment: 'staging',
      bucket: 'demo-uploads',
      users: {
        release: {
          sshPublicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest'],
          roleArn: 'arn:aws:iam::123456789012:role/existing',
        },
      },
      logging: false,
    })

    expect(result.resources.DemoStagingSftpReleaseRole).toBeUndefined()
    expect(result.resources.DemoStagingSftpReleaseUser.Properties.Role).toBe('arn:aws:iam::123456789012:role/existing')
    expect(result.resources.DemoStagingSftpLoggingRole).toBeUndefined()
  })

  it('creates an EFS-backed server with a POSIX profile and file system role', () => {
    const result = Sftp.create({
      slug: 'demo',
      environment: 'production',
      storage: {
        type: 'efs',
        fileSystemId: 'fs-01234567',
        posixProfile: { uid: 1000, gid: 1000 },
      },
      users: {
        deploy: {
          sshPublicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest deploy@example.com'],
          homeDirectory: 'incoming/deploy',
        },
      },
    })

    const user = result.resources.DemoProductionSftpDeployUser
    const role = result.resources.DemoProductionSftpDeployRole

    expect(result.domain).toBe('EFS')
    expect(result.resources.DemoProductionSftpServer.Properties.Domain).toBe('EFS')
    expect(user.Properties.HomeDirectory).toBe('/fs-01234567/incoming/deploy')
    expect(user.Properties.PosixProfile).toEqual({ Uid: 1000, Gid: 1000 })
    expect(role.Properties.Policies[0].PolicyDocument.Statement[0]).toMatchObject({
      Action: [
        'elasticfilesystem:ClientMount',
        'elasticfilesystem:ClientWrite',
        'elasticfilesystem:DescribeMountTargets',
      ],
      Resource: {
        'Fn::Sub': 'arn:aws:elasticfilesystem:${AWS::Region}:${AWS::AccountId}:file-system/fs-01234567',
      },
    })
  })

  it('references an in-stack file system through intrinsics', () => {
    const result = Sftp.create({
      slug: 'demo',
      environment: 'production',
      storage: { type: 'efs', fileSystemId: { Ref: 'DemoEfs' } },
      users: {
        deploy: {
          sshPublicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest'],
          posixProfile: { uid: 1001, gid: 1001, secondaryGids: [1002] },
        },
      },
    })

    const user = result.resources.DemoProductionSftpDeployUser

    expect(user.Properties.HomeDirectory).toEqual({
      'Fn::Sub': ['/${FileSystemId}/deploy', { FileSystemId: { Ref: 'DemoEfs' } }],
    })
    expect(user.Properties.PosixProfile).toEqual({ Uid: 1001, Gid: 1001, SecondaryGids: [1002] })
    expect(result.resources.DemoProductionSftpDeployRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource)
      .toEqual({
        'Fn::Sub': [
          'arn:aws:elasticfilesystem:${AWS::Region}:${AWS::AccountId}:file-system/${FileSystemId}',
          { FileSystemId: { Ref: 'DemoEfs' } },
        ],
      })
  })

  it('requires a posixProfile and a resolved file system for EFS storage', () => {
    expect(() =>
      Sftp.create({
        slug: 'demo',
        environment: 'production',
        storage: { type: 'efs', fileSystemId: 'fs-01234567' },
        users: { deploy: { sshPublicKeys: ['ssh-ed25519 AAAAITest'] } },
      }),
    ).toThrow(/posixProfile/)

    expect(() =>
      Sftp.create({
        slug: 'demo',
        environment: 'production',
        storage: { type: 'efs', fileSystem: 'uploads' },
        users: {},
      }),
    ).toThrow(/fileSystemId/)
  })

  it('accepts the s3 storage form alongside the bucket shorthand', () => {
    const result = Sftp.create({
      slug: 'demo',
      environment: 'production',
      storage: { type: 's3', bucket: 'demo-uploads' },
      users: { deploy: { sshPublicKeys: ['ssh-ed25519 AAAAITest'] } },
    })

    expect(result.domain).toBe('S3')
    expect(result.resources.DemoProductionSftpDeployUser.Properties.HomeDirectory).toBe('/demo-uploads/deploy')
    expect(result.resources.DemoProductionSftpDeployUser.Properties.PosixProfile).toBeUndefined()
  })

  it('requires a storage backend', () => {
    expect(() =>
      Sftp.create({
        slug: 'demo',
        environment: 'production',
        users: {},
      }),
    ).toThrow(/bucket/)
  })

  it('validates VPC endpoint details and user home directories', () => {
    expect(() =>
      Sftp.create({
        slug: 'demo',
        environment: 'production',
        bucket: 'demo-uploads',
        endpointType: 'VPC',
        users: {},
      }),
    ).toThrow(/endpointDetails/)

    expect(() =>
      Sftp.create({
        slug: 'demo',
        environment: 'production',
        bucket: 'demo-uploads',
        users: { deploy: { sshPublicKeys: ['key'], homeDirectory: '../other' } },
      }),
    ).toThrow(/homeDirectory/)
  })
})
