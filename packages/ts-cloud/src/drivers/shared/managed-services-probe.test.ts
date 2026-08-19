import { describe, expect, it } from 'bun:test'
import {
  buildManagedServicesProbeScript,
  declaredManagedServices,
  formatMissingManagedServicesError,
  parseMissingManagedServices,
} from './managed-services-probe'

describe('declaredManagedServices', () => {
  it('lists the enabled services, object form included', () => {
    expect(declaredManagedServices({ postgres: true, redis: { version: '7' }, mysql: false }))
      .toEqual(['postgres', 'redis'])
  })

  it('is empty for no config at all', () => {
    expect(declaredManagedServices(undefined)).toEqual([])
    expect(declaredManagedServices({})).toEqual([])
  })
})

describe('buildManagedServicesProbeScript', () => {
  it('probes each declared service by binary and by port', () => {
    const out = buildManagedServicesProbeScript(['postgres', 'redis']).join('\n')
    expect(out).toContain('ts_cloud_probe postgres 5432 postgres psql')
    expect(out).toContain('ts_cloud_probe redis 6379 redis-server redis-cli')
  })

  /**
   * A missing service is a finding to report, not a remote failure — the probe
   * must come back with its answer rather than a non-zero exit.
   */
  it('always exits 0', () => {
    expect(buildManagedServicesProbeScript(['postgres']).at(-1)).toBe('exit 0')
  })

  it('builds nothing when nothing is declared', () => {
    expect(buildManagedServicesProbeScript([])).toEqual([])
  })
})

describe('parseMissingManagedServices', () => {
  it('reports only what the box said was missing', () => {
    const output = 'ts-cloud-service:postgres:missing\nts-cloud-service:redis:present\n'
    expect(parseMissingManagedServices(output, ['postgres', 'redis'])).toEqual(['postgres'])
  })

  /**
   * Silence is not evidence of absence: an older box, or a truncated capture,
   * must not invent a failure and block a deploy that is fine.
   */
  it('reports nothing when the probe said nothing', () => {
    expect(parseMissingManagedServices('', ['postgres'])).toEqual([])
    expect(parseMissingManagedServices(undefined, ['postgres'])).toEqual([])
    expect(parseMissingManagedServices('some unrelated output', ['postgres'])).toEqual([])
  })
})

describe('formatMissingManagedServicesError', () => {
  it('names the setting, the owner, the host, and the ways out', () => {
    const message = formatMissingManagedServicesError(['postgres'], 'uptime-status', '10.0.0.1')
    expect(message).toContain('managedServices.postgres')
    expect(message).toContain("'uptime-status'")
    expect(message).toContain('10.0.0.1')
    expect(message).toContain('Attach mode does not provision services')
  })

  it('reads correctly for several services', () => {
    const message = formatMissingManagedServicesError(['postgres', 'redis'], 'owner', undefined)
    expect(message).toContain('managedServices.postgres, managedServices.redis')
    expect(message).toContain('none of postgres, redis')
  })
})
