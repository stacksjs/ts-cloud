# Mail Server

ts-cloud provisions a mail server from your `cloud.config.ts` — SMTP, IMAP,
DKIM signing, a webmail UI, and the mailboxes you declare. It is
[mail](https://github.com/mail-os/mail), a single Zig binary, installed from
pantry and run under systemd.

The same declaration also gives you a local mail trap, and that is the point of
the feature rather than a side effect. Read on.

## One binary, two jobs

Development mail traps and production mail servers are conventionally two
different programs — mailpit or Mailhog on a laptop, an MTA in production — and
that difference is where mail breaks. A message that renders in mailpit has been
through a parser nothing in production will ever run. A `From` header that
mailpit accepts is one no real MTA would. The bugs that costs are the ones
nobody can reproduce locally, which is the worst kind of bug to own.

So ts-cloud does not install a trap. It installs the mail server in one of two
**modes**:

| Mode | What it does | Ports |
| --- | --- | --- |
| `server` | A real MTA. Receives on 25, submits on 587/465, serves IMAP, signs with DKIM, delivers outbound mail. | 25, 587, 465, 143, 993, webmail 8080 |
| `catcher` | Accepts every message for every recipient — whatever domain it is addressed to — delivers none of them onward, and files them all into one inbox in the webmail UI (`dev` / `dev`). | SMTP 1025, webmail 8025 |

One binary, one parser, one authentication path, one Maildir, one UI — all the
way from a preview box to production, minus the delivery. The catcher's ports
are mailpit's ports on purpose: anything already pointed at a mailpit is pointed
at this without a change.

## Getting started

```ts
// cloud.config.ts
export default {
  project: { name: 'Example', slug: 'example', region: 'us-east-1' },
  environments: {
    production: { type: 'production', domain: 'example.com' },
    staging: { type: 'staging' },
  },
  infrastructure: {
    compute: {
      managedServices: { mail: true },
    },
  },
}
```

That is the whole declaration. `mail: true` resolves per environment:

- **production** gets a `server` on `mail.example.com`, with DKIM keys, ACME
  TLS, spam scoring, and its ports opened in the host firewall.
- **everything else** gets a `catcher` on loopback, with the firewall untouched.

An environment ts-cloud does not recognise resolves to a **catcher**, never a
server. That direction is deliberate: the mistake that costs something is
provisioning an open relay, not provisioning a trap.

### The application is wired for you

Every site deployed to the box gets `MAIL_*` in its `.env`, resolved from the
same declaration the box was provisioned from:

```dotenv
MAIL_MAILER=smtp
MAIL_HOST=127.0.0.1
MAIL_PORT=1025        # 587 on a server
MAIL_ENCRYPTION=null  # tls on a server
```

This is not a convenience. An application that has to be told by hand which port
its own mail server listens on is an application whose `.env` and whose box
disagree the first time either changes — and a wrong `MAIL_PORT` raises nothing.
It just stops sending. Anything you set in the site's own `env` still wins.

## Configuring it

Every field is optional; pass an object instead of `true` for any of them.

```ts
managedServices: {
  mail: {
    mode: 'server',                    // default: server in production, catcher elsewhere
    hostname: 'mail.example.com',      // what it announces, and what MX must point at
    domains: ['example.com', 'example.org'],
    accounts: [
      { address: 'postmaster@example.com', password: process.env.MAIL_POSTMASTER! },
    ],
    tls: { acme: true },
    dkim: { selector: 'default' },
    webmail: { domain: 'mail.example.com' },
    spam: { enforce: false },
  },
}
```

### Accounts

Declared accounts are the source of truth on every deploy, not only the first
one. Change a password here and redeploy and the box follows — the provisioner
runs both `create` and `change-password`, because the CLI's `create` reports
success when the account already exists and a `create || change-password` chain
would silently keep the old password forever.

Read passwords from the environment. `cloud.config.ts` is committed.

### DKIM

`dkim` is on by default for a server. On first provision a 2048-bit key is
generated per domain under `/etc/mail/dkim/`, and the record to publish is
printed:

```
DKIM default._domainkey.example.com IN TXT v=DKIM1; k=rsa; p=MIIBIjANBg...
```

The key is generated **only when the file is absent**. Re-provisioning never
rewrites it: a new key invalidates every signature already in flight, and the
mail that breaks is mail somebody's server has already accepted and is now
failing to verify.

### TLS

`tls.acme` (the default when no certificate is supplied) has the mail server
obtain and renew its own Let's Encrypt certificate for `hostname`. Supply
`certPath` + `keyPath` instead to bring your own, which turns ACME off.

A catcher has TLS off and stays on loopback, so its webmail session cookies are
issued without the `Secure` attribute — a `Secure` cookie over plain-HTTP
loopback is dropped by the browser, and the UI would take a login and then
behave as though nobody had logged in.

### Outbound delivery

| `delivery` | Behaviour |
| --- | --- |
| `'direct'` (server default) | Talk to the recipient's MX on port 25 |
| `'ses'` | Relay through AWS SES in `sesRegion` |
| `'none'` (catcher default) | Accept and deliver locally, never send |

Most providers block outbound port 25 on new accounts and unblock it on request.
Check before choosing `'direct'`; use `'ses'` while it is blocked.

There is deliberately **no generic smarthost option**. The mail server has no
authenticated-relay path yet, so a `relay: { host, username, password }` here
would be a credential written to a box and then ignored — and mail that appears
to be configured and silently goes nowhere is worse than mail that was never
configured at all.

## The webmail UI

The mail server serves its own browser client, and it is on by default. This is
what you look at instead of mailpit's inbox:

- a **catcher** serves it on `http://<box>:8025`, reachable from the box only;
- a **server** serves it on 8080, or on a hostname you name with
  `webmail: { domain: 'mail.example.com' }`, in which case the gateway fronts it
  on 443 and the raw port stays closed. Opening both would publish a plain-HTTP
  login page beside the TLS one.

## Firewall and exposure

A server's listening ports join the host firewall's allow list automatically —
they are derived from the same resolution that configures the listeners, so the
two cannot drift. A server whose 25 was never opened simply receives no mail and
looks like a DNS problem for a week.

A catcher opens nothing and binds `127.0.0.1`. That is load-bearing, and it is
enforced twice: ts-cloud will not open the ports, and the mail server itself
refuses to start in catch-all mode on any non-loopback interface. A machine that
accepts mail for every domain and files it locally is an open relay's more
embarrassing cousin — it does not forward the spam, it keeps it.

`expose: true` therefore cannot be combined with a catcher; use `mode: 'server'`
if you need a reachable mail server in a non-production environment.

## DNS is printed, not published

ts-cloud does not touch your zone for mail. The MX, SPF, DMARC and DKIM records
are listed for you to publish:

| Record | Name | Value |
| --- | --- | --- |
| MX | `example.com` | `mail.example.com` (priority 10) |
| TXT | `example.com` | `v=spf1 mx -all` |
| TXT | `_dmarc.example.com` | `v=DMARC1; p=none; rua=mailto:postmaster@example.com` |
| TXT | `default._domainkey.example.com` | printed during provisioning |

Two reasons. The zone may not be one this deploy owns; and a wrong MX does not
fail — it silently routes somebody's mail somewhere else, and it is discovered
days later by the person who did not get it.

DMARC starts at `p=none` on purpose. A policy that quarantines starts discarding
mail the moment SPF or DKIM is misconfigured, and the first week of a new mail
server is exactly when they are. Tighten it once the reports are clean.

## What is on the box

| Path | What |
| --- | --- |
| `/etc/mail/config.toml` | Generated server config. Overwritten every deploy. |
| `/etc/mail/mail.env` | systemd `EnvironmentFile`: webmail, IMAP, DKIM, delivery. `0640 root:mail-server`. |
| `/etc/mail/dkim/` | Private keys, one per domain, `0600`. |
| `/var/lib/mail/` | Mailboxes and the database. |
| `mail.service` | The unit. Runs as `mail-server`, never as root. |

The unit is hardened (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`)
and holds `CAP_NET_BIND_SERVICE` only when it was actually given a port below
1024 — a catcher on 1025 does not get it.

## Golden images

`services.mail` is stripped from a generic golden image bake. Baking a DKIM
private key into a shared image means every box cloned from it signs with the
same key, and anybody who can boot the image can sign mail as the domains it was
baked for. Mail is provisioned per box at boot instead.
