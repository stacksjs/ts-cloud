import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dashboardActions,
  resolveDashboardAction,
  runDashboardAction,
  sanitizeCloudConfig,
} from '../../src/deploy/local-dashboard-server'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('local dashboard server helpers', () => {
  it('exposes an allowlisted action model with explicit mutation confirmation', () => {
    const actions = dashboardActions('production' as any)
    expect(actions.map((action) => action.id)).toEqual(['status', 'doctor', 'security-scan', 'deploy'])
    expect(resolveDashboardAction('deploy', 'production' as any)?.confirm).toBe('deploy')
    expect(resolveDashboardAction('deploy', 'production' as any)?.mutates).toBe(true)
    expect(resolveDashboardAction('rm -rf', 'production' as any)).toBeUndefined()
  })

  it('sanitizes cloud config for the browser API', () => {
    const sanitized = sanitizeCloudConfig({
      project: { name: 'Stacks', slug: 'stacks', region: 'us-east-1' },
      provider: 'hetzner',
      environments: { production: {} },
      infrastructure: {
        compute: {
          runtime: 'bun',
          webServer: 'rpx',
          proxy: {
            engine: 'rpx',
            onDemandTls: true,
            cdn: { secret: 'do-not-leak', frontedHosts: ['example.com'], originDomain: 'origin.example.com' },
          },
          sshKeys: [
            {
              name: 'chris@macbook',
              publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEFnZmFrZWtleWJvZHlmb3J0ZXN0b25seTEyMzQ chris@macbook',
            },
          ],
        },
      },
      sites: {
        app: { domain: 'example.com', root: 'dist', port: 3000 },
      },
    } as any)

    expect(sanitized.compute.proxy).toEqual({ engine: 'rpx', onDemandTls: true, cdn: true })
    expect(sanitized.compute.sshKeys[0].name).toBe('chris@macbook')
    expect(sanitized.compute.sshKeys[0].fingerprint.startsWith('SHA256:')).toBe(true)
    expect(JSON.stringify(sanitized)).not.toContain('do-not-leak')
    expect(JSON.stringify(sanitized)).not.toContain('AAAAC3Nza')
    expect(sanitized.sites.app.domain).toBe('example.com')
  })

  it('streams child process output and terminates it on cancellation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-cloud-action-'))
    roots.push(root)
    const cliEntry = join(root, 'fixture.ts')
    writeFileSync(cliEntry, `console.log('started')\nawait Bun.sleep(5_000)\nconsole.error('should-not-finish')\n`)
    const controller = new AbortController()
    const chunks: string[] = []
    const startedAt = Date.now()
    const result = await runDashboardAction(
      { id: 'stream', label: 'Stream', description: 'Stream', command: [], mutates: true },
      {
        cwd: root,
        cliEntry,
        signal: controller.signal,
        onOutput: (_stream, chunk) => {
          chunks.push(chunk)
          if (chunk.includes('started')) controller.abort()
        },
      },
    )
    expect(chunks.join('')).toContain('started')
    expect(chunks.join('')).not.toContain('should-not-finish')
    expect(result.ok).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })
})
