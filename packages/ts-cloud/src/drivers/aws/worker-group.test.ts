import { describe, expect, test } from 'bun:test'
import type { AwsWorkerGroupConfig } from './worker-group'
import { AwsWorkerGroupApi, awsWorkerGroupApi, buildWorkerUserData, convergeAwsWorkerGroup, flattenQuery, onEc2, planMarket, planWorkerGroup, queryList, queryResult, spotLaunchRefused, spotReclaimed, subnetCidr, transitionTime } from './worker-group'

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

  test('says why it quit on the serial console, which outlives the instance', () => {
    expect(script).toContain('tee -a /var/log/ts-cloud-worker.log')
    expect(script).toContain('>/dev/console) 2>&1')
    expect(script.indexOf('/dev/console')).toBeLessThan(script.indexOf('trap finish EXIT'))
  })

  test('is a script bash can parse', () => {
    const parsed = Bun.spawnSync(['bash', '-n'], { stdin: new TextEncoder().encode(script) })
    expect(parsed.stderr.toString()).toBe('')
    expect(parsed.exitCode).toBe(0)
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
    const report = await convergeAwsWorkerGroup(api, dedicated, { userData: '#!/bin/bash\n', sleep: async () => {} })
    // A real run reports what it did, not what it would do.
    expect(report.some(line => line.startsWith('created network ci-workers'))).toBe(true)
    expect(report.some(line => line.startsWith('would '))).toBe(false)
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

describe('credentials for the scaler', () => {
  function withEnv(env: Record<string, string | undefined>, run: () => void): void {
    const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined)
        delete process.env[key]
      else process.env[key] = value
    }
    try {
      run()
    }
    finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined)
          delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  const none = { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_PROFILE: 'ts-cloud-test-missing', AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/credentials', AWS_CONFIG_FILE: '/nonexistent/config' }

  test('are none off EC2 without keys, so a tick can skip quietly', () => {
    withEnv(none, () => expect(awsWorkerGroupApi('us-east-1', { onEc2: () => false })).toBeNull())
  })

  test('come from the instance role on EC2', () => {
    withEnv(none, () => expect(awsWorkerGroupApi('us-east-1', { onEc2: () => true })).not.toBeNull())
  })

  test('come from keys in the environment anywhere', () => {
    withEnv({ ...none, AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE00', AWS_SECRET_ACCESS_KEY: 'x'.repeat(40) }, () => expect(awsWorkerGroupApi('us-east-1', { onEc2: () => false })).not.toBeNull())
  })

  test('an EC2 host is recognised by its firmware', () => {
    expect(onEc2(path => path.endsWith('board_asset_tag') ? 'i-0abc123def4567890\n' : null)).toBe(true)
    expect(onEc2(path => path.endsWith('uuid') ? 'EC2E1916-9099-7CAF-FD21-012345ABCDEF' : null)).toBe(true)
    expect(onEc2(path => path.endsWith('board_asset_tag') ? 'Not Specified' : null)).toBe(false)
    expect(onEc2(() => null)).toBe(false)
  })
})

describe('when Spot runs dry', () => {
  const quiet = { refused: [], interrupted: new Map<string, Date>() }

  test('launches on-demand after a refused spot launch, and says why', () => {
    const plan = planMarket({ config, current: 0, trouble: { refused: [ago(120)], interrupted: new Map() }, now })
    expect(plan.percent).toBe(100)
    expect(plan.reason).toContain('1 spot launch(es) refused')
  })

  test('launches on-demand after an instance is reclaimed', () => {
    expect(planMarket({ config, current: 0, trouble: { refused: [], interrupted: new Map([['i-a', ago(60)]]) }, now }).percent).toBe(100)
  })

  test('stays on-demand while the trouble is recent, without asking again', () => {
    expect(planMarket({ config, current: 100, trouble: { refused: [ago(600)], interrupted: new Map() }, now }).percent).toBeNull()
  })

  test('goes back to the declared share once spot has been quiet for the window', () => {
    const plan = planMarket({ config, current: 100, trouble: { refused: [ago(1801)], interrupted: new Map() }, now })
    expect(plan.percent).toBe(0)
    expect(plan.reason).toContain('back to 0% on-demand')
    expect(planMarket({ config, current: 100, trouble: quiet, now }).percent).toBe(0)
  })

  test('changes nothing for a quiet spot group, an on-demand group, or one with fallback off', () => {
    expect(planMarket({ config, current: 0, trouble: quiet, now }).percent).toBeNull()
    const troubled = { refused: [ago(60)], interrupted: new Map() }
    expect(planMarket({ config: { ...config, market: { ...config.market, spot: false } }, current: 100, trouble: troubled, now }).percent).toBeNull()
    expect(planMarket({ config: { ...config, spotFallbackSeconds: 0 }, current: 0, trouble: troubled, now }).percent).toBeNull()
    expect(planMarket({ config, current: null, trouble: troubled, now }).percent).toBeNull()
  })

  test('tells capacity refusals from requests that are simply wrong', () => {
    expect(spotLaunchRefused({ StatusCode: 'Failed', StatusMessage: 'Could not launch Spot Instances. InsufficientInstanceCapacity - There is no Spot capacity available that matches your request.' })).toBe(true)
    expect(spotLaunchRefused({ StatusCode: 'Failed', StatusMessage: 'Could not launch Spot Instances. UnfulfillableCapacity - Unable to fulfill capacity due to your request configuration.' })).toBe(true)
    expect(spotLaunchRefused({ StatusCode: 'Successful', Description: 'Launching a new EC2 instance: i-1' })).toBe(false)
    expect(spotLaunchRefused({ StatusCode: 'Failed', StatusMessage: 'The security group sg-1 does not exist' })).toBe(false)
  })

  test('reads a reclamation and its time from EC2', () => {
    expect(spotReclaimed({ stateReason: { code: 'Server.SpotInstanceTermination' } })).toBe(true)
    expect(spotReclaimed({ stateReason: { code: 'Client.InstanceInitiatedShutdown' } })).toBe(false)
    expect(transitionTime('Service initiated (2026-11-10 19:49:07 GMT)')?.toISOString()).toBe('2026-11-10T19:49:07.000Z')
    expect(transitionTime('')).toBeNull()
  })

  function fake(answers: Record<string, any>) {
    const calls: { action: string, params: URLSearchParams }[] = []
    const api = new AwsWorkerGroupApi({
      request: async (options: any) => {
        const params = new URLSearchParams(options.body)
        const action = String(params.get('Action'))
        calls.push({ action, params })
        return { [`${action}Response`]: { [`${action}Result`]: answers[action] ?? {} } }
      },
    }, 'us-east-1')
    return { api, calls }
  }

  test('collects refused launches and reclaimed instances since a time', async () => {
    const { api, calls } = fake({
      DescribeScalingActivities: { Activities: { member: [
        { StatusCode: 'Failed', StatusMessage: 'Could not launch Spot Instances. InsufficientInstanceCapacity', StartTime: ago(300).toISOString() },
        { StatusCode: 'Failed', StatusMessage: 'Could not launch Spot Instances. InsufficientInstanceCapacity', StartTime: ago(7200).toISOString() },
        { StatusCode: 'Successful', Description: 'Launching a new EC2 instance: i-b', StartTime: ago(200).toISOString() },
      ] } },
      DescribeInstances: { reservationSet: { item: { instancesSet: { item: [
        { instanceId: 'i-a', stateReason: { code: 'Server.SpotInstanceTermination' }, reason: `Service initiated (${ago(240).toISOString().slice(0, 19).replace('T', ' ')} GMT)` },
        { instanceId: 'i-c', stateReason: { code: 'Client.UserInitiatedShutdown' }, reason: '' },
      ] } } } },
    })
    const trouble = await api.spotTrouble('ci-workers', ago(1800))
    expect(trouble.refused).toHaveLength(1)
    expect([...trouble.interrupted.keys()]).toEqual(['i-a'])
    const describe = calls.find(call => call.action === 'DescribeInstances')!.params
    expect(describe.get('Filter.1.Name')).toBe('tag:ts-cloud:worker-group')
    expect(describe.get('Filter.1.Value.1')).toBe('ci-workers')
  })

  test('answers which runners were reclaimed by filter, so a forgotten id cannot fail the call', async () => {
    const { api, calls } = fake({ DescribeInstances: { reservationSet: { item: { instancesSet: { item: { instanceId: 'i-0abc12345', stateReason: { code: 'Server.SpotInstanceTermination' }, reason: '' } } } } } })
    expect([...await api.interrupted(['i-0abc12345', 'hq-runner-01'])]).toEqual(['i-0abc12345'])
    expect(calls[0]!.params.get('Filter.1.Name')).toBe('instance-id')
    expect(calls[0]!.params.get('Filter.1.Value.2')).toBeNull()
    expect(await api.interrupted(['hq-runner-01'])).toEqual(new Set())
    expect(calls).toHaveLength(1)
  })

  test('moves only the on-demand share, and reads it back', async () => {
    const { api, calls } = fake({ DescribeAutoScalingGroups: { AutoScalingGroups: { member: { DesiredCapacity: 1, MinSize: 0, MaxSize: 6, Instances: '', MixedInstancesPolicy: { InstancesDistribution: { OnDemandPercentageAboveBaseCapacity: '100' } } } } } })
    await api.setOnDemandShare('ci-workers', 100)
    const update = calls.find(call => call.action === 'UpdateAutoScalingGroup')!.params
    expect(update.get('MixedInstancesPolicy.InstancesDistribution.OnDemandPercentageAboveBaseCapacity')).toBe('100')
    expect([...update.keys()].some(key => key.includes('LaunchTemplate'))).toBe(false)
    expect((await api.describeGroup('ci-workers'))?.onDemandPercentage).toBe(100)
  })
})
