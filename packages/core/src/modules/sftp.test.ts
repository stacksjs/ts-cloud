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
    expect(role.Properties.Policies[0].PolicyDocument.Statement[1].Resource).toBe('arn:aws:s3:::demo-uploads/incoming/deploy/*')
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

  it('validates VPC endpoint details and user home directories', () => {
    expect(() => Sftp.create({
      slug: 'demo',
      environment: 'production',
      bucket: 'demo-uploads',
      endpointType: 'VPC',
      users: {},
    })).toThrow(/endpointDetails/)

    expect(() => Sftp.create({
      slug: 'demo',
      environment: 'production',
      bucket: 'demo-uploads',
      users: { deploy: { sshPublicKeys: ['key'], homeDirectory: '../other' } },
    })).toThrow(/homeDirectory/)
  })
})
