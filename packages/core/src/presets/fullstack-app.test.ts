import { describe, expect, it } from 'bun:test'
import { CloudFormationBuilder } from '../cloudformation/builder'
import { createExistingStaticFullStackPreset } from './fullstack-app'

describe('existing static frontend full-stack preset', () => {
  it('builds only the backend stack with managed stateful services', () => {
    const config = createExistingStaticFullStackPreset({
      name: 'Example',
      slug: 'example',
      domain: 'origin-api.example.com',
      imageUri: '123.dkr.ecr.us-east-1.amazonaws.com/example@sha256:abc',
      certificateArn: 'arn:aws:acm:us-east-1:123:certificate/one',
    })
    const result = new CloudFormationBuilder(config as any).build()
    expect(result.Resources.AppService?.Type).toBe('AWS::ECS::Service')
    expect(result.Resources.PostgresDb?.Type).toBe('AWS::RDS::DBInstance')
    expect(result.Resources.RedisReplicationGroup?.Type).toBe('AWS::ElastiCache::ReplicationGroup')
    expect(result.Resources.JobsQueue?.Type).toBe('AWS::SQS::Queue')
    expect(result.Resources.PostgresDb?.DeletionPolicy).toBe('Snapshot')
    expect(result.Resources.RedisReplicationGroup?.DeletionPolicy).toBe('Snapshot')
    expect(result.Resources.JobsQueue?.DeletionPolicy).toBe('Retain')
    expect(result.Resources.DBSecret?.DeletionPolicy).toBe('Retain')
    expect(result.Resources.FrontendBucket).toBeUndefined()
    expect(result.Resources.CloudFrontDistribution).toBeUndefined()
  })

  it('injects managed endpoints and secret references without literal credentials', () => {
    const config = createExistingStaticFullStackPreset({
      name: 'Example',
      slug: 'example',
      domain: 'origin-api.example.com',
      imageUri: 'image@sha256:abc',
    })
    const result = new CloudFormationBuilder(config as any).build()
    const container = result.Resources.AppTaskDefinition?.Properties?.ContainerDefinitions[0]
    expect(container.Environment.find((item: any) => item.Name === 'DB_HOST').Value).toEqual({
      'Fn::GetAtt': ['PostgresDb', 'Endpoint.Address'],
    })
    expect(container.Environment.find((item: any) => item.Name === 'QUEUE_URL').Value).toEqual({ Ref: 'JobsQueue' })
    expect(container.Secrets.map((item: any) => item.Name)).toEqual(['DB_USERNAME', 'DB_PASSWORD'])
    expect(JSON.stringify(result)).not.toContain('DATABASE_PASSWORD=')
  })
})
