import type { ApplicationDraftInput } from './types'
import { describe, expect, it } from 'bun:test'
import { inspectApplicationArchive } from './archive'
import { detectApplication } from './detection'
import { parseApplicationManifest, planApplication } from './plan'

function base(build: ApplicationDraftInput['build'], runtime: ApplicationDraftInput['runtime']): ApplicationDraftInput {
  return { schemaVersion: 1, name: 'Web', slug: 'web', projectId: 'project', environmentId: 'production', source: { kind: 'local', root: '.' }, build, runtime }
}

function storedZip(path: string, content = 'hello'): Uint8Array {
  const name = new TextEncoder().encode(path); const body = new TextEncoder().encode(content); const bytes = new Uint8Array(30 + name.length + body.length); const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(8, 0, true); view.setUint32(18, body.length, true); view.setUint32(22, body.length, true); view.setUint16(26, name.length, true)
  bytes.set(name, 30); bytes.set(body, 30 + name.length); return bytes
}

function tar(path: string, kind = '0'): Uint8Array {
  const bytes = new Uint8Array(1024); const encoder = new TextEncoder(); bytes.set(encoder.encode(path), 0); bytes.set(encoder.encode('00000000000\0'), 124); bytes[156] = kind.charCodeAt(0); return bytes
}

describe('application detection', () => {
  it('detects Dockerfile, Bun/Node, Laravel, PHP, and static projects from explicit evidence', () => {
    expect(detectApplication([{ path: 'Dockerfile', content: 'FROM oven/bun' }, { path: 'package.json', content: '{"scripts":{"start":"bun index.ts"}}' }, { path: 'bun.lock' }]).map(item => item.framework)).toEqual(['dockerfile', 'bun'])
    expect(detectApplication([{ path: 'package.json', content: '{"scripts":{"start":"node server.js"}}' }, { path: 'package-lock.json' }])[0]).toMatchObject({ framework: 'node', strategy: 'server' })
    expect(detectApplication([{ path: 'artisan' }, { path: 'composer.json', content: '{"require":{"laravel/framework":"^12"}}' }])[0]).toMatchObject({ framework: 'laravel', confidence: .98 })
    expect(detectApplication([{ path: 'composer.json', content: '{"require":{}}' }])[0]).toMatchObject({ framework: 'php' })
    expect(detectApplication([{ path: 'index.html' }])[0]).toMatchObject({ framework: 'static', strategy: 'static' })
  })

  it('keeps ambiguous evidence ranked and unsupported projects manually configurable', () => {
    const ambiguous = detectApplication([{ path: 'Dockerfile' }, { path: 'package.json', content: '{}' }, { path: 'bun.lock' }])
    expect(ambiguous).toHaveLength(2)
    expect(ambiguous[0]).toMatchObject({ framework: 'dockerfile', confidence: .99 })
    expect(detectApplication([{ path: 'README.md' }])[0]).toMatchObject({ framework: 'unknown', strategy: 'buildpack', confidence: .2 })
  })
})

describe('application planning', () => {
  it('round-trips deterministic manifests for four build strategies', () => {
    const drafts = [
      base({ kind: 'server', runtime: 'bun', startCommand: 'bun run start' }, { target: 'server', architecture: 'arm64', port: 3000, healthCheck: { protocol: 'http', path: '/health' } }),
      base({ kind: 'static', publishDirectory: 'dist', buildCommand: 'bun run build' }, { target: 'serverless', architecture: 'x86_64' }),
      base({ kind: 'dockerfile', context: '.', dockerfile: 'Dockerfile', target: 'release' }, { target: 'container', architecture: 'x86_64', port: 8080, healthCheck: { protocol: 'tcp' } }),
      { ...base({ kind: 'prebuilt_image', image: 'registry.example/acme/web@sha256:abc' }, { target: 'container', architecture: 'arm64', port: 8080, healthCheck: { protocol: 'http', path: '/ready' } }), source: { kind: 'image', image: 'registry.example/acme/web@sha256:abc' } as const },
    ]
    for (const draft of drafts) {
      const first = planApplication(draft)
      const second = planApplication(draft)
      expect(first.valid).toBe(true)
      expect(first.serializedManifest).toBe(second.serializedManifest)
      expect(parseApplicationManifest(first.serializedManifest)).toEqual(first.manifest)
    }
  })

  it('fails invalid combinations before mutation and redacts misplaced secrets', () => {
    const draft = base({ kind: 'dockerfile', context: '../escape', dockerfile: '/Dockerfile', buildArgs: { API_TOKEN: 'do-not-leak' }, secretNames: ['REGISTRY_PASSWORD'] }, { target: 'serverless', architecture: 'x86_64', port: 70000, healthCheck: { protocol: 'http', path: 'health' } })
    draft.environment = { DATABASE_PASSWORD: 'do-not-leak-either' }
    draft.domain = { hostname: 'not a domain' }
    const plan = planApplication(draft)
    expect(plan.valid).toBe(false)
    expect(plan.issues.map(item => item.code)).toEqual(expect.arrayContaining(['write_only_secret_required', 'write_only_build_secret_required', 'unsafe_docker_path', 'unsupported_serverless_dockerfile', 'invalid_port', 'invalid_health_path', 'invalid_domain']))
    expect(plan.missingSecrets).toEqual(['DATABASE_PASSWORD', 'REGISTRY_PASSWORD'])
    expect(JSON.stringify(plan)).not.toContain('do-not-leak')
  })
})

describe('application archive inspection', () => {
  it('accepts bounded safe ZIP and TAR entries without extracting them', () => {
    expect(inspectApplicationArchive(storedZip('dist/index.html'), 'site.zip')).toMatchObject({ format: 'zip', entries: 1, expandedBytes: 5, paths: ['dist/index.html'] })
    expect(inspectApplicationArchive(tar('public/index.html'), 'site.tar')).toMatchObject({ format: 'tar', entries: 1, paths: ['public/index.html'] })
  })

  it('rejects traversal, links, malformed formats, and expansion limits', () => {
    expect(() => inspectApplicationArchive(storedZip('../secret'), 'bad.zip')).toThrow('Unsafe archive path')
    expect(() => inspectApplicationArchive(tar('link', '2'), 'bad.tar')).toThrow('links are not accepted')
    expect(() => inspectApplicationArchive(storedZip('large', '123456'), 'large.zip', { maxExpandedBytes: 5 })).toThrow('expansion limit')
    expect(() => inspectApplicationArchive(new Uint8Array([1, 2, 3]), 'bad.exe')).toThrow('Only ZIP')
  })
})
