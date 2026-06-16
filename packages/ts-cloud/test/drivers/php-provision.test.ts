import { describe, expect, it } from 'bun:test'
import {
  buildPhpProvisionScript,
  LARAVEL_PHP_EXTENSIONS,
  phpFpmSocketPath,
  phpPackagesForVersion,
} from '../../src/drivers/shared/php-provision'
import { generateUbuntuAppCloudInit } from '../../src/drivers/hetzner/cloud-init'

describe('buildPhpProvisionScript', () => {
  it('defaults to PHP 8.3 with nginx + Composer', () => {
    const script = buildPhpProvisionScript().join('\n')
    expect(script).toContain('add-apt-repository -y ppa:ondrej/php')
    expect(script).toContain('apt-get install -y nginx')
    expect(script).toContain('apt-get install -y php8.3-fpm')
    expect(script).toContain('systemctl enable php8.3-fpm')
    expect(script).toContain('update-alternatives --set php /usr/bin/php8.3')
    expect(script).toContain('--filename=composer')
  })

  it('installs each requested version with its own fpm pool', () => {
    const script = buildPhpProvisionScript({ versions: ['8.3', '8.2'] }).join('\n')
    expect(script).toContain('php8.3-fpm')
    expect(script).toContain('php8.2-fpm')
    expect(script).toContain('systemctl start php8.2-fpm')
  })

  it('honours an explicit default version', () => {
    const script = buildPhpProvisionScript({ versions: ['8.3', '8.2'], default: '8.2' }).join('\n')
    expect(script).toContain('update-alternatives --set php /usr/bin/php8.2')
  })

  it('appends extra extensions and keeps the Laravel baseline', () => {
    const pkgs = phpPackagesForVersion('8.3', [...LARAVEL_PHP_EXTENSIONS, 'imagick'])
    expect(pkgs).toContain('php8.3-mbstring')
    expect(pkgs).toContain('php8.3-redis')
    expect(pkgs).toContain('php8.3-imagick')
  })

  it('can skip nginx (rpx engine) and Composer', () => {
    const script = buildPhpProvisionScript({ installNginx: false, installComposer: false }).join('\n')
    expect(script).not.toContain('apt-get install -y nginx')
    expect(script).not.toContain('composer')
  })

  it('exposes the fpm socket path nginx fastcgi_pass uses', () => {
    expect(phpFpmSocketPath('8.3')).toBe('/run/php/php8.3-fpm.sock')
  })
})

describe('generateUbuntuAppCloudInit with phpProvision', () => {
  it('splices the PHP provision script into the bootstrap', () => {
    const bootstrap = generateUbuntuAppCloudInit({
      runtime: 'php',
      phpProvision: buildPhpProvisionScript({ versions: ['8.3'] }),
    })
    expect(bootstrap).toContain('php8.3-fpm')
    expect(bootstrap).toContain('apt-get install -y nginx')
    // A php runtime must not pull in the bun installer.
    expect(bootstrap).not.toContain('bun.sh/install')
  })
})
