import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { deployShipsFiles } from '../../src/deploy/site-target'

function config(sites: CloudConfig['sites'], extra: Partial<CloudConfig> = {}): CloudConfig {
  return {
    project: { name: 'p', slug: 'p', region: 'us-east-1' },
    environments: { production: { type: 'production' } },
    infrastructure: { compute: { size: 'small' } },
    sites,
    ...extra,
  } as CloudConfig
}

describe('deployShipsFiles', () => {
  it('is false when every site is a route, so there is no artifact to scan', () => {
    // The motivating case: a registry whose hosts are all forwarded to a
    // service ts-cloud does not manage. Nothing in the working tree reaches a
    // box, so scanning it only reported findings in code that is not deployed.
    const cfg = config({
      registry: { domain: 'registry.example.com', proxyTo: 'localhost:3001' },
      www: { domain: 'www.example.com', redirect: 'https://example.com' },
    })
    expect(deployShipsFiles(cfg)).toBe(false)
  })

  it('is true as soon as one site ships something', () => {
    const cfg = config({
      registry: { domain: 'registry.example.com', proxyTo: 'localhost:3001' },
      docs: { domain: 'example.com', deploy: 'server', root: 'dist' },
    })
    expect(deployShipsFiles(cfg)).toBe(true)
  })

  it('counts a bucket site as shipping, because it uploads its built root', () => {
    // A bucket site produces no compute release, so `shipsARelease` is false
    // for it — but its files DO leave this machine. Keep the full scan.
    expect(deployShipsFiles(config({ marketing: { domain: 'example.com', root: 'dist' } }))).toBe(true)
  })

  it('keeps the full scan for a serverless project regardless of sites', () => {
    const cfg = config(
      { www: { domain: 'www.example.com', redirect: 'https://example.com' } },
      {
        environments: {
          production: { type: 'production', app: { kind: 'bun', entry: 'server.ts' } },
        },
      } as Partial<CloudConfig>,
    )
    expect(deployShipsFiles(cfg)).toBe(true)
  })

  it('keeps the full scan for an infrastructure-only deploy with no sites', () => {
    expect(deployShipsFiles(config({}))).toBe(true)
  })

  it('honours --site: scoping to one route site still ships nothing', () => {
    const cfg = config({
      registry: { domain: 'registry.example.com', proxyTo: 'localhost:3001' },
      docs: { domain: 'example.com', deploy: 'server', root: 'dist' },
    })
    expect(deployShipsFiles(cfg, 'registry')).toBe(false)
    expect(deployShipsFiles(cfg, 'docs')).toBe(true)
  })

  it('keeps the full scan when --site names something that is not there', () => {
    const cfg = config({ registry: { domain: 'r.example.com', proxyTo: 'localhost:3001' } })
    expect(deployShipsFiles(cfg, 'nope')).toBe(true)
  })
})
