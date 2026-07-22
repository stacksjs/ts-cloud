/**
 * Automatic unattended security/system updates, mirroring Forge's scheduled
 * maintenance. Installs `unattended-upgrades` and enables the daily APT
 * auto-update timers so security patches land without manual intervention.
 */

/**
 * Build the commands that enable automatic security updates. Idempotent.
 * Returns `[]` when disabled.
 */
export function buildAutoUpdatesScript(enabled: boolean = true): string[] {
  if (!enabled) return []

  return [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get install -y unattended-upgrades',
    // Enable the periodic update/upgrade APT timers.
    "cat > /etc/apt/apt.conf.d/20auto-upgrades <<'TS_CLOUD_AUTOUPD_EOF'",
    'APT::Periodic::Update-Package-Lists "1";',
    'APT::Periodic::Unattended-Upgrade "1";',
    'APT::Periodic::Download-Upgradeable-Packages "1";',
    'APT::Periodic::AutocleanInterval "7";',
    'TS_CLOUD_AUTOUPD_EOF',
    'systemctl enable unattended-upgrades 2>/dev/null || true',
    'systemctl restart unattended-upgrades 2>/dev/null || true',
  ]
}
