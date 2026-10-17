import type { CloudConfig, ResolvedMailService } from '@ts-cloud/core'
import { resolveMailProxy, resolveMailService } from '@ts-cloud/core'
import { buildRpxConfig, buildRpxProvisionScript, RPX_BINARY_PATH, RPX_INSTALL_DIR } from '../drivers/shared/rpx-gateway'

/** Existing installations and full compute provisioning share these defaults. */
export interface MailWebmailDeploymentOptions {
  /** Native SSH destination; its configured identities and known hosts apply. */
  target: string
  /** Environment to resolve. @default 'production' */
  environment?: string
  /** The route fragment and renewal-unit owner. @default config.project.slug */
  slug?: string
  /** Existing mail service's EnvironmentFile. @default '/etc/mail/mail.env' */
  envFile?: string
  /** Existing mail service unit. @default 'mail.service' */
  service?: string
  /** Existing shared gateway or provision a gateway owned by this project. */
  gateway?: 'existing' | 'provision'
  /** Bun installed on the host. @default '/usr/local/bin/bun' */
  bunBin?: string
  /** SSH private key; omitted to use normal SSH configuration. */
  sshKeyPath?: string
  /** Run TLS-validated checks for each hostname. @default true */
  verify?: boolean
  /** UI readiness path. @default '/login' */
  healthPath?: string
  /** Bound the remote deployment. @default 300000 */
  timeoutMs?: number
}

function sh(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Patch only webmail settings, atomically preserving SMTP, accounts, DKIM and
 * permissions. The output is `changed` or `unchanged` for conditional restarts. */
export function buildMailWebmailEnvPatch(mail: ResolvedMailService, envFile: string = '/etc/mail/mail.env', bunBin: string = '/usr/local/bin/bun'): string {
  const settings = {
    SMTP_ENABLE_WEBMAIL: String(mail.webmail.enabled),
    SMTP_WEBMAIL_PORT: String(mail.webmail.port),
    SMTP_WEBMAIL_TLS: String(mail.webmail.tls),
    SMTP_WEBMAIL_SECURE_COOKIES: String(mail.webmail.secureCookies),
    SMTP_WEBMAIL_ATTACHMENT_MAX_FILE: String(mail.webmail.attachmentMaxFileBytes),
    SMTP_WEBMAIL_ATTACHMENT_MAX_TOTAL: String(mail.webmail.attachmentMaxTotalBytes),
    SMTP_WEBMAIL_ATTACHMENT_MAX_COUNT: String(mail.webmail.attachmentMaxCount),
    SMTP_WEBMAIL_UNDO_SEND_SECONDS: String(mail.webmail.undoSendSeconds),
  }
  const program = `const fs=require('node:fs');const path=process.argv[1];const settings=JSON.parse(process.argv[2]);const before=fs.readFileSync(path,'utf8');const lines=before.split(/\\r?\\n/).filter(line=>line!==''&&!Object.hasOwn(settings,line.split('=',1)[0]));const after=lines.concat(Object.entries(settings).map(([key,value])=>key+'='+value)).join('\\n')+'\\n';if(after===before){console.log('unchanged')}else{const stat=fs.statSync(path);const backup=path+'.bak-webmail';fs.copyFileSync(path,backup);fs.chmodSync(backup,stat.mode&511);fs.chownSync(backup,stat.uid,stat.gid);const temporary=path+'.webmail-'+process.pid;fs.writeFileSync(temporary,after,{mode:stat.mode&511});fs.chownSync(temporary,stat.uid,stat.gid);fs.chmodSync(temporary,stat.mode&511);fs.renameSync(temporary,path);console.log('changed')}`
  return `${sh(bunBin)} --eval ${sh(program)} ${sh(envFile)} ${sh(JSON.stringify(settings))}`
}

/** Existing-server adoption uses the same rpx builders as cold boot. Domains,
 * aliases, listener settings and ACME options all come from services.mail. */
export function buildMailWebmailDeploymentScript(config: CloudConfig, options: MailWebmailDeploymentOptions): string {
  const environment = options.environment ?? 'production'
  const mail = resolveMailService(config, { environment })
  if (!mail.enabled || !mail.webmail.enabled) return ''
  if (!mail.webmail.domain) throw new Error('Mail webmail deployment needs a hostname; set mail.webmail.domain or use compute provisioning for a local catcher')
  if (mail.webmail.tls) throw new Error('Gateway webmail uses loopback HTTP: set mail.webmail.tls to false, or domain to false for a direct TLS listener')
  const proxy = resolveMailProxy(config, { environment })!
  const slug = options.slug ?? config.project.slug
  const bunBin = options.bunBin ?? '/usr/local/bin/bun'
  const envFile = options.envFile ?? '/etc/mail/mail.env'
  const service = options.service ?? 'mail.service'
  const healthPath = options.healthPath ?? '/login'
  if (!/^[a-z0-9@._-]+$/i.test(service) || service.startsWith('-')) throw new Error('Invalid mail service unit')
  if (!envFile.startsWith('/') || !healthPath.startsWith('/') || /[\r\n]/.test(envFile + healthPath)) throw new Error('Mail environment path must be absolute and health path must start with /')
  const rpxConfig = buildRpxConfig({}, { proxy, slug, mail })
  const existing = options.gateway !== 'provision'
  const commands = [
    'set -euo pipefail',
    `test -f ${sh(envFile)}`,
    ...(existing ? [`test -x ${RPX_BINARY_PATH}`, `test -d ${RPX_INSTALL_DIR}/node_modules/@stacksjs/rpx`, ...(proxy.onDemandTls ? [`test -f ${RPX_INSTALL_DIR}/node_modules/@stacksjs/tlsx/dist/bin/cli.js`] : [])] : []),
    `__tsc_mail_changed="$(${buildMailWebmailEnvPatch(mail, envFile, bunBin)})"`,
    `if [ "$__tsc_mail_changed" = changed ] || ! systemctl is-active --quiet ${sh(service)}; then systemctl restart ${sh(service)}; fi`,
    `curl --fail --silent --show-error --retry 30 --retry-all-errors --retry-delay 1 --max-time 5 ${sh(`http://127.0.0.1:${mail.webmail.port}${healthPath}`)} >/dev/null`,
    ...buildRpxProvisionScript({ config: rpxConfig, proxy, slug, bunBin, tenant: existing }),
  ]
  if (options.verify !== false) {
    for (const host of [mail.webmail.domain, ...mail.webmail.aliases]) {
      commands.push(
        `__tsc_mail_status="$(curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 3 --max-time 15 --output /dev/null --write-out '%{http_code}' ${sh(`https://${host}${healthPath}`)})"`,
        `if [ "$__tsc_mail_status" != 200 ]; then echo ${sh(`ts-cloud: webmail verification failed for ${host}`)} >&2; exit 1; fi`,
      )
    }
  }
  commands.push(`echo ${sh(`[ts-cloud] Webmail deployed: ${[mail.webmail.domain, ...mail.webmail.aliases].join(', ')}`)}`)
  return `${commands.join('\n')}\n`
}

/** Deploy only the webmail integration of an existing mail binary. No mailbox
 * or credential reconciliation runs; the ordinary compute path owns those. */
export async function deployMailWebmail(config: CloudConfig, options: MailWebmailDeploymentOptions): Promise<void> {
  const script = buildMailWebmailDeploymentScript(config, options)
  if (!script) return
  if (!/^(?:[a-z_][a-z0-9._-]*@)?[a-z0-9.:[\]_-]+$/i.test(options.target) || options.target.startsWith('-')) throw new Error('Invalid SSH target')
  const args = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...(options.sshKeyPath ? ['-i', options.sshKeyPath] : []), options.target, 'bash', '-se']
  const child = Bun.spawn(args, { stdin: new Blob([script]), stdout: 'inherit', stderr: 'inherit' })
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 300000)
  try {
    const code = await child.exited
    if (code !== 0) throw new Error(`Mail webmail deployment failed (SSH exit ${code})`)
  }
  finally { clearTimeout(timer) }
}
