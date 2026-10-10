/** Mail deployments use the same resolver, gateway and ACME lifecycle as apps. */
export { buildMailEnv, mailFirewallPorts, mailWebmailSites, resolveMailProxy, resolveMailService } from '@ts-cloud/core'
export type { MailAccountConfig, MailServiceConfig, MailWebmailConfig, ResolvedMailService } from '@ts-cloud/core'
export { buildMailWebmailDeploymentScript, buildMailWebmailEnvPatch, deployMailWebmail } from './webmail'
export type { MailWebmailDeploymentOptions } from './webmail'
