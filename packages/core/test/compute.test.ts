import { describe, expect, it } from 'bun:test'
import { Compute } from '../src/modules/compute'
import { TemplateBuilder } from '../src/template-builder'

describe('Compute Module', () => {
  describe('Server Mode (EC2)', () => {
    describe('createServer', () => {
      it('should create EC2 instance with default settings', () => {
        const { instance, logicalId } = Compute.createServer({
          slug: 'my-app',
          environment: 'production',
        })

        expect(instance.Type).toBe('AWS::EC2::Instance')
        expect(instance.Properties.InstanceType).toBe('t3.micro')
        expect(instance.Properties.BlockDeviceMappings).toBeDefined()
        expect(instance.Properties.BlockDeviceMappings?.[0].Ebs?.VolumeSize).toBe(20)
        expect(instance.Properties.BlockDeviceMappings?.[0].Ebs?.VolumeType).toBe('gp3')
        expect(instance.Properties.BlockDeviceMappings?.[0].Ebs?.Encrypted).toBe(true)
        expect(logicalId).toBeDefined()
      })

      it('should create EC2 instance with custom instance type', () => {
        const { instance } = Compute.createServer({
          slug: 'my-app',
          environment: 'production',
          instanceType: 't3.large',
        })

        expect(instance.Properties.InstanceType).toBe('t3.large')
      })

      it('should create EC2 instance with custom volume', () => {
        const { instance } = Compute.createServer({
          slug: 'my-app',
          environment: 'production',
          volumeSize: 100,
          volumeType: 'gp2',
          encrypted: false,
        })

        expect(instance.Properties.BlockDeviceMappings?.[0].Ebs?.VolumeSize).toBe(100)
        expect(instance.Properties.BlockDeviceMappings?.[0].Ebs?.VolumeType).toBe('gp2')
        expect(instance.Properties.BlockDeviceMappings?.[0].Ebs?.Encrypted).toBe(false)
      })

      it('should include key pair when provided', () => {
        const { instance } = Compute.createServer({
          slug: 'my-app',
          environment: 'production',
          keyName: 'my-keypair',
        })

        expect(instance.Properties.KeyName).toBe('my-keypair')
      })

      it('should include security groups when provided', () => {
        const { instance } = Compute.createServer({
          slug: 'my-app',
          environment: 'production',
          securityGroupIds: ['sg-123', 'sg-456'],
        })

        expect(instance.Properties.SecurityGroupIds).toEqual(['sg-123', 'sg-456'])
      })

      it('should encode user data', () => {
        const userData = '#!/bin/bash\necho "Hello World"'
        const { instance } = Compute.createServer({
          slug: 'my-app',
          environment: 'production',
          userData,
        })

        expect(instance.Properties.UserData).toBeDefined()
        expect(instance.Properties.UserData).toMatchObject({ 'Fn::Base64': userData })
      })
    })

    describe('createSecurityGroup', () => {
      it('should create security group with default settings', () => {
        const { securityGroup, logicalId } = Compute.createSecurityGroup({
          slug: 'my-app',
          environment: 'production',
        })

        expect(securityGroup.Type).toBe('AWS::EC2::SecurityGroup')
        expect(securityGroup.Properties.GroupDescription).toContain('my-app')
        expect(logicalId).toBeDefined()
      })

      it('should create security group with ingress rules', () => {
        const { securityGroup } = Compute.createSecurityGroup({
          slug: 'my-app',
          environment: 'production',
          ingress: [
            { protocol: 'tcp', fromPort: 80, toPort: 80, cidr: '0.0.0.0/0' },
            { protocol: 'tcp', fromPort: 443, toPort: 443, cidr: '0.0.0.0/0' },
          ],
        })

        expect(securityGroup.Properties.SecurityGroupIngress).toHaveLength(2)
        expect(securityGroup.Properties.SecurityGroupIngress?.[0].FromPort).toBe(80)
        expect(securityGroup.Properties.SecurityGroupIngress?.[1].FromPort).toBe(443)
      })

      it('should create security group with egress rules', () => {
        const { securityGroup } = Compute.createSecurityGroup({
          slug: 'my-app',
          environment: 'production',
          egress: [
            { protocol: '-1', cidr: '0.0.0.0/0' },
          ],
        })

        expect(securityGroup.Properties.SecurityGroupEgress).toHaveLength(1)
        expect(securityGroup.Properties.SecurityGroupEgress?.[0].IpProtocol).toBe('-1')
      })
    })

    describe('createWebServerSecurityGroup', () => {
      it('should create web server security group with HTTP, HTTPS, SSH', () => {
        const { securityGroup } = Compute.createWebServerSecurityGroup('my-app', 'production')

        expect(securityGroup.Properties.GroupDescription).toContain('web servers')
        expect(securityGroup.Properties.SecurityGroupIngress).toHaveLength(3)
        expect(securityGroup.Properties.SecurityGroupEgress).toHaveLength(1)

        const ingress = securityGroup.Properties.SecurityGroupIngress!
        expect(ingress.find(r => r.FromPort === 80)).toBeDefined() // HTTP
        expect(ingress.find(r => r.FromPort === 443)).toBeDefined() // HTTPS
        expect(ingress.find(r => r.FromPort === 22)).toBeDefined() // SSH
      })
    })
  })

  describe('Load Balancer', () => {
    describe('createLoadBalancer', () => {
      it('should create ALB with default settings', () => {
        const { loadBalancer, logicalId } = Compute.createLoadBalancer({
          slug: 'my-app',
          environment: 'production',
          subnets: ['subnet-123', 'subnet-456'],
        })

        expect(loadBalancer.Type).toBe('AWS::ElasticLoadBalancingV2::LoadBalancer')
        expect(loadBalancer.Properties.Scheme).toBe('internet-facing')
        expect(loadBalancer.Properties.Type).toBe('application')
        expect(loadBalancer.Properties.Subnets).toEqual(['subnet-123', 'subnet-456'])
        expect(logicalId).toBeDefined()
      })

      it('should create internal ALB', () => {
        const { loadBalancer } = Compute.createLoadBalancer({
          slug: 'my-app',
          environment: 'production',
          scheme: 'internal',
          subnets: ['subnet-123'],
        })

        expect(loadBalancer.Properties.Scheme).toBe('internal')
      })

      it('should include security groups when provided', () => {
        const { loadBalancer } = Compute.createLoadBalancer({
          slug: 'my-app',
          environment: 'production',
          subnets: ['subnet-123'],
          securityGroups: ['sg-123'],
        })

        expect(loadBalancer.Properties.SecurityGroups).toEqual(['sg-123'])
      })
    })

    describe('createTargetGroup', () => {
      it('should create target group with default settings', () => {
        const { targetGroup, logicalId } = Compute.createTargetGroup({
          slug: 'my-app',
          environment: 'production',
          port: 8080,
          vpcId: 'vpc-123',
        })

        expect(targetGroup.Type).toBe('AWS::ElasticLoadBalancingV2::TargetGroup')
        expect(targetGroup.Properties.Port).toBe(8080)
        expect(targetGroup.Properties.Protocol).toBe('HTTP')
        expect(targetGroup.Properties.TargetType).toBe('ip')
        expect(targetGroup.Properties.HealthCheckEnabled).toBe(true)
        expect(targetGroup.Properties.HealthCheckPath).toBe('/')
        expect(logicalId).toBeDefined()
      })

      it('should configure custom health check', () => {
        const { targetGroup } = Compute.createTargetGroup({
          slug: 'my-app',
          environment: 'production',
          port: 3000,
          vpcId: 'vpc-123',
          healthCheckPath: '/health',
          healthCheckInterval: 60,
          healthCheckTimeout: 10,
          healthyThreshold: 3,
          unhealthyThreshold: 5,
        })

        expect(targetGroup.Properties.HealthCheckPath).toBe('/health')
        expect(targetGroup.Properties.HealthCheckIntervalSeconds).toBe(60)
        expect(targetGroup.Properties.HealthCheckTimeoutSeconds).toBe(10)
        expect(targetGroup.Properties.HealthyThresholdCount).toBe(3)
        expect(targetGroup.Properties.UnhealthyThresholdCount).toBe(5)
      })

      it('should support instance target type', () => {
        const { targetGroup } = Compute.createTargetGroup({
          slug: 'my-app',
          environment: 'production',
          port: 80,
          vpcId: 'vpc-123',
          targetType: 'instance',
        })

        expect(targetGroup.Properties.TargetType).toBe('instance')
      })
    })

    describe('createListener', () => {
      it('should create HTTP listener', () => {
        const { listener, logicalId } = Compute.createListener('alb-id', {
          port: 80,
          protocol: 'HTTP',
          defaultTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789:targetgroup/my-tg',
        })

        expect(listener.Type).toBe('AWS::ElasticLoadBalancingV2::Listener')
        expect(listener.Properties.Port).toBe(80)
        expect(listener.Properties.Protocol).toBe('HTTP')
        expect(listener.Properties.DefaultActions[0].Type).toBe('forward')
        expect(logicalId).toBeDefined()
      })

      it('should create HTTPS listener with certificate', () => {
        const { listener } = Compute.createListener('alb-id', {
          port: 443,
          protocol: 'HTTPS',
          certificateArn: 'arn:aws:acm:us-east-1:123456789:certificate/abc',
          defaultTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789:targetgroup/my-tg',
        })

        expect(listener.Properties.Protocol).toBe('HTTPS')
        expect(listener.Properties.Certificates).toHaveLength(1)
        expect(listener.Properties.Certificates?.[0].CertificateArn).toBe('arn:aws:acm:us-east-1:123456789:certificate/abc')
        expect(listener.Properties.SslPolicy).toBeDefined()
      })
    })
  })

  describe('Serverless Mode (ECS Fargate)', () => {
    describe('createEcsCluster', () => {
      it('should create ECS cluster', () => {
        const { cluster, logicalId } = Compute.createEcsCluster('my-app', 'production')

        expect(cluster.Type).toBe('AWS::ECS::Cluster')
        expect(cluster.Properties?.ClusterName).toContain('my-app')
        expect(cluster.Properties?.ClusterName).toContain('production')
        expect(logicalId).toBeDefined()
      })
    })

    describe('createFargateService', () => {
      it('should create complete Fargate service with all resources', () => {
        const result = Compute.createFargateService({
          slug: 'my-app',
          environment: 'production',
          image: 'nginx:latest',
          cpu: '512',
          memory: '1024',
          desiredCount: 2,
          containerPort: 80,
          subnets: ['subnet-123'],
          securityGroups: ['sg-123'],
        })

        // Cluster
        expect(result.cluster.Type).toBe('AWS::ECS::Cluster')
        expect(result.clusterLogicalId).toBeDefined()

        // Task Definition
        expect(result.taskDefinition.Type).toBe('AWS::ECS::TaskDefinition')
        expect(result.taskDefinition.Properties.Cpu).toBe('512')
        expect(result.taskDefinition.Properties.Memory).toBe('1024')
        expect(result.taskDefinition.Properties.RequiresCompatibilities).toContain('FARGATE')
        expect(result.taskDefinition.Properties.NetworkMode).toBe('awsvpc')
        expect(result.taskDefinitionLogicalId).toBeDefined()

        // Container
        const container = result.taskDefinition.Properties.ContainerDefinitions[0]
        expect(container.Image).toBe('nginx:latest')
        expect(container.PortMappings?.[0].ContainerPort).toBe(80)

        // Service
        expect(result.service.Type).toBe('AWS::ECS::Service')
        expect(result.service.Properties.DesiredCount).toBe(2)
        expect(result.service.Properties.LaunchType).toBe('FARGATE')
        expect(result.serviceLogicalId).toBeDefined()

        // IAM Roles
        expect(result.taskRole.Type).toBe('AWS::IAM::Role')
        expect(result.executionRole.Type).toBe('AWS::IAM::Role')
        expect(result.taskRoleLogicalId).toBeDefined()
        expect(result.executionRoleLogicalId).toBeDefined()
      })

      it('should include environment variables', () => {
        const result = Compute.createFargateService({
          slug: 'my-app',
          environment: 'production',
          image: 'my-image',
          subnets: ['subnet-123'],
          securityGroups: ['sg-123'],
          environmentVariables: {
            NODE_ENV: 'production',
            API_KEY: 'secret',
          },
        })

        const container = result.taskDefinition.Properties.ContainerDefinitions[0]
        expect(container.Environment).toHaveLength(2)
        expect(container.Environment?.find(e => e.Name === 'NODE_ENV')?.Value).toBe('production')
        expect(container.Environment?.find(e => e.Name === 'API_KEY')?.Value).toBe('secret')
      })

      it('should include secrets', () => {
        const result = Compute.createFargateService({
          slug: 'my-app',
          environment: 'production',
          image: 'my-image',
          subnets: ['subnet-123'],
          securityGroups: ['sg-123'],
          secrets: [
            { name: 'DB_PASSWORD', valueFrom: 'arn:aws:secretsmanager:us-east-1:123:secret:db-pass' },
          ],
        })

        const container = result.taskDefinition.Properties.ContainerDefinitions[0]
        expect(container.Secrets).toHaveLength(1)
        expect(container.Secrets?.[0].Name).toBe('DB_PASSWORD')
      })

      it('should configure health check', () => {
        const result = Compute.createFargateService({
          slug: 'my-app',
          environment: 'production',
          image: 'my-image',
          subnets: ['subnet-123'],
          securityGroups: ['sg-123'],
          healthCheck: {
            command: ['CMD-SHELL', 'curl -f http://localhost/ || exit 1'],
            interval: 60,
            timeout: 10,
            retries: 5,
          },
        })

        const container = result.taskDefinition.Properties.ContainerDefinitions[0]
        expect(container.HealthCheck).toBeDefined()
        expect(container.HealthCheck?.Command).toEqual(['CMD-SHELL', 'curl -f http://localhost/ || exit 1'])
        expect(container.HealthCheck?.Interval).toBe(60)
        expect(container.HealthCheck?.Timeout).toBe(10)
        expect(container.HealthCheck?.Retries).toBe(5)
      })

      it('should configure logging', () => {
        const result = Compute.createFargateService({
          slug: 'my-app',
          environment: 'production',
          image: 'my-image',
          subnets: ['subnet-123'],
          securityGroups: ['sg-123'],
          logGroup: '/ecs/my-app',
        })

        const container = result.taskDefinition.Properties.ContainerDefinitions[0]
        expect(container.LogConfiguration?.LogDriver).toBe('awslogs')
        expect(container.LogConfiguration?.Options?.['awslogs-group']).toBe('/ecs/my-app')
      })

      it('should attach to load balancer when target group provided', () => {
        const result = Compute.createFargateService({
          slug: 'my-app',
          environment: 'production',
          image: 'my-image',
          subnets: ['subnet-123'],
          securityGroups: ['sg-123'],
          targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/my-tg',
        })

        expect(result.service.Properties.LoadBalancers).toHaveLength(1)
        expect(result.service.Properties.LoadBalancers?.[0].TargetGroupArn).toBe('arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/my-tg')
      })
    })
  })

  describe('Serverless Mode (Lambda)', () => {
    describe('createLambdaFunction', () => {
      it('should create Lambda function with basic settings', () => {
        const { lambdaFunction, role, logicalId, roleLogicalId } = Compute.createLambdaFunction({
          slug: 'my-function',
          environment: 'production',
          runtime: 'nodejs20.x',
          handler: 'index.handler',
          code: {
            zipFile: 'exports.handler = async () => ({ statusCode: 200 })',
          },
        })

        expect(lambdaFunction.Type).toBe('AWS::Lambda::Function')
        expect(lambdaFunction.Properties.Runtime).toBe('nodejs20.x')
        expect(lambdaFunction.Properties.Handler).toBe('index.handler')
        expect(lambdaFunction.Properties.Timeout).toBe(30)
        expect(lambdaFunction.Properties.MemorySize).toBe(128)
        expect(logicalId).toBeDefined()

        expect(role.Type).toBe('AWS::IAM::Role')
        expect(role.Properties.ManagedPolicyArns).toContain('arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')
        expect(roleLogicalId).toBeDefined()
      })

      it('should create Lambda with custom timeout and memory', () => {
        const { lambdaFunction } = Compute.createLambdaFunction({
          slug: 'my-function',
          environment: 'production',
          runtime: 'python3.11',
          handler: 'lambda_function.lambda_handler',
          code: { s3Bucket: 'my-bucket', s3Key: 'lambda.zip' },
          timeout: 300,
          memorySize: 1024,
        })

        expect(lambdaFunction.Properties.Timeout).toBe(300)
        expect(lambdaFunction.Properties.MemorySize).toBe(1024)
      })

      it('should include environment variables', () => {
        const { lambdaFunction } = Compute.createLambdaFunction({
          slug: 'my-function',
          environment: 'production',
          runtime: 'nodejs20.x',
          handler: 'index.handler',
          code: { zipFile: 'code' },
          environmentVariables: {
            TABLE_NAME: 'users',
            REGION: 'us-east-1',
          },
        })

        expect(lambdaFunction.Properties.Environment?.Variables).toEqual({
          TABLE_NAME: 'users',
          REGION: 'us-east-1',
        })
      })

      it('should configure VPC when provided', () => {
        const { lambdaFunction, role } = Compute.createLambdaFunction({
          slug: 'my-function',
          environment: 'production',
          runtime: 'nodejs20.x',
          handler: 'index.handler',
          code: { zipFile: 'code' },
          vpcConfig: {
            securityGroupIds: ['sg-123'],
            subnetIds: ['subnet-123', 'subnet-456'],
          },
        })

        expect(lambdaFunction.Properties.VpcConfig).toBeDefined()
        expect(lambdaFunction.Properties.VpcConfig?.SecurityGroupIds).toEqual(['sg-123'])
        expect(lambdaFunction.Properties.VpcConfig?.SubnetIds).toEqual(['subnet-123', 'subnet-456'])

        // Should include VPC execution role
        expect(role.Properties.ManagedPolicyArns).toContain('arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole')
      })
    })
  })

  describe('User Data Scripts', () => {
    describe('generateNodeServerUserData', () => {
      it('should generate Node.js server setup script', () => {
        const userData = Compute.generateNodeServerUserData({
          nodeVersion: '20',
          appRepo: 'https://github.com/user/app.git',
          environment: {
            NODE_ENV: 'production',
            PORT: '3000',
          },
        })

        expect(userData).toContain('#!/bin/bash')
        expect(userData).toContain('nodejs')
        expect(userData).toContain('pm2')
        expect(userData).toContain('caddy')
        expect(userData).toContain('NODE_ENV')
        expect(userData).toContain('PORT')
        expect(userData).toContain('github.com/user/app.git')
      })
    })

    describe('generateBunServerUserData', () => {
      it('should generate Bun server setup script', () => {
        const userData = Compute.generateBunServerUserData({
          appRepo: 'https://github.com/user/app.git',
          environment: {
            NODE_ENV: 'production',
          },
        })

        expect(userData).toContain('#!/bin/bash')
        expect(userData).toContain('bun.sh/install')
        expect(userData).toContain('caddy')
        expect(userData).toContain('systemd')
        expect(userData).toContain('NODE_ENV')
        expect(userData).toContain('github.com/user/app.git')
      })
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should create complete server infrastructure', () => {
      const template = new TemplateBuilder('Server Infrastructure')

      // Security group
      const { securityGroup, logicalId: sgId } = Compute.createWebServerSecurityGroup('my-app', 'production')
      template.addResource(sgId, securityGroup)

      // EC2 instance
      const { instance, logicalId: instanceId } = Compute.createServer({
        slug: 'my-app',
        environment: 'production',
        instanceType: 't3.small',
        keyName: 'my-key',
        securityGroupIds: [sgId],
        userData: Compute.generateBunServerUserData({
          appRepo: 'https://github.com/user/app.git',
        }),
      })
      template.addResource(instanceId, instance)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(2)
      expect(result.Resources[sgId].Type).toBe('AWS::EC2::SecurityGroup')
      expect(result.Resources[instanceId].Type).toBe('AWS::EC2::Instance')
    })

    it('should create complete Fargate infrastructure with ALB', () => {
      const template = new TemplateBuilder('Fargate Infrastructure')

      // Load balancer
      const { loadBalancer, logicalId: albId } = Compute.createLoadBalancer({
        slug: 'my-app',
        environment: 'production',
        subnets: ['subnet-123', 'subnet-456'],
        securityGroups: ['sg-alb'],
      })
      template.addResource(albId, loadBalancer)

      // Target group
      const { targetGroup, logicalId: tgId } = Compute.createTargetGroup({
        slug: 'my-app',
        environment: 'production',
        port: 8080,
        vpcId: 'vpc-123',
        healthCheckPath: '/health',
      })
      template.addResource(tgId, targetGroup)

      // Listener
      const { listener, logicalId: listenerId } = Compute.createListener(albId, {
        port: 80,
        defaultTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/my-tg',
      })
      template.addResource(listenerId, listener)

      // Fargate service
      const fargateResult = Compute.createFargateService({
        slug: 'my-app',
        environment: 'production',
        image: 'my-app:latest',
        cpu: '256',
        memory: '512',
        containerPort: 8080,
        subnets: ['subnet-123'],
        securityGroups: ['sg-123'],
        environmentVariables: {
          NODE_ENV: 'production',
        },
        logGroup: '/ecs/my-app',
      })

      template.addResource(fargateResult.clusterLogicalId, fargateResult.cluster)
      template.addResource(fargateResult.taskDefinitionLogicalId, fargateResult.taskDefinition)
      template.addResource(fargateResult.serviceLogicalId, fargateResult.service)
      template.addResource(fargateResult.taskRoleLogicalId, fargateResult.taskRole)
      template.addResource(fargateResult.executionRoleLogicalId, fargateResult.executionRole)

      const result = template.build()

      // ALB + TG + Listener + Cluster + TaskDef + Service + TaskRole + ExecRole = 8 resources
      expect(Object.keys(result.Resources)).toHaveLength(8)
      expect(result.Resources[albId].Type).toBe('AWS::ElasticLoadBalancingV2::LoadBalancer')
      expect(result.Resources[tgId].Type).toBe('AWS::ElasticLoadBalancingV2::TargetGroup')
      expect(result.Resources[fargateResult.clusterLogicalId].Type).toBe('AWS::ECS::Cluster')
      expect(result.Resources[fargateResult.taskDefinitionLogicalId].Type).toBe('AWS::ECS::TaskDefinition')
      expect(result.Resources[fargateResult.serviceLogicalId].Type).toBe('AWS::ECS::Service')
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('Compute Test')

      const { lambdaFunction, role, logicalId, roleLogicalId } = Compute.createLambdaFunction({
        slug: 'test-function',
        environment: 'development',
        runtime: 'nodejs20.x',
        handler: 'index.handler',
        code: { zipFile: 'exports.handler = async () => ({ statusCode: 200 })' },
      })

      template.addResource(logicalId, lambdaFunction)
      template.addResource(roleLogicalId, role)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::Lambda::Function')
      expect(parsed.Resources[roleLogicalId].Type).toBe('AWS::IAM::Role')
    })
  })

  describe('Auto Scaling', () => {
    describe('createLaunchConfiguration', () => {
      it('should create a launch configuration', () => {
        const { launchConfiguration, logicalId } = Compute.createLaunchConfiguration({
          slug: 'test-app',
          environment: 'production',
          imageId: 'ami-12345678',
          instanceType: 't3.micro',
        })

        expect(launchConfiguration.Type).toBe('AWS::AutoScaling::LaunchConfiguration')
        expect(launchConfiguration.Properties.ImageId).toBe('ami-12345678')
        expect(launchConfiguration.Properties.InstanceType).toBe('t3.micro')
        expect(launchConfiguration.Properties.BlockDeviceMappings).toBeDefined()
        expect(launchConfiguration.Properties.BlockDeviceMappings?.[0].Ebs?.VolumeSize).toBe(20)
        expect(launchConfiguration.Properties.BlockDeviceMappings?.[0].Ebs?.Encrypted).toBe(true)
        expect(logicalId).toBe('TestAppProductionLaunchConfig')
      })

      it('should include security groups when provided', () => {
        const { launchConfiguration } = Compute.createLaunchConfiguration({
          slug: 'test-app',
          environment: 'production',
          imageId: 'ami-12345678',
          instanceType: 't3.micro',
          securityGroups: [{ Ref: 'WebServerSecurityGroup' }],
        })

        expect(launchConfiguration.Properties.SecurityGroups).toEqual([{ Ref: 'WebServerSecurityGroup' }])
      })

      it('should include user data when provided', () => {
        const { launchConfiguration } = Compute.createLaunchConfiguration({
          slug: 'test-app',
          environment: 'production',
          imageId: 'ami-12345678',
          instanceType: 't3.micro',
          userData: '#!/bin/bash\necho "Hello"',
        })

        expect(launchConfiguration.Properties.UserData).toBeDefined()
        expect(launchConfiguration.Properties.UserData).toHaveProperty('Fn::Base64')
      })
    })

    describe('createAutoScalingGroup', () => {
      it('should create an auto scaling group', () => {
        const { autoScalingGroup, logicalId } = Compute.createAutoScalingGroup({
          slug: 'test-app',
          environment: 'production',
          launchConfigurationName: { Ref: 'MyLaunchConfig' },
          minSize: 2,
          maxSize: 4,
        })

        expect(autoScalingGroup.Type).toBe('AWS::AutoScaling::AutoScalingGroup')
        expect(autoScalingGroup.Properties.MinSize).toBe(2)
        expect(autoScalingGroup.Properties.MaxSize).toBe(4)
        expect(autoScalingGroup.Properties.LaunchConfigurationName).toEqual({ Ref: 'MyLaunchConfig' })
        expect(autoScalingGroup.Properties.Tags).toBeDefined()
        expect(logicalId).toBe('TestAppProductionAsg')
      })

      it('should set desired capacity when provided', () => {
        const { autoScalingGroup } = Compute.createAutoScalingGroup({
          slug: 'test-app',
          environment: 'production',
          launchConfigurationName: { Ref: 'MyLaunchConfig' },
          minSize: 2,
          maxSize: 4,
          desiredCapacity: 3,
        })

        expect(autoScalingGroup.Properties.DesiredCapacity).toBe(3)
      })

      it('should include VPC subnets when provided', () => {
        const { autoScalingGroup } = Compute.createAutoScalingGroup({
          slug: 'test-app',
          environment: 'production',
          launchConfigurationName: { Ref: 'MyLaunchConfig' },
          minSize: 2,
          maxSize: 4,
          vpcZoneIdentifier: ['subnet-123', 'subnet-456'],
        })

        expect(autoScalingGroup.Properties.VPCZoneIdentifier).toEqual(['subnet-123', 'subnet-456'])
      })

      it('should include target groups when provided', () => {
        const { autoScalingGroup } = Compute.createAutoScalingGroup({
          slug: 'test-app',
          environment: 'production',
          launchConfigurationName: { Ref: 'MyLaunchConfig' },
          minSize: 2,
          maxSize: 4,
          targetGroupArns: [{ Ref: 'MyTargetGroup' }],
        })

        expect(autoScalingGroup.Properties.TargetGroupARNs).toEqual([{ Ref: 'MyTargetGroup' }])
      })

      it('should include rolling update policy', () => {
        const { autoScalingGroup } = Compute.createAutoScalingGroup({
          slug: 'test-app',
          environment: 'production',
          launchConfigurationName: { Ref: 'MyLaunchConfig' },
          minSize: 2,
          maxSize: 4,
        })

        expect(autoScalingGroup.UpdatePolicy).toBeDefined()
        expect(autoScalingGroup.UpdatePolicy?.AutoScalingRollingUpdate).toBeDefined()
        expect(autoScalingGroup.UpdatePolicy?.AutoScalingRollingUpdate?.MaxBatchSize).toBe(1)
      })
    })

    describe('createScalingPolicy', () => {
      it('should create a CPU-based scaling policy', () => {
        const { scalingPolicy, logicalId } = Compute.createScalingPolicy({
          slug: 'test-app',
          environment: 'production',
          autoScalingGroupName: { Ref: 'MyASG' },
        })

        expect(scalingPolicy.Type).toBe('AWS::AutoScaling::ScalingPolicy')
        expect(scalingPolicy.Properties.PolicyType).toBe('TargetTrackingScaling')
        expect(scalingPolicy.Properties.AutoScalingGroupName).toEqual({ Ref: 'MyASG' })
        expect(scalingPolicy.Properties.TargetTrackingConfiguration).toBeDefined()
        expect(scalingPolicy.Properties.TargetTrackingConfiguration?.TargetValue).toBe(70)
        expect(scalingPolicy.Properties.TargetTrackingConfiguration?.PredefinedMetricSpecification?.PredefinedMetricType).toBe('ASGAverageCPUUtilization')
        expect(logicalId).toBe('TestAppProductionScalingPolicy')
      })

      it('should allow custom target value', () => {
        const { scalingPolicy } = Compute.createScalingPolicy({
          slug: 'test-app',
          environment: 'production',
          autoScalingGroupName: { Ref: 'MyASG' },
          targetValue: 80,
        })

        expect(scalingPolicy.Properties.TargetTrackingConfiguration?.TargetValue).toBe(80)
      })

      it('should allow custom metric type', () => {
        const { scalingPolicy } = Compute.createScalingPolicy({
          slug: 'test-app',
          environment: 'production',
          autoScalingGroupName: { Ref: 'MyASG' },
          predefinedMetricType: 'ALBRequestCountPerTarget',
        })

        expect(scalingPolicy.Properties.TargetTrackingConfiguration?.PredefinedMetricSpecification?.PredefinedMetricType).toBe('ALBRequestCountPerTarget')
      })
    })

    describe('AutoScaling presets', () => {
      it('should create small web server auto scaling', () => {
        const { autoScalingGroup } = Compute.AutoScaling.smallWebServer(
          'test-app',
          'production',
          { Ref: 'MyLaunchConfig' },
          ['subnet-123', 'subnet-456'],
        )

        expect(autoScalingGroup.Properties.MinSize).toBe(2)
        expect(autoScalingGroup.Properties.MaxSize).toBe(4)
        expect(autoScalingGroup.Properties.DesiredCapacity).toBe(2)
      })

      it('should create medium web server auto scaling', () => {
        const { autoScalingGroup } = Compute.AutoScaling.mediumWebServer(
          'test-app',
          'production',
          { Ref: 'MyLaunchConfig' },
          ['subnet-123', 'subnet-456'],
        )

        expect(autoScalingGroup.Properties.MinSize).toBe(3)
        expect(autoScalingGroup.Properties.MaxSize).toBe(10)
        expect(autoScalingGroup.Properties.DesiredCapacity).toBe(3)
      })

      it('should create large web server auto scaling', () => {
        const { autoScalingGroup } = Compute.AutoScaling.largeWebServer(
          'test-app',
          'production',
          { Ref: 'MyLaunchConfig' },
          ['subnet-123', 'subnet-456'],
        )

        expect(autoScalingGroup.Properties.MinSize).toBe(5)
        expect(autoScalingGroup.Properties.MaxSize).toBe(20)
        expect(autoScalingGroup.Properties.DesiredCapacity).toBe(5)
      })

      it('should create CPU scaling policy', () => {
        const { scalingPolicy } = Compute.AutoScaling.cpuScaling(
          'test-app',
          'production',
          { Ref: 'MyASG' },
          75,
        )

        expect(scalingPolicy.Properties.TargetTrackingConfiguration?.PredefinedMetricSpecification?.PredefinedMetricType).toBe('ASGAverageCPUUtilization')
        expect(scalingPolicy.Properties.TargetTrackingConfiguration?.TargetValue).toBe(75)
      })

      it('should create request count scaling policy', () => {
        const { scalingPolicy } = Compute.AutoScaling.requestCountScaling(
          'test-app',
          'production',
          { Ref: 'MyASG' },
          500,
        )

        expect(scalingPolicy.Properties.TargetTrackingConfiguration?.PredefinedMetricSpecification?.PredefinedMetricType).toBe('ALBRequestCountPerTarget')
        expect(scalingPolicy.Properties.TargetTrackingConfiguration?.TargetValue).toBe(500)
      })
    })
  })
})
