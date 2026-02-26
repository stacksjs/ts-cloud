/**
 * Infrastructure Generator
 * Generates CloudFormation templates from cloud.config.ts using all Phase 2 modules
 */

import type { CloudConfig } from 'ts-cloud-types'
import {
  Storage,
  CDN,
  DNS,
  Security,
  Compute,
  Network,
  FileSystem,
  Email,
  Queue,
  AI,
  Database,
  Cache,
  Permissions,
  ApiGateway,
  Messaging,
  Workflow,
  Monitoring,
  Auth,
  Deployment,
  Redirects,
  Search,
  TemplateBuilder,
} from 'ts-cloud-core'

export interface GenerationOptions {
  config: CloudConfig
  environment: 'production' | 'staging' | 'development'
  modules?: string[]
}

export class InfrastructureGenerator {
  private builder: TemplateBuilder
  private config: CloudConfig
  private environment: 'production' | 'staging' | 'development'
  private mergedConfig: CloudConfig
  private serverEipLogicalIds: Map<string, string> = new Map()

  constructor(options: GenerationOptions) {
    this.config = options.config
    this.environment = options.environment
    this.builder = new TemplateBuilder(
      `${this.config.project.name} - ${this.environment}`,
    )

    // Merge environment-specific infrastructure overrides
    this.mergedConfig = this.mergeEnvironmentConfig()
  }

  /**
   * Merge base config with environment-specific overrides
   */
  private mergeEnvironmentConfig(): CloudConfig {
    const envConfig = this.config.environments[this.environment]
    const envInfra = envConfig?.infrastructure

    if (!envInfra) {
      return this.config
    }

    return {
      ...this.config,
      infrastructure: {
        ...this.config.infrastructure,
        ...envInfra,
        // Deep merge for nested objects
        storage: { ...this.config.infrastructure?.storage, ...envInfra.storage },
        functions: { ...this.config.infrastructure?.functions, ...envInfra.functions },
        servers: { ...this.config.infrastructure?.servers, ...envInfra.servers },
        databases: { ...this.config.infrastructure?.databases, ...envInfra.databases },
        cdn: { ...this.config.infrastructure?.cdn, ...envInfra.cdn },
        queues: { ...this.config.infrastructure?.queues, ...envInfra.queues },
        redirects: { ...this.config.infrastructure?.redirects, ...envInfra.redirects },
        realtime: { ...this.config.infrastructure?.realtime, ...envInfra.realtime },
        cache: { ...this.config.infrastructure?.cache, ...envInfra.cache },
        fileSystem: { ...this.config.infrastructure?.fileSystem, ...envInfra.fileSystem },
        email: { ...this.config.infrastructure?.email, ...envInfra.email },
        search: { ...this.config.infrastructure?.search, ...envInfra.search },
        ai: { ...this.config.infrastructure?.ai, ...envInfra.ai },
      },
    }
  }

  /**
   * Check if a resource should be deployed based on conditions
   */
  private shouldDeploy(resource: any): boolean {
    // Check environment conditions
    if (resource.environments && !resource.environments.includes(this.environment)) {
      return false
    }

    // Check feature flag requirements
    if (resource.requiresFeatures) {
      const features = this.config.features || {}
      const hasRequiredFeatures = resource.requiresFeatures.every(
        (feature: string) => features[feature] === true
      )
      if (!hasRequiredFeatures) {
        return false
      }
    }

    // Check region conditions
    if (resource.regions) {
      const currentRegion = this.config.environments[this.environment]?.region || this.config.project.region
      if (!resource.regions.includes(currentRegion)) {
        return false
      }
    }

    // Check custom condition function
    if (resource.condition && typeof resource.condition === 'function') {
      return resource.condition(this.config, this.environment)
    }

    return true
  }

  /**
   * Generate complete infrastructure
   * Auto-detects what to generate based on configuration
   */
  generate(): this {
    const slug = this.mergedConfig.project.slug
    const env = this.environment

    // Auto-detect and generate based on what's configured (using merged config)
    // If functions or API are defined, generate serverless resources
    const hasServerlessConfig = !!(
      (this.mergedConfig.infrastructure?.functions && Object.keys(this.mergedConfig.infrastructure.functions).length > 0)
      || this.mergedConfig.infrastructure?.api
    )

    // If servers are defined, generate server resources
    const hasServerConfig = !!(
      this.mergedConfig.infrastructure?.servers
      && Object.keys(this.mergedConfig.infrastructure.servers).length > 0
    )

    // If containers are defined, generate ECS/Fargate resources
    // Only generate when mode is 'serverless' or containers are explicitly configured
    const mode = this.mergedConfig.mode || 'server'
    const hasContainerConfig = !!(
      mode === 'serverless'
      && this.mergedConfig.infrastructure?.containers
      && Object.keys(this.mergedConfig.infrastructure.containers).length > 0
    )

    // Generate network resources first if containers need them
    if (hasContainerConfig) {
      this.generateNetworkInfrastructure(slug, env)
      this.generateContainerInfrastructure(slug, env)
    }

    if (hasServerlessConfig) {
      this.generateServerless(slug, env)
    }

    if (hasServerConfig) {
      this.generateServer(slug, env)
    }

    // If jumpBox is configured, generate bastion host
    const jumpBoxConfig = this.mergedConfig.infrastructure?.jumpBox
    if (jumpBoxConfig) {
      this.generateJumpBox(slug, env)
    }

    // Always generate shared infrastructure (storage, CDN, databases, etc.)
    this.generateSharedInfrastructure(slug, env)

    // Apply global tags if specified
    if (this.config.tags) {
      this.applyGlobalTags(this.config.tags)
    }

    return this
  }

  /**
   * Apply global tags to all resources
   */
  private applyGlobalTags(tags: Record<string, string>): void {
    // This would iterate through all resources in the builder and add tags
    // Implementation depends on TemplateBuilder structure
  }

  /**
   * Generate VPC/Network infrastructure required by ECS/Fargate
   */
  private generateNetworkInfrastructure(slug: string, env: typeof this.environment): void {
    // Idempotent — skip if VPC already generated
    if (this.builder.hasResource('VPC')) return

    const networkConfig = this.mergedConfig.infrastructure?.network
    const cidr = networkConfig?.cidr || '10.0.0.0/16'

    // VPC
    const { vpc, logicalId: vpcId } = Network.createVpc({
      slug,
      environment: env,
      cidr,
      enableDnsHostnames: true,
      enableDnsSupport: true,
    })
    this.builder.addResource('VPC', vpc)

    // Internet Gateway
    const igwId = `${slug}${env}IGW`.replace(/[^a-zA-Z0-9]/g, '')
    this.builder.addResource(igwId, {
      Type: 'AWS::EC2::InternetGateway',
      Properties: {
        Tags: [
          { Key: 'Name', Value: `${slug}-${env}-igw` },
          { Key: 'Environment', Value: env },
        ],
      },
    } as any)

    // Attach IGW to VPC
    const attachId = `${slug}${env}IGWAttach`.replace(/[^a-zA-Z0-9]/g, '')
    this.builder.addResource(attachId, {
      Type: 'AWS::EC2::VPCGatewayAttachment',
      Properties: {
        VpcId: { Ref: 'VPC' },
        InternetGatewayId: { Ref: igwId },
      },
    } as any)

    // Public Route Table
    const routeTableId = `${slug}${env}PublicRT`.replace(/[^a-zA-Z0-9]/g, '')
    this.builder.addResource(routeTableId, {
      Type: 'AWS::EC2::RouteTable',
      Properties: {
        VpcId: { Ref: 'VPC' },
        Tags: [
          { Key: 'Name', Value: `${slug}-${env}-public-rt` },
          { Key: 'Environment', Value: env },
        ],
      },
    } as any)

    // Default route to IGW
    this.builder.addResource(`${slug}${env}PublicRoute`.replace(/[^a-zA-Z0-9]/g, ''), {
      Type: 'AWS::EC2::Route',
      Properties: {
        RouteTableId: { Ref: routeTableId },
        DestinationCidrBlock: '0.0.0.0/0',
        GatewayId: { Ref: igwId },
      },
      DependsOn: attachId,
    } as any)

    // Public Subnets (2 AZs for ALB requirement)
    const region = this.mergedConfig.environments[env]?.region || this.mergedConfig.project.region || 'us-east-1'
    const azSuffixes = ['a', 'b']

    for (let i = 0; i < 2; i++) {
      const subnetLogicalId = `PublicSubnet${i + 1}`
      this.builder.addResource(subnetLogicalId, {
        Type: 'AWS::EC2::Subnet',
        Properties: {
          VpcId: { Ref: 'VPC' },
          CidrBlock: `10.0.${i}.0/24`,
          AvailabilityZone: `${region}${azSuffixes[i]}`,
          MapPublicIpOnLaunch: true,
          Tags: [
            { Key: 'Name', Value: `${slug}-${env}-public-${azSuffixes[i]}` },
            { Key: 'Environment', Value: env },
          ],
        },
      } as any)

      // Associate subnet with route table
      this.builder.addResource(`${subnetLogicalId}RTAssoc`, {
        Type: 'AWS::EC2::SubnetRouteTableAssociation',
        Properties: {
          SubnetId: { Ref: subnetLogicalId },
          RouteTableId: { Ref: routeTableId },
        },
      } as any)
    }
  }

  /**
   * Generate ECS/Fargate container infrastructure
   * Creates ECS Cluster, Task Definition, Service, ALB, Security Groups, IAM roles, etc.
   */
  private generateContainerInfrastructure(slug: string, env: typeof this.environment): void {
    const containers = this.mergedConfig.infrastructure?.containers
    if (!containers) return

    const lbConfig = this.mergedConfig.infrastructure?.loadBalancer
    const sslConfig = this.mergedConfig.infrastructure?.ssl
    const dnsConfig = this.mergedConfig.infrastructure?.dns

    // ========================================
    // ACM Certificate (if SSL is configured)
    // ========================================
    let certificateLogicalId: string | undefined
    if (sslConfig?.enabled && sslConfig.domains?.length) {
      if (sslConfig.certificateArn) {
        // Use existing certificate ARN - no resource needed
      }
      else {
        const domain = sslConfig.domains[0]
        const subdomains = sslConfig.domains.slice(1).map((d: string) => {
          // If it's already a full domain (e.g. www.example.com), extract subdomain
          if (d.includes('.') && d.endsWith(domain)) {
            return d.replace(`.${domain}`, '')
          }
          return d
        })

        const { certificate, logicalId } = Security.createCertificate({
          domain,
          subdomains,
          slug,
          environment: env,
          validationMethod: 'DNS',
          hostedZoneId: dnsConfig?.hostedZoneId,
        })

        certificateLogicalId = logicalId
        this.builder.addResource(logicalId, certificate)
      }
    }

    // ========================================
    // ECS Cluster
    // ========================================
    const clusterLogicalId = 'ECSCluster'
    this.builder.addResource(clusterLogicalId, {
      Type: 'AWS::ECS::Cluster',
      Properties: {
        ClusterName: `${slug}-${env}`,
        ClusterSettings: [
          { Name: 'containerInsights', Value: 'enabled' },
        ],
        Tags: [
          { Key: 'Name', Value: `${slug}-${env}` },
          { Key: 'Environment', Value: env },
        ],
      },
    } as any)

    // ========================================
    // ALB Security Group
    // ========================================
    const albSgId = `${slug}${env}ALBSecurityGroup`.replace(/[^a-zA-Z0-9]/g, '')
    this.builder.addResource(albSgId, {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: `ALB security group for ${slug}-${env}`,
        VpcId: { Ref: 'VPC' },
        SecurityGroupIngress: [
          { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0', Description: 'HTTP' },
          { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0', Description: 'HTTPS' },
        ],
        SecurityGroupEgress: [
          { IpProtocol: '-1', CidrIp: '0.0.0.0/0', Description: 'Allow all outbound' },
        ],
        Tags: [
          { Key: 'Name', Value: `${slug}-${env}-alb-sg` },
          { Key: 'Environment', Value: env },
        ],
      },
    } as any)

    // ========================================
    // ECS Task Security Group
    // ========================================
    const ecsSgId = `${slug}${env}ECSSecurityGroup`.replace(/[^a-zA-Z0-9]/g, '')

    // Iterate over containers to build container-specific resources
    for (const [name, containerConfig] of Object.entries(containers)) {
      const port = (containerConfig as any).port || 3000

      this.builder.addResource(ecsSgId, {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupDescription: `ECS tasks security group for ${slug}-${env}`,
          VpcId: { Ref: 'VPC' },
          SecurityGroupIngress: [
            {
              IpProtocol: 'tcp',
              FromPort: port,
              ToPort: port,
              SourceSecurityGroupId: { Ref: albSgId },
              Description: 'Allow traffic from ALB',
            },
          ],
          SecurityGroupEgress: [
            { IpProtocol: '-1', CidrIp: '0.0.0.0/0', Description: 'Allow all outbound' },
          ],
          Tags: [
            { Key: 'Name', Value: `${slug}-${env}-ecs-sg` },
            { Key: 'Environment', Value: env },
          ],
        },
      } as any)

      // ========================================
      // ECS Task Execution Role
      // ========================================
      const execRoleId = `${slug}${env}TaskExecRole`.replace(/[^a-zA-Z0-9]/g, '')
      this.builder.addResource(execRoleId, {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: `${slug}-${env}-ecs-exec-role`,
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
          Policies: [{
            PolicyName: 'ECRPullPolicy',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [{
                Effect: 'Allow',
                Action: [
                  'ecr:GetAuthorizationToken',
                  'ecr:BatchCheckLayerAvailability',
                  'ecr:GetDownloadUrlForLayer',
                  'ecr:BatchGetImage',
                  'logs:CreateLogStream',
                  'logs:PutLogEvents',
                ],
                Resource: '*',
              }],
            },
          }],
        },
      } as any)

      // ========================================
      // ECS Task Role
      // ========================================
      const taskRoleId = `${slug}${env}TaskRole`.replace(/[^a-zA-Z0-9]/g, '')
      this.builder.addResource(taskRoleId, {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: `${slug}-${env}-ecs-task-role`,
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Principal: { Service: 'ecs-tasks.amazonaws.com' },
              Action: 'sts:AssumeRole',
            }],
          },
          Policies: [{
            PolicyName: 'TaskPolicy',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Action: [
                    'logs:CreateLogStream',
                    'logs:PutLogEvents',
                  ],
                  Resource: '*',
                },
                {
                  Effect: 'Allow',
                  Action: [
                    's3:GetObject',
                    's3:PutObject',
                    's3:ListBucket',
                  ],
                  Resource: '*',
                },
              ],
            },
          }],
        },
      } as any)

      // ========================================
      // CloudWatch Log Group
      // ========================================
      const logGroupId = `${slug}${env}${name}LogGroup`.replace(/[^a-zA-Z0-9]/g, '')
      const logGroupName = `/ecs/${slug}-${env}-${name}`
      this.builder.addResource(logGroupId, {
        Type: 'AWS::Logs::LogGroup',
        Properties: {
          LogGroupName: logGroupName,
          RetentionInDays: 30,
        },
      } as any)

      // ========================================
      // ECS Task Definition
      // ========================================
      const taskDefId = `${slug}${env}${name}TaskDef`.replace(/[^a-zA-Z0-9]/g, '')
      const cpu = String((containerConfig as any).cpu || 512)
      const memory = String((containerConfig as any).memory || 1024)

      this.builder.addResource(taskDefId, {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
          Family: `${slug}-${env}-${name}`,
          NetworkMode: 'awsvpc',
          RequiresCompatibilities: ['FARGATE'],
          Cpu: cpu,
          Memory: memory,
          ExecutionRoleArn: { 'Fn::GetAtt': [execRoleId, 'Arn'] },
          TaskRoleArn: { 'Fn::GetAtt': [taskRoleId, 'Arn'] },
          ContainerDefinitions: [{
            Name: name,
            Image: { 'Fn::Sub': `\${AWS::AccountId}.dkr.ecr.\${AWS::Region}.amazonaws.com/${slug}:latest` },
            Essential: true,
            PortMappings: [{
              ContainerPort: port,
              Protocol: 'tcp',
            }],
            LogConfiguration: {
              LogDriver: 'awslogs',
              Options: {
                'awslogs-group': logGroupName,
                'awslogs-region': { Ref: 'AWS::Region' },
                'awslogs-stream-prefix': name,
              },
            },
            HealthCheck: {
              Command: ['CMD-SHELL', `curl -f http://localhost:${port}${(containerConfig as any).healthCheck || '/health'} || exit 1`],
              Interval: 30,
              Timeout: 5,
              Retries: 3,
              StartPeriod: 60,
            },
          }],
          Tags: [
            { Key: 'Name', Value: `${slug}-${env}-${name}` },
            { Key: 'Environment', Value: env },
          ],
        },
        DependsOn: [execRoleId, taskRoleId, logGroupId],
      } as any)

      // ========================================
      // Application Load Balancer
      // ========================================
      const albId = `${slug}${env}ALB`.replace(/[^a-zA-Z0-9]/g, '')
      if (lbConfig?.enabled !== false) {
        this.builder.addResource(albId, {
          Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
          Properties: {
            Name: `${slug}-${env}-alb`,
            Scheme: 'internet-facing',
            Type: 'application',
            Subnets: [{ Ref: 'PublicSubnet1' }, { Ref: 'PublicSubnet2' }],
            SecurityGroups: [{ Ref: albSgId }],
            Tags: [
              { Key: 'Name', Value: `${slug}-${env}-alb` },
              { Key: 'Environment', Value: env },
            ],
          },
        } as any)

        // Target Group
        const tgId = `${slug}${env}TargetGroup`.replace(/[^a-zA-Z0-9]/g, '')
        const healthCheckPath = lbConfig?.healthCheck?.path || (containerConfig as any).healthCheck || '/health'
        this.builder.addResource(tgId, {
          Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
          Properties: {
            Name: `${slug}-${env}-tg`,
            Port: port,
            Protocol: 'HTTP',
            VpcId: { Ref: 'VPC' },
            TargetType: 'ip',
            HealthCheckPath: healthCheckPath,
            HealthCheckIntervalSeconds: lbConfig?.healthCheck?.interval || 30,
            HealthyThresholdCount: lbConfig?.healthCheck?.healthyThreshold || 2,
            UnhealthyThresholdCount: lbConfig?.healthCheck?.unhealthyThreshold || 5,
            HealthCheckTimeoutSeconds: 10,
            Tags: [
              { Key: 'Name', Value: `${slug}-${env}-tg` },
              { Key: 'Environment', Value: env },
            ],
          },
        } as any)

        // HTTP Listener (redirect to HTTPS if SSL, otherwise forward)
        const httpListenerId = `${slug}${env}HTTPListener`.replace(/[^a-zA-Z0-9]/g, '')
        if (sslConfig?.enabled && sslConfig?.redirectHttp) {
          this.builder.addResource(httpListenerId, {
            Type: 'AWS::ElasticLoadBalancingV2::Listener',
            Properties: {
              LoadBalancerArn: { Ref: albId },
              Port: 80,
              Protocol: 'HTTP',
              DefaultActions: [{
                Type: 'redirect',
                RedirectConfig: {
                  Protocol: 'HTTPS',
                  Port: '443',
                  StatusCode: 'HTTP_301',
                },
              }],
            },
          } as any)
        }
        else {
          this.builder.addResource(httpListenerId, {
            Type: 'AWS::ElasticLoadBalancingV2::Listener',
            Properties: {
              LoadBalancerArn: { Ref: albId },
              Port: 80,
              Protocol: 'HTTP',
              DefaultActions: [{
                Type: 'forward',
                TargetGroupArn: { Ref: tgId },
              }],
            },
          } as any)
        }

        // HTTPS Listener (if SSL is configured)
        if (sslConfig?.enabled) {
          const certArn = sslConfig.certificateArn
            || (certificateLogicalId ? { Ref: certificateLogicalId } : undefined)

          if (certArn) {
            const httpsListenerId = `${slug}${env}HTTPSListener`.replace(/[^a-zA-Z0-9]/g, '')
            this.builder.addResource(httpsListenerId, {
              Type: 'AWS::ElasticLoadBalancingV2::Listener',
              Properties: {
                LoadBalancerArn: { Ref: albId },
                Port: 443,
                Protocol: 'HTTPS',
                Certificates: [{ CertificateArn: certArn }],
                DefaultActions: [{
                  Type: 'forward',
                  TargetGroupArn: { Ref: tgId },
                }],
                SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
              },
            } as any)
          }
        }

        // ========================================
        // ECS Service (with load balancer)
        // ========================================
        const serviceId = `${slug}${env}${name}Service`.replace(/[^a-zA-Z0-9]/g, '')
        const desiredCount = (containerConfig as any).desiredCount || 1

        this.builder.addResource(serviceId, {
          Type: 'AWS::ECS::Service',
          Properties: {
            ServiceName: `${slug}-${env}-${name}`,
            Cluster: { Ref: clusterLogicalId },
            TaskDefinition: { Ref: taskDefId },
            DesiredCount: desiredCount,
            LaunchType: 'FARGATE',
            NetworkConfiguration: {
              AwsvpcConfiguration: {
                AssignPublicIp: 'ENABLED',
                SecurityGroups: [{ Ref: ecsSgId }],
                Subnets: [{ Ref: 'PublicSubnet1' }, { Ref: 'PublicSubnet2' }],
              },
            },
            LoadBalancers: [{
              ContainerName: name,
              ContainerPort: port,
              TargetGroupArn: { Ref: tgId },
            }],
            HealthCheckGracePeriodSeconds: 120,
            Tags: [
              { Key: 'Name', Value: `${slug}-${env}-${name}` },
              { Key: 'Environment', Value: env },
            ],
          },
          DependsOn: [taskDefId, httpListenerId, tgId],
        } as any)

        // ========================================
        // Auto Scaling
        // ========================================
        const autoScaling = (containerConfig as any).autoScaling
        if (autoScaling) {
          const scalableTargetId = `${slug}${env}${name}ScalableTarget`.replace(/[^a-zA-Z0-9]/g, '')
          this.builder.addResource(scalableTargetId, {
            Type: 'AWS::ApplicationAutoScaling::ScalableTarget',
            Properties: {
              MaxCapacity: autoScaling.max || 10,
              MinCapacity: autoScaling.min || 1,
              ResourceId: { 'Fn::Sub': `service/\${${clusterLogicalId}}/${slug}-${env}-${name}` },
              ScalableDimension: 'ecs:service:DesiredCount',
              ServiceNamespace: 'ecs',
              RoleARN: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:role/aws-service-role/ecs.application-autoscaling.amazonaws.com/AWSServiceRoleForApplicationAutoScaling_ECSService' },
            },
            DependsOn: serviceId,
          } as any)

          if (autoScaling.targetCpuUtilization) {
            this.builder.addResource(`${slug}${env}${name}CPUScaling`.replace(/[^a-zA-Z0-9]/g, ''), {
              Type: 'AWS::ApplicationAutoScaling::ScalingPolicy',
              Properties: {
                PolicyName: `${slug}-${env}-${name}-cpu-scaling`,
                PolicyType: 'TargetTrackingScaling',
                ScalingTargetId: { Ref: scalableTargetId },
                TargetTrackingScalingPolicyConfiguration: {
                  PredefinedMetricSpecification: {
                    PredefinedMetricType: 'ECSServiceAverageCPUUtilization',
                  },
                  TargetValue: autoScaling.targetCpuUtilization,
                  ScaleInCooldown: 300,
                  ScaleOutCooldown: 60,
                },
              },
            } as any)
          }

          if (autoScaling.targetMemoryUtilization) {
            this.builder.addResource(`${slug}${env}${name}MemoryScaling`.replace(/[^a-zA-Z0-9]/g, ''), {
              Type: 'AWS::ApplicationAutoScaling::ScalingPolicy',
              Properties: {
                PolicyName: `${slug}-${env}-${name}-memory-scaling`,
                PolicyType: 'TargetTrackingScaling',
                ScalingTargetId: { Ref: scalableTargetId },
                TargetTrackingScalingPolicyConfiguration: {
                  PredefinedMetricSpecification: {
                    PredefinedMetricType: 'ECSServiceAverageMemoryUtilization',
                  },
                  TargetValue: autoScaling.targetMemoryUtilization,
                  ScaleInCooldown: 300,
                  ScaleOutCooldown: 60,
                },
              },
            } as any)
          }
        }

        // ========================================
        // Route53 DNS Record for API
        // ========================================
        if (dnsConfig?.domain && dnsConfig?.hostedZoneId) {
          this.builder.addResource(`${slug}${env}ApiDnsRecord`.replace(/[^a-zA-Z0-9]/g, ''), {
            Type: 'AWS::Route53::RecordSet',
            Properties: {
              HostedZoneId: dnsConfig.hostedZoneId,
              Name: `api.${dnsConfig.domain}`,
              Type: 'A',
              AliasTarget: {
                DNSName: { 'Fn::GetAtt': [albId, 'DNSName'] },
                HostedZoneId: { 'Fn::GetAtt': [albId, 'CanonicalHostedZoneID'] },
              },
            },
          } as any)
        }

        // ========================================
        // Outputs
        // ========================================
        this.builder.addOutput('ECSClusterArn', {
          Description: 'ECS Cluster ARN',
          Value: { 'Fn::GetAtt': [clusterLogicalId, 'Arn'] },
          Export: { Name: { 'Fn::Sub': '${AWS::StackName}-ecs-cluster-arn' } as any },
        })

        this.builder.addOutput('ECSServiceName', {
          Description: 'ECS Service Name',
          Value: `${slug}-${env}-${name}`,
          Export: { Name: { 'Fn::Sub': '${AWS::StackName}-ecs-service-name' } as any },
        })

        this.builder.addOutput('LoadBalancerDNS', {
          Description: 'Application Load Balancer DNS Name',
          Value: { 'Fn::GetAtt': [albId, 'DNSName'] },
          Export: { Name: { 'Fn::Sub': '${AWS::StackName}-alb-dns' } as any },
        })
      }
      else {
        // No load balancer - create service without ALB attachment
        const serviceId = `${slug}${env}${name}Service`.replace(/[^a-zA-Z0-9]/g, '')
        this.builder.addResource(serviceId, {
          Type: 'AWS::ECS::Service',
          Properties: {
            ServiceName: `${slug}-${env}-${name}`,
            Cluster: { Ref: clusterLogicalId },
            TaskDefinition: { Ref: taskDefId },
            DesiredCount: (containerConfig as any).desiredCount || 1,
            LaunchType: 'FARGATE',
            NetworkConfiguration: {
              AwsvpcConfiguration: {
                AssignPublicIp: 'ENABLED',
                SecurityGroups: [{ Ref: ecsSgId }],
                Subnets: [{ Ref: 'PublicSubnet1' }, { Ref: 'PublicSubnet2' }],
              },
            },
            Tags: [
              { Key: 'Name', Value: `${slug}-${env}-${name}` },
              { Key: 'Environment', Value: env },
            ],
          },
          DependsOn: [taskDefId],
        } as any)
      }

      // Only process the first container for now (primary API container)
      break
    }

    // S3 Bucket Outputs are generated in generateSharedInfrastructure()
  }

  /**
   * Generate serverless infrastructure (Lambda, ECS Fargate)
   */
  private generateServerless(slug: string, env: typeof this.environment): void {
    // Example: Lambda function
    if (this.mergedConfig.infrastructure?.functions) {
      for (const [name, fnConfig] of Object.entries(this.mergedConfig.infrastructure.functions)) {
        // Check if this function should be deployed
        if (!this.shouldDeploy(fnConfig)) {
          continue
        }
        // Create Lambda execution role
        const { role, logicalId: roleLogicalId } = Permissions.createRole({
          slug,
          environment: env,
          roleName: `${slug}-${env}-${name}-role`,
          servicePrincipal: 'lambda.amazonaws.com',
          managedPolicyArns: [
            'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
        })

        this.builder.addResource(roleLogicalId, role)

        const { lambdaFunction, logicalId } = Compute.createLambdaFunction({
          slug,
          environment: env,
          functionName: `${slug}-${env}-${name}`,
          handler: fnConfig.handler || 'index.handler',
          runtime: fnConfig.runtime || 'nodejs20.x',
          code: {
            zipFile: fnConfig.code || 'export const handler = async () => ({ statusCode: 200 });',
          },
          role: roleLogicalId,
          timeout: fnConfig.timeout,
          memorySize: fnConfig.memorySize,
        })

        this.builder.addResource(logicalId, lambdaFunction)
      }
    }

    // Example: API Gateway
    if (this.mergedConfig.infrastructure?.api) {
      const { restApi, logicalId } = ApiGateway.createRestApi({
        slug,
        environment: env,
        apiName: `${slug}-${env}-api`,
      })

      this.builder.addResource(logicalId, restApi)
    }
  }

  /**
   * Generate server infrastructure (EC2)
   * Creates a full stack per server: EC2 instance + security group + IAM role + instance profile + EIP
   */
  private generateServer(slug: string, env: typeof this.environment): void {
    if (!this.mergedConfig.infrastructure?.servers) return

    const servers = this.mergedConfig.infrastructure.servers
    const computeConfig = this.mergedConfig.infrastructure?.compute
    const sslConfig = this.mergedConfig.infrastructure?.ssl as { enabled?: boolean, letsEncrypt?: { email?: string } } | undefined

    // Check if any server needs a new VPC
    const needsVpc = Object.values(servers).some(s =>
      !s.privateNetwork || s.privateNetwork === 'create',
    )

    if (needsVpc) {
      this.generateNetworkInfrastructure(slug, env)
    }

    // Generate each server
    for (const [name, serverConfig] of Object.entries(servers)) {
      // Resolve instance type: explicit instanceType > size lookup > compute default > fallback
      const sizeKey = serverConfig.instanceType || serverConfig.size || computeConfig?.size
      const sizeSpec = sizeKey ? (Compute.InstanceSize.specs as Record<string, { instanceType: string }>)[sizeKey as string] : undefined
      const resolvedInstanceType = sizeSpec?.instanceType || (sizeKey as string) || 't3.micro'

      // Determine UserData
      const serverType = serverConfig.type || 'app'
      let userData = serverConfig.userData || serverConfig.startupScript

      if (!userData) {
        // Auto-generate UserData based on server type
        userData = Compute.UserData.generateAppServerScript({
          runtime: 'bun',
          runtimeVersion: serverConfig.bunVersion || 'latest',
          webServer: 'none',
          domain: serverConfig.domain,
          enableSsl: !!sslConfig?.enabled,
          sslEmail: sslConfig?.letsEncrypt?.email,
          installRedis: serverType === 'cache',
          installDatabaseClients: !!serverConfig.database,
        })
      }

      // Resolve VPC and subnet IDs
      const vpcId = serverConfig.privateNetwork && serverConfig.privateNetwork !== 'create'
        ? serverConfig.privateNetwork
        : { Ref: 'VPC' } as unknown as string

      const subnetId = serverConfig.subnet
        || { Ref: 'PublicSubnet1' } as unknown as string

      // Determine allowed ports — add SMTP/IMAP ports when email server is enabled
      const emailConfig = this.mergedConfig.infrastructure?.email
      const emailServerEnabled = !!(emailConfig?.server?.enabled)
      const ports = [22, 80, 443]
      if (emailServerEnabled) {
        ports.push(25, 465, 587, 143, 993)
      }

      // Create full server stack (SG + IAM role + instance profile + EC2 + EIP)
      const stack = Compute.createServerModeStack({
        slug: `${slug}-${name}`,
        environment: env,
        vpcId,
        subnetId,
        instanceType: resolvedInstanceType,
        keyName: serverConfig.keyName || `${slug}-${env}`,
        domain: serverConfig.domain,
        userData,
        volumeSize: serverConfig.diskSize || 20,
        imageId: serverConfig.image,
        allowedPorts: ports,
      })

      // Add all resources from the stack to the template
      for (const [logicalId, resource] of Object.entries(stack.resources)) {
        this.builder.addResource(logicalId, resource)
      }

      // Track EIP and instance IDs for CloudFront API routing
      this.serverEipLogicalIds.set(name, stack.outputs.eipLogicalId)
      this.serverEipLogicalIds.set(`${name}Instance`, stack.outputs.instanceLogicalId)

      // Add outputs for this server
      this.builder.addOutput(`${name}InstanceId`, {
        Value: { Ref: stack.outputs.instanceLogicalId },
        Description: `Instance ID for ${name} server`,
      })
      this.builder.addOutput(`${name}PublicIp`, {
        Value: { Ref: stack.outputs.eipLogicalId },
        Description: `Public IP for ${name} server`,
      })
    }
  }

  /**
   * Generate jump box / bastion host infrastructure
   */
  private generateJumpBox(slug: string, env: typeof this.environment): void {
    const raw = this.mergedConfig.infrastructure?.jumpBox
    if (!raw) return

    // Normalize: `true` becomes default config
    const jumpBoxConfig = raw === true ? {} : raw
    if (jumpBoxConfig.enabled === false) return

    // Ensure VPC exists (jumpbox needs to be in a VPC)
    // generateNetworkInfrastructure is idempotent — it checks for existing VPC resource
    this.generateNetworkInfrastructure(slug, env)

    // Resolve instance type from size
    const sizeKey = jumpBoxConfig.size || 'micro'
    const sizeSpec = (Compute.InstanceSize.specs as Record<string, { instanceType: string }>)[sizeKey as string]
    const instanceType = sizeSpec?.instanceType || (sizeKey as string) || 't3.micro'

    // Resolve EFS mount
    let mountEfs: { fileSystemId: string, mountPath?: string } | undefined
    if (jumpBoxConfig.mountEfs) {
      const efsId = typeof jumpBoxConfig.mountEfs === 'string'
        ? jumpBoxConfig.mountEfs
        : { Ref: 'FileSystem' } as unknown as string // auto-detect from template
      mountEfs = {
        fileSystemId: efsId,
        mountPath: jumpBoxConfig.mountPath || '/mnt/efs',
      }
    }

    // Use the appropriate JumpBox preset
    let result
    if (jumpBoxConfig.databaseTools) {
      result = Compute.JumpBox.withDatabaseTools({
        slug,
        environment: env,
        vpcId: { Ref: 'VPC' } as unknown as string,
        subnetId: { Ref: 'PublicSubnet1' } as unknown as string,
        keyName: jumpBoxConfig.keyName || `${slug}-${env}`,
        allowedCidrs: jumpBoxConfig.allowedCidrs,
      })
    } else if (mountEfs) {
      result = Compute.JumpBox.withEfsMount({
        slug,
        environment: env,
        vpcId: { Ref: 'VPC' } as unknown as string,
        subnetId: { Ref: 'PublicSubnet1' } as unknown as string,
        keyName: jumpBoxConfig.keyName || `${slug}-${env}`,
        fileSystemId: mountEfs.fileSystemId,
        mountPath: mountEfs.mountPath,
        allowedCidrs: jumpBoxConfig.allowedCidrs,
      })
    } else {
      result = Compute.createJumpBox({
        slug,
        environment: env,
        vpcId: { Ref: 'VPC' } as unknown as string,
        subnetId: { Ref: 'PublicSubnet1' } as unknown as string,
        keyName: jumpBoxConfig.keyName || `${slug}-${env}`,
        instanceType,
        allowedCidrs: jumpBoxConfig.allowedCidrs,
        mountEfs,
      })
    }

    // Add all resources
    for (const [logicalId, resource] of Object.entries(result.resources)) {
      this.builder.addResource(logicalId, resource)
    }

    // Add outputs
    this.builder.addOutput('JumpBoxInstanceId', {
      Value: { Ref: result.instanceLogicalId },
      Description: 'The ID of the JumpBox EC2 instance (use with SSM Session Manager or SSH)',
    })
  }

  /**
   * Generate shared infrastructure (storage, database, etc.)
   */
  private generateSharedInfrastructure(slug: string, env: typeof this.environment): void {
    const sslConfig = this.mergedConfig.infrastructure?.ssl
    const dnsConfig = this.mergedConfig.infrastructure?.dns
    const domain = dnsConfig?.domain
    const hostedZoneId = dnsConfig?.hostedZoneId

    // Track CloudFront distribution logical IDs for website buckets
    // so we can create DNS records after all distributions are created
    const websiteBucketDistributions: Array<{
      name: string
      bucketLogicalId: string
      distLogicalId: string
      oacLogicalId: string
      aliases: string[]
    }> = []

    // ========================================
    // ACM Certificate for CloudFront
    // ========================================
    // CloudFront requires certs in us-east-1. Create one covering all website domains.
    let cfCertificateLogicalId: string | undefined
    let cfCertificateArn: string | undefined

    if (sslConfig?.certificateArn) {
      // Use existing certificate ARN
      cfCertificateArn = sslConfig.certificateArn
    }
    else if (sslConfig?.enabled && domain && hostedZoneId) {
      // Auto-create certificate covering the domain + www + docs subdomains
      const sslDomains = sslConfig.domains || [domain]
      const primaryDomain = sslDomains[0]
      const subdomains = sslDomains.slice(1).map((d: string) => {
        if (d.includes('.') && d.endsWith(primaryDomain)) {
          return d.replace(`.${primaryDomain}`, '')
        }
        return d
      })

      // Add docs subdomain if docs storage is configured
      if (this.mergedConfig.infrastructure?.storage?.docs && !subdomains.includes('docs')) {
        subdomains.push('docs')
      }

      const { certificate, logicalId: certLogicalId } = Security.createCertificate({
        domain: primaryDomain,
        subdomains,
        slug,
        environment: env,
        validationMethod: 'DNS',
        hostedZoneId,
      })

      cfCertificateLogicalId = certLogicalId
      this.builder.addResource(certLogicalId, certificate)
    }

    // ========================================
    // Storage buckets
    // ========================================
    if (this.mergedConfig.infrastructure?.storage) {
      // Determine if any website bucket exists (needs shared OAC)
      const hasWebsiteBuckets = Object.entries(this.mergedConfig.infrastructure.storage).some(
        ([, cfg]) => cfg.website,
      )

      // Create a shared Origin Access Control for all website buckets
      let sharedOacLogicalId: string | undefined
      if (hasWebsiteBuckets && (cfCertificateLogicalId || cfCertificateArn)) {
        sharedOacLogicalId = `${slug}${env}CloudFrontOAC`.replace(/[^a-zA-Z0-9]/g, '')
        this.builder.addResource(sharedOacLogicalId, {
          Type: 'AWS::CloudFront::OriginAccessControl',
          Properties: {
            OriginAccessControlConfig: {
              Name: `${slug}-${env}-s3-oac`,
              Description: `OAC for ${slug} ${env} S3 website buckets`,
              OriginAccessControlOriginType: 's3',
              SigningBehavior: 'always',
              SigningProtocol: 'sigv4',
            },
          },
        } as any)
      }

      for (const [name, storageConfig] of Object.entries(this.mergedConfig.infrastructure.storage)) {
        // For website buckets served via CloudFront, don't make them public directly
        // CloudFront OAC will handle access
        const serveViaCloudFront = !!(storageConfig.website && sharedOacLogicalId)
        const { bucket, logicalId } = Storage.createBucket({
          slug,
          name,
          environment: env,
          bucketName: `${slug}-${env}-${name}`,
          versioning: storageConfig.versioning,
          encryption: storageConfig.encryption,
          // Don't set public if serving via CloudFront - OAC handles access
          public: serveViaCloudFront ? false : storageConfig.public,
        })

        // For CloudFront-served buckets, allow bucket policies (needed for OAC)
        // but block direct public access via ACLs
        if (serveViaCloudFront && bucket.Properties) {
          bucket.Properties.PublicAccessBlockConfiguration = {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: false, // Allow CloudFront bucket policy
            RestrictPublicBuckets: false, // Allow CloudFront access via policy
          }
        }

        this.builder.addResource(logicalId, bucket)

        // Enable website hosting if configured
        if (storageConfig.website) {
          const websiteConfig = typeof storageConfig.website === 'object' ? storageConfig.website : {}
          const enhanced = Storage.enableWebsiteHosting(
            bucket,
            websiteConfig.indexDocument || 'index.html',
            websiteConfig.errorDocument,
          )
          this.builder.addResource(logicalId, enhanced)
        }

        // ========================================
        // CloudFront distribution for website buckets
        // ========================================
        if (serveViaCloudFront && sharedOacLogicalId && domain) {
          const distLogicalId = `${slug}${env}${name}CDN`.replace(/[^a-zA-Z0-9]/g, '')

          // Determine aliases for this bucket
          const aliases: string[] = []
          if (name === 'public') {
            // Main site: domain + www
            aliases.push(domain)
            if (sslConfig?.domains?.includes(`www.${domain}`)) {
              aliases.push(`www.${domain}`)
            }
          }
          else if (name === 'docs') {
            aliases.push(`docs.${domain}`)
          }
          else if (name === 'blog') {
            aliases.push(`blog.${domain}`)
          }
          // Other website buckets don't get automatic aliases

          // Determine error page behavior
          const websiteConfig = typeof storageConfig.website === 'object' ? storageConfig.website : {}
          const isSpa = name === 'public' // SPA routing: 403/404 → index.html
          const errorDocument = websiteConfig.errorDocument || (isSpa ? 'index.html' : '404.html')

          const customErrorResponses: any[] = []
          if (isSpa) {
            // SPA: route all 403/404 to index.html for client-side routing
            customErrorResponses.push(
              { ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html', ErrorCachingMinTTL: 300 },
              { ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html', ErrorCachingMinTTL: 300 },
            )
          }
          else {
            // Docs: show proper error page
            customErrorResponses.push(
              { ErrorCode: 403, ResponseCode: 404, ResponsePagePath: `/${errorDocument}`, ErrorCachingMinTTL: 300 },
              { ErrorCode: 404, ResponseCode: 404, ResponsePagePath: `/${errorDocument}`, ErrorCachingMinTTL: 300 },
            )
          }

          // Build viewer certificate
          const viewerCertificate: any = cfCertificateArn && aliases.length > 0
            ? {
                AcmCertificateArn: cfCertificateArn,
                SslSupportMethod: 'sni-only',
                MinimumProtocolVersion: 'TLSv1.2_2021',
              }
            : cfCertificateLogicalId && aliases.length > 0
              ? {
                  AcmCertificateArn: { Ref: cfCertificateLogicalId },
                  SslSupportMethod: 'sni-only',
                  MinimumProtocolVersion: 'TLSv1.2_2021',
                }
              : { CloudFrontDefaultCertificate: true }

          const originId = `S3-${slug}-${env}-${name}`
          const region = this.mergedConfig.project.region || 'us-east-1'

          // For non-SPA static sites (docs, blog), create a CloudFront Function
          // to rewrite directory URLs to index.html (e.g., /posts/slug/ → /posts/slug/index.html)
          let cfFunctionLogicalId: string | undefined
          if (!isSpa) {
            cfFunctionLogicalId = `${slug}${env}${name}UrlRewrite`.replace(/[^a-zA-Z0-9]/g, '')
            this.builder.addResource(cfFunctionLogicalId, {
              Type: 'AWS::CloudFront::Function',
              Properties: {
                Name: `${slug}-${env}-${name}-url-rewrite`,
                AutoPublish: true,
                FunctionConfig: {
                  Comment: `URL rewrite for ${slug} ${env} ${name} - appends index.html to directory paths`,
                  Runtime: 'cloudfront-js-2.0',
                },
                FunctionCode: `function handler(event) { var request = event.request; var uri = request.uri; if (uri.endsWith('/')) { request.uri += 'index.html'; } else if (!uri.includes('.')) { request.uri += '/index.html'; } return request; }`,
              },
            } as any)
          }

          // For the public distribution, add EC2 origin for /api/* routing if servers exist
          const origins: any[] = [{
            Id: originId,
            // Use S3 REST endpoint (not website endpoint) for OAC
            DomainName: { 'Fn::Sub': `\${${logicalId}}.s3.${region}.amazonaws.com` },
            OriginPath: '',
            S3OriginConfig: {
              OriginAccessIdentity: '', // Required but empty when using OAC
            },
            OriginAccessControlId: { Ref: sharedOacLogicalId },
          }]

          const cacheBehaviors: any[] = []
          const extraDependsOn: string[] = []

          // Add EC2 API origin for the public (main site) distribution
          if (name === 'public') {
            // Find the first app server's EIP for API routing
            const appEipId = this.serverEipLogicalIds.get('app')
            const appInstanceId = this.serverEipLogicalIds.get('appInstance')
            if (appEipId) {
              const apiOriginId = `EC2-${slug}-${env}-api`

              // CloudFront requires a DNS hostname, not an IP address.
              // Construct the EC2 public DNS name from the EIP:
              //   us-east-1: ec2-{ip-with-dashes}.compute-1.amazonaws.com
              //   other regions: ec2-{ip-with-dashes}.{region}.compute.amazonaws.com
              const serverRegion = this.mergedConfig.infrastructure?.servers?.app?.region
                || this.mergedConfig.project?.region
                || 'us-east-1'
              const dnsSuffix = serverRegion === 'us-east-1'
                ? '.compute-1.amazonaws.com'
                : `.${serverRegion}.compute.amazonaws.com`

              const originDomainName = {
                'Fn::Join': ['', [
                  'ec2-',
                  { 'Fn::Join': ['-', { 'Fn::Split': ['.', { Ref: appEipId }] }] },
                  dnsSuffix,
                ]],
              }

              origins.push({
                Id: apiOriginId,
                DomainName: originDomainName,
                CustomOriginConfig: {
                  HTTPPort: 80,
                  HTTPSPort: 443,
                  OriginProtocolPolicy: 'http-only', // Bun on EC2 handles HTTP from CloudFront
                  OriginSSLProtocols: ['TLSv1.2'],
                },
              })
              extraDependsOn.push(appEipId)
              if (appInstanceId) extraDependsOn.push(appInstanceId)

              // Add /api/* cache behavior routing to EC2
              cacheBehaviors.push({
                PathPattern: '/api/*',
                TargetOriginId: apiOriginId,
                ViewerProtocolPolicy: 'redirect-to-https',
                AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
                CachedMethods: ['GET', 'HEAD'],
                Compress: true,
                // Use CachingDisabled policy for API (no caching)
                CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
                // Use AllViewerExceptHostHeader origin request policy to forward query strings, cookies, etc.
                OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
              })
            }
          }

          const distribution: any = {
            Type: 'AWS::CloudFront::Distribution',
            DependsOn: [logicalId, sharedOacLogicalId, ...(cfFunctionLogicalId ? [cfFunctionLogicalId] : []), ...extraDependsOn],
            Properties: {
              DistributionConfig: {
                Enabled: true,
                Comment: `${slug} ${env} ${name} site`,
                DefaultRootObject: 'index.html',
                Origins: origins,
                DefaultCacheBehavior: {
                  TargetOriginId: originId,
                  ViewerProtocolPolicy: 'redirect-to-https',
                  AllowedMethods: ['GET', 'HEAD', 'OPTIONS'],
                  CachedMethods: ['GET', 'HEAD', 'OPTIONS'],
                  Compress: true,
                  // Use CachingOptimized managed policy
                  CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
                  // Add URL rewrite function for non-SPA sites
                  ...(cfFunctionLogicalId ? {
                    FunctionAssociations: [{
                      EventType: 'viewer-request',
                      FunctionARN: { 'Fn::GetAtt': [cfFunctionLogicalId, 'FunctionARN'] },
                    }],
                  } : {}),
                },
                ...(cacheBehaviors.length > 0 ? { CacheBehaviors: cacheBehaviors } : {}),
                ...(aliases.length > 0 ? { Aliases: aliases } : {}),
                ViewerCertificate: viewerCertificate,
                PriceClass: 'PriceClass_100',
                HttpVersion: 'http2and3',
                IPV6Enabled: true,
                CustomErrorResponses: customErrorResponses,
              },
            },
          }

          // If using stack-created certificate, add dependency
          if (cfCertificateLogicalId) {
            distribution.DependsOn.push(cfCertificateLogicalId)
          }

          this.builder.addResource(distLogicalId, distribution)

          // S3 Bucket Policy - allow CloudFront OAC to read objects
          const policyLogicalId = `${logicalId}CloudFrontPolicy`
          this.builder.addResource(policyLogicalId, {
            Type: 'AWS::S3::BucketPolicy',
            DependsOn: [logicalId, distLogicalId],
            Properties: {
              Bucket: { Ref: logicalId },
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [{
                  Sid: 'AllowCloudFrontServicePrincipal',
                  Effect: 'Allow',
                  Principal: {
                    Service: 'cloudfront.amazonaws.com',
                  },
                  Action: 's3:GetObject',
                  Resource: { 'Fn::Sub': `arn:aws:s3:::\${${logicalId}}/*` },
                  Condition: {
                    StringEquals: {
                      'AWS:SourceArn': { 'Fn::Sub': `arn:aws:cloudfront::\${AWS::AccountId}:distribution/\${${distLogicalId}}` },
                    },
                  },
                }],
              },
            },
          } as any)

          // Track for DNS record creation
          if (aliases.length > 0) {
            websiteBucketDistributions.push({
              name,
              bucketLogicalId: logicalId,
              distLogicalId,
              oacLogicalId: sharedOacLogicalId,
              aliases,
            })
          }

          // CloudFront distribution outputs
          this.builder.addOutput(`${name}CloudFrontDomain`, {
            Value: { 'Fn::GetAtt': [distLogicalId, 'DomainName'] },
            Description: `CloudFront domain for ${name}`,
          })

          this.builder.addOutput(`${name}CloudFrontDistributionId`, {
            Value: { Ref: distLogicalId },
            Description: `CloudFront distribution ID for ${name}`,
          })
        }

        // Add bucket name output
        this.builder.addOutput(`${name}BucketName`, {
          Value: { Ref: logicalId },
          Description: `S3 bucket name for ${name}`,
        })

        // Map well-known bucket names for deploy action
        if (name === 'public') {
          this.builder.addOutput('FrontendBucketName', {
            Value: { Ref: logicalId },
            Description: 'Frontend S3 bucket name',
          })
        }
        if (name === 'docs') {
          this.builder.addOutput('DocsBucketName', {
            Value: { Ref: logicalId },
            Description: 'Documentation S3 bucket name',
          })
        }
        if (name === 'blog') {
          this.builder.addOutput('BlogBucketName', {
            Value: { Ref: logicalId },
            Description: 'Blog S3 bucket name',
          })
        }
      }
    }

    // ========================================
    // Route53 DNS records for CloudFront distributions
    // ========================================
    if (hostedZoneId && websiteBucketDistributions.length > 0) {
      for (const { name, distLogicalId, aliases } of websiteBucketDistributions) {
        for (const alias of aliases) {
          const safeName = alias.replace(/\./g, '').replace(/[^a-zA-Z0-9]/g, '')

          // A record (IPv4) alias → CloudFront
          this.builder.addResource(`${safeName}ARecord`, {
            Type: 'AWS::Route53::RecordSet',
            DependsOn: [distLogicalId],
            Properties: {
              HostedZoneId: hostedZoneId,
              Name: alias,
              Type: 'A',
              AliasTarget: {
                DNSName: { 'Fn::GetAtt': [distLogicalId, 'DomainName'] },
                HostedZoneId: 'Z2FDTNDATAQYW2', // CloudFront global hosted zone ID
                EvaluateTargetHealth: false,
              },
            },
          } as any)

          // AAAA record (IPv6) alias → CloudFront
          this.builder.addResource(`${safeName}AAAARecord`, {
            Type: 'AWS::Route53::RecordSet',
            DependsOn: [distLogicalId],
            Properties: {
              HostedZoneId: hostedZoneId,
              Name: alias,
              Type: 'AAAA',
              AliasTarget: {
                DNSName: { 'Fn::GetAtt': [distLogicalId, 'DomainName'] },
                HostedZoneId: 'Z2FDTNDATAQYW2', // CloudFront global hosted zone ID
                EvaluateTargetHealth: false,
              },
            },
          } as any)
        }
      }
    }

    // API routes are handled by the Bun server on EC2, routed via CloudFront /api/* behavior

    // Databases
    if (this.mergedConfig.infrastructure?.databases) {
      for (const [name, dbConfig] of Object.entries(this.mergedConfig.infrastructure.databases)) {
        if (dbConfig.engine === 'dynamodb') {
          const { table, logicalId } = Database.createTable({
            slug,
            environment: env,
            tableName: `${slug}-${env}-${name}`,
            partitionKey: (dbConfig.partitionKey || { name: 'id', type: 'S' }) as { name: string; type: 'S' | 'N' | 'B' },
            sortKey: dbConfig.sortKey as any,
          })

          this.builder.addResource(logicalId, table)
        }
        else if (dbConfig.engine === 'postgres') {
          const { dbInstance, logicalId } = Database.createPostgres({
            slug,
            environment: env,
            dbInstanceIdentifier: `${slug}-${env}-${name}`,
            masterUsername: dbConfig.username || 'admin',
            masterUserPassword: dbConfig.password || 'changeme123',
            allocatedStorage: dbConfig.storage || 20,
            dbInstanceClass: dbConfig.instanceClass || 'db.t3.micro',
          })

          this.builder.addResource(logicalId, dbInstance)
        }
        else if (dbConfig.engine === 'mysql') {
          const { dbInstance, logicalId } = Database.createMysql({
            slug,
            environment: env,
            dbInstanceIdentifier: `${slug}-${env}-${name}`,
            masterUsername: dbConfig.username || 'admin',
            masterUserPassword: dbConfig.password || 'changeme123',
            allocatedStorage: dbConfig.storage || 20,
            dbInstanceClass: dbConfig.instanceClass || 'db.t3.micro',
          })

          this.builder.addResource(logicalId, dbInstance)
        }
      }
    }

    // CDN
    if (this.mergedConfig.infrastructure?.cdn) {
      for (const [name, cdnConfig] of Object.entries(this.mergedConfig.infrastructure.cdn)) {
        const { distribution, logicalId } = CDN.createDistribution({
          slug,
          environment: env,
          origin: {
            domainName: cdnConfig.origin,
            originId: `${slug}-origin`,
          },
        })

        this.builder.addResource(logicalId, distribution)
      }
    }

    // Queues (SQS)
    if (this.mergedConfig.infrastructure?.queues) {
      for (const [name, queueConfig] of Object.entries(this.mergedConfig.infrastructure.queues)) {
        // Check if this queue should be deployed
        if (!this.shouldDeploy(queueConfig)) {
          continue
        }

        // Create the main queue
        const { queue, logicalId } = Queue.createQueue({
          slug,
          environment: env,
          name: `${slug}-${env}-${name}`,
          fifo: queueConfig.fifo,
          visibilityTimeout: queueConfig.visibilityTimeout,
          messageRetentionPeriod: queueConfig.messageRetentionPeriod,
          delaySeconds: queueConfig.delaySeconds,
          maxMessageSize: queueConfig.maxMessageSize,
          receiveMessageWaitTime: queueConfig.receiveMessageWaitTime,
          contentBasedDeduplication: queueConfig.contentBasedDeduplication,
          encrypted: queueConfig.encrypted,
          kmsKeyId: queueConfig.kmsKeyId,
        })

        this.builder.addResource(logicalId, queue)

        // Create dead letter queue if enabled
        let dlqLogicalId: string | undefined
        if (queueConfig.deadLetterQueue) {
          const {
            deadLetterQueue,
            updatedSourceQueue,
            deadLetterLogicalId,
          } = Queue.createDeadLetterQueue(logicalId, {
            slug,
            environment: env,
            maxReceiveCount: queueConfig.maxReceiveCount,
          })

          dlqLogicalId = deadLetterLogicalId
          this.builder.addResource(deadLetterLogicalId, deadLetterQueue)

          // Update the main queue with redrive policy
          const resources = this.builder.getResources()
          const existingQueue = resources[logicalId]
          if (existingQueue?.Properties) {
            existingQueue.Properties.RedrivePolicy = updatedSourceQueue.Properties?.RedrivePolicy
          }
        }

        // Lambda trigger (Event Source Mapping)
        if (queueConfig.trigger) {
          const triggerConfig = queueConfig.trigger
          const functionLogicalId = `${slug}${env}${triggerConfig.functionName}`.replace(/[^a-zA-Z0-9]/g, '')

          const eventSourceMapping = {
            Type: 'AWS::Lambda::EventSourceMapping',
            Properties: {
              EventSourceArn: { 'Fn::GetAtt': [logicalId, 'Arn'] },
              FunctionName: { Ref: functionLogicalId },
              BatchSize: triggerConfig.batchSize || 10,
              MaximumBatchingWindowInSeconds: triggerConfig.batchWindow || 0,
              Enabled: true,
              ...(triggerConfig.reportBatchItemFailures !== false && {
                FunctionResponseTypes: ['ReportBatchItemFailures'],
              }),
              ...(triggerConfig.maxConcurrency && {
                ScalingConfig: {
                  MaximumConcurrency: triggerConfig.maxConcurrency,
                },
              }),
              ...(triggerConfig.filterPattern && {
                FilterCriteria: {
                  Filters: [{ Pattern: JSON.stringify(triggerConfig.filterPattern) }],
                },
              }),
            },
            DependsOn: [logicalId, functionLogicalId],
          }

          this.builder.addResource(`${logicalId}Trigger`, eventSourceMapping as any)
        }

        // CloudWatch Alarms
        if (queueConfig.alarms?.enabled) {
          const alarmsConfig = queueConfig.alarms

          // Create SNS topic for notifications if emails are provided
          let alarmTopicArn = alarmsConfig.notificationTopicArn
          if (!alarmTopicArn && alarmsConfig.notificationEmails?.length) {
            const topicLogicalId = `${logicalId}AlarmTopic`
            this.builder.addResource(topicLogicalId, {
              Type: 'AWS::SNS::Topic',
              Properties: {
                TopicName: `${slug}-${env}-${name}-alarms`,
                DisplayName: `${name} Queue Alarms`,
              },
            } as any)

            // Add email subscriptions
            alarmsConfig.notificationEmails.forEach((email, idx) => {
              this.builder.addResource(`${topicLogicalId}Sub${idx}`, {
                Type: 'AWS::SNS::Subscription',
                Properties: {
                  TopicArn: { Ref: topicLogicalId },
                  Protocol: 'email',
                  Endpoint: email,
                },
              } as any)
            })

            alarmTopicArn = { Ref: topicLogicalId } as any
          }

          // Queue depth alarm
          const depthThreshold = alarmsConfig.queueDepthThreshold || 1000
          this.builder.addResource(`${logicalId}DepthAlarm`, {
            Type: 'AWS::CloudWatch::Alarm',
            Properties: {
              AlarmName: `${slug}-${env}-${name}-queue-depth`,
              AlarmDescription: `Queue ${name} depth exceeds ${depthThreshold} messages`,
              MetricName: 'ApproximateNumberOfMessagesVisible',
              Namespace: 'AWS/SQS',
              Statistic: 'Average',
              Period: 300,
              EvaluationPeriods: 2,
              Threshold: depthThreshold,
              ComparisonOperator: 'GreaterThanThreshold',
              Dimensions: [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [logicalId, 'QueueName'] } }],
              ...(alarmTopicArn && { AlarmActions: [alarmTopicArn], OKActions: [alarmTopicArn] }),
            },
          } as any)

          // Message age alarm
          const ageThreshold = alarmsConfig.messageAgeThreshold || 3600
          this.builder.addResource(`${logicalId}AgeAlarm`, {
            Type: 'AWS::CloudWatch::Alarm',
            Properties: {
              AlarmName: `${slug}-${env}-${name}-message-age`,
              AlarmDescription: `Queue ${name} oldest message exceeds ${ageThreshold} seconds`,
              MetricName: 'ApproximateAgeOfOldestMessage',
              Namespace: 'AWS/SQS',
              Statistic: 'Maximum',
              Period: 300,
              EvaluationPeriods: 2,
              Threshold: ageThreshold,
              ComparisonOperator: 'GreaterThanThreshold',
              Dimensions: [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [logicalId, 'QueueName'] } }],
              ...(alarmTopicArn && { AlarmActions: [alarmTopicArn], OKActions: [alarmTopicArn] }),
            },
          } as any)

          // DLQ alarm (if DLQ is enabled)
          if (dlqLogicalId && alarmsConfig.dlqAlarm !== false) {
            this.builder.addResource(`${dlqLogicalId}Alarm`, {
              Type: 'AWS::CloudWatch::Alarm',
              Properties: {
                AlarmName: `${slug}-${env}-${name}-dlq-messages`,
                AlarmDescription: `Dead letter queue for ${name} has messages`,
                MetricName: 'ApproximateNumberOfMessagesVisible',
                Namespace: 'AWS/SQS',
                Statistic: 'Sum',
                Period: 300,
                EvaluationPeriods: 1,
                Threshold: 0,
                ComparisonOperator: 'GreaterThanThreshold',
                Dimensions: [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [dlqLogicalId, 'QueueName'] } }],
                ...(alarmTopicArn && { AlarmActions: [alarmTopicArn] }),
              },
            } as any)
          }
        }

        // SNS Subscription
        if (queueConfig.subscribe) {
          const subConfig = queueConfig.subscribe

          // Determine topic ARN
          let topicArn = subConfig.topicArn
          if (!topicArn && subConfig.topicName) {
            // Reference existing topic in the stack
            topicArn = { Ref: subConfig.topicName } as any
          }

          if (topicArn) {
            // Queue policy to allow SNS to send messages
            this.builder.addResource(`${logicalId}SnsPolicy`, {
              Type: 'AWS::SQS::QueuePolicy',
              Properties: {
                Queues: [{ Ref: logicalId }],
                PolicyDocument: {
                  Version: '2012-10-17',
                  Statement: [{
                    Effect: 'Allow',
                    Principal: { Service: 'sns.amazonaws.com' },
                    Action: 'sqs:SendMessage',
                    Resource: { 'Fn::GetAtt': [logicalId, 'Arn'] },
                    Condition: {
                      ArnEquals: { 'aws:SourceArn': topicArn },
                    },
                  }],
                },
              },
            } as any)

            // SNS Subscription
            const subscriptionProps: Record<string, any> = {
              TopicArn: topicArn,
              Protocol: 'sqs',
              Endpoint: { 'Fn::GetAtt': [logicalId, 'Arn'] },
              RawMessageDelivery: subConfig.rawMessageDelivery || false,
            }

            if (subConfig.filterPolicy) {
              subscriptionProps.FilterPolicy = subConfig.filterPolicy
              subscriptionProps.FilterPolicyScope = subConfig.filterPolicyScope || 'MessageAttributes'
            }

            this.builder.addResource(`${logicalId}SnsSub`, {
              Type: 'AWS::SNS::Subscription',
              Properties: subscriptionProps,
              DependsOn: `${logicalId}SnsPolicy`,
            } as any)
          }
        }
      }
    }

    // Realtime (WebSocket)
    if (this.mergedConfig.infrastructure?.realtime?.enabled) {
      const realtimeMode = this.mergedConfig.infrastructure.realtime.mode || 'serverless'
      if (realtimeMode === 'server') {
        this.generateRealtimeServerResources(slug, env)
      }
      else {
        this.generateRealtimeResources(slug, env)
      }
    }

    // Redirects (domain + path)
    const redirectsConfig = this.mergedConfig.infrastructure?.redirects
    if (redirectsConfig) {
      const targetDomain = redirectsConfig.target
        || this.mergedConfig.infrastructure?.dns?.domain
        || ''
      const protocol = redirectsConfig.protocol || 'https'

      // Domain redirects — each source domain gets an S3 redirect bucket
      if (redirectsConfig.domains?.length && targetDomain) {
        for (const sourceDomain of redirectsConfig.domains) {
          const { bucket, bucketPolicy, logicalId, policyLogicalId } = Redirects.createDomainRedirectBucket({
            slug,
            environment: env,
            sourceDomain,
            targetDomain,
            protocol,
          })

          this.builder.addResource(logicalId, bucket)
          this.builder.addResource(policyLogicalId, bucketPolicy)
        }
      }

      // Path redirects — CloudFront Function for URL rewrites
      if (redirectsConfig.paths && Object.keys(redirectsConfig.paths).length > 0) {
        const rules = Redirects.fromMapping(redirectsConfig.paths, {
          statusCode: redirectsConfig.statusCode || 301,
        })

        const { function: redirectFn, logicalId } = Redirects.createPathRedirectFunction({
          slug,
          environment: env,
          rules,
        })

        this.builder.addResource(logicalId, redirectFn)
      }
    }

    // Monitoring
    if (this.mergedConfig.infrastructure?.monitoring?.alarms) {
      for (const [name, alarmConfig] of Object.entries(this.mergedConfig.infrastructure.monitoring.alarms)) {
        const { alarm, logicalId } = Monitoring.createAlarm({
          slug,
          environment: env,
          alarmName: `${slug}-${env}-${name}`,
          metricName: alarmConfig.metricName || 'Errors',
          namespace: alarmConfig.namespace || 'AWS/Lambda',
          threshold: alarmConfig.threshold || 1,
          comparisonOperator: (alarmConfig.comparisonOperator || 'GreaterThanThreshold') as 'GreaterThanThreshold',
        })

        this.builder.addResource(logicalId, alarm)
      }
    }

    // Cache (ElastiCache Redis/Memcached)
    const cacheConfig = this.mergedConfig.infrastructure?.cache
    if (cacheConfig) {
      const cacheType = cacheConfig.type || 'redis'

      if (cacheType === 'redis') {
        // Ensure VPC exists for cache subnet group
        this.generateNetworkInfrastructure(slug, env)

        const redisConfig = cacheConfig.redis || {}
        const { replicationGroup, subnetGroup, logicalId, subnetGroupId } = Cache.createRedis({
          slug,
          environment: env,
          nodeType: redisConfig.nodeType || cacheConfig.nodeType || 'cache.t3.micro',
          engineVersion: redisConfig.engineVersion || '7.1',
          port: redisConfig.port || 6379,
          numCacheClusters: redisConfig.numCacheNodes || 2,
          automaticFailover: redisConfig.automaticFailoverEnabled !== false,
          atRestEncryption: true,
          transitEncryption: true,
          snapshotRetentionDays: redisConfig.snapshotRetentionLimit || 7,
          snapshotWindow: redisConfig.snapshotWindow,
          subnetIds: [
            { Ref: 'PublicSubnet1' } as unknown as string,
            { Ref: 'PublicSubnet2' } as unknown as string,
          ],
        })

        this.builder.addResource(logicalId, replicationGroup)
        if (subnetGroup && subnetGroupId) {
          this.builder.addResource(subnetGroupId, subnetGroup)
        }

        this.builder.addOutput('CacheEndpoint', {
          Value: { 'Fn::GetAtt': [logicalId, 'PrimaryEndPoint.Address'] } as any,
          Description: 'Redis primary endpoint address',
        })
        this.builder.addOutput('CachePort', {
          Value: { 'Fn::GetAtt': [logicalId, 'PrimaryEndPoint.Port'] } as any,
          Description: 'Redis primary endpoint port',
        })
      }
      else if (cacheType === 'memcached') {
        this.generateNetworkInfrastructure(slug, env)

        const mcConfig = cacheConfig.elasticache || {}
        const { cluster, subnetGroup, logicalId, subnetGroupId } = Cache.createMemcached({
          slug,
          environment: env,
          nodeType: mcConfig.nodeType || cacheConfig.nodeType || 'cache.t3.micro',
          engineVersion: mcConfig.engineVersion || '1.6.22',
          numCacheNodes: mcConfig.numCacheNodes || 2,
          subnetIds: [
            { Ref: 'PublicSubnet1' } as unknown as string,
            { Ref: 'PublicSubnet2' } as unknown as string,
          ],
        })

        this.builder.addResource(logicalId, cluster)
        if (subnetGroup && subnetGroupId) {
          this.builder.addResource(subnetGroupId, subnetGroup)
        }

        this.builder.addOutput('CacheEndpoint', {
          Value: { 'Fn::GetAtt': [logicalId, 'ConfigurationEndpoint.Address'] } as any,
          Description: 'Memcached configuration endpoint address',
        })
      }
    }

    // Email (SES)
    const emailConfig = this.mergedConfig.infrastructure?.email
    if (emailConfig) {
      const domain = emailConfig.domain || this.mergedConfig.infrastructure?.dns?.domain
      if (domain) {
        // Verify domain identity
        const { emailIdentity, logicalId: identityLogicalId } = Email.verifyDomain({
          domain,
          slug,
          environment: env,
          enableDkim: emailConfig.enableDkim !== false,
          dkimKeyLength: emailConfig.dkimKeyLength || 'RSA_2048_BIT',
        })
        this.builder.addResource(identityLogicalId, emailIdentity)

        // Create configuration set
        if (emailConfig.configurationSet !== false) {
          const { configurationSet, logicalId: configSetLogicalId } = Email.createConfigurationSet({
            slug,
            environment: env,
          })
          this.builder.addResource(configSetLogicalId, configurationSet)
        }

        // DNS records (SPF, DKIM, DMARC) if hosted zone is available
        const hostedZoneId = emailConfig.hostedZoneId
          || this.mergedConfig.infrastructure?.dns?.hostedZoneId
        if (hostedZoneId) {
          // DKIM CNAME records (using Fn::GetAtt to reference tokens from the SES identity)
          if (emailConfig.enableDkim !== false) {
            for (let i = 1; i <= 3; i++) {
              const dkimLogicalId = `DkimRecord${i}${domain.replace(/\./g, '')}`
              this.builder.addResource(dkimLogicalId, {
                Type: 'AWS::Route53::RecordSet',
                DependsOn: [identityLogicalId],
                Properties: {
                  HostedZoneId: hostedZoneId,
                  Name: { 'Fn::GetAtt': [identityLogicalId, `DkimDNSTokenName${i}`] },
                  Type: 'CNAME',
                  TTL: 1800,
                  ResourceRecords: [{ 'Fn::GetAtt': [identityLogicalId, `DkimDNSTokenValue${i}`] }],
                },
              })
            }
          }

          const { record: spfRecord, logicalId: spfLogicalId } = Email.createSpfRecord(
            domain,
            hostedZoneId,
          )
          this.builder.addResource(spfLogicalId, spfRecord)

          const { record: dmarcRecord, logicalId: dmarcLogicalId } = Email.createDmarcRecord(
            domain,
            hostedZoneId,
            {
              policy: 'none',
              reportingEmail: emailConfig.dmarcReportingEmail || `dmarc-reports@${domain}`,
            },
          )
          this.builder.addResource(dmarcLogicalId, dmarcRecord)
        }

        this.builder.addOutput('EmailDomain', {
          Value: domain,
          Description: 'SES verified email domain',
        })

        // Inbound email pipeline (when server.enabled is true)
        const emailServerConfig = emailConfig.server
        if (emailServerConfig?.enabled && hostedZoneId) {
          const region = this.mergedConfig.environments[env]?.region || this.mergedConfig.project.region || 'us-east-1'
          const emailBucketName = `${slug}-${env}-email`

          // Create IAM role for email Lambda functions
          const { role, policy, roleLogicalId, policyLogicalId } = Email.createEmailLambdaRole({
            slug,
            environment: env,
            s3BucketArn: `arn:aws:s3:::${emailBucketName}`,
            sesIdentityArn: `arn:aws:ses:${region}:*:identity/${domain}`,
          })
          this.builder.addResource(roleLogicalId, role)
          this.builder.addResource(policyLogicalId, policy)

          // Create inbound email Lambda
          const {
            function: inboundLambda,
            permission,
            logicalId: inboundId,
            permissionLogicalId,
          } = Email.createInboundEmailLambda({
            slug,
            environment: env,
            roleArn: { 'Fn::GetAtt': [roleLogicalId, 'Arn'] } as unknown as string,
            s3BucketName: emailBucketName,
            organizedPrefix: 'mailboxes/',
          })
          this.builder.addResource(inboundId, inboundLambda)
          this.builder.addResource(permissionLogicalId, permission)

          // Create receipt rule set, receipt rule, and MX record
          const inboundSetup = Email.createInboundEmailSetup({
            slug,
            environment: env,
            domain,
            s3BucketName: emailBucketName,
            s3KeyPrefix: 'inbox/',
            region,
            hostedZoneId,
            lambdaFunctionArn: { 'Fn::GetAtt': [inboundId, 'Arn'] } as unknown as string,
          })
          for (const [id, resource] of Object.entries(inboundSetup.resources)) {
            // SES receipt rule must wait for Lambda permission to exist
            if ((resource as any).Type === 'AWS::SES::ReceiptRule') {
              ;(resource as any).DependsOn = [permissionLogicalId, inboundId]
            }
            this.builder.addResource(id, resource)
          }

          this.builder.addOutput('InboundEmailLambda', {
            Value: { Ref: inboundId } as any,
            Description: 'Inbound email processing Lambda function',
          })

          this.builder.addOutput('EmailBucket', {
            Value: emailBucketName,
            Description: 'S3 bucket for email storage',
          })

          // Create mail.{domain} A record pointing to the app server's EIP
          const appEipLogicalId = this.serverEipLogicalIds.get('app')
          if (appEipLogicalId && hostedZoneId) {
            const mailSubdomain = (emailServerConfig as any)?.subdomain || 'mail'
            const mailDomain = `${mailSubdomain}.${domain}`
            const safeMailName = mailDomain.replace(/[^a-zA-Z0-9]/g, '')

            this.builder.addResource(`${safeMailName}ARecord`, {
              Type: 'AWS::Route53::RecordSet',
              Properties: {
                HostedZoneId: hostedZoneId,
                Name: mailDomain,
                Type: 'A',
                TTL: '300',
                ResourceRecords: [{ Ref: appEipLogicalId }],
              },
            } as any)
          }

          this.builder.addOutput('MailHost', {
            Value: `mail.${domain}`,
            Description: 'Mail server hostname for SMTP/IMAP clients',
          })
        }
      }
    }

    // Search (OpenSearch)
    const searchConfig = this.mergedConfig.infrastructure?.search
    if (searchConfig) {
      const searchVpc = searchConfig.vpc
        ? {
          subnetIds: [{ Ref: 'PublicSubnet1' } as unknown as string],
          securityGroupIds: [] as string[],
        }
        : undefined

      if (searchVpc) {
        this.generateNetworkInfrastructure(slug, env)
      }

      const { domain: searchDomain, logicalId: searchLogicalId } = Search.createDomain({
        slug,
        environment: env,
        engineVersion: searchConfig.engineVersion || 'OpenSearch_2.11',
        instanceType: searchConfig.instanceType || 't3.small.search',
        instanceCount: searchConfig.instanceCount || 1,
        volumeSize: searchConfig.volumeSize || 10,
        volumeType: searchConfig.volumeType || 'gp3',
        dedicatedMaster: searchConfig.dedicatedMaster || false,
        dedicatedMasterType: searchConfig.dedicatedMasterType,
        dedicatedMasterCount: searchConfig.dedicatedMasterCount || 3,
        multiAz: searchConfig.multiAz || false,
        encryption: searchConfig.encryption || { atRest: true, nodeToNode: true },
        advancedSecurity: searchConfig.advancedSecurity,
        autoTune: searchConfig.autoTune !== false,
        vpc: searchVpc,
      })

      this.builder.addResource(searchLogicalId, searchDomain)

      this.builder.addOutput('SearchDomainEndpoint', {
        Value: { 'Fn::GetAtt': [searchLogicalId, 'DomainEndpoint'] } as any,
        Description: 'OpenSearch domain endpoint',
      })
      this.builder.addOutput('SearchDomainArn', {
        Value: { 'Fn::GetAtt': [searchLogicalId, 'Arn'] } as any,
        Description: 'OpenSearch domain ARN',
      })
    }

    // File System (EFS)
    const fileSystemConfig = this.mergedConfig.infrastructure?.fileSystem
    if (fileSystemConfig && Object.keys(fileSystemConfig).length > 0) {
      this.generateNetworkInfrastructure(slug, env)

      for (const [name, fsConfig] of Object.entries(fileSystemConfig)) {
        // Create the EFS file system
        const { fileSystem, logicalId: fsLogicalId } = FileSystem.createFileSystem({
          slug: `${slug}-${name}`,
          environment: env,
          encrypted: fsConfig.encrypted !== false,
          performanceMode: fsConfig.performanceMode || 'generalPurpose',
          throughputMode: fsConfig.throughputMode || 'bursting',
          enableBackup: true,
        })

        this.builder.addResource(fsLogicalId, fileSystem)

        // Create EFS security group
        const { securityGroup, logicalId: sgLogicalId } = FileSystem.createEfsSecurityGroup({
          slug: `${slug}-${name}`,
          environment: env,
          vpcId: { Ref: 'VPC' } as unknown as string,
          sourceCidrBlocks: ['10.0.0.0/16'],
        })

        this.builder.addResource(sgLogicalId, securityGroup)

        // Create mount targets in each subnet
        const { mountTargets, logicalIds: mtLogicalIds } = FileSystem.createMultiAzMountTargets(
          fsLogicalId,
          {
            slug: `${slug}-${name}`,
            environment: env,
            subnetIds: [
              { Ref: 'PublicSubnet1' } as unknown as string,
              { Ref: 'PublicSubnet2' } as unknown as string,
            ],
            securityGroupId: { Ref: sgLogicalId } as unknown as string,
          },
        )

        for (let i = 0; i < mountTargets.length; i++) {
          this.builder.addResource(mtLogicalIds[i], mountTargets[i])
        }

        this.builder.addOutput(`${name}FileSystemId`, {
          Value: { Ref: fsLogicalId },
          Description: `EFS file system ID for ${name}`,
        })
      }
    }

    // AI (Bedrock)
    const aiConfig = this.mergedConfig.infrastructure?.ai
    if (aiConfig) {
      const service = aiConfig.service || 'ecs'
      const models = aiConfig.models || ['*']
      const allowStreaming = aiConfig.allowStreaming !== false

      let result: { role: any; logicalId: string }

      if (service === 'ecs') {
        result = AI.enableBedrockForEcs({
          slug,
          environment: env,
          models,
          allowStreaming,
        })
      }
      else if (service === 'ec2') {
        result = AI.enableBedrockForEc2({
          slug,
          environment: env,
          models,
          allowStreaming,
        })
      }
      else if (service === 'lambda') {
        result = AI.enableBedrockForLambda({
          slug,
          environment: env,
          models,
          allowStreaming,
        })
      }
      else {
        // Custom service principal
        result = AI.createBedrockRole(service, {
          slug,
          environment: env,
          models,
          allowStreaming,
        })
      }

      this.builder.addResource(result.logicalId, result.role)

      // Also create a standalone policy if async invocation is needed
      if (aiConfig.allowAsync) {
        const { policy, logicalId: policyLogicalId } = AI.createBedrockPolicy({
          slug,
          environment: env,
          models,
          allowStreaming,
          allowAsync: true,
        })
        this.builder.addResource(policyLogicalId, policy)
      }

      this.builder.addOutput('BedrockRoleArn', {
        Value: { 'Fn::GetAtt': [result.logicalId, 'Arn'] } as any,
        Description: 'IAM role ARN with Bedrock permissions',
      })
    }
  }

  /**
   * Generate Realtime (WebSocket) infrastructure
   * Creates API Gateway WebSocket API, Lambda handlers, DynamoDB tables
   */
  private generateRealtimeResources(slug: string, env: typeof this.environment): void {
    const config = this.mergedConfig.infrastructure?.realtime
    if (!config) return

    const apiName = config.name || `${slug}-${env}-realtime`
    const scalingConfig = config.scaling || {}
    const storageConfig = config.storage || { type: 'dynamodb' }
    const handlerMemory = scalingConfig.handlerMemory || 256
    const handlerTimeout = scalingConfig.handlerTimeout || 30

    // ========================================
    // DynamoDB Tables for Connection Management
    // ========================================
    const connectionsTableId = `${slug}${env}RealtimeConnections`.replace(/[^a-zA-Z0-9]/g, '')
    const channelsTableId = `${slug}${env}RealtimeChannels`.replace(/[^a-zA-Z0-9]/g, '')

    if (storageConfig.type === 'dynamodb') {
      const dynamoConfig = storageConfig.dynamodb || {}
      const billingMode = dynamoConfig.billingMode || 'PAY_PER_REQUEST'

      // Connections table - stores active WebSocket connections
      this.builder.addResource(connectionsTableId, {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${slug}-${env}-realtime-connections`,
          BillingMode: billingMode,
          AttributeDefinitions: [
            { AttributeName: 'connectionId', AttributeType: 'S' },
            { AttributeName: 'userId', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'connectionId', KeyType: 'HASH' },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: 'userId-index',
              KeySchema: [
                { AttributeName: 'userId', KeyType: 'HASH' },
              ],
              Projection: { ProjectionType: 'ALL' },
              ...(billingMode === 'PROVISIONED' && {
                ProvisionedThroughput: {
                  ReadCapacityUnits: dynamoConfig.readCapacity || 5,
                  WriteCapacityUnits: dynamoConfig.writeCapacity || 5,
                },
              }),
            },
          ],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
          ...(billingMode === 'PROVISIONED' && {
            ProvisionedThroughput: {
              ReadCapacityUnits: dynamoConfig.readCapacity || 5,
              WriteCapacityUnits: dynamoConfig.writeCapacity || 5,
            },
          }),
          ...(dynamoConfig.pointInTimeRecovery && {
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          }),
          Tags: [
            { Key: 'Name', Value: `${slug}-${env}-realtime-connections` },
            { Key: 'Environment', Value: env },
          ],
        },
      } as any)

      // Channels table - stores channel subscriptions
      this.builder.addResource(channelsTableId, {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${slug}-${env}-realtime-channels`,
          BillingMode: billingMode,
          AttributeDefinitions: [
            { AttributeName: 'channel', AttributeType: 'S' },
            { AttributeName: 'connectionId', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'channel', KeyType: 'HASH' },
            { AttributeName: 'connectionId', KeyType: 'RANGE' },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: 'connectionId-index',
              KeySchema: [
                { AttributeName: 'connectionId', KeyType: 'HASH' },
              ],
              Projection: { ProjectionType: 'ALL' },
              ...(billingMode === 'PROVISIONED' && {
                ProvisionedThroughput: {
                  ReadCapacityUnits: dynamoConfig.readCapacity || 5,
                  WriteCapacityUnits: dynamoConfig.writeCapacity || 5,
                },
              }),
            },
          ],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
          ...(billingMode === 'PROVISIONED' && {
            ProvisionedThroughput: {
              ReadCapacityUnits: dynamoConfig.readCapacity || 5,
              WriteCapacityUnits: dynamoConfig.writeCapacity || 5,
            },
          }),
          Tags: [
            { Key: 'Name', Value: `${slug}-${env}-realtime-channels` },
            { Key: 'Environment', Value: env },
          ],
        },
      } as any)
    }

    // ========================================
    // IAM Role for WebSocket Handlers
    // ========================================
    const roleId = `${slug}${env}RealtimeRole`.replace(/[^a-zA-Z0-9]/g, '')

    this.builder.addResource(roleId, {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: `${slug}-${env}-realtime-handler-role`,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          }],
        },
        ManagedPolicyArns: [
          'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
        Policies: [{
          PolicyName: 'RealtimeHandlerPolicy',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'dynamodb:GetItem',
                  'dynamodb:PutItem',
                  'dynamodb:DeleteItem',
                  'dynamodb:Query',
                  'dynamodb:Scan',
                  'dynamodb:UpdateItem',
                ],
                Resource: [
                  { 'Fn::GetAtt': [connectionsTableId, 'Arn'] },
                  { 'Fn::Sub': `\${${connectionsTableId}.Arn}/index/*` },
                  { 'Fn::GetAtt': [channelsTableId, 'Arn'] },
                  { 'Fn::Sub': `\${${channelsTableId}.Arn}/index/*` },
                ],
              },
              {
                Effect: 'Allow',
                Action: 'execute-api:ManageConnections',
                Resource: { 'Fn::Sub': 'arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:*/*' },
              },
            ],
          },
        }],
      },
    } as any)

    // ========================================
    // Lambda Handlers for WebSocket Routes
    // ========================================
    const connectHandlerId = `${slug}${env}RealtimeConnect`.replace(/[^a-zA-Z0-9]/g, '')
    const disconnectHandlerId = `${slug}${env}RealtimeDisconnect`.replace(/[^a-zA-Z0-9]/g, '')
    const messageHandlerId = `${slug}${env}RealtimeMessage`.replace(/[^a-zA-Z0-9]/g, '')

    // $connect handler
    this.builder.addResource(connectHandlerId, {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: `${slug}-${env}-realtime-connect`,
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: { 'Fn::GetAtt': [roleId, 'Arn'] },
        MemorySize: handlerMemory,
        Timeout: handlerTimeout,
        Environment: {
          Variables: {
            CONNECTIONS_TABLE: { Ref: connectionsTableId },
            CHANNELS_TABLE: { Ref: channelsTableId },
            ENVIRONMENT: env,
          },
        },
        Code: {
          ZipFile: this.generateConnectHandlerCode(),
        },
      },
      DependsOn: [roleId, connectionsTableId],
    } as any)

    // $disconnect handler
    this.builder.addResource(disconnectHandlerId, {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: `${slug}-${env}-realtime-disconnect`,
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: { 'Fn::GetAtt': [roleId, 'Arn'] },
        MemorySize: handlerMemory,
        Timeout: handlerTimeout,
        Environment: {
          Variables: {
            CONNECTIONS_TABLE: { Ref: connectionsTableId },
            CHANNELS_TABLE: { Ref: channelsTableId },
            ENVIRONMENT: env,
          },
        },
        Code: {
          ZipFile: this.generateDisconnectHandlerCode(),
        },
      },
      DependsOn: [roleId, connectionsTableId, channelsTableId],
    } as any)

    // $default (message) handler
    this.builder.addResource(messageHandlerId, {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: `${slug}-${env}-realtime-message`,
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: { 'Fn::GetAtt': [roleId, 'Arn'] },
        MemorySize: handlerMemory,
        Timeout: handlerTimeout,
        Environment: {
          Variables: {
            CONNECTIONS_TABLE: { Ref: connectionsTableId },
            CHANNELS_TABLE: { Ref: channelsTableId },
            ENVIRONMENT: env,
          },
        },
        Code: {
          ZipFile: this.generateMessageHandlerCode(),
        },
      },
      DependsOn: [roleId, connectionsTableId, channelsTableId],
    } as any)

    // ========================================
    // API Gateway WebSocket API
    // ========================================
    const apiId = `${slug}${env}RealtimeApi`.replace(/[^a-zA-Z0-9]/g, '')

    this.builder.addResource(apiId, {
      Type: 'AWS::ApiGatewayV2::Api',
      Properties: {
        Name: apiName,
        ProtocolType: 'WEBSOCKET',
        RouteSelectionExpression: '$request.body.action',
        Tags: {
          Name: apiName,
          Environment: env,
        },
      },
    } as any)

    // Lambda permissions for API Gateway
    const connectPermId = `${connectHandlerId}Permission`
    const disconnectPermId = `${disconnectHandlerId}Permission`
    const messagePermId = `${messageHandlerId}Permission`

    this.builder.addResource(connectPermId, {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        FunctionName: { Ref: connectHandlerId },
        Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com',
        SourceArn: { 'Fn::Sub': `arn:aws:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${${apiId}}/*/$connect` },
      },
    } as any)

    this.builder.addResource(disconnectPermId, {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        FunctionName: { Ref: disconnectHandlerId },
        Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com',
        SourceArn: { 'Fn::Sub': `arn:aws:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${${apiId}}/*/$disconnect` },
      },
    } as any)

    this.builder.addResource(messagePermId, {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        FunctionName: { Ref: messageHandlerId },
        Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com',
        SourceArn: { 'Fn::Sub': `arn:aws:execute-api:\${AWS::Region}:\${AWS::AccountId}:\${${apiId}}/*/$default` },
      },
    } as any)

    // Integrations
    const connectIntegId = `${apiId}ConnectInteg`
    const disconnectIntegId = `${apiId}DisconnectInteg`
    const messageIntegId = `${apiId}MessageInteg`

    this.builder.addResource(connectIntegId, {
      Type: 'AWS::ApiGatewayV2::Integration',
      Properties: {
        ApiId: { Ref: apiId },
        IntegrationType: 'AWS_PROXY',
        IntegrationUri: { 'Fn::Sub': `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${${connectHandlerId}.Arn}/invocations` },
      },
    } as any)

    this.builder.addResource(disconnectIntegId, {
      Type: 'AWS::ApiGatewayV2::Integration',
      Properties: {
        ApiId: { Ref: apiId },
        IntegrationType: 'AWS_PROXY',
        IntegrationUri: { 'Fn::Sub': `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${${disconnectHandlerId}.Arn}/invocations` },
      },
    } as any)

    this.builder.addResource(messageIntegId, {
      Type: 'AWS::ApiGatewayV2::Integration',
      Properties: {
        ApiId: { Ref: apiId },
        IntegrationType: 'AWS_PROXY',
        IntegrationUri: { 'Fn::Sub': `arn:aws:apigateway:\${AWS::Region}:lambda:path/2015-03-31/functions/\${${messageHandlerId}.Arn}/invocations` },
      },
    } as any)

    // Routes
    this.builder.addResource(`${apiId}ConnectRoute`, {
      Type: 'AWS::ApiGatewayV2::Route',
      Properties: {
        ApiId: { Ref: apiId },
        RouteKey: '$connect',
        AuthorizationType: 'NONE',
        Target: { 'Fn::Sub': `integrations/\${${connectIntegId}}` },
      },
    } as any)

    this.builder.addResource(`${apiId}DisconnectRoute`, {
      Type: 'AWS::ApiGatewayV2::Route',
      Properties: {
        ApiId: { Ref: apiId },
        RouteKey: '$disconnect',
        Target: { 'Fn::Sub': `integrations/\${${disconnectIntegId}}` },
      },
    } as any)

    this.builder.addResource(`${apiId}DefaultRoute`, {
      Type: 'AWS::ApiGatewayV2::Route',
      Properties: {
        ApiId: { Ref: apiId },
        RouteKey: '$default',
        Target: { 'Fn::Sub': `integrations/\${${messageIntegId}}` },
      },
    } as any)

    // Stage
    const stageId = `${apiId}Stage`
    this.builder.addResource(stageId, {
      Type: 'AWS::ApiGatewayV2::Stage',
      Properties: {
        ApiId: { Ref: apiId },
        StageName: env,
        AutoDeploy: true,
        DefaultRouteSettings: {
          ThrottlingBurstLimit: scalingConfig.messagesPerSecond || 1000,
          ThrottlingRateLimit: scalingConfig.messagesPerSecond || 1000,
        },
      },
    } as any)

    // ========================================
    // CloudWatch Alarms (if monitoring enabled)
    // ========================================
    if (config.monitoring?.enabled) {
      const monitoringConfig = config.monitoring
      let alarmTopicArn = monitoringConfig.notificationTopicArn

      // Create SNS topic if emails provided
      if (!alarmTopicArn && monitoringConfig.notificationEmails?.length) {
        const topicId = `${apiId}AlarmTopic`
        this.builder.addResource(topicId, {
          Type: 'AWS::SNS::Topic',
          Properties: {
            TopicName: `${slug}-${env}-realtime-alarms`,
            DisplayName: 'Realtime WebSocket Alarms',
          },
        } as any)

        monitoringConfig.notificationEmails.forEach((email, idx) => {
          this.builder.addResource(`${topicId}Sub${idx}`, {
            Type: 'AWS::SNS::Subscription',
            Properties: {
              TopicArn: { Ref: topicId },
              Protocol: 'email',
              Endpoint: email,
            },
          } as any)
        })

        alarmTopicArn = { Ref: topicId } as any
      }

      // Connection count alarm
      if (monitoringConfig.connectionThreshold) {
        this.builder.addResource(`${apiId}ConnectionAlarm`, {
          Type: 'AWS::CloudWatch::Alarm',
          Properties: {
            AlarmName: `${slug}-${env}-realtime-connections`,
            AlarmDescription: `WebSocket connections exceed ${monitoringConfig.connectionThreshold}`,
            MetricName: 'ConnectCount',
            Namespace: 'AWS/ApiGateway',
            Statistic: 'Sum',
            Period: 300,
            EvaluationPeriods: 2,
            Threshold: monitoringConfig.connectionThreshold,
            ComparisonOperator: 'GreaterThanThreshold',
            Dimensions: [{ Name: 'ApiId', Value: { Ref: apiId } }],
            ...(alarmTopicArn && { AlarmActions: [alarmTopicArn] }),
          },
        } as any)
      }

      // Error rate alarm
      if (monitoringConfig.errorThreshold) {
        this.builder.addResource(`${apiId}ErrorAlarm`, {
          Type: 'AWS::CloudWatch::Alarm',
          Properties: {
            AlarmName: `${slug}-${env}-realtime-errors`,
            AlarmDescription: `WebSocket errors exceed ${monitoringConfig.errorThreshold}/min`,
            MetricName: 'ExecutionError',
            Namespace: 'AWS/ApiGateway',
            Statistic: 'Sum',
            Period: 60,
            EvaluationPeriods: 3,
            Threshold: monitoringConfig.errorThreshold,
            ComparisonOperator: 'GreaterThanThreshold',
            Dimensions: [{ Name: 'ApiId', Value: { Ref: apiId } }],
            ...(alarmTopicArn && { AlarmActions: [alarmTopicArn] }),
          },
        } as any)
      }
    }

    // ========================================
    // Outputs
    // ========================================
    this.builder.addOutput(`${apiId}Endpoint`, {
      Description: 'WebSocket API endpoint URL',
      Value: { 'Fn::Sub': `wss://\${${apiId}}.execute-api.\${AWS::Region}.amazonaws.com/${env}` },
      Export: { Name: { 'Fn::Sub': `\${AWS::StackName}-realtime-endpoint` } as any },
    })

    this.builder.addOutput(`${apiId}Id`, {
      Description: 'WebSocket API ID',
      Value: { Ref: apiId },
      Export: { Name: { 'Fn::Sub': `\${AWS::StackName}-realtime-api-id` } as any },
    })
  }

  /**
   * Generate $connect Lambda handler code
   */
  private generateConnectHandlerCode(): string {
    return `
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const userId = event.queryStringParameters?.userId || 'anonymous';
  const ttl = Math.floor(Date.now() / 1000) + 86400; // 24 hours

  try {
    await docClient.send(new PutCommand({
      TableName: process.env.CONNECTIONS_TABLE,
      Item: {
        connectionId,
        userId,
        connectedAt: new Date().toISOString(),
        ttl,
      },
    }));

    return { statusCode: 200, body: 'Connected' };
  } catch (error) {
    console.error('Connect error:', error);
    return { statusCode: 500, body: 'Failed to connect' };
  }
};
`.trim()
  }

  /**
   * Generate $disconnect Lambda handler code
   */
  private generateDisconnectHandlerCode(): string {
    return `
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, DeleteCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;

  try {
    // Remove connection record
    await docClient.send(new DeleteCommand({
      TableName: process.env.CONNECTIONS_TABLE,
      Key: { connectionId },
    }));

    // Remove all channel subscriptions for this connection
    const subscriptions = await docClient.send(new QueryCommand({
      TableName: process.env.CHANNELS_TABLE,
      IndexName: 'connectionId-index',
      KeyConditionExpression: 'connectionId = :cid',
      ExpressionAttributeValues: { ':cid': connectionId },
    }));

    if (subscriptions.Items) {
      for (const sub of subscriptions.Items) {
        await docClient.send(new DeleteCommand({
          TableName: process.env.CHANNELS_TABLE,
          Key: { channel: sub.channel, connectionId },
        }));
      }
    }

    return { statusCode: 200, body: 'Disconnected' };
  } catch (error) {
    console.error('Disconnect error:', error);
    return { statusCode: 500, body: 'Failed to disconnect' };
  }
};
`.trim()
  }

  /**
   * Generate $default (message) Lambda handler code
   */
  private generateMessageHandlerCode(): string {
    return `
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const endpoint = \`https://\${event.requestContext.domainName}/\${event.requestContext.stage}\`;
  const apiClient = new ApiGatewayManagementApiClient({ endpoint });

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { action, channel, data } = body;

  try {
    switch (action) {
      case 'subscribe': {
        const ttl = Math.floor(Date.now() / 1000) + 86400;
        await docClient.send(new PutCommand({
          TableName: process.env.CHANNELS_TABLE,
          Item: { channel, connectionId, subscribedAt: new Date().toISOString(), ttl },
        }));
        return { statusCode: 200, body: JSON.stringify({ action: 'subscribed', channel }) };
      }

      case 'unsubscribe': {
        await docClient.send(new DeleteCommand({
          TableName: process.env.CHANNELS_TABLE,
          Key: { channel, connectionId },
        }));
        return { statusCode: 200, body: JSON.stringify({ action: 'unsubscribed', channel }) };
      }

      case 'broadcast': {
        // Get all subscribers for the channel
        const subscribers = await docClient.send(new QueryCommand({
          TableName: process.env.CHANNELS_TABLE,
          KeyConditionExpression: 'channel = :channel',
          ExpressionAttributeValues: { ':channel': channel },
        }));

        const message = JSON.stringify({ channel, event: body.event, data });

        // Send to all subscribers
        const sendPromises = (subscribers.Items || []).map(async (sub) => {
          try {
            await apiClient.send(new PostToConnectionCommand({
              ConnectionId: sub.connectionId,
              Data: message,
            }));
          } catch (error) {
            if (error.statusCode === 410) {
              // Connection is stale, remove it
              await docClient.send(new DeleteCommand({
                TableName: process.env.CHANNELS_TABLE,
                Key: { channel, connectionId: sub.connectionId },
              }));
            }
          }
        });

        await Promise.all(sendPromises);
        return { statusCode: 200, body: JSON.stringify({ action: 'broadcasted', channel, recipients: subscribers.Items?.length || 0 }) };
      }

      case 'ping': {
        return { statusCode: 200, body: JSON.stringify({ action: 'pong', timestamp: Date.now() }) };
      }

      default:
        return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action', action }) };
    }
  } catch (error) {
    console.error('Message handler error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
`.trim()
  }

  /**
   * Generate Realtime Server Mode infrastructure (ts-broadcasting)
   * Creates ECS/EC2 resources for running the Bun WebSocket server
   */
  private generateRealtimeServerResources(slug: string, env: typeof this.environment): void {
    const config = this.mergedConfig.infrastructure?.realtime
    if (!config) return

    const serverConfig = config.server || {}
    const port = serverConfig.port || 6001
    const instances = serverConfig.instances || 1

    // ========================================
    // Security Group for WebSocket Server
    // ========================================
    const sgId = `${slug}${env}RealtimeSG`.replace(/[^a-zA-Z0-9]/g, '')

    this.builder.addResource(sgId, {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: `Security group for ${slug} realtime WebSocket server`,
        GroupName: `${slug}-${env}-realtime-sg`,
        VpcId: { Ref: 'VPC' },
        SecurityGroupIngress: [
          {
            IpProtocol: 'tcp',
            FromPort: port,
            ToPort: port,
            CidrIp: '0.0.0.0/0',
            Description: 'WebSocket connections',
          },
          {
            IpProtocol: 'tcp',
            FromPort: 443,
            ToPort: 443,
            CidrIp: '0.0.0.0/0',
            Description: 'HTTPS/WSS connections',
          },
        ],
        SecurityGroupEgress: [
          {
            IpProtocol: '-1',
            CidrIp: '0.0.0.0/0',
            Description: 'Allow all outbound',
          },
        ],
        Tags: [
          { Key: 'Name', Value: `${slug}-${env}-realtime-sg` },
          { Key: 'Environment', Value: env },
        ],
      },
    } as any)

    // ========================================
    // ECS Task Definition for ts-broadcasting
    // ========================================
    const taskDefId = `${slug}${env}RealtimeTaskDef`.replace(/[^a-zA-Z0-9]/g, '')
    const taskRoleId = `${slug}${env}RealtimeTaskRole`.replace(/[^a-zA-Z0-9]/g, '')
    const execRoleId = `${slug}${env}RealtimeExecRole`.replace(/[^a-zA-Z0-9]/g, '')

    // Task execution role
    this.builder.addResource(execRoleId, {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: `${slug}-${env}-realtime-exec-role`,
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
      },
    } as any)

    // Task role (for the application)
    this.builder.addResource(taskRoleId, {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: `${slug}-${env}-realtime-task-role`,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Principal: { Service: 'ecs-tasks.amazonaws.com' },
            Action: 'sts:AssumeRole',
          }],
        },
        Policies: [{
          PolicyName: 'RealtimeTaskPolicy',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'logs:CreateLogStream',
                  'logs:PutLogEvents',
                ],
                Resource: '*',
              },
              // Add ElastiCache access if Redis is enabled
              ...(serverConfig.redis?.enabled ? [{
                Effect: 'Allow',
                Action: [
                  'elasticache:DescribeCacheClusters',
                  'elasticache:DescribeReplicationGroups',
                ],
                Resource: '*',
              }] : []),
            ],
          },
        }],
      },
    } as any)

    // Build environment variables for ts-broadcasting
    const envVars: Array<{ Name: string, Value: any }> = [
      { Name: 'BROADCAST_HOST', Value: serverConfig.host || '0.0.0.0' },
      { Name: 'BROADCAST_PORT', Value: String(port) },
      { Name: 'NODE_ENV', Value: env === 'production' ? 'production' : 'development' },
    ]

    if (serverConfig.redis?.enabled) {
      if (serverConfig.redis.useElastiCache) {
        envVars.push({ Name: 'REDIS_HOST', Value: { 'Fn::GetAtt': ['CacheCluster', 'RedisEndpoint.Address'] } })
        envVars.push({ Name: 'REDIS_PORT', Value: { 'Fn::GetAtt': ['CacheCluster', 'RedisEndpoint.Port'] } })
      }
      else {
        envVars.push({ Name: 'REDIS_HOST', Value: serverConfig.redis.host || 'localhost' })
        envVars.push({ Name: 'REDIS_PORT', Value: String(serverConfig.redis.port || 6379) })
      }
      if (serverConfig.redis.keyPrefix) {
        envVars.push({ Name: 'REDIS_KEY_PREFIX', Value: serverConfig.redis.keyPrefix })
      }
    }

    // Task definition
    this.builder.addResource(taskDefId, {
      Type: 'AWS::ECS::TaskDefinition',
      Properties: {
        Family: `${slug}-${env}-realtime`,
        NetworkMode: 'awsvpc',
        RequiresCompatibilities: ['FARGATE'],
        Cpu: '512',
        Memory: '1024',
        ExecutionRoleArn: { 'Fn::GetAtt': [execRoleId, 'Arn'] },
        TaskRoleArn: { 'Fn::GetAtt': [taskRoleId, 'Arn'] },
        ContainerDefinitions: [{
          Name: 'realtime',
          Image: { 'Fn::Sub': `\${AWS::AccountId}.dkr.ecr.\${AWS::Region}.amazonaws.com/${slug}-realtime:latest` },
          Essential: true,
          PortMappings: [{
            ContainerPort: port,
            Protocol: 'tcp',
          }],
          Environment: envVars,
          LogConfiguration: {
            LogDriver: 'awslogs',
            Options: {
              'awslogs-group': `/ecs/${slug}-${env}-realtime`,
              'awslogs-region': { Ref: 'AWS::Region' },
              'awslogs-stream-prefix': 'realtime',
            },
          },
          HealthCheck: {
            Command: ['CMD-SHELL', `curl -f http://localhost:${port}${serverConfig.healthCheckPath || '/health'} || exit 1`],
            Interval: 30,
            Timeout: 5,
            Retries: 3,
            StartPeriod: 60,
          },
        }],
        Tags: [
          { Key: 'Name', Value: `${slug}-${env}-realtime` },
          { Key: 'Environment', Value: env },
        ],
      },
      DependsOn: [execRoleId, taskRoleId],
    } as any)

    // CloudWatch Log Group
    const logGroupId = `${slug}${env}RealtimeLogs`.replace(/[^a-zA-Z0-9]/g, '')
    this.builder.addResource(logGroupId, {
      Type: 'AWS::Logs::LogGroup',
      Properties: {
        LogGroupName: `/ecs/${slug}-${env}-realtime`,
        RetentionInDays: 30,
      },
    } as any)

    // ========================================
    // ECS Service
    // ========================================
    const serviceId = `${slug}${env}RealtimeService`.replace(/[^a-zA-Z0-9]/g, '')

    this.builder.addResource(serviceId, {
      Type: 'AWS::ECS::Service',
      Properties: {
        ServiceName: `${slug}-${env}-realtime`,
        Cluster: { Ref: 'ECSCluster' },
        TaskDefinition: { Ref: taskDefId },
        DesiredCount: instances,
        LaunchType: 'FARGATE',
        NetworkConfiguration: {
          AwsvpcConfiguration: {
            AssignPublicIp: 'ENABLED',
            SecurityGroups: [{ Ref: sgId }],
            Subnets: [{ Ref: 'PublicSubnet1' }, { Ref: 'PublicSubnet2' }],
          },
        },
        HealthCheckGracePeriodSeconds: 60,
        Tags: [
          { Key: 'Name', Value: `${slug}-${env}-realtime` },
          { Key: 'Environment', Value: env },
        ],
      },
      DependsOn: [taskDefId, sgId, logGroupId],
    } as any)

    // ========================================
    // Auto Scaling (if configured)
    // ========================================
    if (serverConfig.autoScaling) {
      const scalingConfig = serverConfig.autoScaling
      const scalableTargetId = `${slug}${env}RealtimeScalableTarget`.replace(/[^a-zA-Z0-9]/g, '')

      this.builder.addResource(scalableTargetId, {
        Type: 'AWS::ApplicationAutoScaling::ScalableTarget',
        Properties: {
          MaxCapacity: scalingConfig.max || 10,
          MinCapacity: scalingConfig.min || 1,
          ResourceId: { 'Fn::Sub': `service/\${ECSCluster}/${slug}-${env}-realtime` },
          RoleARN: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:role/aws-service-role/ecs.application-autoscaling.amazonaws.com/AWSServiceRoleForApplicationAutoScaling_ECSService' },
          ScalableDimension: 'ecs:service:DesiredCount',
          ServiceNamespace: 'ecs',
        },
        DependsOn: serviceId,
      } as any)

      // CPU-based scaling policy
      if (scalingConfig.targetCPU) {
        this.builder.addResource(`${slug}${env}RealtimeCPUPolicy`.replace(/[^a-zA-Z0-9]/g, ''), {
          Type: 'AWS::ApplicationAutoScaling::ScalingPolicy',
          Properties: {
            PolicyName: `${slug}-${env}-realtime-cpu-scaling`,
            PolicyType: 'TargetTrackingScaling',
            ScalingTargetId: { Ref: scalableTargetId },
            TargetTrackingScalingPolicyConfiguration: {
              PredefinedMetricSpecification: {
                PredefinedMetricType: 'ECSServiceAverageCPUUtilization',
              },
              TargetValue: scalingConfig.targetCPU,
              ScaleInCooldown: 300,
              ScaleOutCooldown: 60,
            },
          },
        } as any)
      }
    }

    // ========================================
    // CloudWatch Alarms (if monitoring enabled)
    // ========================================
    if (config.monitoring?.enabled) {
      const monitoringConfig = config.monitoring
      let alarmTopicArn = monitoringConfig.notificationTopicArn

      if (!alarmTopicArn && monitoringConfig.notificationEmails?.length) {
        const topicId = `${slug}${env}RealtimeAlarmTopic`.replace(/[^a-zA-Z0-9]/g, '')
        this.builder.addResource(topicId, {
          Type: 'AWS::SNS::Topic',
          Properties: {
            TopicName: `${slug}-${env}-realtime-alarms`,
            DisplayName: 'Realtime Server Alarms',
          },
        } as any)

        monitoringConfig.notificationEmails.forEach((email, idx) => {
          this.builder.addResource(`${topicId}Sub${idx}`, {
            Type: 'AWS::SNS::Subscription',
            Properties: {
              TopicArn: { Ref: topicId },
              Protocol: 'email',
              Endpoint: email,
            },
          } as any)
        })

        alarmTopicArn = { Ref: topicId } as any
      }

      // CPU alarm
      this.builder.addResource(`${slug}${env}RealtimeCPUAlarm`.replace(/[^a-zA-Z0-9]/g, ''), {
        Type: 'AWS::CloudWatch::Alarm',
        Properties: {
          AlarmName: `${slug}-${env}-realtime-high-cpu`,
          AlarmDescription: 'Realtime server CPU utilization is high',
          MetricName: 'CPUUtilization',
          Namespace: 'AWS/ECS',
          Statistic: 'Average',
          Period: 300,
          EvaluationPeriods: 2,
          Threshold: 80,
          ComparisonOperator: 'GreaterThanThreshold',
          Dimensions: [
            { Name: 'ClusterName', Value: { Ref: 'ECSCluster' } },
            { Name: 'ServiceName', Value: `${slug}-${env}-realtime` },
          ],
          ...(alarmTopicArn && { AlarmActions: [alarmTopicArn] }),
        },
        DependsOn: serviceId,
      } as any)

      // Memory alarm
      this.builder.addResource(`${slug}${env}RealtimeMemoryAlarm`.replace(/[^a-zA-Z0-9]/g, ''), {
        Type: 'AWS::CloudWatch::Alarm',
        Properties: {
          AlarmName: `${slug}-${env}-realtime-high-memory`,
          AlarmDescription: 'Realtime server memory utilization is high',
          MetricName: 'MemoryUtilization',
          Namespace: 'AWS/ECS',
          Statistic: 'Average',
          Period: 300,
          EvaluationPeriods: 2,
          Threshold: 80,
          ComparisonOperator: 'GreaterThanThreshold',
          Dimensions: [
            { Name: 'ClusterName', Value: { Ref: 'ECSCluster' } },
            { Name: 'ServiceName', Value: `${slug}-${env}-realtime` },
          ],
          ...(alarmTopicArn && { AlarmActions: [alarmTopicArn] }),
        },
        DependsOn: serviceId,
      } as any)
    }

    // ========================================
    // Outputs
    // ========================================
    this.builder.addOutput(`${slug}${env}RealtimeEndpoint`.replace(/[^a-zA-Z0-9]/g, ''), {
      Description: 'Realtime WebSocket server endpoint',
      Value: { 'Fn::Sub': `wss://${slug}-${env}-realtime.\${AWS::Region}.elb.amazonaws.com:${port}` },
      Export: { Name: { 'Fn::Sub': `\${AWS::StackName}-realtime-endpoint` } as any },
    })
  }

  /**
   * Generate broadcast.config.ts content for ts-broadcasting
   */
  generateBroadcastConfig(): string {
    const config = this.mergedConfig.infrastructure?.realtime
    if (!config || config.mode !== 'server') return ''

    const serverConfig = config.server || {}

    return `import type { BroadcastConfig } from 'ts-broadcasting'

export default {
  verbose: ${this.environment !== 'production'},
  driver: '${serverConfig.driver || 'bun'}',
  default: 'bun',

  connections: {
    bun: {
      driver: 'bun',
      host: process.env.BROADCAST_HOST || '${serverConfig.host || '0.0.0.0'}',
      port: Number(process.env.BROADCAST_PORT) || ${serverConfig.port || 6001},
      scheme: '${serverConfig.scheme || 'wss'}',
      options: {
        idleTimeout: ${serverConfig.idleTimeout || 120},
        maxPayloadLength: ${serverConfig.maxPayloadLength || 16 * 1024 * 1024},
        backpressureLimit: ${serverConfig.backpressureLimit || 1024 * 1024},
        closeOnBackpressureLimit: ${serverConfig.closeOnBackpressureLimit || false},
        sendPings: ${serverConfig.sendPings !== false},
        perMessageDeflate: ${serverConfig.perMessageDeflate !== false},
      },
    },
  },
${serverConfig.redis?.enabled ? `
  redis: {
    host: process.env.REDIS_HOST || '${serverConfig.redis.host || 'localhost'}',
    port: Number(process.env.REDIS_PORT) || ${serverConfig.redis.port || 6379},
    ${serverConfig.redis.password ? `password: process.env.REDIS_PASSWORD || '${serverConfig.redis.password}',` : ''}
    database: ${serverConfig.redis.database || 0},
    keyPrefix: '${serverConfig.redis.keyPrefix || 'broadcasting:'}',
  },
` : ''}
${serverConfig.rateLimit?.enabled ? `
  rateLimit: {
    max: ${serverConfig.rateLimit.max || 100},
    window: ${serverConfig.rateLimit.window || 60000},
    perChannel: ${serverConfig.rateLimit.perChannel !== false},
    perUser: ${serverConfig.rateLimit.perUser !== false},
  },
` : ''}
${serverConfig.loadManagement?.enabled ? `
  loadManagement: {
    enabled: true,
    maxConnections: ${serverConfig.loadManagement.maxConnections || 10000},
    maxSubscriptionsPerConnection: ${serverConfig.loadManagement.maxSubscriptionsPerConnection || 100},
    shedLoadThreshold: ${serverConfig.loadManagement.shedLoadThreshold || 0.8},
  },
` : ''}
} satisfies BroadcastConfig
`
  }

  /**
   * Generate YAML output
   */
  toYAML(): string {
    return this.builder.toYAML()
  }

  /**
   * Generate JSON output
   */
  toJSON(): string {
    return this.builder.toJSON()
  }

  /**
   * Get the template builder
   */
  getBuilder(): TemplateBuilder {
    return this.builder
  }
}
