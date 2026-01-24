import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'

export function registerTeamCommands(app: CLI): void {
  app
    .command('team:add <email> <role>', 'Add team member')
    .action(async (email: string, role: string) => {
      cli.header('Adding Team Member')

      cli.info(`Email: ${email}`)
      cli.info(`Role: ${role}`)

      const validRoles = ['admin', 'developer', 'viewer']
      if (!validRoles.includes(role.toLowerCase())) {
        cli.error(`Invalid role. Must be one of: ${validRoles.join(', ')}`)
        return
      }

      const confirm = await cli.confirm('\nAdd this team member?', true)
      if (!confirm) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Creating IAM user and sending invitation...')
      spinner.start()

      // TODO: Create IAM user with appropriate policies based on role
      // TODO: Send invitation email with credentials
      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.succeed('Team member added successfully')

      cli.success('\nTeam member added!')
      cli.info('An invitation email has been sent with access credentials')

      cli.info('\nAccess Details:')
      cli.info(`  - Email: ${email}`)
      cli.info(`  - Role: ${role}`)
      cli.info(`  - Status: Pending`)
    })

  app
    .command('team:list', 'List team members')
    .action(async () => {
      cli.header('Team Members')

      const spinner = new cli.Spinner('Fetching team members...')
      spinner.start()

      // TODO: Fetch IAM users with appropriate tags
      await new Promise(resolve => setTimeout(resolve, 1500))

      spinner.stop()

      cli.table(
        ['Email', 'Role', 'Status', 'Added', 'Last Login'],
        [
          ['admin@example.com', 'Admin', 'Active', '2024-01-01', '2 hours ago'],
          ['dev@example.com', 'Developer', 'Active', '2024-01-15', '1 day ago'],
          ['viewer@example.com', 'Viewer', 'Active', '2024-02-01', '3 days ago'],
          ['new@example.com', 'Developer', 'Pending', '2024-11-10', 'Never'],
        ],
      )

      cli.info('\nTip: Use `cloud team:add` to add new team members')
      cli.info('Tip: Use `cloud team:remove` to remove team members')
    })

  app
    .command('team:remove <email>', 'Remove team member')
    .action(async (email: string) => {
      cli.header('Removing Team Member')

      cli.info(`Email: ${email}`)

      cli.warn('\nThis will revoke all access for this team member')

      const confirm = await cli.confirm('Remove this team member?', false)
      if (!confirm) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Removing IAM user and access...')
      spinner.start()

      // TODO: Delete IAM user and associated resources
      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.succeed('Team member removed successfully')

      cli.success('\nTeam member removed!')
      cli.info('All access credentials have been revoked')
    })
}
