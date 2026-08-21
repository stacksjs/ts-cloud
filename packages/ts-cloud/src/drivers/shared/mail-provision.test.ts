import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { buildMailEnv, mailFirewallPorts, resolveMailService } from '@ts-cloud/core'
import { buildServicesProvisionScript } from './db-provision'
import {
  buildDkimScript,
  buildMailAccountScript,
  buildMailConfigToml,
  buildMailEnvFile,
  buildMailProvisionScript,
  buildMailUnit,
  dkimKeyPath,
  mailDnsRecords,
  MAIL_USER,
} from './mail-provision'

function config(overrides: Partial<CloudConfig> = {}): CloudConfig {
  return {
    project: { name: 'Example', slug: 'example', region: 'us-east-1' },
    environments: {
      production: { type: 'production' },
      staging: { type: 'staging' },
    },
    sites: { main: { domain: 'example.com', root: 'dist' } },
    ...overrides,
  } as CloudConfig
}

function withMail(mail: any, overrides: Partial<CloudConfig> = {}): CloudConfig {
  const base = config(overrides)
  return {
    ...base,
    infrastructure: {
      ...base.infrastructure,
      compute: { ...base.infrastructure?.compute, managedServices: { mail } },
    },
  } as CloudConfig
}

describe('resolveMailService', () => {
  it('is disabled when nothing declares it', () => {
    const mail = resolveMailService(config(), { environment: 'production' })
    expect(mail.enabled).toBe(false)
    expect(buildMailProvisionScript(mail)).toEqual([])
  })

  it('resolves `true` to a server in production', () => {
    const mail = resolveMailService(withMail(true), { environment: 'production' })
    expect(mail.mode).toBe('server')
    expect(mail.hostname).toBe('mail.example.com')
    expect(mail.ports.smtp).toBe(25)
    expect(mail.ports.submission).toBe(587)
    expect(mail.expose).toBe(true)
    expect(mail.dkim.enabled).toBe(true)
  })

  it('resolves `true` to a catcher everywhere else, on mailpit’s ports', () => {
    const mail = resolveMailService(withMail(true), { environment: 'staging' })
    expect(mail.mode).toBe('catcher')
    expect(mail.ports.smtp).toBe(1025)
    expect(mail.webmail.port).toBe(8025)
    expect(mail.ports.submission).toBeUndefined()
    expect(mail.delivery).toBe('none')
  })

  it('treats an unknown environment as non-production', () => {
    // The safe direction: the mistake that costs something is provisioning an
    // open relay, not provisioning a trap.
    const mail = resolveMailService(withMail(true), { environment: 'preview-42' })
    expect(mail.mode).toBe('catcher')
  })

  it('keeps a catcher on loopback and out of the firewall', () => {
    const mail = resolveMailService(withMail(true), { environment: 'staging' })
    expect(mail.bindAddress).toBe('127.0.0.1')
    expect(mailFirewallPorts(mail)).toEqual([])
  })

  it('opens exactly the server’s listening ports', () => {
    const mail = resolveMailService(withMail(true), { environment: 'production' })
    expect(mail.bindAddress).toBe('0.0.0.0')
    expect(mailFirewallPorts(mail)).toEqual([25, 143, 465, 587, 993, 8080])
  })

  it('leaves the webmail port closed when a domain fronts it', () => {
    const mail = resolveMailService(
      withMail({ mode: 'server', webmail: { domain: 'mail.example.com' } }),
      { environment: 'production' },
    )
    expect(mailFirewallPorts(mail)).not.toContain(8080)
  })

  it('carries the hostname’s parent as a local domain', () => {
    const mail = resolveMailService(withMail({ mode: 'server', domains: ['other.test'] }), { environment: 'production' })
    expect(mail.domains).toEqual(['mail.example.com', 'example.com', 'other.test'])
  })

  it('lets an explicit mode override the environment', () => {
    const mail = resolveMailService(withMail({ mode: 'server' }), { environment: 'staging' })
    expect(mail.mode).toBe('server')
    expect(mail.ports.smtp).toBe(25)
  })
})

describe('buildMailEnv', () => {
  it('points an application at the catcher’s SMTP port with no credentials', () => {
    const env = buildMailEnv(resolveMailService(withMail(true), { environment: 'staging' }))
    expect(env).toEqual({
      MAIL_MAILER: 'smtp',
      MAIL_HOST: '127.0.0.1',
      MAIL_PORT: '1025',
      MAIL_ENCRYPTION: 'null',
      MAIL_USERNAME: 'null',
      MAIL_PASSWORD: 'null',
    })
  })

  it('uses the submission port and the first account on a server', () => {
    const mail = resolveMailService(
      withMail({ mode: 'server', accounts: [{ address: 'app@example.com', password: 'secret' }] }),
      { environment: 'production' },
    )
    const env = buildMailEnv(mail)
    expect(env.MAIL_PORT).toBe('587')
    expect(env.MAIL_USERNAME).toBe('app@example.com')
    expect(env.MAIL_PASSWORD).toBe('secret')
    expect(env.MAIL_ENCRYPTION).toBe('tls')
  })

  it('is empty when mail is not declared, so nothing is overwritten', () => {
    expect(buildMailEnv(resolveMailService(config(), { environment: 'production' }))).toEqual({})
  })
})

describe('buildMailConfigToml', () => {
  it('binds a catcher to loopback and turns auth off', () => {
    const toml = buildMailConfigToml(resolveMailService(withMail(true), { environment: 'staging' }))
    expect(toml).toContain('host = "127.0.0.1"')
    expect(toml).toContain('port = 1025')
    expect(toml).toContain('[auth]\nenabled = false')
    expect(toml).toContain('[tls]\nenabled = false')
  })

  it('makes a catcher catch, which takes catch_all', () => {
    // Without it the trap refuses almost everything it is sent: mail to a
    // domain the server does not host is correctly 550'd, and for a trap that
    // is every message an application under test produces.
    const catcher = buildMailConfigToml(resolveMailService(withMail(true), { environment: 'staging' }))
    expect(catcher).toContain('catch_all = true')

    // And a real server must never have it. It would accept and file mail for
    // every domain on earth.
    const server = buildMailConfigToml(resolveMailService(withMail(true), { environment: 'production' }))
    expect(server).not.toContain('catch_all')
  })

  it('binds a server to every interface with TLS and ACME on', () => {
    const toml = buildMailConfigToml(resolveMailService(withMail(true), { environment: 'production' }))
    expect(toml).toContain('host = "0.0.0.0"')
    expect(toml).toContain('hostname = "mail.example.com"')
    expect(toml).toContain('[auth]\nenabled = true')
    expect(toml).toContain('[acme]\nenabled = true')
  })

  it('does not enable ACME when a certificate is supplied', () => {
    const mail = resolveMailService(
      withMail({ mode: 'server', tls: { certPath: '/c.pem', keyPath: '/k.pem' } }),
      { environment: 'production' },
    )
    const toml = buildMailConfigToml(mail)
    expect(toml).toContain('cert_path = "/c.pem"')
    expect(toml).toContain('[acme]\nenabled = false')
  })
})

describe('buildMailEnvFile', () => {
  it('serves the webmail UI without Secure cookies over plain HTTP', () => {
    // A Secure cookie is dropped by the browser on a plain-HTTP loopback
    // connection, so the UI would take a login and behave as though nobody
    // had logged in.
    const env = buildMailEnvFile(resolveMailService(withMail(true), { environment: 'staging' }))
    expect(env).toContain('SMTP_ENABLE_WEBMAIL=true')
    expect(env).toContain('SMTP_WEBMAIL_PORT=8025')
    expect(env).toContain('SMTP_WEBMAIL_SECURE_COOKIES=false')
  })

  it('gives every extra domain its own DKIM key', () => {
    const mail = resolveMailService(
      withMail({ mode: 'server', domains: ['other.test'] }),
      { environment: 'production' },
    )
    const env = buildMailEnvFile(mail)
    expect(env).toContain('DKIM_DOMAIN=mail.example.com')
    expect(env).toContain(`DKIM_EXTRA_KEYS=example.com:default:${dkimKeyPath(mail, 'example.com')},other.test:default:${dkimKeyPath(mail, 'other.test')}`)
  })

  it('omits IMAP and submission for a catcher', () => {
    const env = buildMailEnvFile(resolveMailService(withMail(true), { environment: 'staging' }))
    expect(env).not.toContain('IMAP_ENABLED')
    expect(env).not.toContain('SUBMISSION_PORT')
  })
})

describe('buildMailUnit', () => {
  it('grants CAP_NET_BIND_SERVICE only for privileged ports', () => {
    const server = buildMailUnit(resolveMailService(withMail(true), { environment: 'production' }))
    expect(server).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE')

    const catcher = buildMailUnit(resolveMailService(withMail(true), { environment: 'staging' }))
    expect(catcher).not.toContain('CAP_NET_BIND_SERVICE')
  })

  it('never runs as root', () => {
    const unit = buildMailUnit(resolveMailService(withMail(true), { environment: 'production' }))
    expect(unit).toContain(`User=${MAIL_USER}`)
    expect(unit).toContain('NoNewPrivileges=true')
    expect(unit).toContain('ProtectSystem=strict')
  })

  it('names the directories it must still be able to write', () => {
    // ProtectSystem=strict makes the whole filesystem read-only; without these
    // the server cannot store a single message.
    const unit = buildMailUnit(resolveMailService(withMail(true), { environment: 'production' }))
    expect(unit).toContain('ReadWritePaths=/var/lib/mail /etc/mail')
  })
})

describe('buildDkimScript', () => {
  it('generates a key only when one is absent', () => {
    const mail = resolveMailService(withMail(true), { environment: 'production' })
    const script = buildDkimScript(mail).join('\n')
    expect(script).toContain(`if [ ! -f '${dkimKeyPath(mail, 'mail.example.com')}' ]; then openssl genrsa`)
    expect(script).toContain('p=$(openssl rsa')
  })

  it('signs nothing for a catcher', () => {
    expect(buildDkimScript(resolveMailService(withMail(true), { environment: 'staging' }))).toEqual([])
  })
})

describe('buildMailAccountScript', () => {
  it('runs create AND change-password, because create exits 0 when the account exists', () => {
    const mail = resolveMailService(
      withMail({ mode: 'server', accounts: [{ address: 'app@example.com', password: 'secret' }] }),
      { environment: 'production' },
    )
    const script = buildMailAccountScript(mail)
    expect(script).toHaveLength(2)
    expect(script[0]).toContain('user:local create')
    expect(script[1]).toContain('user:local change-password')
    // Against the server's own database, as the service account — as root it
    // would create a second database beside the one the server reads.
    expect(script[0]).toContain(`runuser -u ${MAIL_USER}`)
    expect(script[0]).toContain("SMTP_DB_PATH='/var/lib/mail/mail.db'")
  })
})

describe('mailDnsRecords', () => {
  it('is empty for a catcher, which receives nothing from the internet', () => {
    expect(mailDnsRecords(resolveMailService(withMail(true), { environment: 'staging' }))).toEqual([])
  })

  it('names MX, SPF, DMARC and DKIM for every domain', () => {
    const records = mailDnsRecords(resolveMailService(withMail(true), { environment: 'production' }))
    const forParent = records.filter(record => record.name === 'example.com' || record.name === '_dmarc.example.com')
    expect(forParent.map(record => record.type)).toEqual(['MX', 'TXT', 'TXT'])
    expect(records.some(record => record.name === 'default._domainkey.example.com')).toBe(true)
  })

  it('starts DMARC in report-only mode', () => {
    // A policy that quarantines starts discarding mail the moment SPF or DKIM
    // is misconfigured, and the first week of a new mail server is exactly
    // when they are.
    const records = mailDnsRecords(resolveMailService(withMail(true), { environment: 'production' }))
    expect(records.find(record => record.name.startsWith('_dmarc'))?.value).toContain('p=none')
  })
})

describe('buildServicesProvisionScript', () => {
  it('provisions mail beside the engines', () => {
    const mail = resolveMailService(withMail(true), { environment: 'production' })
    const script = buildServicesProvisionScript({ postgres: true, mail: true }, { mail }).join('\n')
    expect(script).toContain('postgresql.org')
    expect(script).toContain('github.com/mail-os/mail')
    expect(script).toContain('systemctl restart mail')
  })

  it('provisions mail on a box that runs no engines at all', () => {
    const mail = resolveMailService(withMail(true), { environment: 'production' })
    const script = buildServicesProvisionScript({ mail: true }, { mail }).join('\n')
    expect(script).toContain('github.com/mail-os/mail')
  })

  it('provisions nothing when no mail is resolved', () => {
    expect(buildServicesProvisionScript({})).toEqual([])
  })
})
