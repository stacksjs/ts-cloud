import { describe, expect, it } from 'bun:test'
import {
  resolveDeployBucketName,
  resolveProjectStackName,
  resolveSiteResourceName,
  resolveSiteStackName,
  resolveStorageBucketName,
} from '../src/stack-naming'

const baseConfig = {
  project: {
    name: 'Pantry',
    slug: 'pantry',
    region: 'us-east-1',
  },
}

describe('stack-naming', () => {
  it('resolves project stack as slug-environment', () => {
    expect(resolveProjectStackName(baseConfig, 'production')).toBe('pantry-production')
  })

  it('honors project.stackName override', () => {
    expect(resolveProjectStackName({
      project: { ...baseConfig.project, stackName: 'pantry-sh-main-static-site' },
    }, 'production')).toBe('pantry-sh-main-static-site')
  })

  it('resolves site stack as slug-environment-siteKey-site', () => {
    expect(resolveSiteStackName(baseConfig, 'main', {}, 'production')).toBe('pantry-production-main-site')
  })

  it('honors site.stackName override', () => {
    expect(resolveSiteStackName(baseConfig, 'main', {
      stackName: 'pantry-sh-main-static-site',
    }, 'production')).toBe('pantry-sh-main-static-site')
  })

  it('resolves site resource prefix as slug-siteKey', () => {
    expect(resolveSiteResourceName(baseConfig, 'main')).toBe('pantry-main')
  })

  it('resolves storage bucket names', () => {
    expect(resolveStorageBucketName('pantry', 'production', 'binaries')).toBe('pantry-production-binaries')
    expect(resolveStorageBucketName('pantry', 'production', 'site', 'pantry-dev-site')).toBe('pantry-dev-site')
  })

  it('resolves deploy bucket name', () => {
    expect(resolveDeployBucketName('pantry', 'production')).toBe('pantry-production-deploy')
  })
})
