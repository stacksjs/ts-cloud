import { describe, expect, it } from 'bun:test'
import {
  buildPhpFpmPoolConf,
  buildPhpFpmPoolScript,
  PHP_FPM_POOL_DIR,
  phpFpmPoolListen,
  phpFpmPoolPort,
  siteUser,
} from '../../src/drivers/shared/php-fpm-pool'

describe('site user + port derivation', () => {
  it('derives a safe, ≤32-char Linux user from the site name', () => {
    expect(siteUser('app')).toBe('web_app')
    expect(siteUser('My App.Site')).toBe('web_my_app_site')
    const long = siteUser('a'.repeat(60))
    expect(long.length).toBeLessThanOrEqual(32)
    expect(long.startsWith('web_')).toBe(true)
  })

  it('assigns a deterministic per-site port above the shared php-fpm port', () => {
    const p = phpFpmPoolPort('app')
    expect(p).toBe(phpFpmPoolPort('app')) // stable
    expect(p).toBeGreaterThanOrEqual(9100)
    expect(p).toBeLessThan(9500)
    expect(p).not.toBe(9074)
    expect(phpFpmPoolListen('app')).toBe(`127.0.0.1:${p}`)
  })
})

describe('buildPhpFpmPoolConf', () => {
  const conf = buildPhpFpmPoolConf({ siteName: 'app', appBase: '/var/www/app' })

  it('runs the pool as the dedicated user on the per-site port', () => {
    expect(conf).toContain('[app]')
    expect(conf).toContain('user = web_app')
    expect(conf).toContain('group = web_app')
    expect(conf).toContain(`listen = ${phpFpmPoolListen('app')}`)
  })

  it('jails PHP to the site dir + /tmp via open_basedir', () => {
    expect(conf).toContain('php_admin_value[open_basedir] = /var/www/app:/tmp')
  })

  it('honours a custom max_children', () => {
    expect(buildPhpFpmPoolConf({ siteName: 'app', appBase: '/var/www/app', maxChildren: 25 })).toContain(
      'pm.max_children = 25',
    )
  })
})

describe('buildPhpFpmPoolScript', () => {
  const s = buildPhpFpmPoolScript({ siteName: 'app', appBase: '/var/www/app' }).join('\n')

  it('creates the dedicated user/group idempotently', () => {
    expect(s).toContain('getent group web_app >/dev/null || groupadd --system web_app')
    expect(s).toContain('useradd --system --no-create-home --shell /usr/sbin/nologin -g web_app web_app')
  })

  it('grants nginx (www-data) group access and takes ownership of the tree', () => {
    expect(s).toContain('usermod -aG web_app www-data')
    // chown/chmod tolerate failure: they run under the deploy script's set -e
    // after the release is already live, so one odd file must not abort it.
    expect(s).toContain('chown -R web_app:web_app /var/www/app || true')
    expect(s).toContain('chmod -R g+rX /var/www/app || true')
  })

  it('re-tightens the shared .env after the recursive chmod', () => {
    expect(s).toContain('chmod 600 /var/www/app/shared/.env')
  })

  it('drops the pool config into pantry’s include dir and restarts php-fpm', () => {
    expect(s).toContain(`mkdir -p ${PHP_FPM_POOL_DIR}`)
    expect(s).toContain(`cat > ${PHP_FPM_POOL_DIR}/app.conf`)
    expect(s).toContain('pantry restart php-fpm')
  })
})
