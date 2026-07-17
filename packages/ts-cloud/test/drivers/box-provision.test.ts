import type { BoxEc2Client, BoxSsmClient } from '../../src/drivers/shared/box-provision'
import { describe, expect, it } from 'bun:test'
import { HetznerClient } from '../../src/drivers/hetzner/client'
import {
  AwsBoxProvisioner,
  buildBoxUserData,
  createBoxProvisioner,
  HetznerBoxProvisioner,
} from '../../src/drivers/shared/box-provision'

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBOXKEY chris@laptop'

describe('buildBoxUserData', () => {
  it('authorizes the key for root and enables root login', () => {
    const userData = buildBoxUserData({ sshPublicKey: KEY })
    expect(userData.startsWith('#cloud-config')).toBe(true)
    expect(userData).toContain('disable_root: false')
    expect(userData).toContain(`  - ${KEY}`)
    expect(userData).toContain('/root/.ssh/authorized_keys')
  })

  it('embeds and runs the bootstrap script when given', () => {
    const userData = buildBoxUserData({ sshPublicKey: KEY, bootstrapScript: '#!/bin/bash\necho hello' })
    expect(userData).toContain('write_files:')
    expect(userData).toContain('echo hello')
    expect(userData).toContain('[ bash, /var/lib/cloud/box-bootstrap.sh ]')
  })

  it('omits write_files without a bootstrap script', () => {
    const userData = buildBoxUserData({ sshPublicKey: KEY })
    expect(userData).not.toContain('write_files:')
    expect(userData).not.toContain('box-bootstrap.sh')
  })
})

describe('HetznerBoxProvisioner', () => {
  function fakeHetzner(calls: string[]): HetznerClient {
    const running = {
      id: 42,
      name: 'demo-box',
      status: 'running',
      public_net: { ipv4: { ip: '203.0.113.9' } },
      server_type: { name: 'cx23' },
      datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
    }
    const routes: Record<string, (body: any) => unknown> = {
      'GET /ssh_keys': () => ({ ssh_keys: [] }),
      'POST /ssh_keys': body => ({ ssh_key: { id: 1, name: body.name, fingerprint: 'ff', public_key: body.public_key } }),
      'GET /firewalls': () => ({ firewalls: [] }),
      'POST /firewalls': body => ({ firewall: { id: 2, name: body.name }, actions: [] }),
      'GET /servers': () => ({ servers: [] }),
      'POST /servers': body => ({ server: { ...running, name: body.name }, action: { id: 9, status: 'success' } }),
      'GET /servers/42': () => ({ server: running }),
    }
    return new HetznerClient({
      apiToken: 't',
      fetchImpl: async (url, init) => {
        const method = init?.method ?? 'GET'
        // Strip the pagination query string so routes match the bare path.
        const path = url.replace('https://api.hetzner.cloud/v1', '').split('?')[0]
        calls.push(`${method} ${path}`)
        const handler = routes[`${method} ${path}`]
        if (!handler)
          return new Response(JSON.stringify({ error: { message: `no route ${method} ${path}` } }), { status: 404 })
        return new Response(JSON.stringify(handler(init?.body ? JSON.parse(String(init.body)) : undefined)), { status: 200 })
      },
    })
  }

  it('provisions key + firewall + server and reports the public IP', async () => {
    const calls: string[] = []
    const provisioner = new HetznerBoxProvisioner(fakeHetzner(calls))
    const box = await provisioner.ensureBox({
      name: 'demo-box',
      size: 'cx23',
      ports: [{ protocol: 'udp', port: 51820 }],
      sshPublicKey: KEY,
    })
    expect(box).toEqual({ provider: 'hetzner', id: '42', name: 'demo-box', publicIp: '203.0.113.9', created: true })
    expect(calls).toContain('POST /ssh_keys')
    expect(calls).toContain('POST /firewalls')
    expect(calls).toContain('POST /servers')
  })
})

describe('AwsBoxProvisioner', () => {
  function fakes(overrides: Partial<Record<string, any>> = {}): { ec2: BoxEc2Client, ssm: BoxSsmClient, calls: string[] } {
    const calls: string[] = []
    const running = {
      InstanceId: 'i-0abc',
      State: { Name: 'running' as const },
      PublicIpAddress: '198.51.100.4',
    }
    const ec2: BoxEc2Client = {
      describeInstances: async (options) => {
        calls.push('describeInstances')
        const states = options?.Filters?.find(f => f.Name === 'instance-state-name')?.Values ?? []
        if (overrides.existingInstance && states.includes('running'))
          return { Reservations: [{ Instances: [running] }] }
        return { Reservations: [] }
      },
      getInstance: async () => {
        calls.push('getInstance')
        return running
      },
      describeSecurityGroups: async () => {
        calls.push('describeSecurityGroups')
        return overrides.existingSg ? { SecurityGroups: [{ GroupId: 'sg-111' }] as any } : { SecurityGroups: [] }
      },
      createSecurityGroup: async () => {
        calls.push('createSecurityGroup')
        return { GroupId: 'sg-222' }
      },
      authorizeSecurityGroupIngress: async (options) => {
        calls.push(`authorizeIngress:${options.IpPermissions.map(p => `${p.IpProtocol}/${p.FromPort}`).join(',')}`)
      },
      runInstances: async (options) => {
        calls.push(`runInstances:${options.ImageId}:${options.InstanceType}`)
        return { Instances: [{ InstanceId: 'i-0abc' }] }
      },
      terminateInstances: async () => {
        calls.push('terminateInstances')
        return {} as any
      },
      deleteSecurityGroup: async () => {
        calls.push('deleteSecurityGroup')
      },
    }
    const ssm: BoxSsmClient = {
      getParameter: async () => {
        calls.push('ssm:getParameter')
        return { Parameter: { Value: 'ami-ubuntu2404' } } as any
      },
    }
    return { ec2, ssm, calls }
  }

  it('creates SG + instance with the resolved Ubuntu AMI and opens the requested ports', async () => {
    const { ec2, ssm, calls } = fakes()
    const provisioner = new AwsBoxProvisioner({ ec2, ssm })
    const box = await provisioner.ensureBox({
      name: 'demo-box',
      size: 't3.micro',
      ports: [{ protocol: 'udp', port: 51820 }, { protocol: 'icmp' }],
      sshPublicKey: KEY,
    })
    expect(box).toEqual({ provider: 'aws', id: 'i-0abc', name: 'demo-box', publicIp: '198.51.100.4', created: true })
    expect(calls).toContain('ssm:getParameter')
    expect(calls).toContain('createSecurityGroup')
    expect(calls).toContain('authorizeIngress:tcp/22,udp/51820,icmp/-1')
    expect(calls).toContain('runInstances:ami-ubuntu2404:t3.micro')
  })

  it('reuses a running instance without creating anything', async () => {
    const { ec2, ssm, calls } = fakes({ existingInstance: true })
    const provisioner = new AwsBoxProvisioner({ ec2, ssm })
    const box = await provisioner.ensureBox({ name: 'demo-box', size: 't3.micro', sshPublicKey: KEY })
    expect(box.created).toBe(false)
    expect(box.publicIp).toBe('198.51.100.4')
    expect(calls).not.toContain('runInstances:ami-ubuntu2404:t3.micro')
    expect(calls).not.toContain('createSecurityGroup')
  })

  it('honors an explicit ami- image without asking SSM', async () => {
    const { ec2, ssm, calls } = fakes()
    const provisioner = new AwsBoxProvisioner({ ec2, ssm })
    await provisioner.ensureBox({ name: 'demo-box', size: 't3.micro', image: 'ami-custom123', sshPublicKey: KEY })
    expect(calls).not.toContain('ssm:getParameter')
    expect(calls.some(c => c === 'runInstances:ami-custom123:t3.micro')).toBe(true)
  })
})

describe('createBoxProvisioner', () => {
  it('routes to the right implementation and validates options', () => {
    const hetzner = new HetznerClient({ apiToken: 't' })
    expect(createBoxProvisioner({ provider: 'hetzner', hetzner }).provider).toBe('hetzner')
    expect(() => createBoxProvisioner({ provider: 'hetzner' })).toThrow('HetznerClient')
    expect(() => createBoxProvisioner({ provider: 'aws' })).toThrow('ec2')
  })
})
