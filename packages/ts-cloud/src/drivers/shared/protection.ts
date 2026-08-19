/**
 * Edge protection at provision time.
 *
 * UFW (see `ufw.ts`) decides which ports are open. This decides what happens to
 * the traffic that arrives on them: kernel-level flood mitigation, and the WAF.
 *
 * Both are **on by default**. A protection that has to be switched on protects
 * only the people who already knew they needed it, which is never the box that
 * gets hit. The escape hatches are explicit (`ddos: false`, `waf: false`) and
 * the WAF starts in detection-only, so the default posture is "see everything,
 * block only floods".
 */
import type { DdosConfig } from '../../protection/ddos'
import type { WafConfig } from '../../protection/waf'
import { renderDdosInstallScript } from '../../protection/ddos'
import { renderWafInstallScript } from '../../protection/waf'

/** `true` for defaults, `false` to skip, or an object to tune. */
export type ProtectionSetting<T> = boolean | T | undefined

/**
 * Wrap a generated script so it runs as its own file.
 *
 * The generators emit complete scripts with their own `set -euo pipefail`.
 * Splicing those lines into the provisioning script would apply that shell
 * strictness to everything after them, so a later unrelated command that
 * returns non-zero would abort the whole bootstrap. Writing to a file and
 * executing it keeps the failure domain to the script that owns it.
 */
function runAsScript(name: string, script: string): string[] {
  const path = `/tmp/ts-cloud-${name}.sh`
  const marker = `TS_CLOUD_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_EOF`
  return [
    `cat > ${path} <<'${marker}'`,
    script.replace(/\n$/, ''),
    marker,
    `chmod +x ${path}`,
    // `|| true`: protection failing to install must not fail the deploy. A box
    // that is up without mitigation is recoverable; a deploy that will not
    // complete because nftables is missing is an outage of its own.
    `bash ${path} || echo "ts-cloud: ${name} setup did not complete; continuing" >&2`,
    `rm -f ${path}`,
  ]
}

function resolve<T extends object>(setting: ProtectionSetting<T>, fallback: T): T | undefined {
  if (setting === false) return undefined
  if (setting === true || setting === undefined) return fallback
  return setting
}

/** L3/L4 defaults: protect the web ports, count-and-drop, ten-minute bans. */
export const DEFAULT_COMPUTE_DDOS: DdosConfig = { enabled: true, ports: [80, 443] }

/**
 * WAF defaults: paranoia 1, detection only.
 *
 * Detection rather than blocking because zig-waf is pre-alpha and because a
 * ruleset nobody has read their own logs against will block real traffic. The
 * operator promotes it once they have looked.
 */
export const DEFAULT_COMPUTE_WAF: WafConfig = { mode: 'detection', paranoiaLevel: 1 }

/** Kernel-level flood mitigation. Returns no lines when disabled. */
export function buildDdosScript(setting: ProtectionSetting<DdosConfig> = true, extraPorts: number[] = []): string[] {
  const config = resolve(setting, DEFAULT_COMPUTE_DDOS)
  if (!config || config.enabled === false) return []
  const ports = [...new Set([...(config.ports ?? DEFAULT_COMPUTE_DDOS.ports ?? []), ...extraPorts])].sort(
    (a, b) => a - b,
  )
  return runAsScript('ddos', renderDdosInstallScript({ ...config, ports }))
}

/** WAF configuration. Returns no lines when disabled or when the binary is absent. */
export function buildWafScript(setting: ProtectionSetting<WafConfig> = true): string[] {
  const config = resolve(setting, DEFAULT_COMPUTE_WAF)
  if (!config || config.mode === 'off') return []
  // The generated script exits cleanly when zig-waf is not installed, so this
  // is safe to emit unconditionally rather than probing from here.
  return runAsScript('waf', renderWafInstallScript(config))
}

export interface ComputeProtectionConfig {
  ddos?: ProtectionSetting<DdosConfig>
  waf?: ProtectionSetting<WafConfig>
}

/**
 * Both layers, in order: kernel first, then application.
 *
 * Order matters on a box that is already being hit. The packet filter costs
 * nothing per request and starts dropping immediately; the WAF has to parse
 * every request it inspects, so bringing it up first would spend CPU on
 * traffic the kernel was about to discard anyway.
 */
export function buildProtectionScript(
  protection: ComputeProtectionConfig = {},
  extraPorts: number[] = [],
): string[] {
  return [...buildDdosScript(protection.ddos, extraPorts), ...buildWafScript(protection.waf)]
}
