import type { CloudFormationBuilder } from '../builder'
import { Fn } from '../types'

export interface LoadBalancerConfig {
  type: 'application' | 'network'
  healthCheck?: {
    path?: string
    interval?: number
    timeout?: number
    healthyThreshold?: number
    unhealthyThreshold?: number
  }
  stickySession?: {
    enabled: boolean
    duration?: number
  }
}

export interface ServerConfig {
  instanceType: string
  ami?: string
  autoScaling?: {
    min: number
    max: number
    targetCPU?: number
    scaleUpCooldown?: number
    scaleDownCooldown?: number
  }
  loadBalancer?: LoadBalancerConfig
  userData?: string
}

export interface ComputeConfig {
  server?: ServerConfig
  fargate?: {
    taskDefinition: {
      cpu: string
      memory: string
      containerDefinitions?: Array<{
        name: string
        image: string
        portMappings?: Array<{ containerPort: number }>
        environment?: Record<string, any> | Array<{ name?: string, value?: any, Name?: string, Value?: any }>
        secrets?: Array<{ name?: string, valueFrom?: any, Name?: string, ValueFrom?: any }>
        healthCheck?: any
      }>
    }
    service: {
      desiredCount: number
      healthCheck?: {
        path?: string
        interval?: number
        timeout?: number
        healthyThreshold?: number
        unhealthyThreshold?: number
      }
      serviceDiscovery?: {
        enabled: boolean
        namespace?: string
      }
      autoScaling?: {
        min: number
        max: number
        targetCPU?: number
      }
    }
    loadBalancer?: {
      type?: 'application'
      customDomain?: { domain?: string, certificateArn?: string }
    }
  }
  services?: Array<{
    name: string
    type: 'fargate' | 'ec2'
    taskDefinition: any
    service: any
  }>
}

/**
 * Add compute resources (EC2, ECS, ALB) to CloudFormation template
 */
export function addComputeResources(
  builder: CloudFormationBuilder,
  config: ComputeConfig,
): void {
  if (config.server) {
    addEC2Resources(builder, config.server)
  }

  if (config.fargate) {
    addFargateResources(builder, 'app', config.fargate)
  }

  if (config.services) {
    config.services.forEach(service => {
      if (service.type === 'fargate') {
        addFargateResources(builder, service.name, {
          taskDefinition: service.taskDefinition,
          service: service.service,
        })
      }
    })
  }
}

/**
 * Add EC2 Auto Scaling Group with Load Balancer
 */
function addEC2Resources(
  builder: CloudFormationBuilder,
  config: ComputeConfig['server'],
): void {
  if (!config) return

  // Security Group for EC2 instances
  builder.addResource('AppSecurityGroup', 'AWS::EC2::SecurityGroup', {
    GroupDescription: 'Security group for application instances',
    VpcId: Fn.ref('VPC'),
    SecurityGroupIngress: [{
      IpProtocol: 'tcp',
      FromPort: 3000,
      ToPort: 3000,
      SourceSecurityGroupId: Fn.ref('ALBSecurityGroup'),
    }, {
      IpProtocol: 'tcp',
      FromPort: 22,
      ToPort: 22,
      CidrIp: '0.0.0.0/0', // Should be restricted in production
    }],
    SecurityGroupEgress: [{
      IpProtocol: '-1',
      CidrIp: '0.0.0.0/0',
    }],
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-app-sg') },
    ],
  }, {
    dependsOn: 'VPC',
  })

  // IAM Role for EC2 instances
  builder.addResource('EC2InstanceRole', 'AWS::IAM::Role', {
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
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-ec2-role') },
    ],
  })

  builder.addResource('EC2InstanceProfile', 'AWS::IAM::InstanceProfile', {
    Roles: [Fn.ref('EC2InstanceRole')],
  }, {
    dependsOn: 'EC2InstanceRole',
  })

  // Launch Template
  const userData = config.userData || `#!/bin/bash
set -e
# Update system
yum update -y || apt-get update -y

# Install Node.js (Amazon Linux 2)
curl -sL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs || apt-get install -y nodejs

# Install CloudWatch agent
wget https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm
rpm -U ./amazon-cloudwatch-agent.rpm || true

# Signal completion
/opt/aws/bin/cfn-signal -e $? --stack \${AWS::StackName} --resource AutoScalingGroup --region \${AWS::Region}
`

  builder.addResource('LaunchTemplate', 'AWS::EC2::LaunchTemplate', {
    LaunchTemplateName: Fn.sub('${AWS::StackName}-template'),
    LaunchTemplateData: {
      ImageId: config.ami || Fn.findInMap('RegionMap', Fn.ref('AWS::Region'), 'AMI'),
      InstanceType: config.instanceType,
      IamInstanceProfile: {
        Arn: Fn.getAtt('EC2InstanceProfile', 'Arn'),
      },
      SecurityGroupIds: [Fn.ref('AppSecurityGroup')],
      UserData: Fn.base64(Fn.sub(userData)),
      TagSpecifications: [{
        ResourceType: 'instance',
        Tags: [
          { Key: 'Name', Value: Fn.sub('${AWS::StackName}-instance') },
        ],
      }],
      MetadataOptions: {
        HttpTokens: 'required', // IMDSv2
        HttpPutResponseHopLimit: 1,
      },
    },
  }, {
    dependsOn: ['AppSecurityGroup', 'EC2InstanceProfile'],
  })

  // Load Balancer
  if (config.loadBalancer) {
    addLoadBalancer(builder, config.loadBalancer)

    // Auto Scaling Group
    const asgProperties: Record<string, any> = {
      LaunchTemplate: {
        LaunchTemplateId: Fn.ref('LaunchTemplate'),
        Version: Fn.getAtt('LaunchTemplate', 'LatestVersionNumber'),
      },
      MinSize: config.autoScaling?.min.toString() || '1',
      MaxSize: config.autoScaling?.max.toString() || '3',
      DesiredCapacity: config.autoScaling?.min.toString() || '2',
      VPCZoneIdentifier: [
        Fn.ref('PrivateSubnet1'),
        Fn.ref('PrivateSubnet2'),
      ],
      TargetGroupARNs: [Fn.ref('TargetGroup')],
      HealthCheckType: 'ELB',
      HealthCheckGracePeriod: 300,
      Tags: [
        { Key: 'Name', Value: Fn.sub('${AWS::StackName}-asg'), PropagateAtLaunch: true },
      ],
    }

    builder.addResource('AutoScalingGroup', 'AWS::AutoScaling::AutoScalingGroup', asgProperties, {
      dependsOn: ['LaunchTemplate', 'TargetGroup'],
    })

    // Auto Scaling Policies
    if (config.autoScaling) {
      builder.addResource('ScaleUpPolicy', 'AWS::AutoScaling::ScalingPolicy', {
        AdjustmentType: 'ChangeInCapacity',
        AutoScalingGroupName: Fn.ref('AutoScalingGroup'),
        Cooldown: config.autoScaling.scaleUpCooldown?.toString() || '300',
        ScalingAdjustment: '1',
      }, {
        dependsOn: 'AutoScalingGroup',
      })

      builder.addResource('ScaleDownPolicy', 'AWS::AutoScaling::ScalingPolicy', {
        AdjustmentType: 'ChangeInCapacity',
        AutoScalingGroupName: Fn.ref('AutoScalingGroup'),
        Cooldown: config.autoScaling.scaleDownCooldown?.toString() || '300',
        ScalingAdjustment: '-1',
      }, {
        dependsOn: 'AutoScalingGroup',
      })

      // CPU-based alarms
      builder.addResource('HighCPUAlarm', 'AWS::CloudWatch::Alarm', {
        AlarmDescription: 'Scale up when CPU exceeds target',
        MetricName: 'CPUUtilization',
        Namespace: 'AWS/EC2',
        Statistic: 'Average',
        Period: '300',
        EvaluationPeriods: '2',
        Threshold: (config.autoScaling.targetCPU || 70).toString(),
        AlarmActions: [Fn.ref('ScaleUpPolicy')],
        Dimensions: [{
          Name: 'AutoScalingGroupName',
          Value: Fn.ref('AutoScalingGroup'),
        }],
        ComparisonOperator: 'GreaterThanThreshold',
      }, {
        dependsOn: ['AutoScalingGroup', 'ScaleUpPolicy'],
      })

      builder.addResource('LowCPUAlarm', 'AWS::CloudWatch::Alarm', {
        AlarmDescription: 'Scale down when CPU is below threshold',
        MetricName: 'CPUUtilization',
        Namespace: 'AWS/EC2',
        Statistic: 'Average',
        Period: '300',
        EvaluationPeriods: '2',
        Threshold: ((config.autoScaling.targetCPU || 70) - 20).toString(),
        AlarmActions: [Fn.ref('ScaleDownPolicy')],
        Dimensions: [{
          Name: 'AutoScalingGroupName',
          Value: Fn.ref('AutoScalingGroup'),
        }],
        ComparisonOperator: 'LessThanThreshold',
      }, {
        dependsOn: ['AutoScalingGroup', 'ScaleDownPolicy'],
      })
    }
  }
}

/**
 * Add Application/Network Load Balancer
 */
function addLoadBalancer(
  builder: CloudFormationBuilder,
  config: LoadBalancerConfig | undefined,
): void {
  if (!config) return

  // ALB Security Group
  builder.addResource('ALBSecurityGroup', 'AWS::EC2::SecurityGroup', {
    GroupDescription: 'Security group for Application Load Balancer',
    VpcId: Fn.ref('VPC'),
    SecurityGroupIngress: [{
      IpProtocol: 'tcp',
      FromPort: 80,
      ToPort: 80,
      CidrIp: '0.0.0.0/0',
    }, {
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      CidrIp: '0.0.0.0/0',
    }],
    SecurityGroupEgress: [{
      IpProtocol: '-1',
      CidrIp: '0.0.0.0/0',
    }],
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-alb-sg') },
    ],
  }, {
    dependsOn: 'VPC',
  })

  // Application Load Balancer
  builder.addResource('LoadBalancer', 'AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Name: Fn.sub('${AWS::StackName}-alb'),
    Type: config.type || 'application',
    Scheme: 'internet-facing',
    IpAddressType: 'ipv4',
    Subnets: [
      Fn.ref('PublicSubnet1'),
      Fn.ref('PublicSubnet2'),
    ],
    SecurityGroups: [Fn.ref('ALBSecurityGroup')],
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-alb') },
    ],
  }, {
    dependsOn: ['PublicSubnet1', 'PublicSubnet2', 'ALBSecurityGroup'],
  })

  // Target Group
  builder.addResource('TargetGroup', 'AWS::ElasticLoadBalancingV2::TargetGroup', {
    Name: Fn.sub('${AWS::StackName}-tg'),
    Port: 3000,
    Protocol: 'HTTP',
    VpcId: Fn.ref('VPC'),
    HealthCheckEnabled: true,
    HealthCheckPath: config.healthCheck?.path || '/health',
    HealthCheckProtocol: 'HTTP',
    HealthCheckIntervalSeconds: config.healthCheck?.interval || 30,
    HealthCheckTimeoutSeconds: config.healthCheck?.timeout || 5,
    HealthyThresholdCount: config.healthCheck?.healthyThreshold || 2,
    UnhealthyThresholdCount: config.healthCheck?.unhealthyThreshold || 3,
    TargetType: 'instance',
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-tg') },
    ],
  }, {
    dependsOn: 'VPC',
  })

  // Listener
  builder.addResource('LoadBalancerListener', 'AWS::ElasticLoadBalancingV2::Listener', {
    LoadBalancerArn: Fn.ref('LoadBalancer'),
    Port: 80,
    Protocol: 'HTTP',
    DefaultActions: [{
      Type: 'forward',
      TargetGroupArn: Fn.ref('TargetGroup'),
    }],
  }, {
    dependsOn: ['LoadBalancer', 'TargetGroup'],
  })

  // Output
  builder.addOutputs({
    LoadBalancerDNS: {
      Description: 'Load Balancer DNS Name',
      Value: Fn.getAtt('LoadBalancer', 'DNSName'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-alb-dns'),
      },
    },
  })
}

/**
 * Add ECS Fargate resources
 */
function addFargateResources(
  builder: CloudFormationBuilder,
  serviceName: string,
  config: { taskDefinition: any, service: any, loadBalancer?: any },
): void {
  const serviceId = builder.toLogicalId(serviceName)
  const container = config.taskDefinition.containerDefinitions?.[0]
  const containerName = container?.name || container?.Name || serviceName
  const containerPort = container?.portMappings?.[0]?.containerPort || container?.PortMappings?.[0]?.ContainerPort || 3000
  const secretResources = (config.taskDefinition.containerDefinitions || []).flatMap((value: any) => (value.secrets || value.Secrets || []).map((secret: any) => secret.valueFrom || secret.ValueFrom)).filter(Boolean)

  // ECS Cluster
  if (!builder.hasResource('ECSCluster')) {
    builder.addResource('ECSCluster', 'AWS::ECS::Cluster', {
      ClusterName: Fn.sub('${AWS::StackName}-cluster'),
      Tags: [
        { Key: 'Name', Value: Fn.sub('${AWS::StackName}-cluster') },
      ],
    })
  }

  // Task Execution Role
  builder.addResource(`${serviceId}TaskExecutionRole`, 'AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { Service: 'ecs-tasks.amazonaws.com' },
        Action: 'sts:AssumeRole',
      }],
    },
    ManagedPolicyArns: [
      'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
    ],
    ...(secretResources.length ? { Policies: [{ PolicyName: 'read-task-secrets', PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue', 'ssm:GetParameters'], Resource: secretResources }, { Effect: 'Allow', Action: 'kms:Decrypt', Resource: '*' }] } }] } : {}),
  })

  // Task Role
  builder.addResource(`${serviceId}TaskRole`, 'AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { Service: 'ecs-tasks.amazonaws.com' },
        Action: 'sts:AssumeRole',
      }],
    },
    Policies: [{
      PolicyName: 'application-services',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:SendMessage'], Resource: Fn.sub('arn:aws:sqs:${AWS::Region}:${AWS::AccountId}:${AWS::StackName}-*') }, { Effect: 'Allow', Action: ['ses:SendEmail', 'ses:SendRawEmail'], Resource: '*' }],
      },
    }],
  })

  if (!builder.hasResource('ALBSecurityGroup')) {
    builder.addResource('ALBSecurityGroup', 'AWS::EC2::SecurityGroup', {
      GroupDescription: 'Public ingress for the application load balancer',
      VpcId: Fn.ref('VPC'),
      SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' }, ...(config.loadBalancer?.customDomain?.certificateArn ? [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }] : [])],
      SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: containerPort, ToPort: containerPort, CidrIp: '0.0.0.0/0' }],
      Tags: [{ Key: 'Name', Value: Fn.sub('${AWS::StackName}-alb-sg') }],
    }, { dependsOn: 'VPC' })
  }

  if (!builder.hasResource('AppSecurityGroup')) {
    builder.addResource('AppSecurityGroup', 'AWS::EC2::SecurityGroup', {
      GroupDescription: 'Only the application load balancer may reach Fargate tasks',
      VpcId: Fn.ref('VPC'),
      SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: containerPort, ToPort: containerPort, SourceSecurityGroupId: Fn.ref('ALBSecurityGroup') }],
      SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0' }],
      Tags: [{ Key: 'Name', Value: Fn.sub('${AWS::StackName}-app-sg') }],
    }, { dependsOn: ['VPC', 'ALBSecurityGroup'] })
  }

  const normalizedContainers = (config.taskDefinition.containerDefinitions || [{ name: serviceName, image: Fn.sub(`\${AWS::AccountId}.dkr.ecr.\${AWS::Region}.amazonaws.com/${serviceName}:latest`), portMappings: [{ containerPort: 3000 }] }]).map((value: any) => ({
    Name: value.Name || value.name,
    Image: value.Image || value.image,
    Essential: value.Essential ?? value.essential ?? true,
    PortMappings: (value.PortMappings || value.portMappings || []).map((port: any) => ({ ContainerPort: port.ContainerPort ?? port.containerPort, Protocol: port.Protocol || port.protocol || 'tcp' })),
    Environment: Array.isArray(value.Environment || value.environment)
      ? (value.Environment || value.environment).map((item: any) => ({ Name: item.Name || item.name, Value: item.Value ?? item.value }))
      : Object.entries(value.Environment || value.environment || {}).map(([Name, Value]) => ({ Name, Value })),
    Secrets: (value.Secrets || value.secrets || []).map((item: any) => ({ Name: item.Name || item.name, ValueFrom: item.ValueFrom || item.valueFrom })),
    HealthCheck: value.HealthCheck || value.healthCheck,
    Command: value.Command || value.command,
    EntryPoint: value.EntryPoint || value.entryPoint,
    LogConfiguration: value.LogConfiguration || value.logConfiguration || { LogDriver: 'awslogs', Options: { 'awslogs-group': Fn.ref(`${serviceId}LogGroup`), 'awslogs-region': Fn.ref('AWS::Region'), 'awslogs-stream-prefix': serviceName } },
  }))

  // Task Definition
  builder.addResource(`${serviceId}TaskDefinition`, 'AWS::ECS::TaskDefinition', {
    Family: Fn.sub(`\${AWS::StackName}-${serviceName}`),
    NetworkMode: 'awsvpc',
    RequiresCompatibilities: ['FARGATE'],
    Cpu: config.taskDefinition.cpu,
    Memory: config.taskDefinition.memory,
    ExecutionRoleArn: Fn.getAtt(`${serviceId}TaskExecutionRole`, 'Arn'),
    TaskRoleArn: Fn.getAtt(`${serviceId}TaskRole`, 'Arn'),
    ContainerDefinitions: normalizedContainers,
  }, {
    dependsOn: [`${serviceId}TaskExecutionRole`, `${serviceId}TaskRole`, `${serviceId}LogGroup`],
  })

  // Log Group
  builder.addResource(`${serviceId}LogGroup`, 'AWS::Logs::LogGroup', {
    LogGroupName: Fn.sub(`/ecs/\${AWS::StackName}/${serviceName}`),
    RetentionInDays: 14,
  })

  const health = config.service.healthCheck || {}
  builder.addResource(`${serviceId}TargetGroup`, 'AWS::ElasticLoadBalancingV2::TargetGroup', {
    VpcId: Fn.ref('VPC'),
    Port: containerPort,
    Protocol: 'HTTP',
    TargetType: 'ip',
    HealthCheckEnabled: true,
    HealthCheckPath: health.path || '/health',
    HealthCheckProtocol: 'HTTP',
    HealthCheckIntervalSeconds: health.interval || 30,
    HealthCheckTimeoutSeconds: health.timeout || 5,
    HealthyThresholdCount: health.healthyThreshold || 2,
    UnhealthyThresholdCount: health.unhealthyThreshold || 3,
    Matcher: { HttpCode: '200-399' },
    TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
  }, { dependsOn: 'VPC' })

  builder.addResource(`${serviceId}LoadBalancer`, 'AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Type: 'application',
    Scheme: 'internet-facing',
    IpAddressType: 'ipv4',
    Subnets: [Fn.ref('PublicSubnet1'), Fn.ref('PublicSubnet2')],
    SecurityGroups: [Fn.ref('ALBSecurityGroup')],
    LoadBalancerAttributes: [{ Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' }, { Key: 'deletion_protection.enabled', Value: 'true' }],
    Tags: [{ Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-${serviceName}-alb`) }],
  }, { dependsOn: ['PublicSubnet1', 'PublicSubnet2', 'ALBSecurityGroup'] })

  const certificateArn = config.loadBalancer?.customDomain?.certificateArn
  builder.addResource(`${serviceId}HttpListener`, 'AWS::ElasticLoadBalancingV2::Listener', {
    LoadBalancerArn: Fn.ref(`${serviceId}LoadBalancer`),
    Port: 80,
    Protocol: 'HTTP',
    DefaultActions: certificateArn
      ? [{ Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } }]
      : [{ Type: 'forward', TargetGroupArn: Fn.ref(`${serviceId}TargetGroup`) }],
  }, { dependsOn: [`${serviceId}LoadBalancer`, `${serviceId}TargetGroup`] })
  if (certificateArn) {
    builder.addResource(`${serviceId}HttpsListener`, 'AWS::ElasticLoadBalancingV2::Listener', {
      LoadBalancerArn: Fn.ref(`${serviceId}LoadBalancer`), Port: 443, Protocol: 'HTTPS', Certificates: [{ CertificateArn: certificateArn }], SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06', DefaultActions: [{ Type: 'forward', TargetGroupArn: Fn.ref(`${serviceId}TargetGroup`) }],
    }, { dependsOn: [`${serviceId}LoadBalancer`, `${serviceId}TargetGroup`] })
  }

  // ECS Service
  builder.addResource(`${serviceId}Service`, 'AWS::ECS::Service', {
    ServiceName: Fn.sub(`\${AWS::StackName}-${serviceName}`),
    Cluster: Fn.ref('ECSCluster'),
    TaskDefinition: Fn.ref(`${serviceId}TaskDefinition`),
    DesiredCount: config.service.desiredCount,
    LaunchType: 'FARGATE',
    PlatformVersion: 'LATEST',
    HealthCheckGracePeriodSeconds: 60,
    DeploymentConfiguration: { MinimumHealthyPercent: 100, MaximumPercent: 200, DeploymentCircuitBreaker: { Enable: true, Rollback: true } },
    LoadBalancers: [{ ContainerName: containerName, ContainerPort: containerPort, TargetGroupArn: Fn.ref(`${serviceId}TargetGroup`) }],
    NetworkConfiguration: {
      AwsvpcConfiguration: {
        AssignPublicIp: 'DISABLED',
        Subnets: [
          Fn.ref('PrivateSubnet1'),
          Fn.ref('PrivateSubnet2'),
        ],
        SecurityGroups: [Fn.ref('AppSecurityGroup')],
      },
    },
  }, {
    dependsOn: ['ECSCluster', `${serviceId}TaskDefinition`, certificateArn ? `${serviceId}HttpsListener` : `${serviceId}HttpListener`],
  })

  if (config.service.autoScaling) {
    const scaling = config.service.autoScaling
    builder.addResource(`${serviceId}ScalableTarget`, 'AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: scaling.min,
      MaxCapacity: scaling.max,
      ResourceId: Fn.join('/', ['service', Fn.ref('ECSCluster'), Fn.getAtt(`${serviceId}Service`, 'Name')]),
      RoleARN: Fn.sub('arn:aws:iam::${AWS::AccountId}:role/aws-service-role/ecs.application-autoscaling.amazonaws.com/AWSServiceRoleForApplicationAutoScaling_ECSService'),
      ScalableDimension: 'ecs:service:DesiredCount',
      ServiceNamespace: 'ecs',
    }, { dependsOn: `${serviceId}Service` })
    builder.addResource(`${serviceId}ScalingPolicy`, 'AWS::ApplicationAutoScaling::ScalingPolicy', {
      PolicyType: 'TargetTrackingScaling', ScalingTargetId: Fn.ref(`${serviceId}ScalableTarget`), TargetTrackingScalingPolicyConfiguration: { TargetValue: scaling.targetCPU || 70, PredefinedMetricSpecification: { PredefinedMetricType: 'ECSServiceAverageCPUUtilization' }, ScaleInCooldown: 60, ScaleOutCooldown: 30 },
    }, { dependsOn: `${serviceId}ScalableTarget` })
  }

  builder.addOutputs({
    [`${serviceId}ClusterName`]: { Description: 'ECS cluster name', Value: Fn.ref('ECSCluster') },
    [`${serviceId}ServiceName`]: { Description: 'ECS service name', Value: Fn.getAtt(`${serviceId}Service`, 'Name') },
    [`${serviceId}LoadBalancerDnsName`]: { Description: 'ALB origin hostname', Value: Fn.getAtt(`${serviceId}LoadBalancer`, 'DNSName') },
    [`${serviceId}LoadBalancerHostedZoneId`]: { Description: 'ALB canonical hosted zone ID', Value: Fn.getAtt(`${serviceId}LoadBalancer`, 'CanonicalHostedZoneID') },
    [`${serviceId}TargetGroupArn`]: { Description: 'ECS target group ARN', Value: Fn.ref(`${serviceId}TargetGroup`) },
  })
}
