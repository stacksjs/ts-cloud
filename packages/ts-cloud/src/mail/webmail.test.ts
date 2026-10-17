import type { CloudConfig, MailServiceConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mailWebmailSites, resolveMailProxy, resolveMailService } from '@ts-cloud/core'
import { buildRpxConfig } from '../drivers/shared/rpx-gateway'
import { buildMailWebmailDeploymentScript, buildMailWebmailEnvPatch, deployMailWebmail } from './webmail'

function config(mail: boolean | MailServiceConfig = true): CloudConfig {
  return {
    project: { name: 'Mail', slug: 'mail', region: 'us-east-1' },
    environments: { production: { type: 'production', domain: 'example.com' }, development: { type: 'development' } },
    infrastructure: { compute: { managedServices: { mail } } },
  } as CloudConfig
}

describe('native webmail defaults', () => {
  it('routes production mail through HTTPS without publishing a plain listener', () => {
    const c = config()
    const mail = resolveMailService(c, { environment: 'production' })
    expect(mail.webmail).toEqual({ enabled: true, port: 8080, domain: 'mail.example.com', aliases: [], tls: false, secureCookies: true, attachmentMaxFileBytes: 20 * 1024 * 1024, attachmentMaxTotalBytes: 20 * 1024 * 1024, attachmentMaxCount: 20, undoSendSeconds: 10 })
    const proxy = resolveMailProxy(c, { environment: 'production' })!
    expect(proxy.engine).toBe('rpx')
    expect(proxy.onDemandTls).toBe(true)
    const gateway = buildRpxConfig({}, { proxy, mail })
    expect(gateway.proxies).toContainEqual({ to: 'mail.example.com', from: 'localhost:8080', id: 'mail.example.com' })
    expect(gateway.productionCerts.certsDirServerNames).toContain('mail.example.com')
    expect(gateway.onDemandTls?.allowedSuffixes).toContain('mail.example.com')
  })

  it('keeps a development catcher on loopback and allows explicit direct TLS', () => {
    const catcher = resolveMailService(config(), { environment: 'development' })
    expect(catcher.webmail.domain).toBeUndefined()
    expect(catcher.webmail.secureCookies).toBe(false)
    expect(mailWebmailSites(catcher)).toEqual({})
    const direct = resolveMailService(config({ webmail: { domain: false, port: 8443 } }), { environment: 'production' })
    expect(direct.webmail.tls).toBe(true)
    expect(mailWebmailSites(direct)).toEqual({})
  })

  it('carries configurable attachment and Undo Send settings into both provisioning paths', () => {
    const c = config({ webmail: { attachments: { maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 12 * 1024 * 1024, maxCount: 8 }, undoSendSeconds: 5 } })
    const resolved = resolveMailService(c, { environment: 'production' })
    expect(resolved.webmail.attachmentMaxFileBytes).toBe(8 * 1024 * 1024)
    expect(resolved.webmail.attachmentMaxTotalBytes).toBe(12 * 1024 * 1024)
    expect(resolved.webmail.attachmentMaxCount).toBe(8)
    expect(resolved.webmail.undoSendSeconds).toBe(5)
    const patch = buildMailWebmailEnvPatch(resolved)
    for (const key of ['SMTP_WEBMAIL_ATTACHMENT_MAX_FILE', 'SMTP_WEBMAIL_ATTACHMENT_MAX_TOTAL', 'SMTP_WEBMAIL_ATTACHMENT_MAX_COUNT', 'SMTP_WEBMAIL_UNDO_SEND_SECONDS']) expect(patch).toContain(key)
  })

  it('rejects invalid limits and accepts disabling uploads or the cancellation delay', () => {
    for (const value of [-1, 1.5, Number.NaN, 101 * 1024 * 1024]) expect(() => resolveMailService(config({ webmail: { attachments: { maxFileBytes: value } } }))).toThrow('maxFileBytes')
    expect(() => resolveMailService(config({ webmail: { attachments: { maxCount: 101 } } }))).toThrow('maxCount')
    expect(() => resolveMailService(config({ webmail: { undoSendSeconds: 31 } }))).toThrow('undoSendSeconds')
    const disabled = resolveMailService(config({ webmail: { attachments: { maxCount: 0 }, undoSendSeconds: 0 } }))
    expect(disabled.webmail.attachmentMaxCount).toBe(0)
    expect(disabled.webmail.undoSendSeconds).toBe(0)
  })

  it('puts every alias in the same gateway and certificate lifecycle', () => {
    const c = config({ webmail: { port: 8099, aliases: ['mail.other.test'] } })
    const mail = resolveMailService(c, { environment: 'production' })
    const gateway = buildRpxConfig({}, { proxy: resolveMailProxy(c, { environment: 'production' })!, mail })
    expect(gateway.proxies.map(route => route.to)).toEqual(['mail.example.com', 'mail.other.test'])
    expect(gateway.proxies.every(route => route.from === 'localhost:8099')).toBe(true)
    expect(gateway.productionCerts.certsDirServerNames).toContain('mail.other.test')
    expect(gateway.onDemandTls?.allowedSuffixes).toContain('mail.other.test')
    const script = buildMailWebmailDeploymentScript(c, { target: 'root@host', envFile: '/etc/custom/mail.env', service: 'custom-mail.service' })
    expect(script).toContain('/etc/custom/mail.env')
    expect(script).toContain('custom-mail.service')
    expect(script).toContain('rpx-cert-renew-mail.timer')
    expect(script).toContain('https://mail.other.test/login')
    expect(script).not.toContain('user:local')
    expect(script).not.toContain('curl --insecure')
    const syntax = Bun.spawnSync(['bash', '-n'], { stdin: Buffer.from(script), stdout: 'pipe', stderr: 'pipe' })
    expect(syntax.stderr.toString()).toBe('')
    expect(syntax.exitCode).toBe(0)
  })

  it('rejects invalid hostnames and unsafe SSH destinations before executing', async () => {
    const c = config({ webmail: { aliases: ['mail.test;echo invalid'] } })
    expect(() => buildMailWebmailDeploymentScript(c, { target: 'root@host' })).toThrow('Invalid mail webmail hostname')
    await expect(deployMailWebmail(config(), { target: 'root@host;echo invalid' })).rejects.toThrow('Invalid SSH target')
    expect(buildMailWebmailDeploymentScript(config(false), { target: 'root@host' })).toBe('')
  })
})

it('webmail adoption preserves SMTP configuration, permissions and idempotence', () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-cloud-webmail-'))
  try {
    const path = join(root, 'mail.env')
    const before = 'SMTP_DB_PATH=/existing/smtp.db\nSMTP_ENABLE_TLS=true\nDKIM_PRIVATE_KEY_PATH=/existing/dkim.pem\nSMTP_WEBMAIL_PORT=8080\n'
    writeFileSync(path, before)
    chmodSync(path, 0o640)
    const mail = resolveMailService(config({ webmail: { port: 8099 } }), { environment: 'production' })
    const patch = buildMailWebmailEnvPatch(mail, path, process.execPath)
    const first = Bun.spawnSync(['bash', '-c', `umask 077\n${patch}`], { stdout: 'pipe', stderr: 'pipe' })
    expect(first.stderr.toString()).toBe('')
    expect(first.exitCode).toBe(0)
    expect(first.stdout.toString().trim()).toBe('changed')
    const after = readFileSync(path, 'utf8')
    expect(after).toContain('SMTP_DB_PATH=/existing/smtp.db')
    expect(after).toContain('SMTP_ENABLE_TLS=true')
    expect(after).toContain('SMTP_WEBMAIL_PORT=8099')
    expect(after).toContain('SMTP_WEBMAIL_TLS=false')
    expect(after).toContain('SMTP_WEBMAIL_SECURE_COOKIES=true')
    expect(statSync(path).mode & 0o777).toBe(0o640)
    expect(statSync(`${path}.bak-webmail`).mode & 0o777).toBe(0o640)
    expect(readFileSync(`${path}.bak-webmail`, 'utf8')).toBe(before)
    const second = Bun.spawnSync(['bash', '-c', patch], { stdout: 'pipe', stderr: 'pipe' })
    expect(second.exitCode).toBe(0)
    expect(second.stdout.toString().trim()).toBe('unchanged')
    expect(readFileSync(path, 'utf8')).toBe(after)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
