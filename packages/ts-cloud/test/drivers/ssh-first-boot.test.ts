import { describe, expect, it } from 'bun:test'
import { wrapCloudInitUserData } from '../../src/drivers/hetzner/cloud-init'
import { buildCloudInitFirstBoot, FIRST_BOOT_SCRIPT_PATH } from '../../src/drivers/ssh/first-boot'

const identity = {
  hostname: 'pi-app',
  user: 'pi',
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEYBODY chris@laptop',
  timezone: 'Europe/Berlin',
  locale: 'en_US.UTF-8',
}
const bootstrap = '#!/bin/bash\nset -euo pipefail\necho "[ts-cloud] hello"\n'

describe('buildCloudInitFirstBoot', () => {
  it('user-data for Raspberry Pi OS: identity, no passwords, the rpi block, the bootstrap', () => {
    const { files } = buildCloudInitFirstBoot(identity, bootstrap, { os: 'raspberry-pi-os' })
    const userData = files['user-data']
    expect(userData.startsWith('#cloud-config\n')).toBe(true)
    expect(userData).toContain('hostname: "pi-app"')
    expect(userData).toContain('manage_etc_hosts: true')
    expect(userData).toContain('  - name: "pi"')
    expect(userData).toContain('      - "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEYBODY chris@laptop"')
    expect(userData).toContain('    sudo: "ALL=(ALL) NOPASSWD:ALL"')
    expect(userData).toContain('    shell: /bin/bash')
    expect(userData).toContain('    lock_passwd: true')
    expect(userData).toContain('ssh_pwauth: false')
    expect(userData).toContain('timezone: "Europe/Berlin"')
    expect(userData).toContain('locale: "en_US.UTF-8"')
    expect(userData).toContain('package_update: true')
    expect(userData).toContain('rpi:\n  enable_ssh: true\n  interfaces:\n    spi: false\n    i2c: false')
    expect(userData).toContain(`  - path: ${FIRST_BOOT_SCRIPT_PATH}`)
    expect(userData).toContain("permissions: '0700'")
    expect(userData).toContain('      echo "[ts-cloud] hello"')
    expect(userData).toContain(`runcmd:\n  - [ bash, ${FIRST_BOOT_SCRIPT_PATH} ]`)
    // Ordering: identity first, then the file, then the run.
    expect(userData.indexOf('users:')).toBeLessThan(userData.indexOf('write_files:'))
    expect(userData.indexOf('write_files:')).toBeLessThan(userData.indexOf('runcmd:'))
  })

  it('user-data for Ubuntu carries no rpi block', () => {
    const { files } = buildCloudInitFirstBoot(identity, bootstrap, { os: 'ubuntu' })
    expect(files['user-data']).not.toContain('rpi:')
    expect(files['user-data']).toContain('hostname: "pi-app"')
  })

  it('keeps the Wi-Fi passphrase in network-config only', () => {
    const { files } = buildCloudInitFirstBoot(
      { ...identity, wifi: { ssid: 'Home Net', passphrase: 'correct horse', country: 'DE' } },
      bootstrap,
      { os: 'raspberry-pi-os' },
    )
    expect(files['network-config']).toContain('regulatory-domain: "DE"')
    expect(files['network-config']).toContain('      "Home Net":\n        password: "correct horse"')
    expect(files['user-data']).not.toContain('correct horse')
    expect(files['meta-data']).not.toContain('correct horse')
  })

  it('network-config without Wi-Fi is wired DHCP only', () => {
    const { files } = buildCloudInitFirstBoot(identity, bootstrap, { os: 'ubuntu' })
    expect(files['network-config']).toBe(
      ['version: 2', 'ethernets:', '  eth0:', '    match:', '      name: "e*"', '    dhcp4: true', '    dhcp6: true', '    optional: true', ''].join('\n'),
    )
  })

  it('meta-data names the instance after the host', () => {
    const { files } = buildCloudInitFirstBoot(identity, bootstrap, { os: 'raspberry-pi-os' })
    expect(files['meta-data']).toBe('instance-id: "ts-cloud-pi-app"\nlocal-hostname: "pi-app"\n')
  })

  it('names the boot volume and the next command in the instructions', () => {
    expect(buildCloudInitFirstBoot(identity, bootstrap, { os: 'raspberry-pi-os' }).instructions).toContain("'bootfs'")
    expect(buildCloudInitFirstBoot(identity, bootstrap, { os: 'ubuntu' }).instructions).toContain("'system-boot'")
    expect(buildCloudInitFirstBoot(identity, bootstrap, { os: 'ubuntu' }).instructions).toContain('cloud ssh:preflight pi-app.local --user pi')
  })

  it('rejects an identity it cannot spell', () => {
    expect(() => buildCloudInitFirstBoot({ ...identity, hostname: 'Pi App' }, bootstrap, { os: 'ubuntu' })).toThrow('Invalid hostname')
    expect(() => buildCloudInitFirstBoot({ ...identity, user: 'Pi' }, bootstrap, { os: 'ubuntu' })).toThrow('Invalid user')
    expect(() => buildCloudInitFirstBoot({ ...identity, publicKey: 'not a key' }, bootstrap, { os: 'ubuntu' })).toThrow('publicKey')
    expect(() =>
      buildCloudInitFirstBoot({ ...identity, wifi: { ssid: 'x', passphrase: 'y', country: 'Germany' } }, bootstrap, { os: 'ubuntu' }),
    ).toThrow('wifi.country')
  })
})

describe('wrapCloudInitUserData', () => {
  it('is byte-identical to before without extras (the Hetzner user_data must not change)', () => {
    expect(wrapCloudInitUserData('#!/bin/bash\nset -euo pipefail\necho hi')).toBe(
      [
        '#cloud-config',
        'write_files:',
        '  - path: /var/lib/cloud/ts-cloud-bootstrap.sh',
        "    permissions: '0755'",
        '    owner: root:root',
        '    content: |',
        '      #!/bin/bash',
        '      set -euo pipefail',
        '      echo hi',
        'runcmd:',
        '  - [ bash, /var/lib/cloud/ts-cloud-bootstrap.sh ]',
        '',
      ].join('\n'),
    )
  })
})
