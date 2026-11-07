import type { TypesenseServiceConfig } from '@ts-cloud/core'
import { isIP } from 'node:net'
import { buildPantryInstallScript } from './package-manager'

interface ResolvedTypesense {
  version: string
  apiKey: string
  bindAddress: string
  port: number
}

function resolveTypesense(config: false | TypesenseServiceConfig | undefined): ResolvedTypesense | null {
  if (config === undefined || config === false) return null
  if (!config || typeof config !== 'object' || !/^[A-Za-z0-9_-]{32,256}$/.test(config.apiKey || ''))
    throw new Error('managedServices.typesense requires a private apiKey of 32-256 URL-safe characters')
  const version = config.version ?? '30.2'
  if (!/^\d+(?:\.\d+){1,3}$/.test(version)) throw new Error('managedServices.typesense.version must pin a numeric release')
  const bindAddress = config.bindAddress ?? '127.0.0.1'
  if (!isIP(bindAddress) || bindAddress.includes('%')) throw new Error('managedServices.typesense.bindAddress must be an IP address without a zone suffix')
  const port = config.port ?? 8108
  if (!Number.isInteger(port) || port < 1025 || port > 65535) throw new Error('managedServices.typesense.port must leave an adjacent peering port')
  return { version, apiKey: config.apiKey, bindAddress, port }
}

/** Applications receive the same key and port; explicit site.env values still win. */
export function buildTypesenseEnv(config: false | TypesenseServiceConfig | undefined, servicesHost?: string): Record<string, string> {
  const value = resolveTypesense(config)
  if (!value) return {}
  return {
    TYPESENSE_HOST: servicesHost || (value.bindAddress === '0.0.0.0' ? '127.0.0.1' : value.bindAddress === '::' ? '::1' : value.bindAddress),
    TYPESENSE_PORT: String(value.port), TYPESENSE_PROTOCOL: 'http', TYPESENSE_API_KEY: value.apiKey,
  }
}

/**
 * Pantry supplies the binary and library paths. A dedicated systemd unit keeps
 * the key in a root-only EnvironmentFile, outside argv and the public
 * systemctl Environment property. systemd owns durable data as a service user.
 */
export function buildTypesenseProvisionScript(config: false | TypesenseServiceConfig | undefined, options: { bindPrivate?: boolean } = {}): string[] {
  const value = resolveTypesense(config)
  if (!value) return []
  const { version, apiKey, bindAddress, port } = value
  if (options.bindPrivate && !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(bindAddress))
    throw new Error('A Typesense services fleet requires an explicit private bindAddress')
  const healthHost = bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress === '::' ? '::1' : bindAddress
  const origin = `http://${isIP(healthHost) === 6 ? `[${healthHost}]` : healthHost}:${port}`
  return [
    ...buildPantryInstallScript([`typesense.org@${version}`]),
    '(', 'set -eu', 'umask 077',
    'TS_CLOUD_TYPESENSE_UNIT=/etc/systemd/system/ts-cloud-typesense.service',
    'if [ -f "$TS_CLOUD_TYPESENSE_UNIT" ] && ! grep -qFx \'# Managed by ts-cloud Typesense\' "$TS_CLOUD_TYPESENSE_UNIT"; then echo \'Typesense unit belongs to another service\' >&2; exit 1; fi',
    'TS_CLOUD_TYPESENSE_LISTENERS=$(ss -ltnpH)',
    `TS_CLOUD_TYPESENSE_PORTS=$(printf '%s\\n' "$TS_CLOUD_TYPESENSE_LISTENERS" | awk '$4 ~ /[:.](${port}|${port - 1})$/')`,
    'if [ -n "$TS_CLOUD_TYPESENSE_PORTS" ]; then',
    '  TS_CLOUD_TYPESENSE_PID=$(systemctl show --property=MainPID --value ts-cloud-typesense.service 2>/dev/null || true)',
    '  case "$TS_CLOUD_TYPESENSE_PID" in \'\'|0|*[!0-9]*) echo \'Typesense ports belong to another service\' >&2; exit 1 ;; esac',
    '  if printf \'%s\\n\' "$TS_CLOUD_TYPESENSE_PORTS" | grep -qv "pid=$TS_CLOUD_TYPESENSE_PID,"; then echo \'Typesense ports belong to another service\' >&2; exit 1; fi',
    'fi',
    'TS_CLOUD_TYPESENSE_RUNTIME=$(cd /opt/pantry && pantry env)',
    'eval "$TS_CLOUD_TYPESENSE_RUNTIME"',
    'TS_CLOUD_TYPESENSE_BIN=$(readlink -f "$(command -v typesense-server)")',
    '[ -x "$TS_CLOUD_TYPESENSE_BIN" ]',
    'id -u ts-cloud-typesense >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/ts-cloud-typesense --no-create-home --shell /usr/sbin/nologin ts-cloud-typesense',
    'mkdir -p /etc/ts-cloud',
    'TS_CLOUD_TYPESENSE_ENV=$(mktemp /etc/ts-cloud/typesense-env.XXXXXX)',
    'TS_CLOUD_TYPESENSE_NEW_UNIT=$(mktemp /etc/systemd/system/typesense-unit.XXXXXX)',
    'trap \'rm -f "$TS_CLOUD_TYPESENSE_ENV" "$TS_CLOUD_TYPESENSE_NEW_UNIT"\' EXIT HUP INT TERM',
    `printf '%s\\n' 'TYPESENSE_API_KEY=${apiKey}' "LD_LIBRARY_PATH=\${LD_LIBRARY_PATH:-}" > "$TS_CLOUD_TYPESENSE_ENV"`,
    'cat > "$TS_CLOUD_TYPESENSE_NEW_UNIT" <<TS_CLOUD_TYPESENSE_UNIT_EOF',
    '# Managed by ts-cloud Typesense',
    '[Unit]', 'Description=ts-cloud managed Typesense', 'After=network-online.target', 'Wants=network-online.target',
    '[Service]', 'Type=simple', 'User=ts-cloud-typesense', 'Group=ts-cloud-typesense',
    'EnvironmentFile=/etc/ts-cloud/typesense.env',
    'StateDirectory=ts-cloud-typesense', 'StateDirectoryMode=0700',
    `ExecStart=$TS_CLOUD_TYPESENSE_BIN --data-dir /var/lib/ts-cloud-typesense --api-address ${bindAddress} --api-port ${port} --peering-address ${bindAddress} --peering-port ${port - 1}`,
    'Restart=on-failure', 'RestartSec=2', 'LimitNOFILE=65536',
    'NoNewPrivileges=true', 'PrivateTmp=true', 'ProtectHome=true', 'ProtectSystem=strict',
    '[Install]', 'WantedBy=multi-user.target', 'TS_CLOUD_TYPESENSE_UNIT_EOF',
    'TS_CLOUD_TYPESENSE_CHANGED=0',
    'if ! cmp -s "$TS_CLOUD_TYPESENSE_ENV" /etc/ts-cloud/typesense.env; then install -m 600 "$TS_CLOUD_TYPESENSE_ENV" /etc/ts-cloud/typesense.env; TS_CLOUD_TYPESENSE_CHANGED=1; fi',
    'chmod 600 /etc/ts-cloud/typesense.env',
    'if ! cmp -s "$TS_CLOUD_TYPESENSE_NEW_UNIT" "$TS_CLOUD_TYPESENSE_UNIT"; then install -m 644 "$TS_CLOUD_TYPESENSE_NEW_UNIT" "$TS_CLOUD_TYPESENSE_UNIT"; TS_CLOUD_TYPESENSE_CHANGED=1; fi',
    'systemctl daemon-reload', 'systemctl enable ts-cloud-typesense.service',
    'if [ "$TS_CLOUD_TYPESENSE_CHANGED" = 1 ] || ! systemctl is-active --quiet ts-cloud-typesense.service; then systemctl restart ts-cloud-typesense.service; fi',
    'TS_CLOUD_TYPESENSE_READY=0',
    'TS_CLOUD_TYPESENSE_KEY=$(sed -n \'s/^TYPESENSE_API_KEY=//p\' /etc/ts-cloud/typesense.env)',
    'for TS_CLOUD_TYPESENSE_ATTEMPT in $(seq 1 60); do',
    `  if systemctl is-active --quiet ts-cloud-typesense.service && curl -fsS --max-time 2 '${origin}/health' | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' && printf 'header = "X-TYPESENSE-API-KEY: %s"\\n' "$TS_CLOUD_TYPESENSE_KEY" | curl --config - -fsS --max-time 2 '${origin}/collections' >/dev/null; then TS_CLOUD_TYPESENSE_READY=1; break; fi`,
    '  sleep 1', 'done',
    '[ "$TS_CLOUD_TYPESENSE_READY" = 1 ] || { echo \'Authenticated Typesense readiness failed\' >&2; exit 1; }',
    ')',
  ]
}
