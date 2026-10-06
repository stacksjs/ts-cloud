import { describe, expect, test } from 'bun:test'
import { EC2Client } from './ec2'

function capture(response: Record<string, unknown> = {}) {
  const ec2 = new EC2Client('us-west-2')
  const sent: Array<Record<string, string>> = []
  ;(ec2 as any).client = {
    request: async (options: { body: string }) => {
      sent.push(Object.fromEntries(new URLSearchParams(options.body)))
      return response
    },
  }
  return { ec2, sent }
}

describe('EC2 launch options', () => {
  test('runInstances sends the key pair, shutdown behaviour, disks and IMDSv2', async () => {
    const { ec2, sent } = capture({ RunInstancesResponse: { instancesSet: { item: [] } } })
    await ec2.runInstances({
      ImageId: 'ami-1',
      InstanceType: 'm7gd.16xlarge',
      MinCount: 1,
      MaxCount: 1,
      KeyName: 'build',
      InstanceInitiatedShutdownBehavior: 'terminate',
      BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: 64, VolumeType: 'gp3', DeleteOnTermination: true } }],
      MetadataOptions: { HttpTokens: 'required' },
    })
    expect(sent[0]).toMatchObject({
      'Action': 'RunInstances',
      'KeyName': 'build',
      'InstanceInitiatedShutdownBehavior': 'terminate',
      'BlockDeviceMapping.1.DeviceName': '/dev/sda1',
      'BlockDeviceMapping.1.Ebs.VolumeSize': '64',
      'BlockDeviceMapping.1.Ebs.VolumeType': 'gp3',
      'BlockDeviceMapping.1.Ebs.DeleteOnTermination': 'true',
      'MetadataOptions.HttpTokens': 'required',
    })
  })

  test('importKeyPair base64-encodes the public key and deleteKeyPair names it', async () => {
    const { ec2, sent } = capture({ ImportKeyPairResponse: { keyName: 'build', keyPairId: 'key-1', keyFingerprint: 'ab:cd' } })
    const imported = await ec2.importKeyPair({ KeyName: 'build', PublicKeyMaterial: 'ssh-ed25519 AAAA test\n' })
    expect(imported).toEqual({ KeyName: 'build', KeyPairId: 'key-1', KeyFingerprint: 'ab:cd' })
    expect(sent[0]!.Action).toBe('ImportKeyPair')
    expect(Buffer.from(sent[0]!.PublicKeyMaterial!, 'base64').toString()).toBe('ssh-ed25519 AAAA test')
    await ec2.deleteKeyPair('build')
    expect(sent[1]).toMatchObject({ Action: 'DeleteKeyPair', KeyName: 'build' })
  })
})
