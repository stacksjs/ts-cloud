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
} from 'ts-cloud-aws-types'
import type { EnvironmentType } from 'ts-cloud-types'
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
  functionName?: string
  runtime: string
  handler: string
  code: {
    s3Bucket?: string
    s3Key?: string
    zipFile?: string
  }
  role?: string
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
      instance.Properties.UserData = Fn.Base64(userData) as any
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
          'awslogs-region': Fn.Ref('AWS::Region') as any,
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
        Code: {
          ...(code.s3Bucket && { S3Bucket: code.s3Bucket }),
          ...(code.s3Key && { S3Key: code.s3Key }),
          ...(code.zipFile && { ZipFile: code.zipFile }),
        },
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
pm2 start npm --name 'app' -- start
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
    ): { autoScalingGroup: AutoScalingGroup; logicalId: string } => {
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
    ): { autoScalingGroup: AutoScalingGroup; logicalId: string } => {
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
    ): { autoScalingGroup: AutoScalingGroup; logicalId: string } => {
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
    ): { scalingPolicy: AutoScalingScalingPolicy; logicalId: string } => {
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
    ): { scalingPolicy: AutoScalingScalingPolicy; logicalId: string } => {
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

  /**
   * Secrets Manager integration utilities
   */
  static readonly Secrets = {
    /**
     * Convert environment variables to ECS secrets configuration
     * This takes environment variable names and their corresponding Secrets Manager ARNs
     */
    fromSecretsManager: (secrets: Record<string, string>): Array<{ name: string, valueFrom: string }> => {
      return Object.entries(secrets).map(([name, secretArn]) => ({
        name,
        valueFrom: secretArn,
      }))
    },

    /**
     * Reference a specific key from a JSON secret
     * Format: arn:aws:secretsmanager:region:account:secret:name:json-key::
     */
    fromJsonSecret: (secretArn: string, jsonKey: string): string => {
      return `${secretArn}:${jsonKey}::`
    },

    /**
     * Reference a specific version of a secret
     * Format: arn:aws:secretsmanager:region:account:secret:name::version-id:
     */
    fromSecretVersion: (secretArn: string, versionId: string): string => {
      return `${secretArn}::${versionId}:`
    },

    /**
     * Reference a specific version stage of a secret
     * Format: arn:aws:secretsmanager:region:account:secret:name:::version-stage
     */
    fromSecretVersionStage: (secretArn: string, versionStage: string): string => {
      return `${secretArn}:::${versionStage}`
    },

    /**
     * Create IAM policy for Secrets Manager access
     */
    createAccessPolicy: (secretArns: string[]): {
      PolicyName: string
      PolicyDocument: {
        Version: '2012-10-17'
        Statement: Array<{
          Effect: 'Allow' | 'Deny'
          Action: string[]
          Resource: string[]
        }>
      }
    } => ({
      PolicyName: 'SecretsManagerAccess',
      PolicyDocument: {
        Version: '2012-10-17' as const,
        Statement: [{
          Effect: 'Allow' as const,
          Action: [
            'secretsmanager:GetSecretValue',
            'secretsmanager:DescribeSecret',
          ],
          Resource: secretArns,
        }],
      },
    }),

    /**
     * Create IAM policy for KMS decryption (when secrets are encrypted with KMS)
     */
    createKmsPolicy: (kmsKeyArns: string[]): {
      PolicyName: string
      PolicyDocument: {
        Version: '2012-10-17'
        Statement: Array<{
          Effect: 'Allow' | 'Deny'
          Action: string[]
          Resource: string[]
        }>
      }
    } => ({
      PolicyName: 'KMSDecryptAccess',
      PolicyDocument: {
        Version: '2012-10-17' as const,
        Statement: [{
          Effect: 'Allow' as const,
          Action: ['kms:Decrypt'],
          Resource: kmsKeyArns,
        }],
      },
    }),

    /**
     * Build secret ARN from components
     */
    buildSecretArn: (params: {
      region: string
      accountId: string
      secretName: string
    }): string => {
      return `arn:aws:secretsmanager:${params.region}:${params.accountId}:secret:${params.secretName}`
    },

    /**
     * Build secret ARN pattern for wildcard matching
     * Useful for IAM policies
     */
    buildSecretArnPattern: (params: {
      region?: string
      accountId?: string
      secretNamePrefix: string
    }): string => {
      const region = params.region || '*'
      const accountId = params.accountId || '*'
      return `arn:aws:secretsmanager:${region}:${accountId}:secret:${params.secretNamePrefix}*`
    },

    /**
     * Common environment secrets mapping
     * Maps common application environment variable names to secrets
     */
    commonAppSecrets: (secretPrefix: string): Record<string, string> => ({
      DATABASE_URL: `${secretPrefix}/database-url`,
      DATABASE_PASSWORD: `${secretPrefix}/database-password`,
      REDIS_URL: `${secretPrefix}/redis-url`,
      REDIS_PASSWORD: `${secretPrefix}/redis-password`,
      API_KEY: `${secretPrefix}/api-key`,
      JWT_SECRET: `${secretPrefix}/jwt-secret`,
      ENCRYPTION_KEY: `${secretPrefix}/encryption-key`,
      AWS_ACCESS_KEY_ID: `${secretPrefix}/aws-access-key-id`,
      AWS_SECRET_ACCESS_KEY: `${secretPrefix}/aws-secret-access-key`,
      MAIL_PASSWORD: `${secretPrefix}/mail-password`,
      STRIPE_SECRET_KEY: `${secretPrefix}/stripe-secret-key`,
      STRIPE_WEBHOOK_SECRET: `${secretPrefix}/stripe-webhook-secret`,
    }),
  }

  /**
   * Create ECS Fargate service with full Secrets Manager integration
   */
  static createFargateServiceWithSecrets(options: FargateServiceOptions & {
    secretArns?: string[]
    kmsKeyArns?: string[]
  }): {
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
      secretArns = [],
      kmsKeyArns = [],
      ...baseOptions
    } = options

    // Create base Fargate service
    const result = Compute.createFargateService(baseOptions)

    // Add Secrets Manager access policy to execution role if secrets are provided
    if (secretArns.length > 0) {
      if (!result.executionRole.Properties.Policies) {
        result.executionRole.Properties.Policies = []
      }

      result.executionRole.Properties.Policies.push(
        Compute.Secrets.createAccessPolicy(secretArns),
      )

      // Add KMS policy if KMS keys are specified
      if (kmsKeyArns.length > 0) {
        result.executionRole.Properties.Policies.push(
          Compute.Secrets.createKmsPolicy(kmsKeyArns),
        )
      }
    }

    return result
  }

  /**
   * Generate secret references for container environment
   * This is a helper to convert secret names to full ARN references
   */
  static generateSecretReferences(params: {
    region: string
    accountId: string
    secretPrefix: string
    secrets: string[]
  }): Array<{ name: string, valueFrom: string }> {
    return params.secrets.map((secretName) => {
      const secretArn = `arn:aws:secretsmanager:${params.region}:${params.accountId}:secret:${params.secretPrefix}/${secretName}`
      return {
        name: secretName.toUpperCase().replace(/-/g, '_'),
        valueFrom: secretArn,
      }
    })
  }

  /**
   * Create environment secrets configuration for common patterns
   */
  static readonly EnvSecrets = {
    /**
     * Database credentials as secrets
     */
    database: (secretArn: string): Array<{ name: string, valueFrom: string }> => ([
      { name: 'DB_HOST', valueFrom: `${secretArn}:host::` },
      { name: 'DB_PORT', valueFrom: `${secretArn}:port::` },
      { name: 'DB_USERNAME', valueFrom: `${secretArn}:username::` },
      { name: 'DB_PASSWORD', valueFrom: `${secretArn}:password::` },
      { name: 'DB_NAME', valueFrom: `${secretArn}:dbname::` },
    ]),

    /**
     * Redis credentials as secrets
     */
    redis: (secretArn: string): Array<{ name: string, valueFrom: string }> => ([
      { name: 'REDIS_HOST', valueFrom: `${secretArn}:host::` },
      { name: 'REDIS_PORT', valueFrom: `${secretArn}:port::` },
      { name: 'REDIS_PASSWORD', valueFrom: `${secretArn}:password::` },
    ]),

    /**
     * API credentials as secrets
     */
    apiCredentials: (secretArn: string): Array<{ name: string, valueFrom: string }> => ([
      { name: 'API_KEY', valueFrom: `${secretArn}:apiKey::` },
      { name: 'API_SECRET', valueFrom: `${secretArn}:apiSecret::` },
    ]),

    /**
     * Mail credentials as secrets
     */
    mail: (secretArn: string): Array<{ name: string, valueFrom: string }> => ([
      { name: 'MAIL_HOST', valueFrom: `${secretArn}:host::` },
      { name: 'MAIL_PORT', valueFrom: `${secretArn}:port::` },
      { name: 'MAIL_USERNAME', valueFrom: `${secretArn}:username::` },
      { name: 'MAIL_PASSWORD', valueFrom: `${secretArn}:password::` },
    ]),

    /**
     * AWS credentials as secrets (for cross-account access)
     */
    awsCredentials: (secretArn: string): Array<{ name: string, valueFrom: string }> => ([
      { name: 'AWS_ACCESS_KEY_ID', valueFrom: `${secretArn}:accessKeyId::` },
      { name: 'AWS_SECRET_ACCESS_KEY', valueFrom: `${secretArn}:secretAccessKey::` },
    ]),
  }

  /**
   * Create a JumpBox (Bastion Host) for SSH access to private resources
   */
  static createJumpBox(options: {
    slug: string
    environment: EnvironmentType
    vpcId: string
    subnetId: string
    keyName: string
    instanceType?: string
    imageId?: string
    allowedCidrs?: string[]
    mountEfs?: {
      fileSystemId: string
      mountPath?: string
    }
  }): {
    instance: EC2Instance
    securityGroup: EC2SecurityGroup
    instanceProfile: any
    instanceRole: IAMRole
    instanceLogicalId: string
    securityGroupLogicalId: string
    instanceProfileLogicalId: string
    instanceRoleLogicalId: string
    resources: Record<string, any>
  } {
    const {
      slug,
      environment,
      vpcId,
      subnetId,
      keyName,
      instanceType = 't3.micro',
      imageId = 'ami-0c55b159cbfafe1f0', // Amazon Linux 2023
      allowedCidrs = ['0.0.0.0/0'],
      mountEfs,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'jumpbox',
    })

    // Create security group for SSH access
    const securityGroupLogicalId = generateLogicalId(`${resourceName}-sg`)
    const securityGroup: EC2SecurityGroup = {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupName: `${resourceName}-sg`,
        GroupDescription: `Security group for ${resourceName} JumpBox SSH access`,
        VpcId: vpcId,
        SecurityGroupIngress: allowedCidrs.map(cidr => ({
          IpProtocol: 'tcp',
          FromPort: 22,
          ToPort: 22,
          CidrIp: cidr,
          Description: `SSH access from ${cidr}`,
        })),
        SecurityGroupEgress: [{
          IpProtocol: '-1',
          CidrIp: '0.0.0.0/0',
          Description: 'Allow all outbound traffic',
        }],
        Tags: [
          { Key: 'Name', Value: `${resourceName}-sg` },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    // Create IAM role for instance
    const instanceRoleLogicalId = generateLogicalId(`${resourceName}-role`)
    const instanceRole: IAMRole = {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: `${resourceName}-role`,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Principal: {
              Service: 'ec2.amazonaws.com',
            },
            Action: 'sts:AssumeRole',
          }],
        },
        ManagedPolicyArns: [
          'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore', // For SSM Session Manager
        ],
        Policies: mountEfs
          ? [{
              PolicyName: 'EFSAccess',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [{
                  Effect: 'Allow',
                  Action: [
                    'elasticfilesystem:ClientMount',
                    'elasticfilesystem:ClientWrite',
                    'elasticfilesystem:ClientRootAccess',
                  ],
                  Resource: '*',
                }],
              },
            }]
          : undefined,
      },
    }

    // Create instance profile
    const instanceProfileLogicalId = generateLogicalId(`${resourceName}-profile`)
    const instanceProfile = {
      Type: 'AWS::IAM::InstanceProfile',
      Properties: {
        InstanceProfileName: `${resourceName}-profile`,
        Roles: [Fn.Ref(instanceRoleLogicalId)],
      },
    }

    // Build user data script
    let userDataScript = `#!/bin/bash
yum update -y
yum install -y amazon-efs-utils nfs-utils jq curl wget htop
`

    // Add EFS mount if specified
    if (mountEfs) {
      const mountPath = mountEfs.mountPath || '/mnt/efs'
      userDataScript += `
# Mount EFS
mkdir -p ${mountPath}
mount -t efs ${mountEfs.fileSystemId}:/ ${mountPath}
echo "${mountEfs.fileSystemId}:/ ${mountPath} efs defaults,_netdev 0 0" >> /etc/fstab
`
    }

    // Create the JumpBox instance
    const instanceLogicalId = generateLogicalId(resourceName)
    const instance: EC2Instance = {
      Type: 'AWS::EC2::Instance',
      DependsOn: [instanceProfileLogicalId],
      Properties: {
        ImageId: imageId,
        InstanceType: instanceType,
        KeyName: keyName,
        SubnetId: subnetId,
        SecurityGroupIds: [Fn.Ref(securityGroupLogicalId)] as any,
        IamInstanceProfile: Fn.Ref(instanceProfileLogicalId) as any,
        UserData: Fn.Base64(userDataScript) as any,
        BlockDeviceMappings: [{
          DeviceName: '/dev/xvda',
          Ebs: {
            VolumeSize: 20,
            VolumeType: 'gp3',
            Encrypted: true,
            DeleteOnTermination: true,
          },
        }],
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
          { Key: 'Purpose', Value: 'JumpBox/Bastion' },
        ],
      },
    }

    const resources: Record<string, any> = {
      [securityGroupLogicalId]: securityGroup,
      [instanceRoleLogicalId]: instanceRole,
      [instanceProfileLogicalId]: instanceProfile,
      [instanceLogicalId]: instance,
    }

    return {
      instance,
      securityGroup,
      instanceProfile,
      instanceRole,
      instanceLogicalId,
      securityGroupLogicalId,
      instanceProfileLogicalId,
      instanceRoleLogicalId,
      resources,
    }
  }

  /**
   * JumpBox helper configurations
   */
  static readonly JumpBox = {
    /**
     * Create JumpBox with EFS mount for file access
     */
    withEfsMount: (params: {
      slug: string
      environment: EnvironmentType
      vpcId: string
      subnetId: string
      keyName: string
      fileSystemId: string
      mountPath?: string
      allowedCidrs?: string[]
    }): {
      instance: EC2Instance
      securityGroup: EC2SecurityGroup
      instanceProfile: any
      instanceRole: IAMRole
      instanceLogicalId: string
      securityGroupLogicalId: string
      instanceProfileLogicalId: string
      instanceRoleLogicalId: string
      resources: Record<string, any>
    } => {
      return Compute.createJumpBox({
        slug: params.slug,
        environment: params.environment,
        vpcId: params.vpcId,
        subnetId: params.subnetId,
        keyName: params.keyName,
        allowedCidrs: params.allowedCidrs,
        mountEfs: {
          fileSystemId: params.fileSystemId,
          mountPath: params.mountPath || '/mnt/efs',
        },
      })
    },

    /**
     * Create minimal JumpBox (SSH only)
     */
    minimal: (params: {
      slug: string
      environment: EnvironmentType
      vpcId: string
      subnetId: string
      keyName: string
      allowedCidrs?: string[]
    }): {
      instance: EC2Instance
      securityGroup: EC2SecurityGroup
      instanceProfile: any
      instanceRole: IAMRole
      instanceLogicalId: string
      securityGroupLogicalId: string
      instanceProfileLogicalId: string
      instanceRoleLogicalId: string
      resources: Record<string, any>
    } => {
      return Compute.createJumpBox({
        slug: params.slug,
        environment: params.environment,
        vpcId: params.vpcId,
        subnetId: params.subnetId,
        keyName: params.keyName,
        instanceType: 't3.nano',
        allowedCidrs: params.allowedCidrs,
      })
    },

    /**
     * Create JumpBox with database tools
     */
    withDatabaseTools: (params: {
      slug: string
      environment: EnvironmentType
      vpcId: string
      subnetId: string
      keyName: string
      allowedCidrs?: string[]
    }): {
      instance: EC2Instance
      securityGroup: EC2SecurityGroup
      instanceProfile: any
      instanceRole: IAMRole
      instanceLogicalId: string
      securityGroupLogicalId: string
      instanceProfileLogicalId: string
      instanceRoleLogicalId: string
      resources: Record<string, any>
    } => {
      const result = Compute.createJumpBox({
        slug: params.slug,
        environment: params.environment,
        vpcId: params.vpcId,
        subnetId: params.subnetId,
        keyName: params.keyName,
        allowedCidrs: params.allowedCidrs,
      })

      // Modify user data to include database tools
      const userDataScript = `#!/bin/bash
yum update -y
yum install -y amazon-efs-utils nfs-utils jq curl wget htop

# Install PostgreSQL client
amazon-linux-extras install postgresql14 -y

# Install MySQL client
yum install -y mysql

# Install Redis CLI
yum install -y redis

echo "Database tools installed!"
`

      result.instance.Properties.UserData = Fn.Base64(userDataScript) as any

      return result
    },

    /**
     * Allowed CIDRs for corporate VPNs (common patterns)
     */
    commonCidrs: {
      any: ['0.0.0.0/0'] as const,
      privateOnly: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] as const,
    },
  }

  /**
   * Instance size mapping - human-readable sizes to AWS instance types
   * Provides Stacks configuration parity for "size" configuration option
   */
  static readonly InstanceSize = {
    /**
     * Map human-readable size to EC2 instance type
     */
    toInstanceType: (
      size: 'nano' | 'micro' | 'small' | 'medium' | 'large' | 'xlarge' | '2xlarge' | '4xlarge' | '8xlarge',
      family: 't3' | 't3a' | 'm6i' | 'c6i' | 'r6i' = 't3',
    ): string => {
      return `${family}.${size}`
    },

    /**
     * Size configurations with CPU and memory specs
     */
    specs: {
      nano: { vcpu: 2, memory: 0.5, instanceType: 't3.nano' },
      micro: { vcpu: 2, memory: 1, instanceType: 't3.micro' },
      small: { vcpu: 2, memory: 2, instanceType: 't3.small' },
      medium: { vcpu: 2, memory: 4, instanceType: 't3.medium' },
      large: { vcpu: 2, memory: 8, instanceType: 't3.large' },
      xlarge: { vcpu: 4, memory: 16, instanceType: 't3.xlarge' },
      '2xlarge': { vcpu: 8, memory: 32, instanceType: 't3.2xlarge' },
    } as const,

    /**
     * Get Fargate CPU/memory from size
     */
    toFargateSpecs: (
      size: 'nano' | 'micro' | 'small' | 'medium' | 'large' | 'xlarge' | '2xlarge',
    ): { cpu: string, memory: string } => {
      const mapping: Record<string, { cpu: string, memory: string }> = {
        nano: { cpu: '256', memory: '512' },
        micro: { cpu: '256', memory: '1024' },
        small: { cpu: '512', memory: '1024' },
        medium: { cpu: '1024', memory: '2048' },
        large: { cpu: '2048', memory: '4096' },
        xlarge: { cpu: '4096', memory: '8192' },
        '2xlarge': { cpu: '4096', memory: '16384' },
      }
      return mapping[size] || mapping.medium
    },

    /**
     * Get Lambda memory from size
     */
    toLambdaMemory: (
      size: 'nano' | 'micro' | 'small' | 'medium' | 'large' | 'xlarge' | '2xlarge',
    ): number => {
      const mapping: Record<string, number> = {
        nano: 128,
        micro: 256,
        small: 512,
        medium: 1024,
        large: 2048,
        xlarge: 4096,
        '2xlarge': 8192,
      }
      return mapping[size] || 1024
    },

    /**
     * Presets for common workloads
     */
    presets: {
      webServer: 't3.small',
      apiServer: 't3.medium',
      worker: 't3.medium',
      database: 'r6i.large',
      cache: 'r6i.medium',
      compute: 'c6i.large',
      general: 'm6i.medium',
    } as const,
  }

  /**
   * Disk configuration helpers
   * Provides Stacks configuration parity for disk options
   */
  static readonly DiskConfig = {
    /**
     * Create EBS volume configuration
     */
    create: (options: {
      size: number
      type?: 'standard' | 'ssd' | 'premium' | 'gp2' | 'gp3' | 'io1' | 'io2'
      encrypted?: boolean
      iops?: number
      throughput?: number
      deleteOnTermination?: boolean
    }): {
      VolumeSize: number
      VolumeType: string
      Encrypted: boolean
      Iops?: number
      Throughput?: number
      DeleteOnTermination: boolean
    } => {
      const { size, type = 'ssd', encrypted = true, iops, throughput, deleteOnTermination = true } = options

      // Map human-readable types to AWS types
      const typeMapping: Record<string, string> = {
        standard: 'gp2',
        ssd: 'gp3',
        premium: 'io2',
        gp2: 'gp2',
        gp3: 'gp3',
        io1: 'io1',
        io2: 'io2',
      }

      const volumeType = typeMapping[type] || 'gp3'

      const config: any = {
        VolumeSize: size,
        VolumeType: volumeType,
        Encrypted: encrypted,
        DeleteOnTermination: deleteOnTermination,
      }

      // Add IOPS for provisioned IOPS types
      if ((volumeType === 'io1' || volumeType === 'io2' || volumeType === 'gp3') && iops) {
        config.Iops = iops
      }

      // Add throughput for gp3
      if (volumeType === 'gp3' && throughput) {
        config.Throughput = throughput
      }

      return config
    },

    /**
     * Common disk configurations
     */
    presets: {
      /**
       * Standard SSD (20GB gp3)
       */
      standard: {
        VolumeSize: 20,
        VolumeType: 'gp3',
        Encrypted: true,
        DeleteOnTermination: true,
      },

      /**
       * Large storage (100GB gp3)
       */
      large: {
        VolumeSize: 100,
        VolumeType: 'gp3',
        Encrypted: true,
        DeleteOnTermination: true,
      },

      /**
       * High performance (50GB io2)
       */
      highPerformance: {
        VolumeSize: 50,
        VolumeType: 'io2',
        Iops: 3000,
        Encrypted: true,
        DeleteOnTermination: true,
      },

      /**
       * Database optimized (100GB io2 with high IOPS)
       */
      database: {
        VolumeSize: 100,
        VolumeType: 'io2',
        Iops: 10000,
        Encrypted: true,
        DeleteOnTermination: false,
      },
    },
  }

  /**
   * Spot instance configuration
   * Provides Stacks configuration parity for spot instances
   */
  static readonly SpotConfig = {
    /**
     * Create spot instance specification for Launch Template
     */
    create: (options: {
      maxPrice?: string
      spotInstanceType?: 'one-time' | 'persistent'
      interruptionBehavior?: 'hibernate' | 'stop' | 'terminate'
      blockDurationMinutes?: number
    }): {
      SpotOptions: {
        MaxPrice?: string
        SpotInstanceType?: string
        InstanceInterruptionBehavior?: string
        BlockDurationMinutes?: number
      }
    } => {
      const {
        maxPrice,
        spotInstanceType = 'one-time',
        interruptionBehavior = 'terminate',
        blockDurationMinutes,
      } = options

      const spotOptions: any = {
        SpotInstanceType: spotInstanceType,
        InstanceInterruptionBehavior: interruptionBehavior,
      }

      if (maxPrice) {
        spotOptions.MaxPrice = maxPrice
      }

      if (blockDurationMinutes) {
        spotOptions.BlockDurationMinutes = blockDurationMinutes
      }

      return { SpotOptions: spotOptions }
    },

    /**
     * Common spot instance configurations
     */
    presets: {
      /**
       * Standard spot (80% on-demand price)
       */
      standard: {
        spotInstanceType: 'one-time',
        interruptionBehavior: 'terminate',
      },

      /**
       * Persistent spot (for long-running workloads)
       */
      persistent: {
        spotInstanceType: 'persistent',
        interruptionBehavior: 'stop',
      },

      /**
       * Cost-optimized (lower max price)
       */
      costOptimized: {
        maxPrice: '0.05',
        spotInstanceType: 'one-time',
        interruptionBehavior: 'terminate',
      },
    },
  }

  /**
   * Mixed instances configuration for Auto Scaling Groups
   * Provides Stacks configuration parity for mixed instance fleets
   */
  static readonly MixedInstances = {
    /**
     * Create mixed instances policy for ASG
     */
    create: (options: {
      instanceTypes: Array<{ size: string, weight?: number }>
      baseCapacity?: number
      onDemandPercentage?: number
      spotAllocationStrategy?: 'lowest-price' | 'capacity-optimized' | 'capacity-optimized-prioritized'
      spotMaxPrice?: string
    }): {
      MixedInstancesPolicy: {
        InstancesDistribution: {
          OnDemandBaseCapacity: number
          OnDemandPercentageAboveBaseCapacity: number
          SpotAllocationStrategy: string
          SpotMaxPrice?: string
        }
        LaunchTemplate: {
          Overrides: Array<{
            InstanceType: string
            WeightedCapacity?: string
          }>
        }
      }
    } => {
      const {
        instanceTypes,
        baseCapacity = 0,
        onDemandPercentage = 20,
        spotAllocationStrategy = 'capacity-optimized',
        spotMaxPrice,
      } = options

      const distribution: any = {
        OnDemandBaseCapacity: baseCapacity,
        OnDemandPercentageAboveBaseCapacity: onDemandPercentage,
        SpotAllocationStrategy: spotAllocationStrategy,
      }

      if (spotMaxPrice) {
        distribution.SpotMaxPrice = spotMaxPrice
      }

      const overrides = instanceTypes.map(({ size, weight }) => {
        const override: any = { InstanceType: Compute.InstanceSize.toInstanceType(size as any) }
        if (weight) {
          override.WeightedCapacity = String(weight)
        }
        return override
      })

      return {
        MixedInstancesPolicy: {
          InstancesDistribution: distribution,
          LaunchTemplate: {
            Overrides: overrides,
          },
        },
      }
    },

    /**
     * Common mixed instance configurations
     */
    presets: {
      /**
       * Cost-optimized (80% spot)
       */
      costOptimized: {
        baseCapacity: 0,
        onDemandPercentage: 20,
        spotAllocationStrategy: 'lowest-price',
        instanceTypes: [
          { size: 'small', weight: 1 },
          { size: 'medium', weight: 2 },
        ] as const,
      },

      /**
       * Balanced (50% spot)
       */
      balanced: {
        baseCapacity: 1,
        onDemandPercentage: 50,
        spotAllocationStrategy: 'capacity-optimized',
        instanceTypes: [
          { size: 'medium', weight: 1 },
          { size: 'large', weight: 2 },
        ] as const,
      },

      /**
       * High availability (20% spot)
       */
      highAvailability: {
        baseCapacity: 2,
        onDemandPercentage: 80,
        spotAllocationStrategy: 'capacity-optimized-prioritized',
        instanceTypes: [
          { size: 'medium', weight: 1 },
        ] as const,
      },
    },
  }

  /**
   * Auto-scaling configuration helpers
   * Provides Stacks configuration parity for auto-scaling options
   */
  static readonly AutoScalingConfig = {
    /**
     * Create auto-scaling configuration
     */
    create: (options: {
      min: number
      max: number
      desired?: number
      scaleUpThreshold?: number
      scaleDownThreshold?: number
      cooldownSeconds?: number
      targetMetric?: 'cpu' | 'memory' | 'requests'
    }): {
      minSize: number
      maxSize: number
      desiredCapacity: number
      scalingPolicies: Array<{
        policyType: string
        targetValue: number
        predefinedMetricType: string
        scaleInCooldown: number
        scaleOutCooldown: number
      }>
    } => {
      const {
        min,
        max,
        desired = min,
        scaleUpThreshold = 70,
        scaleDownThreshold = 30,
        cooldownSeconds = 300,
        targetMetric = 'cpu',
      } = options

      const metricMapping: Record<string, string> = {
        cpu: 'ASGAverageCPUUtilization',
        memory: 'ASGAverageMemoryUtilization',
        requests: 'ALBRequestCountPerTarget',
      }

      return {
        minSize: min,
        maxSize: max,
        desiredCapacity: desired,
        scalingPolicies: [
          {
            policyType: 'TargetTrackingScaling',
            targetValue: scaleUpThreshold,
            predefinedMetricType: metricMapping[targetMetric] || metricMapping.cpu,
            scaleInCooldown: cooldownSeconds,
            scaleOutCooldown: cooldownSeconds,
          },
        ],
      }
    },

    /**
     * ECS auto-scaling configuration
     */
    forEcs: (options: {
      min: number
      max: number
      cpuTarget?: number
      memoryTarget?: number
    }): {
      minCapacity: number
      maxCapacity: number
      targetTrackingPolicies: Array<{
        predefinedMetricType: string
        targetValue: number
      }>
    } => {
      const { min, max, cpuTarget = 70, memoryTarget } = options

      const policies: Array<{ predefinedMetricType: string, targetValue: number }> = [
        {
          predefinedMetricType: 'ECSServiceAverageCPUUtilization',
          targetValue: cpuTarget,
        },
      ]

      if (memoryTarget) {
        policies.push({
          predefinedMetricType: 'ECSServiceAverageMemoryUtilization',
          targetValue: memoryTarget,
        })
      }

      return {
        minCapacity: min,
        maxCapacity: max,
        targetTrackingPolicies: policies,
      }
    },

    /**
     * Common auto-scaling configurations
     */
    presets: {
      /**
       * Small service (1-3 instances)
       */
      small: {
        min: 1,
        max: 3,
        scaleUpThreshold: 70,
        scaleDownThreshold: 30,
      },

      /**
       * Medium service (2-10 instances)
       */
      medium: {
        min: 2,
        max: 10,
        scaleUpThreshold: 70,
        scaleDownThreshold: 30,
      },

      /**
       * Large service (3-50 instances)
       */
      large: {
        min: 3,
        max: 50,
        scaleUpThreshold: 60,
        scaleDownThreshold: 40,
      },

      /**
       * High availability (always 2+ instances)
       */
      highAvailability: {
        min: 2,
        max: 20,
        scaleUpThreshold: 60,
        scaleDownThreshold: 30,
      },
    },
  }

  /**
   * Load balancer configuration helpers
   * Provides Stacks configuration parity for load balancer options
   */
  static readonly LoadBalancerConfig = {
    /**
     * Create load balancer health check configuration
     */
    healthCheck: (options: {
      path?: string
      interval?: number
      timeout?: number
      healthyThreshold?: number
      unhealthyThreshold?: number
      protocol?: 'HTTP' | 'HTTPS' | 'TCP'
    }): {
      HealthCheckPath?: string
      HealthCheckIntervalSeconds: number
      HealthCheckTimeoutSeconds: number
      HealthyThresholdCount: number
      UnhealthyThresholdCount: number
      HealthCheckProtocol?: string
    } => {
      const {
        path = '/',
        interval = 30,
        timeout = 5,
        healthyThreshold = 2,
        unhealthyThreshold = 5,
        protocol = 'HTTP',
      } = options

      const config: any = {
        HealthCheckIntervalSeconds: interval,
        HealthCheckTimeoutSeconds: timeout,
        HealthyThresholdCount: healthyThreshold,
        UnhealthyThresholdCount: unhealthyThreshold,
      }

      if (protocol !== 'TCP') {
        config.HealthCheckPath = path
        config.HealthCheckProtocol = protocol
      }

      return config
    },

    /**
     * Common health check configurations
     */
    presets: {
      /**
       * Standard HTTP health check
       */
      standard: {
        path: '/health',
        interval: 30,
        timeout: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 5,
      },

      /**
       * Fast health check (for quick failover)
       */
      fast: {
        path: '/health',
        interval: 10,
        timeout: 3,
        healthyThreshold: 2,
        unhealthyThreshold: 2,
      },

      /**
       * Relaxed health check (for slow-starting apps)
       */
      relaxed: {
        path: '/health',
        interval: 60,
        timeout: 30,
        healthyThreshold: 2,
        unhealthyThreshold: 10,
      },
    },
  }

  /**
   * SSL configuration helpers
   * Provides Stacks configuration parity for SSL options
   */
  static readonly SslConfig = {
    /**
     * Create SSL listener configuration
     */
    httpsListener: (options: {
      certificateArn: string
      targetGroupArn: string
      port?: number
      sslPolicy?: string
    }): {
      Port: number
      Protocol: string
      Certificates: Array<{ CertificateArn: string }>
      SslPolicy: string
      DefaultActions: Array<{ Type: string, TargetGroupArn: string }>
    } => {
      const {
        certificateArn,
        targetGroupArn,
        port = 443,
        sslPolicy = 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      } = options

      return {
        Port: port,
        Protocol: 'HTTPS',
        Certificates: [{ CertificateArn: certificateArn }],
        SslPolicy: sslPolicy,
        DefaultActions: [{
          Type: 'forward',
          TargetGroupArn: targetGroupArn,
        }],
      }
    },

    /**
     * Create HTTP to HTTPS redirect listener
     */
    httpRedirectListener: (port: number = 80): {
      Port: number
      Protocol: string
      DefaultActions: Array<{
        Type: string
        RedirectConfig: {
          Protocol: string
          Port: string
          StatusCode: string
        }
      }>
    } => ({
      Port: port,
      Protocol: 'HTTP',
      DefaultActions: [{
        Type: 'redirect',
        RedirectConfig: {
          Protocol: 'HTTPS',
          Port: '443',
          StatusCode: 'HTTP_301',
        },
      }],
    }),

    /**
     * SSL policies (TLS versions)
     */
    policies: {
      tls13: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      tls12: 'ELBSecurityPolicy-TLS-1-2-Ext-2018-06',
      tls11: 'ELBSecurityPolicy-TLS-1-1-2017-01',
      fips: 'ELBSecurityPolicy-TLS-1-2-Ext-FIPS-2022-05',
    } as const,
  }

  /**
   * Functions configuration helpers (Lambda)
   * Provides Stacks configuration parity for functions configuration
   */
  static readonly FunctionConfig = {
    /**
     * Create Lambda function configuration
     */
    create: (options: {
      handler: string
      runtime?: string
      timeout?: number
      memorySize?: number
      environmentVariables?: Record<string, string>
      reservedConcurrency?: number
    }): {
      Handler: string
      Runtime: string
      Timeout: number
      MemorySize: number
      Environment?: { Variables: Record<string, string> }
      ReservedConcurrentExecutions?: number
    } => {
      const {
        handler,
        runtime = 'nodejs20.x',
        timeout = 30,
        memorySize = 256,
        environmentVariables,
        reservedConcurrency,
      } = options

      const config: any = {
        Handler: handler,
        Runtime: runtime,
        Timeout: timeout,
        MemorySize: memorySize,
      }

      if (environmentVariables) {
        config.Environment = { Variables: environmentVariables }
      }

      if (reservedConcurrency) {
        config.ReservedConcurrentExecutions = reservedConcurrency
      }

      return config
    },

    /**
     * Runtime options
     */
    runtimes: {
      nodejs20: 'nodejs20.x',
      nodejs18: 'nodejs18.x',
      python312: 'python3.12',
      python311: 'python3.11',
      java21: 'java21',
      java17: 'java17',
      go: 'provided.al2023',
      rust: 'provided.al2023',
    } as const,

    /**
     * Common function configurations
     */
    presets: {
      /**
       * API handler (fast response)
       */
      api: {
        runtime: 'nodejs20.x',
        timeout: 30,
        memorySize: 256,
      },

      /**
       * Worker (background processing)
       */
      worker: {
        runtime: 'nodejs20.x',
        timeout: 300,
        memorySize: 512,
      },

      /**
       * Cron job (scheduled task)
       */
      cron: {
        runtime: 'nodejs20.x',
        timeout: 900,
        memorySize: 1024,
      },

      /**
       * Data processing (high memory)
       */
      dataProcessing: {
        runtime: 'nodejs20.x',
        timeout: 900,
        memorySize: 3008,
      },
    },
  }

  /**
   * User data scripts for EC2 Server Mode (Forge-style)
   * Provides installation scripts for Bun, Node.js, Nginx, Caddy, PM2, etc.
   */
  static readonly UserData = {
    /**
     * Generate complete user data script for app server
     */
    generateAppServerScript: (options: {
      runtime?: 'bun' | 'node'
      runtimeVersion?: string
      webServer?: 'nginx' | 'caddy' | 'none'
      processManager?: 'pm2' | 'systemd'
      enableSsl?: boolean
      sslEmail?: string
      domain?: string
      appPort?: number
      installDatabaseClients?: boolean
      installRedis?: boolean
      extraPackages?: string[]
    }): string => {
      const {
        runtime = 'bun',
        runtimeVersion = 'latest',
        webServer = 'nginx',
        processManager = 'systemd',
        enableSsl = true,
        sslEmail = 'admin@example.com',
        domain,
        appPort = 3000,
        installDatabaseClients = false,
        installRedis = false,
        extraPackages = [],
      } = options

      let script = `#!/bin/bash
set -e

# Update system
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get upgrade -y

# Install basic tools
apt-get install -y curl wget git jq htop unzip

`

      // Install runtime
      if (runtime === 'bun') {
        script += Compute.UserData.Scripts.bun(runtimeVersion)
      }
      else {
        script += Compute.UserData.Scripts.nodeJs(runtimeVersion)
      }

      // Install web server
      if (webServer === 'nginx') {
        script += Compute.UserData.Scripts.nginx()
        if (domain && enableSsl) {
          script += Compute.UserData.Scripts.nginxProxy(domain, appPort)
        }
      }
      else if (webServer === 'caddy') {
        script += Compute.UserData.Scripts.caddy()
        if (domain) {
          script += Compute.UserData.Scripts.caddyProxy(domain, appPort)
        }
      }

      // Install process manager
      if (processManager === 'pm2' && runtime === 'node') {
        script += Compute.UserData.Scripts.pm2()
      }

      // Install Let's Encrypt if enabled
      if (enableSsl && webServer === 'nginx' && domain) {
        script += Compute.UserData.Scripts.letsEncrypt(domain, sslEmail)
      }

      // Install database clients if requested
      if (installDatabaseClients) {
        script += Compute.UserData.Scripts.databaseClients()
      }

      // Install Redis if requested
      if (installRedis) {
        script += Compute.UserData.Scripts.redis()
      }

      // Install extra packages
      if (extraPackages.length > 0) {
        script += `\n# Install extra packages\napt-get install -y ${extraPackages.join(' ')}\n`
      }

      script += `\necho "Server setup complete!"\n`

      return script
    },

    /**
     * Individual installation scripts
     */
    Scripts: {
      /**
       * Install Bun
       */
      bun: (version: string = 'latest'): string => `
# Install Bun
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
echo 'export BUN_INSTALL="$HOME/.bun"' >> /etc/profile.d/bun.sh
echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> /etc/profile.d/bun.sh
${version !== 'latest' ? `bun upgrade --version ${version}` : ''}
bun --version
`,

      /**
       * Install Node.js via nvm
       */
      nodeJs: (version: string = '20'): string => `
# Install Node.js via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install ${version}
nvm use ${version}
nvm alias default ${version}
echo 'export NVM_DIR="$HOME/.nvm"' >> /etc/profile.d/nvm.sh
echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"' >> /etc/profile.d/nvm.sh
node --version
npm --version
`,

      /**
       * Install Nginx
       */
      nginx: (): string => `
# Install Nginx
apt-get install -y nginx
systemctl enable nginx
systemctl start nginx
`,

      /**
       * Configure Nginx as reverse proxy
       */
      nginxProxy: (domain: string, port: number = 3000): string => `
# Configure Nginx reverse proxy
cat > /etc/nginx/sites-available/${domain} << 'NGINX_CONFIG'
server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX_CONFIG

ln -sf /etc/nginx/sites-available/${domain} /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
`,

      /**
       * Install Caddy
       */
      caddy: (): string => `
# Install Caddy
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
systemctl enable caddy
`,

      /**
       * Configure Caddy as reverse proxy
       */
      caddyProxy: (domain: string, port: number = 3000): string => `
# Configure Caddy reverse proxy
cat > /etc/caddy/Caddyfile << 'CADDY_CONFIG'
${domain} {
    reverse_proxy localhost:${port}
}
CADDY_CONFIG

systemctl restart caddy
`,

      /**
       * Install PM2
       */
      pm2: (): string => `
# Install PM2
npm install -g pm2
pm2 startup systemd -u root --hp /root
`,

      /**
       * Install Let's Encrypt (certbot)
       */
      letsEncrypt: (domain: string, email: string, staging: boolean = false): string => `
# Install Certbot
apt-get install -y certbot python3-certbot-nginx
# Obtain SSL certificate
certbot --nginx -d ${domain} --non-interactive --agree-tos -m ${email} ${staging ? '--staging' : ''}
# Setup auto-renewal
echo "0 0 * * * root certbot renew --quiet" > /etc/cron.d/certbot-renew
`,

      /**
       * Install database clients
       */
      databaseClients: (): string => `
# Install database clients
apt-get install -y postgresql-client mysql-client
`,

      /**
       * Install Redis (server and cli)
       */
      redis: (): string => `
# Install Redis
apt-get install -y redis-server redis-tools
systemctl enable redis-server
systemctl start redis-server
`,

      /**
       * Create systemd service for app
       */
      systemdService: (options: {
        serviceName: string
        description: string
        workingDirectory: string
        execStart: string
        user?: string
        environmentVars?: Record<string, string>
      }): string => {
        const {
          serviceName,
          description,
          workingDirectory,
          execStart,
          user = 'root',
          environmentVars = {},
        } = options

        const envLines = Object.entries(environmentVars)
          .map(([key, value]) => `Environment="${key}=${value}"`)
          .join('\n')

        return `
# Create systemd service for ${serviceName}
cat > /etc/systemd/system/${serviceName}.service << 'SERVICE_FILE'
[Unit]
Description=${description}
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${workingDirectory}
ExecStart=${execStart}
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=${serviceName}
${envLines}

[Install]
WantedBy=multi-user.target
SERVICE_FILE

systemctl daemon-reload
systemctl enable ${serviceName}
systemctl start ${serviceName}
`
      },

      /**
       * Setup swap file
       */
      swapFile: (sizeGb: number = 2): string => `
# Setup swap file
fallocate -l ${sizeGb}G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
`,

      /**
       * Setup firewall (ufw)
       */
      firewall: (allowPorts: number[] = [22, 80, 443]): string => `
# Setup firewall
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
${allowPorts.map(p => `ufw allow ${p}`).join('\n')}
ufw --force enable
`,
    },

    /**
     * Preset user data configurations
     */
    Presets: {
      /**
       * Bun app server with Nginx
       */
      bunWithNginx: (domain: string, appPort: number = 3000): string =>
        Compute.UserData.generateAppServerScript({
          runtime: 'bun',
          webServer: 'nginx',
          processManager: 'systemd',
          domain,
          appPort,
          enableSsl: true,
        }),

      /**
       * Bun app server with Caddy (auto SSL)
       */
      bunWithCaddy: (domain: string, appPort: number = 3000): string =>
        Compute.UserData.generateAppServerScript({
          runtime: 'bun',
          webServer: 'caddy',
          processManager: 'systemd',
          domain,
          appPort,
          enableSsl: false, // Caddy handles SSL automatically
        }),

      /**
       * Node.js app server with PM2 and Nginx
       */
      nodeWithPm2: (domain: string, appPort: number = 3000): string =>
        Compute.UserData.generateAppServerScript({
          runtime: 'node',
          webServer: 'nginx',
          processManager: 'pm2',
          domain,
          appPort,
          enableSsl: true,
        }),

      /**
       * Minimal worker server (no web server)
       */
      worker: (runtime: 'bun' | 'node' = 'bun'): string =>
        Compute.UserData.generateAppServerScript({
          runtime,
          webServer: 'none',
          processManager: 'systemd',
          enableSsl: false,
        }),
    },
  }

  /**
   * Create Elastic IP allocation
   */
  static createElasticIp(options: {
    slug: string
    environment: EnvironmentType
    domain?: string
    instanceLogicalId?: string
  }): {
    eip: any
    eipAssociation?: any
    eipLogicalId: string
    associationLogicalId?: string
    resources: Record<string, any>
  } {
    const { slug, environment, domain, instanceLogicalId } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'eip',
    })

    const eipLogicalId = generateLogicalId(resourceName)

    const eip = {
      Type: 'AWS::EC2::EIP',
      Properties: {
        Domain: 'vpc',
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
          ...(domain ? [{ Key: 'Domain', Value: domain }] : []),
        ],
      },
    }

    const resources: Record<string, any> = {
      [eipLogicalId]: eip,
    }

    let eipAssociation
    let associationLogicalId

    if (instanceLogicalId) {
      associationLogicalId = generateLogicalId(`${resourceName}-assoc`)
      eipAssociation = {
        Type: 'AWS::EC2::EIPAssociation',
        Properties: {
          AllocationId: Fn.GetAtt(eipLogicalId, 'AllocationId'),
          InstanceId: Fn.Ref(instanceLogicalId),
        },
      }
      resources[associationLogicalId] = eipAssociation
    }

    return {
      eip,
      eipAssociation,
      eipLogicalId,
      associationLogicalId,
      resources,
    }
  }

  /**
   * Create complete Server Mode stack (Forge-style)
   * Creates EC2 instance with Elastic IP, security group, and IAM role
   */
  static createServerModeStack(options: {
    slug: string
    environment: EnvironmentType
    vpcId: string
    subnetId: string
    instanceType?: string
    imageId?: string
    keyName: string
    domain?: string
    userData?: string
    allowedPorts?: number[]
    volumeSize?: number
    volumeType?: 'gp2' | 'gp3' | 'io1' | 'io2'
  }): {
    instance: EC2Instance
    securityGroup: EC2SecurityGroup
    eip: any
    eipAssociation: any
    instanceRole: IAMRole
    instanceProfile: any
    resources: Record<string, any>
    outputs: {
      instanceLogicalId: string
      securityGroupLogicalId: string
      eipLogicalId: string
      associationLogicalId: string
      roleLogicalId: string
      profileLogicalId: string
    }
  } {
    const {
      slug,
      environment,
      vpcId,
      subnetId,
      instanceType = 't3.small',
      imageId = 'ami-0c55b159cbfafe1f0', // Amazon Linux 2023
      keyName,
      domain,
      userData,
      allowedPorts = [22, 80, 443],
      volumeSize = 20,
      volumeType = 'gp3',
    } = options

    const resources: Record<string, any> = {}

    // Create security group
    const sgResourceName = generateResourceName({ slug, environment, resourceType: 'server-sg' })
    const securityGroupLogicalId = generateLogicalId(sgResourceName)

    const securityGroup: EC2SecurityGroup = {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupName: sgResourceName,
        GroupDescription: `Security group for ${slug} server`,
        VpcId: vpcId,
        SecurityGroupIngress: allowedPorts.map(port => ({
          IpProtocol: 'tcp',
          FromPort: port,
          ToPort: port,
          CidrIp: '0.0.0.0/0',
          Description: `Port ${port}`,
        })),
        SecurityGroupEgress: [{
          IpProtocol: '-1',
          CidrIp: '0.0.0.0/0',
          Description: 'Allow all outbound',
        }],
        Tags: [
          { Key: 'Name', Value: sgResourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }
    resources[securityGroupLogicalId] = securityGroup

    // Create IAM role for instance
    const roleResourceName = generateResourceName({ slug, environment, resourceType: 'server-role' })
    const roleLogicalId = generateLogicalId(roleResourceName)

    const instanceRole: IAMRole = {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: roleResourceName,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Principal: { Service: 'ec2.amazonaws.com' },
            Action: 'sts:AssumeRole',
          }],
        },
        ManagedPolicyArns: [
          'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
          'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy',
        ],
      },
    }
    resources[roleLogicalId] = instanceRole

    // Create instance profile
    const profileResourceName = generateResourceName({ slug, environment, resourceType: 'server-profile' })
    const profileLogicalId = generateLogicalId(profileResourceName)

    const instanceProfile = {
      Type: 'AWS::IAM::InstanceProfile',
      Properties: {
        InstanceProfileName: profileResourceName,
        Roles: [Fn.Ref(roleLogicalId)],
      },
    }
    resources[profileLogicalId] = instanceProfile

    // Create EC2 instance
    const instanceResourceName = generateResourceName({ slug, environment, resourceType: 'server' })
    const instanceLogicalId = generateLogicalId(instanceResourceName)

    const instance: EC2Instance = {
      Type: 'AWS::EC2::Instance',
      DependsOn: [profileLogicalId],
      Properties: {
        ImageId: imageId,
        InstanceType: instanceType,
        KeyName: keyName,
        SubnetId: subnetId,
        SecurityGroupIds: [Fn.Ref(securityGroupLogicalId) as unknown as string],
        IamInstanceProfile: Fn.Ref(profileLogicalId) as unknown as string,
        BlockDeviceMappings: [{
          DeviceName: '/dev/xvda',
          Ebs: {
            VolumeSize: volumeSize,
            VolumeType: volumeType,
            Encrypted: true,
            DeleteOnTermination: true,
          },
        }],
        Tags: [
          { Key: 'Name', Value: instanceResourceName },
          { Key: 'Environment', Value: environment },
          ...(domain ? [{ Key: 'Domain', Value: domain }] : []),
        ],
      },
    }

    if (userData) {
      instance.Properties.UserData = Fn.Base64(userData) as any
    }

    resources[instanceLogicalId] = instance

    // Create Elastic IP
    const { eip, eipAssociation, eipLogicalId, associationLogicalId, resources: eipResources } = Compute.createElasticIp({
      slug,
      environment,
      domain,
      instanceLogicalId,
    })

    Object.assign(resources, eipResources)

    return {
      instance,
      securityGroup,
      eip,
      eipAssociation,
      instanceRole,
      instanceProfile,
      resources,
      outputs: {
        instanceLogicalId,
        securityGroupLogicalId,
        eipLogicalId,
        associationLogicalId: associationLogicalId!,
        roleLogicalId,
        profileLogicalId,
      },
    }
  }

  /**
   * Server Mode presets for common server types
   */
  static readonly ServerMode = {
    /**
     * Create web/app server
     */
    webServer: (options: {
      slug: string
      environment: EnvironmentType
      vpcId: string
      subnetId: string
      keyName: string
      domain: string
      runtime?: 'bun' | 'node'
      webServer?: 'nginx' | 'caddy'
    }): {
      instance: EC2Instance
      securityGroup: EC2SecurityGroup
      eip: any
      eipAssociation: any
      instanceRole: IAMRole
      instanceProfile: any
      resources: Record<string, any>
      outputs: {
        instanceLogicalId: string
        securityGroupLogicalId: string
        eipLogicalId: string
        associationLogicalId: string
        roleLogicalId: string
        profileLogicalId: string
      }
    } => {
      const userData = Compute.UserData.generateAppServerScript({
        runtime: options.runtime || 'bun',
        webServer: options.webServer || 'nginx',
        domain: options.domain,
        enableSsl: true,
      })

      return Compute.createServerModeStack({
        ...options,
        userData,
        instanceType: 't3.small',
        allowedPorts: [22, 80, 443],
      })
    },

    /**
     * Create worker server (no web server)
     */
    workerServer: (options: {
      slug: string
      environment: EnvironmentType
      vpcId: string
      subnetId: string
      keyName: string
      runtime?: 'bun' | 'node'
      installRedis?: boolean
    }): {
      instance: EC2Instance
      securityGroup: EC2SecurityGroup
      eip: any
      eipAssociation: any
      instanceRole: IAMRole
      instanceProfile: any
      resources: Record<string, any>
      outputs: {
        instanceLogicalId: string
        securityGroupLogicalId: string
        eipLogicalId: string
        associationLogicalId: string
        roleLogicalId: string
        profileLogicalId: string
      }
    } => {
      const userData = Compute.UserData.generateAppServerScript({
        runtime: options.runtime || 'bun',
        webServer: 'none',
        installRedis: options.installRedis,
      })

      return Compute.createServerModeStack({
        ...options,
        userData,
        instanceType: 't3.medium',
        allowedPorts: [22],
      })
    },

    /**
     * Create cache server (Redis)
     */
    cacheServer: (options: {
      slug: string
      environment: EnvironmentType
      vpcId: string
      subnetId: string
      keyName: string
    }): {
      instance: EC2Instance
      securityGroup: EC2SecurityGroup
      eip: any
      eipAssociation: any
      instanceRole: IAMRole
      instanceProfile: any
      resources: Record<string, any>
      outputs: {
        instanceLogicalId: string
        securityGroupLogicalId: string
        eipLogicalId: string
        associationLogicalId: string
        roleLogicalId: string
        profileLogicalId: string
      }
    } => {
      const userData = `#!/bin/bash
set -e
apt-get update && apt-get upgrade -y
apt-get install -y redis-server
sed -i 's/bind 127.0.0.1/bind 0.0.0.0/' /etc/redis/redis.conf
systemctl enable redis-server
systemctl restart redis-server
echo "Redis server setup complete!"
`

      return Compute.createServerModeStack({
        ...options,
        userData,
        instanceType: 't3.medium',
        allowedPorts: [22, 6379],
      })
    },
  }
}
