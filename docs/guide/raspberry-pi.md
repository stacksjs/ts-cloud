# Raspberry Pi

A Raspberry Pi is the smallest host ts-cloud deploys to, and the one it did not create. The `ssh` provider adopts it: you install the OS, ts-cloud checks the board, bootstraps the same stack a Hetzner box gets at first boot, and from then on `cloud deploy` works exactly as it does anywhere else.

Two ways in, depending on whether the card is still in your laptop.

## At image time (recommended)

Flash the 64-bit image (Raspberry Pi OS Trixie or Ubuntu Server arm64) with Raspberry Pi Imager, then let ts-cloud write the cloud-init first-boot files:

```bash
cloud ssh:first-boot \
  --os raspberry-pi-os \
  --hostname pi-app \
  --user pi \
  --key ~/.ssh/id_ed25519.pub \
  --wifi-ssid "Home Net" --wifi-country DE \
  --timezone Europe/Berlin \
  --out ./first-boot
```

The Wi-Fi passphrase is read from `$WIFI_PASSWORD` (or the variable named by `--wifi-passphrase-env`) and lands only in `network-config`, never in `user-data`. The command writes `user-data`, `network-config` and `meta-data` into `--out` and refuses to overwrite them without `--force`; it never touches a mounted card itself. Copy the three files onto the boot partition (`bootfs` on Pi OS, `system-boot` on Ubuntu), replacing the ones the imager left there, eject, and boot.

The first boot takes a few minutes: cloud-init creates the user with your key and passwordless sudo, disables password login and the peripheral buses, waits for the clock to sync, then runs the ts-cloud bootstrap. When the LEDs settle:

```bash
cloud ssh:preflight pi-app.local --user pi
cloud deploy --env production
```

The deploy adopts the host (see below), finds the bootstrap already applied by its version marker, and ships the sites.

## Adopting a running Pi

Already have a Pi on the network? Point the config at it:

```typescript
cloud: { provider: 'ssh' },
ssh: {
  hosts: [{ host: 'pi-app.local', user: 'pi' }],
  profile: 'raspberry-pi',
},
```

Then:

```bash
cloud ssh:preflight        # pin the host key, probe the board, list findings
cloud ssh:bootstrap        # or let the first cloud deploy do it
cloud deploy --env production
```

The adopt runs on every deploy and is cheap after the first: pin the host key (recorded in `<stateDir>/ssh/known_hosts`, and a different key is refused from then on), wait for sshd, run the preflight, wait for a cloud-init first boot if one is still going, run the bootstrap, and record the host in the driver state. The bootstrap is guarded by `/var/lib/ts-cloud/bootstrap.v<N>`: once a version has been applied only the gateway's route fragment is refreshed, so a rerun (cloud-init on some Pi images reruns modules on every boot) cannot re-download the runtime or re-create swap. `TS_CLOUD_SSH_SKIP_BOOTSTRAP=1` skips it entirely when local state already carries the current version.

The preflight refuses a host that cannot work rather than letting the bootstrap discover it slowly: a 32-bit image, a non-Debian OS, under 1 GiB of memory, under 4 GiB free, a user without passwordless sudo, no HTTPS egress. An unsynced clock is only a warning, because the bootstrap waits for it (a Pi 5 has no battery-backed RTC and boots in 1970 until NTP answers, which apt and ACME both reject).

## What the profile changes

`profile: 'raspberry-pi'` keeps the shared recipe and adjusts what an SD card cares about: a 1 GB swapfile instead of 2 (an explicit `compute.swapGb` still wins), a journal bounded to 128 MB and seven days, `psmisc` and `ca-certificates` installed explicitly (a minimal Debian lacks `fuser`, which frees :80/:443 for the gateway), and an early refusal of services that only ship x86_64 builds. `generic` is the recipe unchanged, for any other Debian or Ubuntu host.

## LAN or public

Sites on a Pi are usually reached one of two ways, and the config says which:

- **Public**: your router forwards :80 and :443 to the Pi. Set `ssh.publicIp` to the address DNS should point at (or leave `auto`), and the rpx gateway issues Let's Encrypt certificates as it does on a cloud box.
- **LAN only**: set `ssh.lan.hostname` to the mDNS name (`pi-app.local`) and `ssh.lan.tls` to `local-ca` or `off`. The gateway wiring for a locally issued CA is being added to rpx; until it lands the setting is recorded and the gateway serves the public configuration.

## Limits

- One host. `ssh.hosts` with more than one entry is refused; fleets of Pis are not a thing yet.
- ARM only ships what ARM ships. `managedServices.vitess` is refused on the `raspberry-pi` profile and on any host whose preflight reports `aarch64`, because Vitess publishes x86_64 tarballs only. bun, pantry and rpx all have arm64 builds.
- SD cards wear. The profile bounds the journal and shrinks swap, but a Pi that builds releases on-box will still write a lot; build in CI and ship tarballs where you can, and prefer an NVMe HAT or USB SSD for anything that runs a database.
- `cloud.attachTo` is not supported: a Pi is nobody's shared box.
- `cloud compute:destroy` forgets the host and removes nothing on it. Stop the systemd units and delete `/var/ts-cloud` and `/etc/rpx` by hand if you want it clean.
