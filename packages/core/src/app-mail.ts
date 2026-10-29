import type {
  CloudConfig,
  ComputeProxyConfig,
  SiteConfig,
  EnvironmentType,
  MailPortsConfig,
  MailServiceConfig,
  MailServiceMode,
} from './types'

/**
 * The one place that decides what "mail" means for an environment.
 *
 * `services.mail` is deliberately allowed to be `true`, because the useful
 * declaration is "this project sends email" and not "this project runs an MTA
 * on 25 with DKIM keys for two domains and a smarthost". Everything after that
 * follows from the environment: production wants a real server, a preview box
 * wants a trap. Both are the same binary, which is the point - see
 * {@link MailServiceMode}.
 *
 * The provisioner, the firewall, the DNS planner and the `.env` writer all
 * resolve through here so they cannot disagree about which ports are open,
 * which hostname is announced, or where the webmail UI is. That mattered
 * immediately: a catcher whose SMTP port the `.env` said was 1025 and whose
 * firewall rule said 25 is a box where mail silently goes nowhere.
 */

/** Everything about the mail service, with nothing left to infer. */
export interface ResolvedMailService {
  /** Whether mail is provisioned at all. */
  enabled: boolean
  /** Real MTA or local trap. */
  mode: MailServiceMode
  /** Pinned version, or `undefined` for the latest release. */
  version?: string
  /** The FQDN the server announces and signs as. */
  hostname: string
  /** Every domain delivered to mailboxes here, `hostname`'s parent included. */
  domains: string[]
  /** Resolved listening ports; a port that is off is absent. */
  ports: ResolvedMailPorts
  /** TLS, resolved. `acme` implies the server obtains its own certificate. */
  tls: { enabled: boolean, acme: boolean, certPath?: string, keyPath?: string, requireForAuth: boolean, acmeEmail?: string, systemCredentials?: { certPath: string; keyPath: string } }
  /** DKIM, resolved. Off means the server signs nothing. */
  dkim: { enabled: boolean, selector: string, rotate: boolean, rotateIntervalDays: number }
  /** Webmail UI, resolved. */
  webmail: { enabled: boolean, port: number, domain?: string, aliases: string[], tls: boolean, secureCookies: boolean, attachmentMaxFileBytes: number, attachmentMaxTotalBytes: number, attachmentMaxCount: number, undoSendSeconds: number }
  /** How outbound mail leaves. */
  delivery: 'direct' | 'ses' | 'none'
  /** SES region for `delivery: 'ses'`. */
  sesRegion: string
  /** Mailboxes created on provision. */
  accounts: Array<{ address: string, password: string, passwordPolicy: 'initial' | 'managed' }>
  /** Where mailboxes, the database and the DKIM keys live. */
  storagePath: string
  /** Largest accepted message, in bytes. */
  maxMessageSize: number
  /** Inbound spam handling, resolved. */
  spam: { enabled: boolean, enforce: boolean, junkScore: number, rejectScore: number, dnsbl: boolean, dnsblReject: boolean, greylist: boolean }
  /** Where received mail is POSTed, when configured. */
  webhookUrl?: string
  /** Whether the mail ports face the internet. */
  expose: boolean
  /** The address the listeners bind to, which follows from {@link expose}. */
  bindAddress: string
}

/** Resolved ports. A protocol this mode does not serve is absent, not zero. */
export interface ResolvedMailPorts {
  smtp: number
  submission?: number
  submissions?: number
  imap?: number
  imaps?: number
  webmail: number
  managesieve?: number
}

/** mailpit's ports, which a catcher adopts so nothing has to be repointed. */
const CATCHER_SMTP_PORT = 1025
const CATCHER_WEBMAIL_PORT = 8025

function settings(value: boolean | MailServiceConfig | undefined): MailServiceConfig {
  return typeof value === 'object' && value !== null ? value : {}
}

/** Whether a `services.mail` declaration asks for anything at all. */
export function mailEnabled(value: boolean | MailServiceConfig | undefined): boolean {
  return value === true || (typeof value === 'object' && value !== null)
}

/**
 * The domain this project's mail belongs to.
 *
 * The environment's own domain first, then the primary site's, then the
 * project slug as a last resort. A catcher never reaches the last one in
 * practice because it announces `localhost` instead - it delivers to itself,
 * so the name only has to be syntactically valid.
 */
function projectDomain(config: Pick<CloudConfig, 'project' | 'sites' | 'environments'>, environment?: string): string {
  const env = environment ? config.environments?.[environment] : undefined
  if (env?.domain) return env.domain

  const sites = Object.values(config.sites ?? {})
  const main = config.sites?.main?.domain ?? sites.find(site => site.domain)?.domain
  if (main) return main

  return `${config.project?.slug ?? 'app'}.local`
}

/**
 * The parent of a `mail.example.com`-shaped hostname, which the mail server
 * already treats as local. Returned so callers can present the full set of
 * domains without re-deriving the rule.
 */
function parentDomain(hostname: string): string | undefined {
  const dot = hostname.indexOf('.')
  return dot > 0 ? hostname.slice(dot + 1) : undefined
}

export interface ResolveMailOptions {
  /** Which environment is being provisioned, e.g. `'production'`. */
  environment?: string
  /**
   * Its type, when the caller already knows it. Otherwise it is read from
   * `config.environments[environment].type`, and an unknown environment is
   * treated as non-production - which is the safe direction: the mistake that
   * costs something is provisioning an open relay, not provisioning a trap.
   */
  environmentType?: EnvironmentType
}

/**
 * Resolve `infrastructure.compute.managedServices.mail` for an environment.
 *
 * Returns `enabled: false` (and defaults everywhere else) when mail is not
 * declared, so callers can read the shape unconditionally instead of guarding
 * every field.
 */
export function resolveMailService(
  config: Pick<CloudConfig, 'project' | 'sites' | 'environments' | 'infrastructure'>,
  options: ResolveMailOptions = {},
): ResolvedMailService {
  const declared = config.infrastructure?.compute?.managedServices?.mail
  const mail = settings(declared)
  const envType = options.environmentType
    ?? (options.environment ? config.environments?.[options.environment]?.type : undefined)

  // Unknown environment reads as non-production. See ResolveMailOptions.
  const mode: MailServiceMode = mail.mode ?? (envType === 'production' ? 'server' : 'catcher')
  const server = mode === 'server'

  const domain = projectDomain(config, options.environment)
  const hostname = mail.hostname ?? (server ? `mail.${domain}` : 'localhost')

  const declaredPorts: MailPortsConfig = mail.ports ?? {}
  const ports: ResolvedMailPorts = server
    ? {
        smtp: declaredPorts.smtp ?? 25,
        submission: declaredPorts.submission ?? 587,
        submissions: declaredPorts.submissions ?? 465,
        imap: declaredPorts.imap ?? 143,
        imaps: declaredPorts.imaps ?? 993,
        webmail: declaredPorts.webmail ?? 8080,
        managesieve: declaredPorts.managesieve,
      }
    : {
        // A catcher serves SMTP and a UI and nothing else. Submission and IMAP
        // exist to authenticate real users against real mailboxes, and a trap
        // has neither - offering them would only invite somebody to configure a
        // desktop client against a server that discards everything.
        smtp: declaredPorts.smtp ?? CATCHER_SMTP_PORT,
        submission: declaredPorts.submission,
        submissions: declaredPorts.submissions,
        imap: declaredPorts.imap,
        imaps: declaredPorts.imaps,
        webmail: declaredPorts.webmail ?? CATCHER_WEBMAIL_PORT,
        managesieve: declaredPorts.managesieve,
      }

  const tlsDeclared = mail.tls ?? {}
  const tlsEnabled = tlsDeclared.enabled ?? server
  const explicitCert = !!(tlsDeclared.systemCredentials || (tlsDeclared.certPath && tlsDeclared.keyPath))
  if (tlsDeclared.systemCredentials && Object.values(tlsDeclared.systemCredentials).some(path => !/^\/[a-z0-9_./-]+$/i.test(path) || path.includes('/../')))
    throw new Error('Mail system credentials require absolute certificate paths')
  const accounts = (mail.accounts ?? []).map(account => ({ address: account.address, password: account.password, passwordPolicy: account.passwordPolicy ?? 'initial' as const }))

  const dkimDeclared = typeof mail.dkim === 'object' && mail.dkim !== null ? mail.dkim : {}
  const dkimEnabled = mail.dkim === false ? false : (mail.dkim === true || server)

  const webmailDeclared = typeof mail.webmail === 'object' && mail.webmail !== null ? mail.webmail : {}
  const webmailEnabled = mail.webmail === false ? false : (webmailDeclared.enabled ?? true)
  const publicHostname = hostname.includes('.') && !hostname.endsWith('.local') && !/^\d+\.\d+\.\d+\.\d+$/.test(hostname)
  const webmailDomain = webmailDeclared.domain === false ? undefined : (webmailDeclared.domain ?? (server && publicHostname ? hostname : undefined))
  const webmailTls = webmailDeclared.tls ?? (webmailDomain ? false : tlsEnabled)
  const webmailAliases = [...new Set(webmailDeclared.aliases ?? [])].filter(alias => alias !== webmailDomain)


  const spamDeclared = mail.spam ?? {}
  const delivery = mail.delivery ?? (server ? 'direct' : 'none')

  const expose = mail.expose ?? server

  const parent = parentDomain(hostname)
  const domains = [...new Set([
    hostname,
    ...(parent ? [parent] : []),
    ...(mail.domains ?? []),
  ])]

  const attachmentMaxFileBytes = webmailDeclared.attachments?.maxFileBytes ?? 20 * 1024 * 1024
  const attachmentMaxTotalBytes = webmailDeclared.attachments?.maxTotalBytes ?? 20 * 1024 * 1024
  const attachmentMaxCount = webmailDeclared.attachments?.maxCount ?? 20
  const undoSendSeconds = webmailDeclared.undoSendSeconds ?? 10
  for (const [name, value, maximum] of [
    ['maxFileBytes', attachmentMaxFileBytes, 100 * 1024 * 1024],
    ['maxTotalBytes', attachmentMaxTotalBytes, 100 * 1024 * 1024],
    ['maxCount', attachmentMaxCount, 100],
    ['undoSendSeconds', undoSendSeconds, 30],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > maximum) throw new Error(`Mail webmail ${name} must be an integer from 0 to ${maximum}`)
  }
  return {
    enabled: mailEnabled(declared),
    mode,
    version: mail.version,
    hostname,
    domains,
    ports,
    tls: {
      enabled: tlsEnabled,
      acme: tlsEnabled && !explicitCert && (tlsDeclared.acme ?? true),
      certPath: tlsDeclared.systemCredentials ? '/run/credentials/mail.service/server.crt' : tlsDeclared.certPath,
      keyPath: tlsDeclared.systemCredentials ? '/run/credentials/mail.service/server.key' : tlsDeclared.keyPath,
      systemCredentials: tlsDeclared.systemCredentials,
      // Only meaningful where TLS exists at all; a catcher with no TLS that
      // required it for AUTH would refuse every login it offers.
      requireForAuth: tlsDeclared.requireForAuth ?? (tlsEnabled && server),
      acmeEmail: tlsDeclared.acmeEmail ?? accounts[0]?.address,
    },
    dkim: {
      enabled: dkimEnabled,
      selector: dkimDeclared.selector ?? 'default',
      rotate: dkimDeclared.rotate ?? false,
      rotateIntervalDays: dkimDeclared.rotateIntervalDays ?? 90,
    },
    webmail: {
      enabled: webmailEnabled,
      port: webmailDeclared.port ?? ports.webmail,
      domain: webmailDomain,
      aliases: webmailAliases,
      tls: webmailTls,
      secureCookies: webmailDeclared.secureCookies ?? (!!webmailDomain || webmailTls),
      attachmentMaxFileBytes,
      attachmentMaxTotalBytes,
      attachmentMaxCount,
      undoSendSeconds,
    },
    delivery,
    sesRegion: mail.sesRegion ?? 'us-east-1',
    accounts,
    storagePath: mail.storagePath ?? '/var/lib/mail',
    maxMessageSize: mail.maxMessageSize ?? 26_214_400,
    spam: {
      enabled: spamDeclared.enabled ?? server,
      enforce: spamDeclared.enforce ?? false,
      junkScore: spamDeclared.junkScore ?? 5,
      rejectScore: spamDeclared.rejectScore ?? 12,
      dnsbl: spamDeclared.dnsbl ?? server,
      dnsblReject: spamDeclared.dnsblReject ?? false,
      greylist: spamDeclared.greylist ?? false,
    },
    webhookUrl: mail.webhookUrl,
    expose,
    // A catcher that is not exposed binds loopback, and that is load-bearing
    // rather than tidy: it accepts mail for every recipient and shows it in a
    // UI with no password. See MailServiceConfig.expose.
    bindAddress: expose ? '0.0.0.0' : '127.0.0.1',
  }
}

/**
 * The ports the host firewall has to open for this mail service.
 *
 * Empty when mail is not exposed, which is the whole reason this is a function
 * rather than a list somebody maintains beside the resolver: a catcher's ports
 * must never end up in an allow list.
 */
export function mailFirewallPorts(mail: ResolvedMailService): number[] {
  if (!mail.enabled || !mail.expose) return []

  const ports = [
    mail.ports.smtp,
    mail.ports.submission,
    mail.ports.submissions,
    mail.ports.imap,
    mail.ports.imaps,
    mail.ports.managesieve,
  ].filter((port): port is number => typeof port === 'number')

  // The webmail UI only joins the list when it is reached on its own port. A
  // `webmail.domain` means the gateway fronts it on 443, which is already open,
  // and opening the raw port as well would publish a plain-HTTP login page
  // beside the TLS one.
  if (mail.webmail.enabled && !mail.webmail.domain) ports.push(mail.webmail.port)

  return [...new Set(ports)].sort((a, b) => a - b)
}

/**
 * `.env` pairs pointing an application at this mail service, in the shape the
 * Stacks/Laravel families of framework read.
 *
 * Merge into a site's `env` so `MAIL_*` is set from the same resolution the
 * provisioner used. The alternative - a hand-copied `MAIL_PORT` - is the
 * mistake this whole module exists to make impossible.
 */
export function buildMailEnv(mail: ResolvedMailService): Record<string, string> {
  if (!mail.enabled) return {}

  // Submission where there is one, otherwise the SMTP port. A catcher has no
  // submission port and expects application mail on 1025.
  const port = mail.ports.submission ?? mail.ports.smtp

  const env: Record<string, string> = {
    MAIL_MAILER: 'smtp',
    MAIL_HOST: '127.0.0.1',
    MAIL_PORT: String(port),
  }

  // A catcher accepts anything from anyone on loopback, so an application that
  // sends a username would be authenticating against a server with no accounts.
  if (mail.mode === 'server') {
    env.MAIL_ENCRYPTION = mail.tls.enabled ? 'tls' : 'null'
    const account = mail.accounts[0]
    if (account) {
      env.MAIL_USERNAME = account.address
      env.MAIL_PASSWORD = account.password
    }
  }
  else {
    env.MAIL_ENCRYPTION = 'null'
    env.MAIL_USERNAME = 'null'
    env.MAIL_PASSWORD = 'null'
  }

  return env
}


/** Gateway routes derived from the managed service, so there is no second site
 * declaration to keep in sync with its listener or certificate names. */
export function mailWebmailSites(mail: ResolvedMailService): Record<string, SiteConfig> {
  if (!mail.enabled || !mail.webmail.enabled || !mail.webmail.domain) return {}
  const domains = [mail.webmail.domain, ...mail.webmail.aliases]
  if (!Number.isInteger(mail.webmail.port) || mail.webmail.port < 1 || mail.webmail.port > 65535)
    throw new Error('Mail webmail port must be between 1 and 65535')
  return Object.fromEntries(domains.map((domain, index) => {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain))
      throw new Error(`Invalid mail webmail hostname: ${domain}`)
    return [`__mail_webmail_${index}`, { domain, proxyTo: `localhost:${mail.webmail.port}` }]
  }))
}

/** A production webmail hostname gets managed HTTPS by default. Explicit
 * gateway settings still win, including custom certificates and ACME contact. */
export function resolveMailProxy(config: Pick<CloudConfig, 'project' | 'sites' | 'environments' | 'infrastructure'>, options: ResolveMailOptions = {}): ComputeProxyConfig | undefined {
  const proxy = config.infrastructure?.compute?.proxy
  const mail = resolveMailService(config, options)
  if (!mail.enabled || !mail.webmail.enabled || !mail.webmail.domain) return proxy
  return {
    engine: 'rpx',
    onDemandTls: true,
    onDemandTlsEmail: mail.tls.acmeEmail ?? `webmaster@${mail.webmail.domain}`,
    ...proxy,
  }
}
