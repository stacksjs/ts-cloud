import type {
  ApplicationLoadBalancer,
  AutoScalingGroup,
  AutoScalingLaunchConfiguration,
  AutoScalingScalingPolicy,
  EC2Instance,
  EC2SecurityGroup,
  ECSCluster,
  ECSService,
  ECSTaskDefinition,
  IAMRole,
  LambdaFunction,
  Listener,
  TargetGroup,
} from '@ts-cloud/aws-types'
import type { EnvironmentType } from '@ts-cloud/types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface ServerOptions {
  slug: string
  environment: EnvironmentType
  instanceType?: string
  imageId?: string
  keyName?: string
  securityGroupIds?: string[]
  subnetId?: string
  userData?: string
  volumeSize?: number
  volumeType?: 'gp2' | 'gp3' | 'io1' | 'io2'
  encrypted?: boolean
}

export interface SecurityGroupOptions {
  slug: string
  environment: EnvironmentType
  vpcId?: string
  description?: string
  ingress?: SecurityGroupRule[]
  egress?: SecurityGroupRule[]
}

export interface SecurityGroupRule {
  protocol: string
  fromPort?: number
  toPort?: number
  cidr?: string
  sourceSecurityGroupId?: string
}

export interface LoadBalancerOptions {
  slug: string
  environment: EnvironmentType
  scheme?: 'internet-facing' | 'internal'
  subnets: string[]
  securityGroups?: string[]
  type?: 'application' | 'network'
}

export interface TargetGroupOptions {
  slug: string
  environment: EnvironmentType
  port: number
  protocol?: 'HTTP' | 'HTTPS' | 'TCP'
  vpcId: string
  targetType?: 'instance' | 'ip' | 'lambda'
  healthCheckPath?: string
  healthCheckInterval?: number
  healthCheckTimeout?: number
  healthyThreshold?: number
  unhealthyThreshold?: number
}

export interface ListenerOptions {
  port: number
  protocol?: 'HTTP' | 'HTTPS'
  certificateArn?: string
  defaultTargetGroupArn: string
}

export interface FargateServiceOptions {
  slug: string
  environment: EnvironmentType
  image: string
  cpu?: string
  memory?: string
  desiredCount?: number
  containerPort?: number
  environmentVariables?: Record<string, string>
  secrets?: Array<{ name: string, valueFrom: string }>
  healthCheck?: {
    command: string[]
    interval?: number
    timeout?: number
    retries?: number
  }
  logGroup?: string
  subnets: string[]
  securityGroups: string[]
  targetGroupArn?: string
}

export interface LambdaFunctionOptions {
  slug: string
  environment: EnvironmentType
  runtime: string
  handler: string
  code: {
    s3Bucket?: string
    s3Key?: string
    zipFile?: string
  }
  timeout?: number
  memorySize?: number
  environmentVariables?: Record<string, string>
  vpcConfig?: {
    securityGroupIds: string[]
    subnetIds: string[]
  }
}

export interface LaunchConfigurationOptions {
  slug: string
  environment: EnvironmentType
  imageId: string
  instanceType: string
  keyName?: string
  securityGroups?: Array<string | { Ref: string }>
  userData?: string
  volumeSize?: number
  volumeType?: 'gp2' | 'gp3' | 'io1' | 'io2'
  encrypted?: boolean
  iamInstanceProfile?: string | { Ref: string }
}

export interface AutoScalingGroupOptions {
  slug: string
  environment: EnvironmentType
  launchConfigurationName: string | { Ref: string }
  minSize: number
  maxSize: number
  desiredCapacity?: number
  vpcZoneIdentifier?: string[] | { Ref: string }
  targetGroupArns?: Array<string | { Ref: string }>
  healthCheckType?: 'EC2' | 'ELB'
  healthCheckGracePeriod?: number
  cooldown?: number
  tags?: Record<string, string>
}

export interface ScalingPolicyOptions {
  slug: string
  environment: EnvironmentType
  autoScalingGroupName: string | { Ref: string }
  policyType?: 'TargetTrackingScaling' | 'StepScaling' | 'SimpleScaling'
  targetValue?: number
  predefinedMetricType?: 'ASGAverageCPUUtilization' | 'ASGAverageNetworkIn' | 'ASGAverageNetworkOut' | 'ALBRequestCountPerTarget'
  scaleInCooldown?: number
  scaleOutCooldown?: number
}

/**
 * Compute Module - EC2, ECS, Lambda Management
 * Provides clean API for both server (Forge-style) and serverless (Vapor-style) deployments
 */
export class Compute {
  /**
   * Create an EC2 server instance (Server Mode - Forge-style)
   */
  static createServer(options: ServerOptions): {
    instance: EC2Instance
    logicalId: string
  } {
    const {
      slug,
      environment,
      instanceType = 't3.micro',
      imageId = 'ami-0c55b159cbfafe1f0', // Amazon Linux 2023
      keyName,
      securityGroupIds,
      subnetId,
      userData,
      volumeSize = 20,
      volumeType = 'gp3',
      encrypted = true,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'ec2',
    })

    const logicalId = generateLogicalId(resourceName)

    const instance: EC2Instance = {
      Type: 'AWS::EC2::Instance',
      Properties: {
        ImageId: imageId,
        InstanceType: instanceType,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (keyName) {
      instance.Properties.KeyName = keyName
    }

    if (securityGroupIds) {
      instance.Properties.SecurityGroupIds = securityGroupIds
    }

    if (subnetId) {
      instance.Properties.SubnetId = subnetId
    }

    if (userData) {
      // Base64 encode user data
      instance.Properties.UserData = Fn.Base64(userData)
    }

    // Configure EBS volume
    instance.Properties.BlockDeviceMappings = [
      {
        DeviceName: '/dev/xvda',
        Ebs: {
          VolumeSize: volumeSize,
          VolumeType: volumeType,
          Encrypted: encrypted,
          DeleteOnTermination: true,
        },
      },
    ]

    return { instance, logicalId }
  }

  /**
   * Create a security group
   */
  static createSecurityGroup(options: SecurityGroupOptions): {
    securityGroup: EC2SecurityGroup
    logicalId: string
  } {
    const {
      slug,
      environment,
      vpcId,
      description,
      ingress = [],
      egress = [],
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'sg',
    })

    const logicalId = generateLogicalId(resourceName)

    const securityGroup: EC2SecurityGroup = {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: description || `Security group for ${slug} ${environment}`,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (vpcId) {
      securityGroup.Properties.VpcId = vpcId
    }

    if (ingress.length > 0) {
      securityGroup.Properties.SecurityGroupIngress = ingress.map(rule => ({
        IpProtocol: rule.protocol,
        FromPort: rule.fromPort,
        ToPort: rule.toPort,
        CidrIp: rule.cidr,
        SourceSecurityGroupId: rule.sourceSecurityGroupId,
      }))
    }

    if (egress.length > 0) {
      securityGroup.Properties.SecurityGroupEgress = egress.map(rule => ({
        IpProtocol: rule.protocol,
        FromPort: rule.fromPort,
        ToPort: rule.toPort,
        CidrIp: rule.cidr,
        DestinationSecurityGroupId: rule.sourceSecurityGroupId,
      }))
    }

    return { securityGroup, logicalId }
  }

  /**
   * Create common security group rules for web servers
   */
  static createWebServerSecurityGroup(
    slug: string,
    environment: EnvironmentType,
    vpcId?: string,
  ): {
      securityGroup: EC2SecurityGroup
      logicalId: string
    } {
    return Compute.createSecurityGroup({
      slug,
      environment,
      vpcId,
      description: 'Security group for web servers - HTTP, HTTPS, SSH',
      ingress: [
        { protocol: 'tcp', fromPort: 80, toPort: 80, cidr: '0.0.0.0/0' }, // HTTP
        { protocol: 'tcp', fromPort: 443, toPort: 443, cidr: '0.0.0.0/0' }, // HTTPS
        { protocol: 'tcp', fromPort: 22, toPort: 22, cidr: '0.0.0.0/0' }, // SSH (restrict in production)
      ],
      egress: [
        { protocol: '-1', fromPort: 0, toPort: 0, cidr: '0.0.0.0/0' }, // All outbound
      ],
    })
  }

  /**
   * Create an Application Load Balancer
   */
  static createLoadBalancer(options: LoadBalancerOptions): {
    loadBalancer: ApplicationLoadBalancer
    logicalId: string
  } {
    const {
      slug,
      environment,
      scheme = 'internet-facing',
      subnets,
      securityGroups,
      type = 'application',
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'alb',
    })

    const logicalId = generateLogicalId(resourceName)

    const loadBalancer: ApplicationLoadBalancer = {
      Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      Properties: {
        Name: resourceName,
        Scheme: scheme,
        Type: type,
        Subnets: subnets,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (securityGroups) {
      loadBalancer.Properties.SecurityGroups = securityGroups
    }

    return { loadBalancer, logicalId }
  }

  /**
   * Create a target group
   */
  static createTargetGroup(options: TargetGroupOptions): {
    targetGroup: TargetGroup
    logicalId: string
  } {
    const {
      slug,
      environment,
      port,
      protocol = 'HTTP',
      vpcId,
      targetType = 'ip',
      healthCheckPath = '/',
      healthCheckInterval = 30,
      healthCheckTimeout = 5,
      healthyThreshold = 2,
      unhealthyThreshold = 3,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'tg',
    })

    const logicalId = generateLogicalId(resourceName)

    const targetGroup: TargetGroup = {
      Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      Properties: {
        Name: resourceName,
        Port: port,
        Protocol: protocol,
        VpcId: vpcId,
        TargetType: targetType,
        HealthCheckEnabled: true,
        HealthCheckProtocol: protocol,
        HealthCheckPath: healthCheckPath,
        HealthCheckIntervalSeconds: healthCheckInterval,
        HealthCheckTimeoutSeconds: healthCheckTimeout,
        HealthyThresholdCount: healthyThreshold,
        UnhealthyThresholdCount: unhealthyThreshold,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { targetGroup, logicalId }
  }

  /**
   * Create an ALB listener
   */
  static createListener(
    loadBalancerLogicalId: string,
    options: ListenerOptions,
  ): {
      listener: Listener
      logicalId: string
    } {
    const {
      port,
      protocol = 'HTTP',
      certificateArn,
      defaultTargetGroupArn,
    } = options

    const logicalId = generateLogicalId(`listener-${loadBalancerLogicalId}-${port}`)

    const listener: Listener = {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Properties: {
        LoadBalancerArn: Fn.Ref(loadBalancerLogicalId),
        Port: port,
        Protocol: protocol,
        DefaultActions: [
          {
            Type: 'forward',
            TargetGroupArn: defaultTargetGroupArn,
          },
        ],
      },
    }

    if (protocol === 'HTTPS' && certificateArn) {
      listener.Properties.Certificates = [{ CertificateArn: certificateArn }]
      listener.Properties.SslPolicy = 'ELBSecurityPolicy-TLS13-1-2-2021-06'
    }

    return { listener, logicalId }
  }

  /**
   * Create ECS cluster for Fargate (Serverless Mode - Vapor-style)
   */
  static createEcsCluster(
    slug: string,
    environment: EnvironmentType,
  ): {
      cluster: ECSCluster
      logicalId: string
    } {
    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'ecs-cluster',
    })

    const logicalId = generateLogicalId(resourceName)

    const cluster: ECSCluster = {
      Type: 'AWS::ECS::Cluster',
      Properties: {
        ClusterName: resourceName,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { cluster, logicalId }
  }

  /**
   * Create ECS Fargate task definition and service
   */
  static createFargateService(options: FargateServiceOptions): {
    cluster: ECSCluster
    taskDefinition: ECSTaskDefinition
    service: ECSService
    taskRole: IAMRole
    executionRole: IAMRole
    clusterLogicalId: string
    taskDefinitionLogicalId: string
    serviceLogicalId: string
    taskRoleLogicalId: string
    executionRoleLogicalId: string
  } {
    const {
      slug,
      environment,
      image,
      cpu = '256',
      memory = '512',
      desiredCount = 1,
      containerPort = 8080,
      environmentVariables = {},
      secrets = [],
      healthCheck,
      logGroup,
      subnets,
      securityGroups,
      targetGroupArn,
    } = options

    // Create ECS Cluster
    const { cluster, logicalId: clusterLogicalId } = Compute.createEcsCluster(slug, environment)

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'fargate',
    })

    // Create Task Execution Role (needed for pulling images, logging, etc.)
    const executionRoleLogicalId = generateLogicalId(`${resourceName}-execution-role`)
    const executionRole: IAMRole = {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Service: 'ecs-tasks.amazonaws.com',
              },
              Action: 'sts:AssumeRole',
            },
          ],
        },
        ManagedPolicyArns: [
          'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
        ],
      },
    }

    // Create Task Role (for application permissions)
    const taskRoleLogicalId = generateLogicalId(`${resourceName}-task-role`)
    const taskRole: IAMRole = {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Service: 'ecs-tasks.amazonaws.com',
              },
              Action: 'sts:AssumeRole',
            },
          ],
        },
      },
    }

    // Create Task Definition
    const taskDefinitionLogicalId = generateLogicalId(`${resourceName}-task`)
    const taskDefinition: ECSTaskDefinition = {
      Type: 'AWS::ECS::TaskDefinition',
      Properties: {
        Family: resourceName,
        TaskRoleArn: Fn.GetAtt(taskRoleLogicalId, 'Arn') as any,
        ExecutionRoleArn: Fn.GetAtt(executionRoleLogicalId, 'Arn') as any,
        NetworkMode: 'awsvpc',
        RequiresCompatibilities: ['FARGATE'],
        Cpu: cpu,
        Memory: memory,
        ContainerDefinitions: [
          {
            Name: slug,
            Image: image,
            Essential: true,
            PortMappings: [
              {
                ContainerPort: containerPort,
                Protocol: 'tcp',
              },
            ],
            Environment: Object.entries(environmentVariables).map(([Name, Value]) => ({
              Name,
              Value,
            })),
            Secrets: secrets.map(s => ({
              Name: s.name,
              ValueFrom: s.valueFrom,
            })),
          },
        ],
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    // Add health check if provided
    if (healthCheck) {
      taskDefinition.Properties.ContainerDefinitions[0].HealthCheck = {
        Command: healthCheck.command,
        Interval: healthCheck.interval || 30,
        Timeout: healthCheck.timeout || 5,
        Retries: healthCheck.retries || 3,
        StartPeriod: 60,
      }
    }

    // Add logging configuration
    if (logGroup) {
      taskDefinition.Properties.ContainerDefinitions[0].LogConfiguration = {
        LogDriver: 'awslogs',
        Options: {
          'awslogs-group': logGroup,
          'awslogs-region': Fn.Ref('AWS::Region'),
          'awslogs-stream-prefix': slug,
        },
      }
    }

    // Create ECS Service
    const serviceLogicalId = generateLogicalId(`${resourceName}-service`)
    const service: ECSService = {
      Type: 'AWS::ECS::Service',
      Properties: {
        ServiceName: resourceName,
        Cluster: Fn.Ref(clusterLogicalId),
        TaskDefinition: Fn.Ref(taskDefinitionLogicalId),
        DesiredCount: desiredCount,
        LaunchType: 'FARGATE',
        NetworkConfiguration: {
          AwsvpcConfiguration: {
            Subnets: subnets,
            SecurityGroups: securityGroups,
            AssignPublicIp: 'ENABLED',
          },
        },
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    // Add load balancer integration if target group provided
    if (targetGroupArn) {
      service.Properties.LoadBalancers = [
        {
          TargetGroupArn: targetGroupArn,
          ContainerName: slug,
          ContainerPort: containerPort,
        },
      ]
    }

    return {
      cluster,
      taskDefinition,
      service,
      taskRole,
      executionRole,
      clusterLogicalId,
      taskDefinitionLogicalId,
      serviceLogicalId,
      taskRoleLogicalId,
      executionRoleLogicalId,
    }
  }

  /**
   * Create a Lambda function
   */
  static createLambdaFunction(options: LambdaFunctionOptions): {
    lambdaFunction: LambdaFunction
    role: IAMRole
    logicalId: string
    roleLogicalId: string
  } {
    const {
      slug,
      environment,
      runtime,
      handler,
      code,
      timeout = 30,
      memorySize = 128,
      environmentVariables = {},
      vpcConfig,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'lambda',
    })

    const logicalId = generateLogicalId(resourceName)

    // Create Lambda execution role
    const roleLogicalId = generateLogicalId(`${resourceName}-role`)
    const role: IAMRole = {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Service: 'lambda.amazonaws.com',
              },
              Action: 'sts:AssumeRole',
            },
          ],
        },
        ManagedPolicyArns: [
          'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
      },
    }

    // Add VPC execution role if VPC config provided
    if (vpcConfig) {
      role.Properties.ManagedPolicyArns!.push(
        'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',
      )
    }

    const lambdaFunction: LambdaFunction = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: resourceName,
        Runtime: runtime,
        Role: Fn.GetAtt(roleLogicalId, 'Arn') as any,
        Handler: handler,
        Code: code,
        Timeout: timeout,
        MemorySize: memorySize,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (Object.keys(environmentVariables).length > 0) {
      lambdaFunction.Properties.Environment = {
        Variables: environmentVariables,
      }
    }

    if (vpcConfig) {
      lambdaFunction.Properties.VpcConfig = {
        SecurityGroupIds: vpcConfig.securityGroupIds,
        SubnetIds: vpcConfig.subnetIds,
      }
    }

    return { lambdaFunction, role, logicalId, roleLogicalId }
  }

  /**
   * Generate Node.js server user data script
   */
  static generateNodeServerUserData(options: {
    nodeVersion?: string
    appRepo?: string
    environment?: Record<string, string>
  } = {}): string {
    const { nodeVersion = '20', appRepo, environment = {} } = options

    const envVars = Object.entries(environment)
      .map(([key, value]) => `echo "export ${key}='${value}'" >> /etc/environment`)
      .join('\n')

    return `#!/bin/bash
# Update system
yum update -y

# Install Node.js ${nodeVersion}
curl -fsSL https://rpm.nodesource.com/setup_${nodeVersion}.x | bash -
yum install -y nodejs

# Install PM2 for process management
npm install -g pm2

# Install Caddy for reverse proxy and automatic HTTPS
yum install -y yum-plugin-copr
yum copr enable -y @caddy/caddy
yum install -y caddy

# Set environment variables
${envVars}

# Clone application (if repo provided)
${appRepo ? `
cd /var/www
git clone ${appRepo} app
cd app
npm install
pm2 start npm --name "app" -- start
pm2 save
pm2 startup systemd -u ec2-user --hp /home/ec2-user
` : '# No repository specified'}

# Configure Caddy
cat > /etc/caddy/Caddyfile <<'EOF'
:80 {
    reverse_proxy localhost:3000
}
EOF

# Start Caddy
systemctl enable caddy
systemctl start caddy

echo "Server setup complete!"
`
  }

  /**
   * Generate Bun server user data script
   */
  static generateBunServerUserData(options: {
    appRepo?: string
    environment?: Record<string, string>
  } = {}): string {
    const { appRepo, environment = {} } = options

    const envVars = Object.entries(environment)
      .map(([key, value]) => `echo "export ${key}='${value}'" >> /etc/environment`)
      .join('\n')

    return `#!/bin/bash
# Update system
yum update -y

# Install Bun
curl -fsSL https://bun.sh/install | bash
echo 'export BUN_INSTALL="/root/.bun"' >> /root/.bashrc
echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> /root/.bashrc
source /root/.bashrc

# Install Caddy
yum install -y yum-plugin-copr
yum copr enable -y @caddy/caddy
yum install -y caddy

# Set environment variables
${envVars}

# Clone application (if repo provided)
${appRepo ? `
cd /var/www
git clone ${appRepo} app
cd app
bun install

# Create systemd service
cat > /etc/systemd/system/app.service <<'SERVICE'
[Unit]
Description=Bun Application
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/var/www/app
ExecStart=/root/.bun/bin/bun run start
Restart=always

[Install]
WantedBy=multi-user.target
SERVICE

systemctl enable app
systemctl start app
` : '# No repository specified'}

# Configure Caddy
cat > /etc/caddy/Caddyfile <<'EOF'
:80 {
    reverse_proxy localhost:3000
}
EOF

systemctl enable caddy
systemctl start caddy

echo "Bun server setup complete!"
`
  }

  /**
   * Create a Launch Configuration for Auto Scaling
   */
  static createLaunchConfiguration(options: LaunchConfigurationOptions): {
    launchConfiguration: AutoScalingLaunchConfiguration
    logicalId: string
  } {
    const {
      slug,
      environment,
      imageId,
      instanceType,
      keyName,
      securityGroups,
      userData,
      volumeSize = 20,
      volumeType = 'gp3',
      encrypted = true,
      iamInstanceProfile,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'launch-config',
    })

    const logicalId = generateLogicalId(resourceName)

    const launchConfiguration: AutoScalingLaunchConfiguration = {
      Type: 'AWS::AutoScaling::LaunchConfiguration',
      Properties: {
        ImageId: imageId,
        InstanceType: instanceType,
        BlockDeviceMappings: [
          {
            DeviceName: '/dev/xvda',
            Ebs: {
              VolumeSize: volumeSize,
              VolumeType: volumeType,
              Encrypted: encrypted,
              DeleteOnTermination: true,
            },
          },
        ],
      },
    }

    if (keyName) {
      launchConfiguration.Properties.KeyName = keyName
    }

    if (securityGroups) {
      launchConfiguration.Properties.SecurityGroups = securityGroups
    }

    if (userData) {
      launchConfiguration.Properties.UserData = Fn.Base64(userData)
    }

    if (iamInstanceProfile) {
      launchConfiguration.Properties.IamInstanceProfile = iamInstanceProfile
    }

    return { launchConfiguration, logicalId }
  }

  /**
   * Create an Auto Scaling Group
   */
  static createAutoScalingGroup(options: AutoScalingGroupOptions): {
    autoScalingGroup: AutoScalingGroup
    logicalId: string
  } {
    const {
      slug,
      environment,
      launchConfigurationName,
      minSize,
      maxSize,
      desiredCapacity,
      vpcZoneIdentifier,
      targetGroupArns,
      healthCheckType = 'EC2',
      healthCheckGracePeriod = 300,
      cooldown = 300,
      tags = {},
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'asg',
    })

    const logicalId = generateLogicalId(resourceName)

    const autoScalingGroup: AutoScalingGroup = {
      Type: 'AWS::AutoScaling::AutoScalingGroup',
      Properties: {
        AutoScalingGroupName: resourceName,
        LaunchConfigurationName: launchConfigurationName,
        MinSize: minSize,
        MaxSize: maxSize,
        HealthCheckType: healthCheckType,
        HealthCheckGracePeriod: healthCheckGracePeriod,
        Cooldown: cooldown,
        Tags: [
          { Key: 'Name', Value: resourceName, PropagateAtLaunch: true },
          { Key: 'Environment', Value: environment, PropagateAtLaunch: true },
          ...Object.entries(tags).map(([key, value]) => ({
            Key: key,
            Value: value,
            PropagateAtLaunch: true,
          })),
        ],
      },
    }

    if (desiredCapacity !== undefined) {
      autoScalingGroup.Properties.DesiredCapacity = desiredCapacity
    }

    if (vpcZoneIdentifier) {
      autoScalingGroup.Properties.VPCZoneIdentifier = vpcZoneIdentifier
    }

    if (targetGroupArns) {
      autoScalingGroup.Properties.TargetGroupARNs = targetGroupArns
    }

    // Add rolling update policy for safer deployments
    autoScalingGroup.UpdatePolicy = {
      AutoScalingRollingUpdate: {
        MaxBatchSize: 1,
        MinInstancesInService: Math.max(0, minSize - 1),
        PauseTime: 'PT5M',
        WaitOnResourceSignals: false,
      },
    }

    return { autoScalingGroup, logicalId }
  }

  /**
   * Create a Target Tracking Scaling Policy (CPU-based by default)
   */
  static createScalingPolicy(options: ScalingPolicyOptions): {
    scalingPolicy: AutoScalingScalingPolicy
    logicalId: string
  } {
    const {
      slug,
      environment,
      autoScalingGroupName,
      policyType = 'TargetTrackingScaling',
      targetValue = 70, // 70% CPU by default
      predefinedMetricType = 'ASGAverageCPUUtilization',
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'scaling-policy',
    })

    const logicalId = generateLogicalId(resourceName)

    const scalingPolicy: AutoScalingScalingPolicy = {
      Type: 'AWS::AutoScaling::ScalingPolicy',
      Properties: {
        AutoScalingGroupName: autoScalingGroupName,
        PolicyType: policyType,
      },
    }

    if (policyType === 'TargetTrackingScaling') {
      scalingPolicy.Properties.TargetTrackingConfiguration = {
        PredefinedMetricSpecification: {
          PredefinedMetricType: predefinedMetricType,
        },
        TargetValue: targetValue,
      }
    }

    return { scalingPolicy, logicalId }
  }

  /**
   * Common Auto Scaling configurations
   */
  static readonly AutoScaling = {
    /**
     * Small web server auto scaling (2-4 instances)
     */
    smallWebServer: (
      slug: string,
      environment: EnvironmentType,
      launchConfigRef: string | { Ref: string },
      subnetIds: string[],
      targetGroupArns?: Array<string | { Ref: string }>,
    ) => {
      return Compute.createAutoScalingGroup({
        slug,
        environment,
        launchConfigurationName: launchConfigRef,
        minSize: 2,
        maxSize: 4,
        desiredCapacity: 2,
        vpcZoneIdentifier: subnetIds,
        targetGroupArns,
        healthCheckType: targetGroupArns ? 'ELB' : 'EC2',
        healthCheckGracePeriod: 300,
      })
    },

    /**
     * Medium web server auto scaling (3-10 instances)
     */
    mediumWebServer: (
      slug: string,
      environment: EnvironmentType,
      launchConfigRef: string | { Ref: string },
      subnetIds: string[],
      targetGroupArns?: Array<string | { Ref: string }>,
    ) => {
      return Compute.createAutoScalingGroup({
        slug,
        environment,
        launchConfigurationName: launchConfigRef,
        minSize: 3,
        maxSize: 10,
        desiredCapacity: 3,
        vpcZoneIdentifier: subnetIds,
        targetGroupArns,
        healthCheckType: targetGroupArns ? 'ELB' : 'EC2',
        healthCheckGracePeriod: 300,
      })
    },

    /**
     * Large web server auto scaling (5-20 instances)
     */
    largeWebServer: (
      slug: string,
      environment: EnvironmentType,
      launchConfigRef: string | { Ref: string },
      subnetIds: string[],
      targetGroupArns?: Array<string | { Ref: string }>,
    ) => {
      return Compute.createAutoScalingGroup({
        slug,
        environment,
        launchConfigurationName: launchConfigRef,
        minSize: 5,
        maxSize: 20,
        desiredCapacity: 5,
        vpcZoneIdentifier: subnetIds,
        targetGroupArns,
        healthCheckType: targetGroupArns ? 'ELB' : 'EC2',
        healthCheckGracePeriod: 300,
      })
    },

    /**
     * CPU-based scaling policy (default 70%)
     */
    cpuScaling: (
      slug: string,
      environment: EnvironmentType,
      asgName: string | { Ref: string },
      targetCpu = 70,
    ) => {
      return Compute.createScalingPolicy({
        slug,
        environment,
        autoScalingGroupName: asgName,
        policyType: 'TargetTrackingScaling',
        predefinedMetricType: 'ASGAverageCPUUtilization',
        targetValue: targetCpu,
      })
    },

    /**
     * Request count scaling policy (ALB)
     */
    requestCountScaling: (
      slug: string,
      environment: EnvironmentType,
      asgName: string | { Ref: string },
      targetRequestCount = 1000,
    ) => {
      return Compute.createScalingPolicy({
        slug,
        environment,
        autoScalingGroupName: asgName,
        policyType: 'TargetTrackingScaling',
        predefinedMetricType: 'ALBRequestCountPerTarget',
        targetValue: targetRequestCount,
      })
    },
  }
}
