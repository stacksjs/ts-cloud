import type { CloudConfig, SftpConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { buildComputeProvisionScripts } from './compute-provision'
import {
  assertSftpSupported,
  buildSftpProvisionScript,
  DEFAULT_SFTP_PORT,
  sftpFirewallPorts,
  sftpRoot,
  sftpUnitName,
} from './sftp-provision'

const users: SftpConfig['users'] = {
  deploy: { sshPublicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest deploy@example.com'] },
}

describe('sftp provisioning', () => {
  it('installs ts-sftp and runs it as a systemd unit', () => {
    const script = buildSftpProvisionScript({ slug: 'demo', sftp: { users } }).join('\n')

    expect(script).toContain('bun add ts-sftp@latest')
    expect(script).toContain('/etc/systemd/system/demo-sftp.service')
    expect(script).toContain('systemctl enable demo-sftp.service')
    expect(script).toContain('--root /var/sftp/demo')
    expect(script).toContain(`--port ${DEFAULT_SFTP_PORT}`)
    expect(script).toContain('--user deploy:/etc/ts-sftp/users/deploy.pub')
  })

  it('keeps an existing host key so the fingerprint survives a redeploy', () => {
    const script = buildSftpProvisionScript({ slug: 'demo', sftp: { users } }).join('\n')
    expect(script).toContain('[ -f /etc/ts-sftp/host_key ] || bun')
    expect(script).toContain('chmod 600 /etc/ts-sftp/host_key')
  })

  it('writes each user their own authorized keys file and home directory', () => {
    const script = buildSftpProvisionScript({
      slug: 'demo',
      sftp: {
        users: {
          deploy: { sshPublicKeys: ['ssh-ed25519 AAAAKey1', 'ssh-ed25519 AAAAKey2'], homeDirectory: 'incoming/deploy' },
        },
      },
    }).join('\n')

    expect(script).toContain("mkdir -p '/var/sftp/demo/incoming/deploy'")
    expect(script).toContain('ssh-ed25519 AAAAKey1\nssh-ed25519 AAAAKey2')
  })

  it('honors port, read-only, version, and a custom directory', () => {
    const script = buildSftpProvisionScript({
      slug: 'demo',
      sftp: {
        users,
        port: 2022,
        readOnly: true,
        version: '0.1.1',
        storage: { type: 'efs', path: '/srv/uploads' },
      },
    }).join('\n')

    expect(script).toContain('bun add ts-sftp@0.1.1')
    expect(script).toContain('--root /srv/uploads')
    expect(script).toContain('--port 2022')
    expect(script).toContain('--read-only')
    expect(script).toContain('ReadWritePaths=/srv/uploads')
  })

  it('rejects a home directory that climbs out of the root', () => {
    expect(() =>
      buildSftpProvisionScript({
        slug: 'demo',
        sftp: { users: { deploy: { sshPublicKeys: ['ssh-ed25519 AAAA'], homeDirectory: '../escape' } } },
      }),
    ).toThrow(/homeDirectory/)
  })

  it('names the unit and root after the project', () => {
    expect(sftpUnitName('my-app')).toBe('my-app-sftp')
    expect(sftpRoot({ slug: 'my-app', sftp: { users } })).toBe('/var/sftp/my-app')
    expect(sftpFirewallPorts({ users, port: 2022 })).toEqual([2022])
    expect(sftpFirewallPorts(undefined)).toEqual([])
  })
})

describe('provider support', () => {
  it('accepts anything on aws, where Transfer Family serves it', () => {
    expect(() => assertSftpSupported({ bucket: 'uploads', users }, 'aws')).not.toThrow()
  })

  it('explains that bucket storage is aws-only', () => {
    expect(() => assertSftpSupported({ bucket: 'uploads', users }, 'hetzner')).toThrow(
      /bucket-backed storage is only available on the aws provider/,
    )
    expect(() => assertSftpSupported({ storage: { type: 's3', bucket: 'uploads' }, users }, 'hetzner')).toThrow(
      /storage: \{ type: 'efs' \}/,
    )
  })

  it('accepts on-server storage on a box provider', () => {
    expect(() => assertSftpSupported({ storage: { type: 'efs' }, users }, 'hetzner')).not.toThrow()
  })

  it('requires a key for every user', () => {
    expect(() => assertSftpSupported({ storage: { type: 'efs' }, users: { deploy: { sshPublicKeys: [] } } }, 'hetzner'))
      .toThrow(/needs at least one SSH public key/)
  })
})

describe('compute provisioning', () => {
  const config: CloudConfig = {
    project: { name: 'Demo', slug: 'demo', region: 'us-east-1' },
    environments: { production: { type: 'production' } },
    cloud: { provider: 'hetzner' },
    infrastructure: {
      compute: { size: 'small' },
      sftp: { storage: { type: 'efs' }, users },
    },
  }

  it('provisions the SFTP server as part of a box deploy', () => {
    const scripts = buildComputeProvisionScripts(config)
    const extras = (scripts.servicesProvision ?? []).join(String.fromCharCode(10))

    expect(extras).toContain('systemctl enable demo-sftp.service')
    expect(extras).toContain('--user deploy:/etc/ts-sftp/users/deploy.pub')
  })

  it('leaves a box deploy untouched when no sftp is configured', () => {
    const scripts = buildComputeProvisionScripts({
      ...config,
      infrastructure: { compute: { size: 'small' } },
    })
    expect((scripts.servicesProvision ?? []).join(String.fromCharCode(10))).not.toContain("ts-sftp")
  })

  it('fails the deploy rather than silently dropping an aws-only option', () => {
    expect(() =>
      buildComputeProvisionScripts({
        ...config,
        infrastructure: { compute: { size: 'small' }, sftp: { bucket: 'demo-uploads', users } },
      }),
    ).toThrow(/only available on the aws provider/)
  })
})
