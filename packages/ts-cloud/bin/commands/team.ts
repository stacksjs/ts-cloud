import type { CLI } from '@stacksjs/clapp'
import { unsupportedCommand } from './capability-command'

export function registerTeamCommands(app: CLI): void {
  for (const [name, description] of [
    ['team:add <email> <role>', 'Invite an organization member'],
    ['team:list', 'List organization members'],
    ['team:remove <email>', 'Revoke organization membership'],
  ] as const)
    app.command(name, description).action(async (...args: any[]) =>
      unsupportedCommand(name.split(' ')[0]!, {
        target: String(args[0] ?? ''),
        message:
          'Legacy IAM-backed team commands are deprecated and cannot safely represent organization-scoped access.',
        nextAction: 'Use the Team dashboard or organization invitation API; this command exits without changing IAM.',
      }),
    )
}
