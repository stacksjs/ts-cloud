import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRpxConfig, buildRpxHttp2PolicyCheck, buildRpxProvisionScript } from '../../src/drivers/shared/rpx-gateway'

const directory = mkdtempSync(join(tmpdir(), 'rpx-effective-policy-'))
writeFileSync(join(directory, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$TEST_SERVICE_ENV"\nexit "${TEST_SYSTEMCTL_STATUS:-0}"\n', { mode: 0o755 })
afterAll(() => rmSync(directory, { recursive: true, force: true }))

function inspect(environment: string, enabled = false, status = '0') {
  return Bun.spawnSync(['bash', '-e', '-c', `${buildRpxHttp2PolicyCheck(enabled, process.execPath)}\nprintf gateway-restart-reached`], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_SERVICE_ENV: environment, TEST_SYSTEMCTL_STATUS: status },
  })
}

describe.skipIf(process.platform === 'win32')('effective gateway HTTP/2 policy', () => {
  it.each([false, true])('allows the declared effective policy (%s)', (enabled) => {
    const result = inspect(`APP_ENV=production RPX_HTTP2=${enabled ? '1' : '0'}`, enabled)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('gateway-restart-reached')
  })

  it('refuses an overriding opt-in without exposing unrelated environment secrets', () => {
    const result = inspect('APP_KEY=private-fixture-value RPX_HTTP2=1')
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout.toString()).toBe('')
    expect(result.stderr.toString()).toContain('systemd drop-in overrides')
    expect(result.stderr.toString()).not.toContain('private-fixture-value')
  })

  it('checks the last assignment and accepts systemd quoting', () => {
    expect(inspect('RPX_HTTP2=1 "RPX_HTTP2=0"').exitCode).toBe(0)
    expect(inspect('"RPX_HTTP2=0" RPX_HTTP2=1').exitCode).not.toBe(0)
  })

  it('refuses missing policy and failed inspection even when stdout matches', () => {
    expect(inspect('APP_ENV=production').exitCode).not.toBe(0)
    expect(inspect('RPX_HTTP2=0', false, '1').exitCode).not.toBe(0)
  })

  it('checks the owner after daemon reload and leaves tenant policy untouched', () => {
    const proxy = { engine: 'rpx' as const }
    const config = buildRpxConfig({}, { proxy })
    const command = buildRpxHttp2PolicyCheck(false)
    const owner = buildRpxProvisionScript({ config, proxy })
    expect(owner.indexOf(command)).toBeGreaterThan(owner.indexOf('systemctl daemon-reload'))
    expect(owner.indexOf(command)).toBeLessThan(owner.indexOf('systemctl disable --now bun-gateway.service 2>/dev/null || true'))
    expect(buildRpxProvisionScript({ config, proxy, tenant: true })).not.toContain(command)
  })
})
