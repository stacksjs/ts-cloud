import type { SiteConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import {
  buildHealthCheckScript,
  buildLaravelDeployScript,
  defaultDeployScriptFor,
  MACRO_ACTIVATE_RELEASE,
  MACRO_CREATE_RELEASE,
  MACRO_RESTART_QUEUES,
} from '../../src/drivers/shared/laravel-deploy'
import { isPhpSite, resolveSiteKind } from '../../src/deploy/site-target'

const laravelSite: SiteConfig = {
  root: '.',
  type: 'laravel',
  domain: 'example.com',
  phpVersion: '8.3',
  repository: { url: 'git@github.com:acme/app.git', branch: 'main' },
  env: { APP_ENV: 'production', APP_KEY: 'base64:xxx' },
}

describe('defaultDeployScriptFor', () => {
  it('produces the Laravel macro template', () => {
    const script = defaultDeployScriptFor('laravel')
    expect(script[0]).toBe(MACRO_CREATE_RELEASE)
    expect(script).toContain('php artisan migrate --force')
    expect(script).toContain('php artisan config:cache')
    expect(script).toContain(MACRO_ACTIVATE_RELEASE)
    expect(script).toContain(MACRO_RESTART_QUEUES)
  })

  it('keeps generic PHP minimal (composer, no artisan)', () => {
    const script = defaultDeployScriptFor('php')
    expect(script).not.toContain('php artisan migrate --force')
    expect(script.some((l) => l.startsWith('composer install'))).toBe(true)
  })
})

describe('buildLaravelDeployScript', () => {
  const script = buildLaravelDeployScript({ siteName: 'app', site: laravelSite, releaseId: 'rel1' })
  const joined = script.join('\n')

  it('expands $CREATE_RELEASE into clone + link + cd', () => {
    expect(joined).toContain(
      "git clone -q --depth 1 --branch 'main' 'git@github.com:acme/app.git' /var/www/app/releases/rel1",
    )
    expect(joined).toContain('ln -sfn /var/www/app/shared/storage /var/www/app/releases/rel1/storage')
    expect(joined).toContain('cd /var/www/app/releases/rel1')
  })

  it('writes the shared .env from site.env', () => {
    expect(joined).toContain('cat > /var/www/app/shared/.env')
    expect(joined).toContain('APP_ENV="production"')
    expect(joined).toContain('chmod 600 /var/www/app/shared/.env')
  })

  it('writes composer auth.json + .npmrc credentials into the release', () => {
    const s = buildLaravelDeployScript({
      siteName: 'app',
      releaseId: 'rel1',
      site: {
        ...laravelSite,
        credentials: {
          composerAuth: { 'github-oauth': { 'github.com': 'tok123' } },
          npmrc: '//registry.npmjs.org/:_authToken=npmtok',
        },
      },
    }).join('\n')
    expect(s).toContain('cat > /var/www/app/releases/rel1/auth.json')
    expect(s).toContain('"github-oauth"')
    expect(s).toContain('cat > /var/www/app/releases/rel1/.npmrc')
    expect(s).toContain('_authToken=npmtok')
    expect(s).toContain('chmod 600 /var/www/app/releases/rel1/auth.json')
  })

  it('uses pantry php (activated via pantry env) — no versioned binary', () => {
    expect(joined).toContain('pantry env')
    expect(joined).toContain('php artisan migrate --force')
    expect(joined).toContain('php artisan queue:restart || true')
    expect(joined).not.toContain('php8.3')
  })

  it('expands $ACTIVATE_RELEASE into atomic flip + prune + fpm reload', () => {
    expect(joined).toContain('mv -Tf /var/www/app/current.tmp /var/www/app/current')
    expect(joined).toContain('pantry restart php-fpm')
    expect(joined).toContain('tail -n +5') // keepReleases default 4
  })

  it('orders code activation before the queue restart', () => {
    const activate = script.findIndex((l) => l.includes('mv -Tf'))
    const restart = script.findIndex((l) => l.includes('queue:restart'))
    expect(activate).toBeLessThan(restart)
  })

  it('throws without a repository', () => {
    expect(() =>
      buildLaravelDeployScript({ siteName: 'x', site: { root: '.', type: 'laravel' }, releaseId: 'r' }),
    ).toThrow(/repository.url/)
  })

  it('honours a custom deployScript override', () => {
    const custom = buildLaravelDeployScript({
      siteName: 'app',
      site: { ...laravelSite, deployScript: [MACRO_CREATE_RELEASE, 'php artisan optimize', MACRO_ACTIVATE_RELEASE] },
      releaseId: 'rel2',
    }).join('\n')
    expect(custom).toContain('php artisan optimize')
    expect(custom).not.toContain('artisan migrate --force')
  })
})

describe('site-target resolution for PHP sites', () => {
  it('classifies php-typed sites as server-php', () => {
    expect(isPhpSite(laravelSite)).toBe(true)
    expect(resolveSiteKind(laravelSite)).toBe('server-php')
    expect(resolveSiteKind({ root: 'dist' })).toBe('bucket')
  })
})

describe('buildHealthCheckScript', () => {
  it('pings the live site via localhost with the Host header and fails on non-2xx/3xx', () => {
    const s = buildHealthCheckScript({
      root: '.',
      type: 'laravel',
      domain: 'acme.com',
      healthCheck: { path: '/up' },
    }).join('\n')
    expect(s).toContain('http://127.0.0.1/up')
    expect(s).toContain('-H "Host: acme.com"')
    expect(s).toContain('health check FAILED')
    expect(s).toContain('exit 1')
  })

  it('normalizes a path without a leading slash', () => {
    const s = buildHealthCheckScript({
      root: '.',
      type: 'laravel',
      domain: 'acme.com',
      healthCheck: { path: 'health' },
    }).join('\n')
    expect(s).toContain('http://127.0.0.1/health')
  })

  it('emits nothing without a healthCheck path or domain', () => {
    expect(buildHealthCheckScript({ root: '.', type: 'laravel', domain: 'acme.com' })).toEqual([])
    expect(buildHealthCheckScript({ root: '.', type: 'laravel', healthCheck: { path: '/up' } })).toEqual([])
  })
})

describe('defaultDeployScriptFor — WordPress', () => {
  it('uses optional composer + no artisan for wordpress', () => {
    const s = defaultDeployScriptFor('wordpress')
    expect(s).toContain(MACRO_CREATE_RELEASE)
    expect(s).toContain(MACRO_ACTIVATE_RELEASE)
    expect(s.join('\n')).toContain('composer install')
    expect(s.join('\n')).toContain('|| true')
    expect(s.join('\n')).not.toContain('artisan')
  })

  it('statamic stays a full Laravel deploy (composer + artisan)', () => {
    expect(defaultDeployScriptFor('statamic').join('\n')).toContain('artisan migrate --force')
  })
})
