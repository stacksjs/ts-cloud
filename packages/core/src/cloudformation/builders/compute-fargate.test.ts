import { describe, expect, it } from 'bun:test'
import { CloudFormationBuilder } from '../builder'

function build() {
  return new CloudFormationBuilder({
    project: { name: 'Full stack', slug: 'full-stack', region: 'us-east-1' },
    environments: { production: { type: 'production' } },
    infrastructure: {
      network: { vpc: { availabilityZones: 2, natGateways: 1 } },
      compute: {
        fargate: {
          taskDefinition: {
            cpu: '256',
            memory: '512',
            containerDefinitions: [
              {
                name: 'api',
                image: '123.dkr.ecr.us-east-1.amazonaws.com/api@sha256:abc',
                portMappings: [{ containerPort: 3000 }],
                environment: { NODE_ENV: 'production' },
                secrets: [
                  { name: 'DATABASE_PASSWORD', valueFrom: 'arn:aws:secretsmanager:us-east-1:123:secret:db:password::' },
                ],
              },
            ],
          },
          service: {
            desiredCount: 2,
            healthCheck: { path: '/api/health' },
            autoScaling: { min: 2, max: 6, targetCPU: 65 },
          },
          loadBalancer: {
            type: 'application',
            customDomain: { domain: 'api.example.com', certificateArn: 'arn:aws:acm:us-east-1:123:certificate/one' },
            originVerifyHeader: { name: 'X-Origin-Verify', value: 'long-random-value' },
          },
        },
      },
    } as any,
  }).build()
}

describe('Fargate CloudFormation resources', () => {
  it('creates an ALB-connected service with private tasks and circuit-breaker rollback', () => {
    const result = build()
    expect(result.Resources.ALBSecurityGroup).toBeDefined()
    expect(result.Resources.AppSecurityGroup).toBeDefined()
    expect(result.Resources.AppTargetGroup?.Properties?.TargetType).toBe('ip')
    expect(result.Resources.AppTargetGroup?.Properties?.HealthCheckPath).toBe('/api/health')
    expect(result.Resources.AppHttpsListener?.Properties?.SslPolicy).toContain('TLS13')
    expect(result.Resources.AppHttpsListener?.Properties?.DefaultActions[0].Type).toBe('fixed-response')
    expect(result.Resources.AppLoadBalancer?.Properties?.LoadBalancerAttributes).toContainEqual({
      Key: 'deletion_protection.enabled',
      Value: 'false',
    })
    expect(result.Resources.AppOriginVerifyRule?.Properties?.Conditions[0].HttpHeaderConfig).toEqual({
      HttpHeaderName: 'X-Origin-Verify',
      Values: ['long-random-value'],
    })
    expect(result.Resources.AppService?.Properties?.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp).toBe(
      'DISABLED',
    )
    expect(result.Resources.AppService?.Properties?.LoadBalancers[0]).toEqual({
      ContainerName: 'api',
      ContainerPort: 3000,
      TargetGroupArn: { Ref: 'AppTargetGroup' },
    })
    expect(result.Resources.AppService?.Properties?.DeploymentConfiguration.DeploymentCircuitBreaker).toEqual({
      Enable: true,
      Rollback: true,
    })
  })

  it('normalizes ergonomic container config to CloudFormation and keeps all resource outputs', () => {
    const result = build()
    const container = result.Resources.AppTaskDefinition?.Properties?.ContainerDefinitions[0]
    expect(container.Name).toBe('api')
    expect(container.PortMappings).toEqual([{ ContainerPort: 3000, Protocol: 'tcp' }])
    expect(container.Environment).toEqual([{ Name: 'NODE_ENV', Value: 'production' }])
    expect(container.Secrets[0].Name).toBe('DATABASE_PASSWORD')
    expect(result.Resources.AppTaskExecutionRole?.Properties?.Policies[0].PolicyDocument.Statement[0].Action).toContain(
      'secretsmanager:GetSecretValue',
    )
    expect(container.LogConfiguration.LogDriver).toBe('awslogs')
    expect(result.Outputs?.AppLoadBalancerDnsName).toBeDefined()
    expect(result.Outputs?.VPCId).toBeDefined()
  })

  it('adds bounded target tracking autoscaling', () => {
    const result = build()
    expect(result.Resources.AppScalableTarget?.Properties?.MinCapacity).toBe(2)
    expect(result.Resources.AppScalableTarget?.Properties?.MaxCapacity).toBe(6)
    expect(result.Resources.AppScalingPolicy?.Properties?.TargetTrackingScalingPolicyConfiguration.TargetValue).toBe(65)
  })
})
