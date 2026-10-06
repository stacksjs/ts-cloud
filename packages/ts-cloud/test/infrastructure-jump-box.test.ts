/**
 * The jump box `infrastructure.jumpBox` generates (stacksjs/stacks#2862).
 *
 * It launched from `ami-0f3caa1cf4417e51b`, a us-east-1 image no other region
 * has, and with `KeyName: <slug>-<env>`, a key pair that had to exist before
 * the deploy. `databaseTools` dropped the size and the EFS mount, installed
 * with Amazon Linux 2 commands that do not exist on AL2023, and `mountEfs:
 * true` referenced a `FileSystem` resource the generator never creates.
 */

import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { amazonLinuxImageId, amazonLinuxImageParameter, Compute, isArmInstanceType } from '@ts-cloud/core'
import { InfrastructureGenerator } from '../src/generators/infrastructure'

function generate(infrastructure: CloudConfig['infrastructure'], region = 'eu-west-2'): any {
  const generator = new InfrastructureGenerator({
    config: {
      project: { name: 'Acme', slug: 'acme', region },
      environments: { production: { type: 'production', region } },
      infrastructure,
    } as CloudConfig,
    environment: 'production',
  })
  generator.generate()
  return JSON.parse(generator.toJSON())
}

function jumpBox(template: any): { instance: any, securityGroup: any, role: any, userData: string, logicalId: string } {
  const logicalId = template.Outputs.JumpBoxInstanceId.Value.Ref
  const instance = template.Resources[logicalId]
  const securityGroup = template.Resources[instance.Properties.SecurityGroupIds[0].Ref]
  const profile = template.Resources[instance.Properties.IamInstanceProfile.Ref]
  const role = template.Resources[profile.Properties.Roles[0].Ref]
  const encoded = instance.Properties.UserData['Fn::Base64']
  const userData = typeof encoded === 'string' ? encoded : JSON.stringify(encoded)
  return { instance, securityGroup, role, userData, logicalId }
}

describe('infrastructure.jumpBox', () => {
  it('launches the region\'s current Amazon Linux 2023, resolved from SSM, not a us-east-1 literal', () => {
    const { instance } = jumpBox(generate({ jumpBox: true }))

    expect(instance.Properties.ImageId).toBe('{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}}')
    expect(JSON.stringify(generate({ jumpBox: true }))).not.toContain('ami-0f3caa1cf4417e51b')
  })

  it('resolves the arm64 image for a Graviton size', () => {
    const { instance } = jumpBox(generate({ jumpBox: { size: 't4g.small' as never } }))

    expect(instance.Properties.InstanceType).toBe('t4g.small')
    expect(instance.Properties.ImageId).toContain('al2023-ami-kernel-default-arm64')
  })

  it('needs no key pair, opens no port, and can be reached through SSM', () => {
    const { instance, securityGroup, role } = jumpBox(generate({ jumpBox: true }))

    expect(instance.Properties.KeyName).toBeUndefined()
    expect(securityGroup.Properties.SecurityGroupIngress).toEqual([])
    expect(securityGroup.Properties.SecurityGroupEgress[0].CidrIp).toBe('0.0.0.0/0')
    expect(role.Properties.ManagedPolicyArns).toContain('arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore')
    expect(instance.Properties.SubnetId).toEqual({ Ref: 'PublicSubnet1' })
  })

  it('adds SSH only when a key pair or source ranges are configured', () => {
    const keyed = jumpBox(generate({ jumpBox: { keyName: 'ops' } }))
    expect(keyed.instance.Properties.KeyName).toBe('ops')
    expect(keyed.securityGroup.Properties.SecurityGroupIngress.map((r: any) => r.CidrIp)).toEqual(['0.0.0.0/0'])

    const ranged = jumpBox(generate({ jumpBox: { allowedCidrs: ['203.0.113.0/24'] } }))
    expect(ranged.instance.Properties.KeyName).toBeUndefined()
    expect(ranged.securityGroup.Properties.SecurityGroupIngress.map((r: any) => r.CidrIp)).toEqual(['203.0.113.0/24'])
  })

  it('keeps the size, the EFS mount and the database tools together', () => {
    const { instance, userData } = jumpBox(generate({
      jumpBox: { size: 'small', databaseTools: true, mountEfs: true },
      fileSystem: { shared: {} },
    } as never))

    expect(instance.Properties.InstanceType).toBe('t3.small')
    expect(userData).toContain('dnf install -y postgresql16 mariadb105 redis6')
    expect(userData).not.toContain('amazon-linux-extras')
    expect(userData).toContain('mount -t efs')
  })

  it('mounts the declared file system by reference, through Fn::Sub', () => {
    const template = generate({ jumpBox: { mountEfs: true }, fileSystem: { shared: {} } } as never)
    const { instance } = jumpBox(template)
    const [script, variables] = instance.Properties.UserData['Fn::Base64']['Fn::Sub']

    expect(script).toContain('mount -t efs -o tls ${FileSystemId}:/ /mnt/efs')
    expect(script).not.toContain('[object Object]')
    expect(template.Resources[variables.FileSystemId.Ref].Type).toBe('AWS::EFS::FileSystem')
  })

  it('mounts a named file system, or an EFS id as given', () => {
    const named = jumpBox(generate({ jumpBox: { mountEfs: 'logs' }, fileSystem: { shared: {}, logs: {} } } as never))
    const byId = jumpBox(generate({ jumpBox: { mountEfs: 'fs-0123abcd' } }))

    expect(named.instance.Properties.UserData['Fn::Base64']['Fn::Sub'][1].FileSystemId.Ref).toContain('Logs')
    expect(byId.instance.Properties.UserData['Fn::Base64']['Fn::Sub'][1].FileSystemId).toBe('fs-0123abcd')
  })

  it('refuses mountEfs: true without exactly one file system to mount', () => {
    expect(() => generate({ jumpBox: { mountEfs: true } })).toThrow('declares no file system')
    expect(() => generate({ jumpBox: { mountEfs: true }, fileSystem: { a: {}, b: {} } } as never)).toThrow('Set mountEfs to the name')
  })

  it('generates nothing when disabled', () => {
    expect(generate({ jumpBox: { enabled: false } }).Outputs?.JumpBoxInstanceId).toBeUndefined()
  })
})

describe('Amazon Linux image resolution', () => {
  it.each([
    ['t3.micro', false],
    ['m5.large', false],
    ['g4dn.xlarge', false],
    ['g5.xlarge', false],
    ['c5n.large', false],
    ['t4g.nano', true],
    ['m7g.large', true],
    ['c7gn.large', true],
    ['x2gd.large', true],
    ['im4gn.large', true],
    ['is4gen.large', true],
    ['g5g.xlarge', true],
    ['a1.medium', true],
  ])('%s is arm64: %p', (instanceType, arm) => {
    expect(isArmInstanceType(instanceType)).toBe(arm)
    expect(amazonLinuxImageParameter(instanceType)).toEndWith(arm ? 'arm64' : 'x86_64')
  })

  it('is the default for createServer, so it runs outside us-east-1', () => {
    expect(Compute.createServer({ slug: 'acme', environment: 'production' }).instance.Properties.ImageId).toBe(amazonLinuxImageId('t3.micro'))
    expect(Compute.createServer({ slug: 'acme', environment: 'production', instanceType: 'm7g.large' }).instance.Properties.ImageId).toBe(amazonLinuxImageId('m7g.large'))
  })
})
