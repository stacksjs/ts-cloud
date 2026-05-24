import { describe, expect, it } from 'bun:test'
import { buildCaddyfile } from '../../src/drivers/shared/caddyfile'
import {
  buildAwsArtifactFetch,
  buildLocalArtifactFetch,
  buildSiteDeployScript,
  resolveExecStart,
} from '../../src/drivers/shared/deploy-script'

describe('resolveExecStart', () => {
  it('rewrites bun start commands to absolute binary path', () => {
    expect(resolveExecStart('bun run server.ts', 'bun')).toBe('/usr/local/bin/bun run server.ts')
  })

  it('rewrites node start commands', () => {
    expect(resolveExecStart('node dist/index.js', 'node')).toBe('/usr/local/bin/node dist/index.js')
  })
})

describe('buildSiteDeployScript', () => {
  it('generates systemd unit and env file commands', () => {
    const script = buildSiteDeployScript({
      siteName: 'web',
      slug: 'my-app',
      artifactFetch: buildLocalArtifactFetch('/var/ts-cloud/staging/release.tar.gz', 'web'),
      execStart: '/usr/local/bin/bun run server.ts',
      envEntries: { NODE_ENV: 'production' },
      port: 3000,
    })

    expect(script[0]).toBe('set -euo pipefail')
    expect(script.join('\n')).toContain('cp "/var/ts-cloud/staging/release.tar.gz" /tmp/web-release.tar.gz')
    expect(script.join('\n')).toContain('WorkingDirectory=/var/www/web')
    expect(script.join('\n')).toContain('ExecStart=/usr/local/bin/bun run server.ts')
    expect(script.join('\n')).toContain('Environment=PORT=3000')
    expect(script.join('\n')).toContain('NODE_ENV="production"')
    expect(script.join('\n')).toContain('systemctl restart my-app-web.service')
  })
})

describe('buildAwsArtifactFetch', () => {
  it('pulls tarball from S3 before extraction', () => {
    expect(buildAwsArtifactFetch('my-app-production-deploy', 'releases/web/abc.tar.gz', 'us-east-1', 'web'))
      .toEqual([
        'aws s3 cp "s3://my-app-production-deploy/releases/web/abc.tar.gz" /tmp/web-release.tar.gz --region us-east-1',
      ])
  })
})

describe('buildCaddyfile', () => {
  it('groups sites by domain with path-specific handles first', () => {
    const caddyfile = buildCaddyfile({
      api: { domain: 'example.com', port: 3001, path: '/api', root: '.output', build: 'bun run build', start: 'bun run api.ts' },
      web: { domain: 'example.com', port: 3000, root: '.output', build: 'bun run build', start: 'bun run web.ts' },
    })

    expect(caddyfile).toContain('example.com {')
    expect(caddyfile!.indexOf('handle /api')).toBeLessThan(caddyfile!.indexOf('handle {'))
    expect(caddyfile).toContain('reverse_proxy localhost:3001')
    expect(caddyfile).toContain('reverse_proxy localhost:3000')
  })
})
