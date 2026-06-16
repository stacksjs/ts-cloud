import type { SiteConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import {
  buildSiteServicesScript,
  queueUnitName,
  schedulerCronPath,
  siteHasServices,
} from '../../src/drivers/shared/laravel-services'

const base = { slug: 'acme', siteName: 'app' }

describe('buildSiteServicesScript — queue workers', () => {
  const site: SiteConfig = {
    root: '.',
    type: 'laravel',
    phpVersion: '8.3',
    queues: [{ connection: 'redis', queue: 'default,emails', processes: 2, tries: 5, timeout: 90 }],
  }
  const script = buildSiteServicesScript({ ...base, site }).join('\n')

  it('writes one systemd unit per process', () => {
    expect(script).toContain('/etc/systemd/system/acme-app-queue-0.service')
    expect(script).toContain('/etc/systemd/system/acme-app-queue-1.service')
  })

  it('renders the queue:work command with tuning flags', () => {
    expect(script).toContain('php8.3 /var/www/app/current/artisan queue:work redis --queue=default,emails')
    expect(script).toContain('--tries=5')
    expect(script).toContain('--timeout=90')
  })

  it('enables and restarts each unit', () => {
    expect(script).toContain('systemctl enable acme-app-queue-0.service')
    expect(script).toContain('systemctl restart acme-app-queue-1.service')
  })

  it('prunes stale units for the site', () => {
    expect(script).toContain("grep -E '^acme-app-(queue|daemon)-.*\\.service$'")
  })
})

describe('buildSiteServicesScript — Horizon', () => {
  it('uses artisan horizon when horizon is set', () => {
    const site: SiteConfig = { root: '.', type: 'laravel', queues: [{ horizon: true }] }
    const script = buildSiteServicesScript({ ...base, site }).join('\n')
    expect(script).toContain('php8.3 /var/www/app/current/artisan horizon')
    expect(script).not.toContain('queue:work')
  })
})

describe('buildSiteServicesScript — scheduler', () => {
  it('writes a cron.d entry running schedule:run every minute', () => {
    const site: SiteConfig = { root: '.', type: 'laravel', scheduler: true }
    const script = buildSiteServicesScript({ ...base, site }).join('\n')
    expect(script).toContain(`cat > ${schedulerCronPath('acme', 'app')}`)
    expect(script).toContain('* * * * * root cd /var/www/app/current && php8.3 artisan schedule:run')
  })

  it('removes the cron entry when scheduler is disabled', () => {
    const site: SiteConfig = { root: '.', type: 'laravel' }
    const script = buildSiteServicesScript({ ...base, site }).join('\n')
    expect(script).toContain(`rm -f ${schedulerCronPath('acme', 'app')}`)
  })
})

describe('buildSiteServicesScript — daemons', () => {
  it('writes a daemon unit per process with the given command', () => {
    const site: SiteConfig = {
      root: '.',
      type: 'laravel',
      daemons: [{ command: 'php artisan reverb:start', name: 'reverb', processes: 1, restart: 'on-failure' }],
    }
    const script = buildSiteServicesScript({ ...base, site }).join('\n')
    expect(script).toContain('/etc/systemd/system/acme-app-daemon-reverb-0.service')
    expect(script).toContain('ExecStart=php artisan reverb:start')
    expect(script).toContain('Restart=on-failure')
  })
})

describe('helpers', () => {
  it('names queue units predictably', () => {
    expect(queueUnitName('acme', 'app', 0)).toBe('acme-app-queue-0')
  })

  it('detects whether a site declares services', () => {
    expect(siteHasServices({ root: '.', scheduler: true })).toBe(true)
    expect(siteHasServices({ root: '.', queues: [{}] })).toBe(true)
    expect(siteHasServices({ root: '.' })).toBe(false)
  })
})
