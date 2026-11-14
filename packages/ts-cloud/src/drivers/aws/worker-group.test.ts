import { describe, expect, test } from 'bun:test'
import type { AwsWorkerGroupConfig } from './worker-group'
import { AwsWorkerGroupApi, awsWorkerGroupApi, buildWorkerUserData, convergeAwsWorkerGroup, flattenQuery, LAUNCH_BACKOFF_AFTER, launchedInstance, onEc2, planLaunchBackoff, planMarket, planWorkerGroup, queryList, queryResult, spotLaunchRefused, spotReclaimed, subnetCidr, transitionTime } from './worker-group'

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

describe('when launches keep ending without a worker', () => {
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000)
  const dead = (count: number, newestMinutesAgo = 3) => Array.from({ length: count }, (_, index) => ({ id: `i-dead${index}`, at: ago(newestMinutesAgo * 60 + index * 60) }))

  test('a group whose launches register is left alone', () => {
    const launches = [{ id: 'i-0a', at: ago(60) }, { id: 'i-0b', at: ago(600) }, { id: 'i-0c', at: ago(1200) }]
    expect(planLaunchBackoff({ config, launches, instances: [], registered: ['i-0a', 'i-0b', 'i-0c'], now })).toMatchObject({ backingOff: false, died: 0, allow: null, reason: null })
    expect(planLaunchBackoff({ config, launches: [], instances: [], registered: [], now }).backingOff).toBe(false)
  })

  test('one or two bad launches are not yet a pattern', () => {
    const plan = planLaunchBackoff({ config, launches: dead(LAUNCH_BACKOFF_AFTER - 1), instances: [], registered: [], now })
    expect(plan).toMatchObject({ backingOff: false, died: LAUNCH_BACKOFF_AFTER - 1, allow: null })
  })

  test('three in a row hold the group back, and say since when and where to look', () => {
    const plan = planLaunchBackoff({ config, launches: dead(3, 1), instances: [], registered: [], now })
    expect(plan).toMatchObject({ backingOff: true, died: 3, example: 'i-dead0', allow: 0 })
    expect(plan.since?.toISOString()).toBe(ago(180).toISOString())
    // Two minutes after the newest launch, which was a minute ago.
    expect(plan.nextProbeAt?.toISOString()).toBe(at(1).toISOString())
    expect(plan.reason).toContain('3 launch(es) in a row ended without a worker since 2026-11-08T19:57:00Z')
    expect(plan.reason).toContain('next probe at 2026-11-08T20:01:00Z')
  })

  test('the gap doubles with every further death and stops at the cap', () => {
    const gap = (count: number, cap?: number) => {
      const plan = planLaunchBackoff({ config: { ...config, launchBackoffSeconds: cap }, launches: dead(count, 0), instances: [], registered: [], now })
      return (plan.nextProbeAt!.getTime() - now.getTime()) / 1000
    }
    expect([3, 4, 5, 6, 7, 8, 40].map(count => gap(count))).toEqual([120, 240, 480, 960, 1800, 1800, 1800])
    expect(gap(9, 600)).toBe(600)
  })

  test('probes with one instance when the gap has passed, and waits for its verdict', () => {
    const launches = dead(3, 5)
    expect(planLaunchBackoff({ config, launches, instances: [], registered: [], now })).toMatchObject({ backingOff: true, allow: 1 })

    const probe = { id: 'i-probe1', at: ago(30) }
    const waiting = planLaunchBackoff({ config, launches: [probe, ...launches], instances: [{ id: 'i-probe1', lifecycle: 'Pending', launchedAt: probe.at }], registered: [], now })
    expect(waiting).toMatchObject({ backingOff: true, died: 3, probing: 'i-probe1', allow: 0 })
    expect(waiting.reason).toContain('probe i-probe1')
  })

  test('the first launch that registers ends it at once', () => {
    const launches = [{ id: 'i-good1', at: ago(120) }, ...dead(40, 30)]
    expect(planLaunchBackoff({ config, launches, instances: [{ id: 'i-good1', lifecycle: 'InService', launchedAt: ago(120) }], registered: ['i-good1'], now })).toMatchObject({ backingOff: false, died: 0, allow: null })
  })

  test('an instance past its grace that never registered counts, one inside it does not', () => {
    const launches = [{ id: 'i-young', at: ago(60) }, { id: 'i-stuck', at: ago(1000) }, ...dead(2, 30)]
    const instances = [{ id: 'i-young', lifecycle: 'InService', launchedAt: ago(60) }, { id: 'i-stuck', lifecycle: 'InService', launchedAt: ago(1000) }]
    expect(planLaunchBackoff({ config, launches, instances, registered: [], now })).toMatchObject({ backingOff: true, died: 3, example: 'i-stuck', probing: 'i-young' })
  })

  test('an instance Spot took back is not the boot failing', () => {
    const launches = dead(3)
    expect(planLaunchBackoff({ config, launches, instances: [], registered: [], reclaimed: ['i-dead0'], now })).toMatchObject({ backingOff: false, died: 2 })
    expect(planLaunchBackoff({ config, launches, instances: [], registered: [], reclaimed: launches.map(launch => launch.id), now })).toMatchObject({ backingOff: false, died: 0 })
  })

  test('a cap of zero never backs off', () => {
    expect(planLaunchBackoff({ config: { ...config, launchBackoffSeconds: 0 }, launches: dead(50), instances: [], registered: [], now }).backingOff).toBe(false)
  })

  test('a held group asks for nothing between probes and for one when a probe is due', () => {
    const held = planLaunchBackoff({ config, launches: dead(6, 1), instances: [], registered: [], now })
    const between = planWorkerGroup({ config, currentDesired: 0, instances: [], workers: [], waiting: 8, backoff: held, now })
    expect(between.desired).toBe(0)
    expect(between.reasons).toEqual([held.reason!])

    const due = planLaunchBackoff({ config, launches: dead(6, 20), instances: [], registered: [], now })
    const probe = planWorkerGroup({ config, currentDesired: 0, instances: [], workers: [], waiting: 8, backoff: due, now })
    expect(probe.desired).toBe(1)
    expect(probe.reasons).toEqual([due.reason!, '8 waiting, 0 arriving, 0 idle: asking for 1 more'])
  })

  test('a held group with nothing waiting says nothing, and one that is not held scales as before', () => {
    const held = planLaunchBackoff({ config, launches: dead(6, 20), instances: [], registered: [], now })
    expect(planWorkerGroup({ config, currentDesired: 0, instances: [], workers: [], waiting: 0, backoff: held, now })).toEqual({ desired: 0, reap: [], reasons: [] })
    const fine = planLaunchBackoff({ config, launches: [], instances: [], registered: [], now })
    expect(planWorkerGroup({ config, currentDesired: 0, instances: [], workers: [], waiting: 3, backoff: fine, now }).desired).toBe(3)
  })

  /*
   * The incident, replayed against the two plans alone. Every launch succeeds
   * as far as AWS can tell; the instance quits two and a half minutes into its
   * boot and lowers the desired capacity on its way out; eight jobs wait.
   */
  test('2026-11-13: twenty-one hours of instances that die at boot launch dozens, not a thousand', () => {
    const launches: { id: string, at: Date }[] = []
    let desired = 0
    const lifetime = 150_000
    const alive = (time: Date) => launches.filter(launch => time.getTime() - launch.at.getTime() < lifetime)

    const tick = (time: Date, registered: string[] = []) => {
      const instances = alive(time).map(launch => ({ id: launch.id, lifecycle: 'InService', launchedAt: launch.at }))
      desired = instances.length
      const backoff = planLaunchBackoff({ config, launches, instances, registered, now: time })
      const plan = planWorkerGroup({ config, currentDesired: desired, instances, workers: registered.filter(id => instances.some(instance => instance.id === id)).map(name => ({ name, idle: false })), waiting: 8, backoff, now: time })
      for (let added = desired; added < plan.desired; added++)
        launches.push({ id: `i-${String(launches.length).padStart(8, '0')}`, at: time })
      return backoff
    }

    let last = tick(now)
    for (let minute = 1; minute <= 21 * 60; minute++)
      last = tick(at(minute))

    expect(last.backingOff).toBe(true)
    // Six at once, then one probe at a time: 16 minutes later, then every 30.
    expect(launches.length).toBeLessThan(60)
    expect(launches.length).toBeGreaterThan(40)
    const gaps = launches.slice(7).map((launch, index) => (launch.at.getTime() - launches[6 + index]!.at.getTime()) / 60_000)
    expect(new Set(gaps)).toEqual(new Set([30]))

    // The boot is fixed: the next probe registers, and the group scales as it always did.
    const before = launches.length
    let minute = 21 * 60
    while (launches.length === before)
      tick(at(++minute))
    const probe = launches.at(-1)!.id
    const recovered = tick(at(minute + 2), [probe])
    expect(recovered.backingOff).toBe(false)
    expect(launches.length).toBe(before + 1 + 5)
  })

  test('reads launches from the group\'s scaling activities, newest first', async () => {
    const calls: URLSearchParams[] = []
    const api = new AwsWorkerGroupApi({
      request: async (options: any) => {
        calls.push(new URLSearchParams(options.body))
        return { DescribeScalingActivitiesResponse: { DescribeScalingActivitiesResult: { Activities: { member: [
          { StatusCode: 'Successful', Description: 'Terminating EC2 instance: i-0aaaaaaaa1', StartTime: ago(30).toISOString() },
          { StatusCode: 'Successful', Description: 'Launching a new EC2 instance: i-0aaaaaaaa1', StartTime: ago(200).toISOString() },
          { StatusCode: 'Failed', Description: 'Launching a new EC2 instance.  Status Reason: Could not launch Spot Instances. InsufficientInstanceCapacity', StartTime: ago(100).toISOString() },
          { StatusCode: 'InProgress', Description: 'Launching a new EC2 instance: i-0bbbbbbbb2', StartTime: ago(20).toISOString() },
        ] } } } }
      },
    }, 'us-east-1')
    expect(await api.launches('ci-workers')).toEqual([{ id: 'i-0bbbbbbbb2', at: ago(20) }, { id: 'i-0aaaaaaaa1', at: ago(200) }])
    expect(calls[0]!.get('AutoScalingGroupName')).toBe('ci-workers')
    expect(launchedInstance({ Description: 'Launching a new EC2 instance from warm pool: i-0cccccccc3' })).toBe('i-0cccccccc3')
    expect(launchedInstance({ Description: 'Terminating EC2 instance: i-0aaaaaaaa1' })).toBeNull()
  })
})
