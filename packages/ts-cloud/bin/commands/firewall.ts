import type { CLI } from '@stacksjs/clapp'
import { unsupportedCommand } from './capability-command'

export function registerFirewallCommands(app: CLI): void {
  for (const [name, description] of [
    ['firewall:rules', 'List provider firewall policy'],
    ['firewall:block <ip>', 'Block an address'],
    ['firewall:unblock <ip>', 'Unblock an address'],
    ['firewall:countries', 'Manage geographic policy'],
  ] as const)
    app.command(name, description).action(async (...args: any[]) =>
      unsupportedCommand(name.split(' ')[0]!, {
        target: String(args[0] ?? ''),
        message: 'No reviewed WAF/IP-set adapter is configured for this legacy command.',
        nextAction: 'Use server firewall configuration or install a provider adapter; no rule was changed.',
      }),
    )
}
