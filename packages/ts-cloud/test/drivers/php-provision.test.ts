import { describe, expect, it } from 'bun:test'
import {
  buildPhpProvisionScript,
  PHP_FPM_LISTEN,
  phpFpmSocketPath,
  resolveDefaultPhpVersion,
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
