import { describe, expect, it } from 'bun:test'
import { buildUbuntuBootstrapScript } from '../../src/drivers/shared/ubuntu-bootstrap'

/**
 * Regression coverage for a real Hetzner cloud-init failure (found via a
 * live deploy, stacksjs/status#1 Phase 9): bun.sh's install script
 * references $HOME internally, but cloud-init's runcmd environment doesn't
 * export HOME by default. Under this script's own `set -euo pipefail`,
 * the unbound-variable error inside the piped installer aborted the WHOLE
 * bootstrap immediately after the bun binary was downloaded — the
 * `ln -sf .../bun /usr/local/bin/bun` symlink, /var/www + /var/ts-cloud
 * directory creation, and the entire rpx gateway install/systemd unit
 * never ran, even though cloud-init itself reported success.
 */
describe('buildUbuntuBootstrapScript', () => {
  it('provisions bounded low-swappiness swap before install-heavy work', () => {
    const script = buildUbuntuBootstrapScript({ runtime: 'bun' })
    expect(script).toContain('fallocate -l 2G /swapfile')
    expect(script).toContain('/swapfile none swap sw 0 0')
    expect(script).toContain('vm.swappiness=10')
    expect(script.indexOf('fallocate -l 2G /swapfile')).toBeLessThan(script.indexOf('apt-get'))

    const disabled = buildUbuntuBootstrapScript({ runtime: 'bun', swapGb: 0 })
    expect(disabled).not.toContain('/swapfile')
  })

  it('exports HOME before piping bun.sh\'s installer, so its internal $HOME reference does not trip set -u', () => {
    const script = buildUbuntuBootstrapScript({ runtime: 'bun' })

    const homeExportIdx = script.indexOf('export HOME=')
    const bunCurlIdx = script.indexOf('curl -fsSL https://bun.sh/install')

    expect(homeExportIdx).toBeGreaterThan(-1)
    expect(bunCurlIdx).toBeGreaterThan(-1)
    expect(homeExportIdx).toBeLessThan(bunCurlIdx)
  })

  it('still runs everything after the bun install (symlink, dirs) on a fresh (non-baked) box', () => {
    const script = buildUbuntuBootstrapScript({ runtime: 'bun', baked: false })

    expect(script).toContain('ln -sf /root/.bun/bin/bun /usr/local/bin/bun')
  })

  it('is a no-op for non-bun runtimes (no stray HOME export)', () => {
    const script = buildUbuntuBootstrapScript({ runtime: 'node', runtimeVersion: '20' })

    expect(script).not.toContain('bun.sh/install')
  })
})
