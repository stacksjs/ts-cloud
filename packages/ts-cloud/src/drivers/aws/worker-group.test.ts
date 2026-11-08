import { describe, expect, test } from 'bun:test'
import type { AwsWorkerGroupConfig } from './worker-group'
import { AwsWorkerGroupApi, buildWorkerUserData, convergeAwsWorkerGroup, flattenQuery, planWorkerGroup, queryList, queryResult, subnetCidr } from './worker-group'

const config: AwsWorkerGroupConfig = {
  name: 'ci-workers',
  region: 'us-east-1',
  instanceTypes: ['c7a.2xlarge', 'c6a.2xlarge'],
  market: { spot: true, onDemandBaseCapacity: 0, onDemandPercentageAboveBase: 0 },
  min: 0,
  max: 6,
  diskGb: 80,
  registrationGraceSeconds: 900,
}
const now = new Date('2026-11-08T20:00:00Z')
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000)

describe('planWorkerGroup', () => {
  test('asks for one instance per waiting task when nothing is up', () => {
    expect(planWorkerGroup({ config, currentDesired: 0, instances: [], workers: [], waiting: 3, now })).toMatchObject({ desired: 3, reap: [] })
  })

  test('does not ask again for tasks an arriving instance will take', () => {
    const instances = [{ id: 'i-a', lifecycle: 'Pending', launchedAt: ago(60) }, { id: 'i-b', lifecycle: 'InService', launchedAt: ago(60) }]
    expect(planWorkerGroup({ config, currentDesired: 2, instances, workers: [], waiting: 2, now }).desired).toBe(2)
  })

  test('uses an idle worker before asking for a new instance', () => {
    const instances = [{ id: 'i-a', lifecycle: 'InService', launchedAt: ago(600) }]
    expect(planWorkerGroup({ config, currentDesired: 1, instances, workers: [{ name: 'i-a', idle: true }], waiting: 1, now }).desired).toBe(1)
  })

  test('adds capacity beyond what busy workers hold', () => {
    const instances = [{ id: 'i-a', lifecycle: 'InService', launchedAt: ago(600) }]
    expect(planWorkerGroup({ config, currentDesired: 1, instances, workers: [{ name: 'i-a', idle: false }], waiting: 2, now }).desired).toBe(3)
  })

  test('never goes above max, and says so', () => {
    const plan = planWorkerGroup({ config, currentDesired: 4, instances: [], workers: [], waiting: 40, now })
    expect(plan.desired).toBe(6)
    expect(plan.reasons).toContain('capped at max 6')
  })

  test('never lowers the desired capacity: idle instances remove themselves', () => {
    const instances = [{ id: 'i-a', lifecycle: 'InService', launchedAt: ago(600) }]
    expect(planWorkerGroup({ config, currentDesired: 1, instances, workers: [{ name: 'i-a', idle: true }], waiting: 0, now })).toMatchObject({ desired: 1, reap: [] })
  })

  test('reaps only an instance that never registered within the grace period', () => {
    const instances = [{ id: 'i-old', lifecycle: 'InService', launchedAt: ago(1800) }, { id: 'i-new', lifecycle: 'InService', launchedAt: ago(120) }]
    const plan = planWorkerGroup({ config, currentDesired: 2, instances, workers: [], waiting: 1, now })
    expect(plan.reap).toEqual(['i-old'])
    expect(plan.desired).toBe(1)
  })

  test('never reaps a registered instance, however old', () => {
    const instances = [{ id: 'i-a', lifecycle: 'InService', launchedAt: ago(86_400) }]
    expect(planWorkerGroup({ config, currentDesired: 1, instances, workers: [{ name: 'i-a', idle: false }], waiting: 0, now }).reap).toEqual([])
  })
})

describe('buildWorkerUserData', () => {
  const script = buildWorkerUserData({
    box: { name: 'ci-workers', size: 'c7a.2xlarge', pantryVersion: '0.11.184', packages: ['bun.sh@1.4.4'], user: { name: 'runner' } },
    user: 'runner',
    command: '/home/runner/worker --name "$INSTANCE_ID"',
    env: { WORKER_URL: 'https://example.test', WORKER_TOKEN: "it's secret" },
  })

  test('terminates the instance and lowers desired capacity when the worker exits', () => {
    expect(script).toContain('trap finish EXIT')
    expect(script).toContain('--should-decrement-desired-capacity || shutdown -h now')
  })

  test('refuses the worker user the metadata service before starting it', () => {
    const block = script.indexOf('--uid-owner runner -d 169.254.169.254/32 -j REJECT || exit 1')
    expect(block).toBeGreaterThan(0)
    expect(block).toBeLessThan(script.indexOf('sudo -u runner'))
  })

  test('runs the command as the user with quoted environment', () => {
    expect(script).toContain(`sudo -u runner -H env WORKER_URL='https://example.test' WORKER_TOKEN='it'"'"'s secret' /home/runner/worker --name "$INSTANCE_ID"`)
  })

  test('converges the box before anything runs', () => {
    const converge = Buffer.from(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(script)![1]!, 'base64').toString()
    expect(converge).toContain('bun.sh@1.4.4')
  })

  test('refuses an unsafe user or variable name', () => {
    expect(() => buildWorkerUserData({ box: { name: 'x', size: 'y' }, user: 'root; rm', command: 'true' })).toThrow('user name')
    expect(() => buildWorkerUserData({ box: { name: 'x', size: 'y' }, user: 'runner', command: 'true', env: { 'A B': 'x' } })).toThrow('variable name')
  })
})

describe('query parameters', () => {
  test('flattens Auto Scaling lists as member.N and EC2 lists as N', () => {
    expect(flattenQuery({ Names: ['a'], Policy: { Overrides: [{ InstanceType: 'c6a.2xlarge' }] } }, 'member')).toEqual({ 'Names.member.1': 'a', 'Policy.Overrides.member.1.InstanceType': 'c6a.2xlarge' })
    expect(flattenQuery({ Filter: [{ Name: 'vpc-id', Value: ['vpc-1'] }] }, 'ec2')).toEqual({ 'Filter.1.Name': 'vpc-id', 'Filter.1.Value.1': 'vpc-1' })
  })

  test('reads one or many list entries the same way', () => {
    expect(queryList({ member: { a: 1 } })).toEqual([{ a: 1 }])
    expect(queryList({ item: [{ a: 1 }, { a: 2 }] })).toHaveLength(2)
    expect(queryList('')).toEqual([])
    expect(queryResult({ FooResponse: { FooResult: { x: 1 } } }, 'Foo')).toEqual({ x: 1 })
  })
})

describe('convergeAwsWorkerGroup', () => {
  function fake(existing: { group?: boolean } = {}) {
    const calls: { service: string, action: string, params: URLSearchParams, region: string }[] = []
    const api = new AwsWorkerGroupApi({
      request: async (options: any) => {
        if (options.service === 'ssm')
          return { Parameter: { Value: 'ami-0123456789abcdef0' } }
        const params = new URLSearchParams(options.body)
        const action = String(params.get('Action'))
        calls.push({ service: options.service, action, params, region: options.region })
        if (action === 'GetRole' || action === 'GetInstanceProfile')
          throw Object.assign(new Error('NoSuchEntity: not found'), { code: 'NoSuchEntity' })
        const answers: Record<string, any> = {
          GetCallerIdentity: { Account: '111122223333' },
          DescribeVpcs: { vpcSet: { item: { vpcId: 'vpc-1' } } },
          DescribeSubnets: { subnetSet: { item: [{ subnetId: 'subnet-a' }, { subnetId: 'subnet-b' }] } },
          DescribeSecurityGroups: { securityGroupInfo: '' },
          CreateSecurityGroup: { groupId: 'sg-1' },
          DescribeLaunchTemplates: { launchTemplates: '' },
          DescribeAutoScalingGroups: { AutoScalingGroups: existing.group ? { member: { DesiredCapacity: 2, MinSize: 0, MaxSize: 6, Instances: '' } } : '' },
        }
        return { [`${action}Response`]: { [`${action}Result`]: answers[action] ?? {} } }
      },
    }, 'us-east-1')
    return { api, calls }
  }

  test('creates a spot mixed instances group and everything it needs', async () => {
    const { api, calls } = fake()
    await convergeAwsWorkerGroup(api, config, { userData: '#!/bin/bash\ntrue\n', sleep: async () => {} })
    expect(calls.map(call => call.action)).toEqual(expect.arrayContaining(['CreateSecurityGroup', 'CreateRole', 'PutRolePolicy', 'CreateInstanceProfile', 'AddRoleToInstanceProfile', 'CreateLaunchTemplate', 'CreateAutoScalingGroup']))

    const asg = calls.find(call => call.action === 'CreateAutoScalingGroup')!.params
    expect(asg.get('DesiredCapacity')).toBe('0')
    expect(asg.get('VPCZoneIdentifier')).toBe('subnet-a,subnet-b')
    expect(asg.get('MixedInstancesPolicy.InstancesDistribution.SpotAllocationStrategy')).toBe('price-capacity-optimized')
    expect(asg.get('MixedInstancesPolicy.InstancesDistribution.OnDemandPercentageAboveBaseCapacity')).toBe('0')
    expect(asg.get('MixedInstancesPolicy.LaunchTemplate.Overrides.member.2.InstanceType')).toBe('c6a.2xlarge')
    expect(asg.get('NewInstancesProtectedFromScaleIn')).toBe('true')

    const template = calls.find(call => call.action === 'CreateLaunchTemplate')!.params
    expect(template.get('LaunchTemplateData.MetadataOptions.HttpTokens')).toBe('required')
    expect(template.get('LaunchTemplateData.ImageId')).toBe('ami-0123456789abcdef0')

    const policy = JSON.parse(String(calls.find(call => call.action === 'PutRolePolicy')!.params.get('PolicyDocument')))
    expect(policy.Statement).toEqual([{ Effect: 'Allow', Action: 'autoscaling:TerminateInstanceInAutoScalingGroup', Resource: 'arn:aws:autoscaling:us-east-1:111122223333:autoScalingGroup:*:autoScalingGroupName/ci-workers' }])
    expect(calls.filter(call => call.service === 'iam').every(call => call.region === 'us-east-1')).toBe(true)
  })

  test('updates an existing group without touching its desired capacity', async () => {
    const { api, calls } = fake({ group: true })
    await convergeAwsWorkerGroup(api, config, { userData: '#!/bin/bash\n', sleep: async () => {} })
    expect(calls.find(call => call.action === 'UpdateAutoScalingGroup')!.params.get('DesiredCapacity')).toBeNull()
    expect(calls.some(call => call.action === 'CreateAutoScalingGroup' || call.action === 'SetDesiredCapacity')).toBe(false)
  })

  test('changes nothing on a dry run', async () => {
    const { api, calls } = fake()
    await convergeAwsWorkerGroup(api, config, { userData: '#!/bin/bash\n', dryRun: true, sleep: async () => {} })
    expect(calls.some(call => /^(Create|Put|Add|Update|Set)/.test(call.action))).toBe(false)
  })

  test('refuses user data EC2 would reject', async () => {
    const { api } = fake()
    await expect(convergeAwsWorkerGroup(api, config, { userData: 'x'.repeat(20_000) })).rejects.toThrow('16384')
  })
})

describe('a dedicated network', () => {
  const dedicated: AwsWorkerGroupConfig = { ...config, network: 'dedicated' }

  function fake(existing: { network?: boolean } = {}) {
    const calls: { action: string, params: URLSearchParams }[] = []
    const api = new AwsWorkerGroupApi({
      request: async (options: any) => {
        if (options.service === 'ssm')
          return { Parameter: { Value: 'ami-0123456789abcdef0' } }
        const params = new URLSearchParams(options.body)
        const action = String(params.get('Action'))
        calls.push({ action, params })
        if (action === 'GetRole' || action === 'GetInstanceProfile')
          return {}
        const owned = params.get('Filter.1.Name') === 'tag:ts-cloud:worker-group' || params.get('Filter.2.Name') === 'tag:ts-cloud:worker-group'
        const answers: Record<string, any> = {
          GetCallerIdentity: { Account: '111122223333' },
          DescribeAvailabilityZones: { availabilityZoneInfo: { item: [{ zoneName: 'us-east-1b' }, { zoneName: 'us-east-1a' }] } },
          DescribeVpcs: { vpcSet: existing.network && owned ? { item: { vpcId: 'vpc-own' } } : '' },
          CreateVpc: { vpc: { vpcId: 'vpc-new' } },
          DescribeInternetGateways: { internetGatewaySet: existing.network ? { item: { internetGatewayId: 'igw-own' } } : '' },
          CreateInternetGateway: { internetGateway: { internetGatewayId: 'igw-new' } },
          DescribeRouteTables: { routeTableSet: existing.network ? { item: { routeTableId: 'rtb-own' } } : '' },
          CreateRouteTable: { routeTable: { routeTableId: 'rtb-new' } },
          DescribeSubnets: { subnetSet: existing.network ? { item: [{ subnetId: 'subnet-a', availabilityZone: 'us-east-1a' }, { subnetId: 'subnet-b', availabilityZone: 'us-east-1b' }] } : '' },
          CreateSubnet: { subnet: { subnetId: `subnet-${calls.filter(call => call.action === 'CreateSubnet').length}` } },
          DescribeSecurityGroups: { securityGroupInfo: { item: { groupId: 'sg-own' } } },
          DescribeLaunchTemplates: { launchTemplates: '' },
          DescribeAutoScalingGroups: { AutoScalingGroups: '' },
        }
        return { [`${action}Response`]: { [`${action}Result`]: answers[action] ?? {} } }
      },
    }, 'us-east-1')
    return { api, calls }
  }

  test('creates a VPC, gateway, public route and one public subnet per zone', async () => {
    const { api, calls } = fake()
    await convergeAwsWorkerGroup(api, dedicated, { userData: '#!/bin/bash\n', sleep: async () => {} })
    const of = (action: string) => calls.filter(call => call.action === action).map(call => call.params)
    expect(of('CreateVpc')[0]!.get('CidrBlock')).toBe('10.88.0.0/16')
    expect(of('CreateVpc')[0]!.get('TagSpecification.1.Tag.2.Value')).toBe('ci-workers')
    expect(of('AttachInternetGateway')[0]!.get('VpcId')).toBe('vpc-new')
    expect(of('CreateRoute')[0]!.get('DestinationCidrBlock')).toBe('0.0.0.0/0')
    expect(of('CreateRoute')[0]!.get('GatewayId')).toBe('igw-new')
    expect(of('CreateSubnet').map(params => `${params.get('AvailabilityZone')} ${params.get('CidrBlock')}`)).toEqual(['us-east-1a 10.88.0.0/20', 'us-east-1b 10.88.16.0/20'])
    expect(of('ModifySubnetAttribute').every(params => params.get('MapPublicIpOnLaunch.Value') === 'true')).toBe(true)
    expect(of('AssociateRouteTable')).toHaveLength(2)
    expect(of('CreateAutoScalingGroup')[0]!.get('VPCZoneIdentifier')).toBe('subnet-1,subnet-2')
  })

  test('finds the network it made instead of making another', async () => {
    const { api, calls } = fake({ network: true })
    await convergeAwsWorkerGroup(api, dedicated, { userData: '#!/bin/bash\n', sleep: async () => {} })
    expect(calls.some(call => /^Create(Vpc|InternetGateway|RouteTable|Subnet|Route)$/.test(call.action))).toBe(false)
    expect(calls.find(call => call.action === 'CreateAutoScalingGroup')!.params.get('VPCZoneIdentifier')).toBe('subnet-a,subnet-b')
  })

  test('says what it would create on a dry run, and creates nothing', async () => {
    const { api, calls } = fake()
    const report = await convergeAwsWorkerGroup(api, dedicated, { userData: '#!/bin/bash\n', dryRun: true, sleep: async () => {} })
    expect(report.some(line => line.startsWith('would create network ci-workers (10.88.0.0/16, 2 public subnets)'))).toBe(true)
    expect(calls.some(call => /^(Create|Put|Add|Update|Set|Attach|Associate|Modify)/.test(call.action))).toBe(false)
  })

  test('splits the range into /20s, one per zone, and refuses a seventeenth', () => {
    expect(subnetCidr('10.88.0.0/16', 0)).toBe('10.88.0.0/20')
    expect(subnetCidr('10.88.0.0/16', 5)).toBe('10.88.80.0/20')
    expect(() => subnetCidr('10.88.0.0/16', 16)).toThrow('sixteen')
  })

  test('refuses to guess when the default VPC is gone', async () => {
    const { api } = fake()
    await expect(convergeAwsWorkerGroup(api, config, { userData: '#!/bin/bash\n', sleep: async () => {} })).rejects.toThrow("network: 'dedicated'")
  })
})
