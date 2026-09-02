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

`profile: 'raspberry-pi'` keeps the shared recipe and adjusts what an SD card cares about: a 1 GB swapfile instead of 2 (an explicit `compute.swapGb` still wins), a journal bounded to 128 MB and seven days, `psmisc` and `ca-certificates` installed explicitly (a minimal Debian lacks `fuser`, which frees :80/:443 for the gateway), an early refusal of services that only ship x86_64 builds, and lower memory ceilings on the gateway's systemd unit: `MemoryHigh=256M` / `MemoryMax=384M` instead of 512M / 768M. The gateway's steady state is well under 100 MB either way, but a 768 MB ceiling on a 2 GB board is not a bound at all, and the reclaim it eventually triggers lands on the SD card. Setting `compute.proxy.memoryHigh` or `memoryMax` yourself overrides both. `generic` is the recipe unchanged, for any other Debian or Ubuntu host.

## LAN or public

Sites on a Pi are usually reached one of two ways, and the config says which:

- **Public**: your router forwards :80 and :443 to the Pi. Set `ssh.publicIp` to the address DNS should point at (or leave `auto`), and the rpx gateway issues Let's Encrypt certificates as it does on a cloud box.
- **LAN only**: set `ssh.lan`. The gateway then signs its own certificates for the LAN names, or serves plain HTTP, depending on `ssh.lan.tls`.

Both are possible at once, on different hostnames. What is never possible is one hostname in both sets: a name is either LAN-only, with a certificate from the box's own authority, or public, with one from Let's Encrypt. ts-cloud refuses that configuration with a message naming the host and where each claim came from, rather than letting the gateway discover it after the deploy has reported success.

## The LAN certificate authority

`ssh.lan` with no `tls`, or `tls: 'local-ca'`, is the default: a certificate authority that lives on the Pi and signs one certificate for the box's LAN names.

```typescript
ssh: {
  hosts: [{ host: 'pi-app.local', user: 'pi' }],
  profile: 'raspberry-pi',
  lan: { hostname: 'pi-app.local' },   // tls defaults to 'local-ca'
},
```

On the next deploy the gateway creates a root CA under `/etc/rpx/local-ca`, signs one leaf covering every LAN name it serves, installs the CA in the Pi's own trust store, and renews the leaf before it expires. rpx registers that leaf per server name **and** as the default TLS context, so reaching the box by address (`https://192.168.1.20`) works too, without SNI. The mechanism is rpx's; see its `localCa` documentation for the details this page does not repeat.

The names on the certificate are:

- `ssh.lan.hostname`, or `<project.slug>.local` when you did not set one.
- `dashboard.<that hostname>`, when this project deploys the management dashboard.
- every site `domain` a public CA could not issue for anyway: a `.local` name, or a bare single-label hostname like `intranet`.
- the box's LAN address as an IP SAN, when the preflight reported one (or the host you configured is itself an address). Never a guessed address: without one, the certificate simply carries no IP.

A name that only gets a certificate still needs a route to serve anything. Give a site the `.local` `domain` you want reachable; `ssh.lan.hostname` on its own puts the name on the certificate but routes nothing.

Where the CA lives:

```
/etc/rpx/local-ca/rpx-root-ca.crt    # the certificate to trust on your devices
/etc/rpx/local-ca/rpx-root-ca.key    # the private key, mode 0600, never leaves the box
```

`cloud deploy` prints the path and the `scp` line to fetch it, and the ssh driver returns it as `lanCaCertPath` for anything scripting on top.

### Trusting it on a laptop

Copy the CA certificate off the box, then add it to the system trust store:

```bash
scp pi@pi-app.local:/etc/rpx/local-ca/rpx-root-ca.crt ./pi-root-ca.crt

# macOS
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ./pi-root-ca.crt

# Debian / Ubuntu
sudo cp ./pi-root-ca.crt /usr/local/share/ca-certificates/pi-root-ca.crt
sudo update-ca-certificates
```

[tlsx](https://github.com/stacksjs/tlsx) (0.13.19 or newer, the same library rpx issues with) prints the steps for any platform rather than making you look them up:

```bash
tlsx trust-instructions --platform macos --ca ./pi-root-ca.crt
tlsx trust-instructions            # every platform it knows
```

Firefox keeps its own trust store and ignores the system one. Import the file under Settings, Privacy & Security, Certificates, View Certificates, Authorities, Import.

### Trusting it on an iPhone or iPad

iOS will not install a bare `.crt` from a file. Wrap it in a configuration profile first:

```bash
tlsx export-ca --ca ./pi-root-ca.crt --format mobileconfig --out ./pi-root-ca.mobileconfig
tlsx trust-instructions --platform ios --ca ./pi-root-ca.mobileconfig
```

AirDrop or mail the `.mobileconfig` to the device, then, and this is the step people miss, install it **and** enable it:

1. Settings, Profile Downloaded, Install.
2. Settings, General, About, Certificate Trust Settings, and turn the switch on for the CA.

Without step 2 the profile is installed and the certificate is still not trusted, which looks exactly like the certificate being wrong. Android is the same shape; `tlsx trust-instructions --platform android` has the current menu path.

### When to choose `tls: 'off'` instead

```typescript
ssh: { hosts: [{ host: 'pi-app.local', user: 'pi' }], lan: { tls: 'off' } },
```

The gateway then binds `:80` only, serves plain HTTP, and binds nothing on `:443`. No certificate, nothing to trust, nothing to renew. Choose it when:

- every client is a device you cannot install a CA on: a TV, a printer, a smart plug, a colleague's phone you are not going to configure.
- the traffic is genuinely not worth protecting on a network you control, and the trust step is a bigger cost than the risk.
- you are bringing your own TLS in front of the Pi anyway (a tunnel, a mesh VPN, another reverse proxy).

Everything on the wire is then readable by anything on that LAN, including any session cookie the dashboard sets, so it is a real trade rather than a convenience. Browsers also withhold service workers, clipboard access and several other APIs on plain HTTP, and the management dashboard is a worse experience without them.

## Exposing a LAN Pi publicly

The local CA is for names the public internet cannot reach. Publishing a site properly needs the public path instead, which is a different set of things:

- a route to the box: a port forward for :80 and :443, or a tunnel.
- public DNS pointing at the address `ssh.publicIp` names (set it to a literal when your router has one and `auto` cannot see past NAT).
- `compute.proxy.onDemandTls` with an email, so the gateway issues Let's Encrypt certificates over http-01 and renews them daily. This is the path documented in [Providers](/guide/providers), and it is what the public hostnames use.

Keep the two sets of names apart. A public hostname and a LAN hostname on one box is a normal, supported setup; the same hostname in both is the configuration ts-cloud refuses.

## Limits

- One host. `ssh.hosts` with more than one entry is refused; fleets of Pis are not a thing yet.
- ARM only ships what ARM ships. `managedServices.vitess` is refused on the `raspberry-pi` profile and on any host whose preflight reports `aarch64`, because Vitess publishes x86_64 tarballs only. bun, pantry and rpx all have arm64 builds.
- SD cards wear. The profile bounds the journal and shrinks swap, but a Pi that builds releases on-box will still write a lot; build in CI and ship tarballs where you can, and prefer an NVMe HAT or USB SSD for anything that runs a database.
- `cloud.attachTo` is not supported: a Pi is nobody's shared box.
- `cloud compute:destroy` forgets the host and removes nothing on it. Stop the systemd units and delete `/var/ts-cloud` and `/etc/rpx` by hand if you want it clean.
