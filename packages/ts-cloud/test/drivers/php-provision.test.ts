import { describe, expect, it } from 'bun:test'
import {
  buildPhpProvisionScript,
  buildPhpTuningScript,
  PHP_FPM_LISTEN,
  phpFpmSocketPath,
  PRODUCTION_PHP_INI,
  resolveDefaultPhpVersion,
  resolvePhpIni,
} from '../../src/drivers/shared/php-provision'
import { generateUbuntuAppCloudInit } from '../../src/drivers/hetzner/cloud-init'

describe('buildPhpProvisionScript (pantry)', () => {
  it('installs php + composer + nginx via pantry and starts php-fpm', () => {
    const script = buildPhpProvisionScript().join('\n')
    expect(script).toContain('pantry install \'php.net@8.3\' \'getcomposer.org\' \'nginx.org\'')
    expect(script).toContain('pantry enable \'php-fpm\'')
    expect(script).toContain('pantry start \'php-fpm\'')
    // No apt/ppa anymore.
    expect(script).not.toContain('apt-get')
    expect(script).not.toContain('ppa:ondrej/php')
  })

  it('pins the requested default php version', () => {
    expect(buildPhpProvisionScript({ versions: ['8.4'] }).join('\n')).toContain('\'php.net@8.4\'')
    expect(buildPhpProvisionScript({ versions: ['8.3', '8.2'], default: '8.2' }).join('\n')).toContain('\'php.net@8.2\'')
    expect(resolveDefaultPhpVersion({ versions: ['8.3', '8.2'], default: '8.2' })).toBe('8.2')
  })

  it('can skip nginx (rpx engine) and Composer', () => {
    const script = buildPhpProvisionScript({ installNginx: false, installComposer: false }).join('\n')
    expect(script).not.toContain('nginx.org')
    expect(script).not.toContain('getcomposer.org')
    expect(script).toContain('\'php.net@8.3\'')
  })

  it('php-fpm listens on TCP for nginx fastcgi_pass', () => {
    expect(phpFpmSocketPath('8.3')).toBe(PHP_FPM_LISTEN)
    expect(PHP_FPM_LISTEN).toBe('127.0.0.1:9074')
  })

  it('applies production OPcache tuning by default', () => {
    const script = buildPhpProvisionScript().join('\n')
    expect(script).toContain('opcache.enable=1')
    expect(script).toContain('opcache.validate_timestamps=0')
    expect(script).toContain('zz-ts-cloud.ini')
    // Discovers the ini layout from the box, then restarts php-fpm to apply.
    expect(script).toContain('Scan this dir for additional .ini files')
    expect(script).toContain('pantry restart php-fpm')
  })
})

describe('buildPhpTuningScript', () => {
  it('omits everything when tuning is off and no overrides given', () => {
    expect(buildPhpTuningScript({ optimizeForProduction: false })).toEqual([])
  })

  it('merges user ini overrides on top of the production defaults', () => {
    const ini = resolvePhpIni({ ini: { memory_limit: '512M', 'opcache.memory_consumption': '512' } })
    expect(ini['opcache.enable']).toBe('1')
    expect(ini.memory_limit).toBe('512M')
    // Override wins over the production default.
    expect(ini['opcache.memory_consumption']).toBe('512')
  })

  it('applies overrides even when production tuning is disabled', () => {
    const ini = resolvePhpIni({ optimizeForProduction: false, ini: { memory_limit: '256M' } })
    expect(ini).toEqual({ memory_limit: '256M' })
    const script = buildPhpTuningScript({ optimizeForProduction: false, ini: { memory_limit: '256M' } }).join('\n')
    expect(script).toContain('memory_limit=256M')
    expect(script).not.toContain('opcache.enable=1')
  })

  it('falls back to a managed marker block in the loaded php.ini', () => {
    const script = buildPhpTuningScript().join('\n')
    expect(script).toContain('ts-cloud-managed BEGIN')
    expect(script).toContain('ts-cloud-managed END')
    // Idempotent: strips a prior block before re-appending.
    expect(script).toContain("sed -i '/; ts-cloud-managed BEGIN/,/; ts-cloud-managed END/d'")
  })

  it('PRODUCTION_PHP_INI disables timestamp validation', () => {
    expect(PRODUCTION_PHP_INI['opcache.validate_timestamps']).toBe('0')
  })
})

describe('generateUbuntuAppCloudInit with phpProvision', () => {
  it('splices the pantry PHP provision into the bootstrap', () => {
    const bootstrap = generateUbuntuAppCloudInit({
      runtime: 'php',
      phpProvision: buildPhpProvisionScript({ versions: ['8.3'] }),
    })
    expect(bootstrap).toContain('php.net@8.3')
    expect(bootstrap).toContain('pantry start \'php-fpm\'')
    // A php runtime must not pull in the bun installer.
    expect(bootstrap).not.toContain('bun.sh/install')
  })

  it('baked image skips install-heavy steps but keeps per-boot setup', () => {
    const bootstrap = generateUbuntuAppCloudInit({
      runtime: 'php',
      phpProvision: buildPhpProvisionScript({ versions: ['8.3'] }),
      baked: true,
    })
    expect(bootstrap).not.toContain('php.net@8.3')
    expect(bootstrap).not.toContain('apt-get update')
    expect(bootstrap).toContain('mkdir -p /var/www')
    expect(bootstrap).toContain('bootstrap complete')
  })
})
