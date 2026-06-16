import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import {
  awsComputeIngressRules,
  buildAwsUserData,
  encodeUserData,
  resolveAwsImageId,
  UBUNTU_AMI_SSM_PARAM,
} from '../../src/drivers/aws/provision'

const phpConfig: CloudConfig = {
  project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
  environments: { production: { type: 'production' } },
  infrastructure: {
    compute: {
      runtime: 'php',
      webServer: 'nginx',
      php: { versions: ['8.3'], default: '8.3' },
      managedServices: { mysql: true },
    },
  },
  sites: {
    main: { root: '.', type: 'laravel', domain: 'acme.com', repository: { url: 'git@github.com:acme/app.git' } },
    ws: { root: '.', deploy: 'server', start: 'bun run ws.ts', port: 6001 },
  },
}

describe('awsComputeIngressRules', () => {
  it('opens SSH/HTTP/HTTPS plus app ports', () => {
    const rules = awsComputeIngressRules(phpConfig)
    const ports = rules.map(r => r.port).sort((a, b) => a - b)
    expect(ports).toContain(22)
    expect(ports).toContain(80)
    expect(ports).toContain(443)
    expect(ports).toContain(6001)
  })
})

describe('buildAwsUserData', () => {
  it('uses the same Ubuntu apt bootstrap as Hetzner (nginx + php-fpm)', () => {
    const ud = buildAwsUserData(phpConfig)
    expect(ud).toContain('#!/bin/bash')
    expect(ud).toContain('pantry install')
    expect(ud).toContain('php.net@8.3')
    expect(ud).toContain('mysql.com')
  })

  it('skips installs for a baked golden image', () => {
    const baked: CloudConfig = {
      ...phpConfig,
      infrastructure: { compute: { ...phpConfig.infrastructure!.compute, image: 'ami-123', bakedImage: true } },
    }
    const ud = buildAwsUserData(baked)
    expect(ud).not.toContain('php.net@8.3')
    expect(ud).toContain('mkdir -p /var/www')
  })
})

describe('resolveAwsImageId', () => {
  it('returns the explicit golden AMI, else null (resolve Ubuntu via SSM)', () => {
    expect(resolveAwsImageId({ ...phpConfig, infrastructure: { compute: { image: 'ami-xyz' } } })).toBe('ami-xyz')
    expect(resolveAwsImageId(phpConfig)).toBeNull()
    expect(UBUNTU_AMI_SSM_PARAM).toContain('ubuntu/server/24.04')
  })
})

describe('encodeUserData', () => {
  it('base64-encodes for the RunInstances API', () => {
    expect(encodeUserData('hello')).toBe(Buffer.from('hello').toString('base64'))
  })
})
