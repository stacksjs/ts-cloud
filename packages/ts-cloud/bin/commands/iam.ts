import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { IAMClient } from '../../src/aws/iam'
import { loadValidatedConfig } from './shared'

export function registerIamCommands(app: CLI): void {
  app
    .command('iam:roles', 'List IAM roles')
    .option('--prefix <prefix>', 'Filter by role name prefix')
    .option('--path <path>', 'Filter by path prefix', { default: '/' })
    .action(async (options: { prefix?: string; path: string }) => {
      cli.header('IAM Roles')

      try {
        const iam = new IAMClient()

        const spinner = new cli.Spinner('Fetching roles...')
        spinner.start()

        const result = await iam.listRoles({ PathPrefix: options.path })
        let roles = result.Roles || []

        if (options.prefix) {
          roles = roles.filter(r => r.RoleName?.startsWith(options.prefix!))
        }

        spinner.succeed(`Found ${roles.length} role(s)`)

        if (roles.length === 0) {
          cli.info('No IAM roles found')
          return
        }

        cli.table(
          ['Role Name', 'Path', 'Created', 'Description'],
          roles.map(role => [
            role.RoleName || 'N/A',
            role.Path || '/',
            role.CreateDate ? new Date(role.CreateDate).toLocaleDateString() : 'N/A',
            (role.Description || '').substring(0, 40),
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list roles: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('iam:role <roleName>', 'Show IAM role details')
    .action(async (roleName: string) => {
      cli.header(`IAM Role: ${roleName}`)

      try {
        const iam = new IAMClient()

        const spinner = new cli.Spinner('Fetching role details...')
        spinner.start()

        const result = await iam.getRole({ RoleName: roleName })
        const role = result.Role

        if (!role) {
          spinner.fail('Role not found')
          return
        }

        // Get attached policies
        const attachedPolicies = await iam.listAttachedRolePolicies({ RoleName: roleName })
        const inlinePolicies = await iam.listRolePolicies({ RoleName: roleName })

        spinner.succeed('Role details loaded')

        cli.info('\nRole Information:')
        cli.info(`  Name: ${role.RoleName}`)
        cli.info(`  ARN: ${role.Arn}`)
        cli.info(`  Path: ${role.Path}`)
        cli.info(`  Created: ${role.CreateDate ? new Date(role.CreateDate).toLocaleString() : 'N/A'}`)

        if (role.Description) {
          cli.info(`  Description: ${role.Description}`)
        }

        if (role.MaxSessionDuration) {
          cli.info(`  Max Session: ${role.MaxSessionDuration / 3600} hours`)
        }

        if (role.AssumeRolePolicyDocument) {
          cli.info('\nTrust Policy:')
          const trustPolicy = JSON.parse(decodeURIComponent(role.AssumeRolePolicyDocument))
          console.log(JSON.stringify(trustPolicy, null, 2))
        }

        if (attachedPolicies.AttachedPolicies && attachedPolicies.AttachedPolicies.length > 0) {
          cli.info('\nAttached Managed Policies:')
          for (const policy of attachedPolicies.AttachedPolicies) {
            cli.info(`  - ${policy.PolicyName}`)
          }
        }

        if (inlinePolicies.PolicyNames && inlinePolicies.PolicyNames.length > 0) {
          cli.info('\nInline Policies:')
          for (const policyName of inlinePolicies.PolicyNames) {
            cli.info(`  - ${policyName}`)
          }
        }

        if (role.Tags && role.Tags.length > 0) {
          cli.info('\nTags:')
          for (const tag of role.Tags) {
            cli.info(`  ${tag.Key}: ${tag.Value}`)
          }
        }
      }
      catch (error: any) {
        cli.error(`Failed to get role: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('iam:policies', 'List IAM policies')
    .option('--scope <scope>', 'Filter by scope (All, AWS, Local)', { default: 'Local' })
    .option('--prefix <prefix>', 'Filter by policy name prefix')
    .option('--path <path>', 'Filter by path prefix', { default: '/' })
    .action(async (options: { scope: string; prefix?: string; path: string }) => {
      cli.header('IAM Policies')

      try {
        const iam = new IAMClient()

        const spinner = new cli.Spinner('Fetching policies...')
        spinner.start()

        const result = await iam.listPolicies({
          Scope: options.scope,
          PathPrefix: options.path,
          OnlyAttached: false,
        })

        let policies = result.Policies || []

        if (options.prefix) {
          policies = policies.filter(p => p.PolicyName?.startsWith(options.prefix!))
        }

        spinner.succeed(`Found ${policies.length} policy(s)`)

        if (policies.length === 0) {
          cli.info('No IAM policies found')
          return
        }

        cli.table(
          ['Policy Name', 'ARN', 'Attachments', 'Created'],
          policies.slice(0, 50).map(policy => [
            policy.PolicyName || 'N/A',
            (policy.Arn || 'N/A').substring(0, 50),
            (policy.AttachmentCount || 0).toString(),
            policy.CreateDate ? new Date(policy.CreateDate).toLocaleDateString() : 'N/A',
          ]),
        )

        if (policies.length > 50) {
          cli.info(`\n... and ${policies.length - 50} more policies`)
        }
      }
      catch (error: any) {
        cli.error(`Failed to list policies: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('iam:policy <policyArn>', 'Show IAM policy details')
    .option('--version <version>', 'Policy version ID')
    .action(async (policyArn: string, options: { version?: string }) => {
      cli.header('IAM Policy Details')

      try {
        const iam = new IAMClient()

        const spinner = new cli.Spinner('Fetching policy...')
        spinner.start()

        const result = await iam.getPolicy({ PolicyArn: policyArn })
        const policy = result.Policy

        if (!policy) {
          spinner.fail('Policy not found')
          return
        }

        // Get the policy document
        const versionId = options.version || policy.DefaultVersionId
        const versionResult = await iam.getPolicyVersion({
          PolicyArn: policyArn,
          VersionId: versionId,
        })

        spinner.succeed('Policy loaded')

        cli.info('\nPolicy Information:')
        cli.info(`  Name: ${policy.PolicyName}`)
        cli.info(`  ARN: ${policy.Arn}`)
        cli.info(`  Path: ${policy.Path}`)
        cli.info(`  Created: ${policy.CreateDate ? new Date(policy.CreateDate).toLocaleString() : 'N/A'}`)
        cli.info(`  Updated: ${policy.UpdateDate ? new Date(policy.UpdateDate).toLocaleString() : 'N/A'}`)
        cli.info(`  Attachment Count: ${policy.AttachmentCount || 0}`)
        cli.info(`  Version: ${versionId}`)

        if (policy.Description) {
          cli.info(`  Description: ${policy.Description}`)
        }

        if (versionResult.PolicyVersion?.Document) {
          cli.info('\nPolicy Document:')
          const document = JSON.parse(decodeURIComponent(versionResult.PolicyVersion.Document))
          console.log(JSON.stringify(document, null, 2))
        }
      }
      catch (error: any) {
        cli.error(`Failed to get policy: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('iam:users', 'List IAM users')
    .option('--path <path>', 'Filter by path prefix', { default: '/' })
    .action(async (options: { path: string }) => {
      cli.header('IAM Users')

      try {
        const iam = new IAMClient()

        const spinner = new cli.Spinner('Fetching users...')
        spinner.start()

        const result = await iam.listUsers({ PathPrefix: options.path })
        const users = result.Users || []

        spinner.succeed(`Found ${users.length} user(s)`)

        if (users.length === 0) {
          cli.info('No IAM users found')
          return
        }

        cli.table(
          ['User Name', 'User ID', 'Path', 'Created', 'Password Last Used'],
          users.map(user => [
            user.UserName || 'N/A',
            user.UserId || 'N/A',
            user.Path || '/',
            user.CreateDate ? new Date(user.CreateDate).toLocaleDateString() : 'N/A',
            user.PasswordLastUsed ? new Date(user.PasswordLastUsed).toLocaleDateString() : 'Never',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list users: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('iam:user <userName>', 'Show IAM user details')
    .action(async (userName: string) => {
      cli.header(`IAM User: ${userName}`)

      try {
        const iam = new IAMClient()

        const spinner = new cli.Spinner('Fetching user details...')
        spinner.start()

        const result = await iam.getUser({ UserName: userName })
        const user = result.User

        if (!user) {
          spinner.fail('User not found')
          return
        }

        // Get additional info
        const [groups, policies, accessKeys] = await Promise.all([
          iam.listGroupsForUser({ UserName: userName }),
          iam.listAttachedUserPolicies({ UserName: userName }),
          iam.listAccessKeys({ UserName: userName }),
        ])

        spinner.succeed('User details loaded')

        cli.info('\nUser Information:')
        cli.info(`  Name: ${user.UserName}`)
        cli.info(`  ARN: ${user.Arn}`)
        cli.info(`  User ID: ${user.UserId}`)
        cli.info(`  Path: ${user.Path}`)
        cli.info(`  Created: ${user.CreateDate ? new Date(user.CreateDate).toLocaleString() : 'N/A'}`)

        if (user.PasswordLastUsed) {
          cli.info(`  Password Last Used: ${new Date(user.PasswordLastUsed).toLocaleString()}`)
        }

        if (groups.Groups && groups.Groups.length > 0) {
          cli.info('\nGroups:')
          for (const group of groups.Groups) {
            cli.info(`  - ${group.GroupName}`)
          }
        }

        if (policies.AttachedPolicies && policies.AttachedPolicies.length > 0) {
          cli.info('\nAttached Policies:')
          for (const policy of policies.AttachedPolicies) {
            cli.info(`  - ${policy.PolicyName}`)
          }
        }

        if (accessKeys.AccessKeyMetadata && accessKeys.AccessKeyMetadata.length > 0) {
          cli.info('\nAccess Keys:')
          for (const key of accessKeys.AccessKeyMetadata) {
            cli.info(`  - ${key.AccessKeyId}: ${key.Status}`)
            if (key.CreateDate) {
              cli.info(`    Created: ${new Date(key.CreateDate).toLocaleString()}`)
            }
          }
        }

        if (user.Tags && user.Tags.length > 0) {
          cli.info('\nTags:')
          for (const tag of user.Tags) {
            cli.info(`  ${tag.Key}: ${tag.Value}`)
          }
        }
      }
      catch (error: any) {
        cli.error(`Failed to get user: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('iam:groups', 'List IAM groups')
    .option('--path <path>', 'Filter by path prefix', { default: '/' })
    .action(async (options: { path: string }) => {
      cli.header('IAM Groups')

      try {
        const iam = new IAMClient()

        const spinner = new cli.Spinner('Fetching groups...')
        spinner.start()

        const result = await iam.listGroups({ PathPrefix: options.path })
        const groups = result.Groups || []

        spinner.succeed(`Found ${groups.length} group(s)`)

        if (groups.length === 0) {
          cli.info('No IAM groups found')
          return
        }

        cli.table(
          ['Group Name', 'Group ID', 'Path', 'Created'],
          groups.map(group => [
            group.GroupName || 'N/A',
            group.GroupId || 'N/A',
            group.Path || '/',
            group.CreateDate ? new Date(group.CreateDate).toLocaleDateString() : 'N/A',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list groups: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('iam:simulate <policyArn>', 'Simulate IAM policy')
    .option('--action <action>', 'Action to simulate (e.g., s3:GetObject)')
    .option('--resource <arn>', 'Resource ARN to test against')
    .action(async (policyArn: string, options: { action?: string; resource?: string }) => {
      cli.header('Simulate IAM Policy')

      try {
        const iam = new IAMClient()

        const action = options.action || await cli.prompt('Action to simulate', 's3:GetObject')
        const resource = options.resource || await cli.prompt('Resource ARN', '*')

        cli.info(`\nPolicy: ${policyArn}`)
        cli.info(`Action: ${action}`)
        cli.info(`Resource: ${resource}`)

        const spinner = new cli.Spinner('Running simulation...')
        spinner.start()

        const result = await iam.simulatePrincipalPolicy({
          PolicySourceArn: policyArn,
          ActionNames: [action],
          ResourceArns: [resource],
        })

        spinner.succeed('Simulation complete')

        if (result.EvaluationResults && result.EvaluationResults.length > 0) {
          for (const evalResult of result.EvaluationResults) {
            const decision = evalResult.EvalDecision

            cli.info(`\nResult for ${evalResult.EvalActionName}:`)

            if (decision === 'allowed') {
              cli.success(`  Decision: ALLOWED`)
            }
            else if (decision === 'implicitDeny') {
              cli.warn(`  Decision: IMPLICIT DENY (no matching allow statement)`)
            }
            else {
              cli.error(`  Decision: EXPLICIT DENY`)
            }

            if (evalResult.MatchedStatements && evalResult.MatchedStatements.length > 0) {
              cli.info('  Matched Statements:')
              for (const statement of evalResult.MatchedStatements) {
                cli.info(`    - ${statement.SourcePolicyId}: ${statement.SourcePolicyType}`)
              }
            }
          }
        }
      }
      catch (error: any) {
        cli.error(`Failed to simulate policy: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('iam:whoami', 'Show current IAM identity')
    .action(async () => {
      cli.header('Current IAM Identity')

      try {
        const iam = new IAMClient()

        const spinner = new cli.Spinner('Fetching identity...')
        spinner.start()

        // Use STS to get caller identity
        const { STSClient } = await import('../../src/aws/sts')
        const sts = new STSClient('us-east-1')
        const identity = await sts.getCallerIdentity()

        spinner.succeed('Identity loaded')

        cli.info('\nCaller Identity:')
        cli.info(`  Account: ${identity.Account}`)
        cli.info(`  ARN: ${identity.Arn}`)
        cli.info(`  User ID: ${identity.UserId}`)

        // Determine identity type
        const arn = identity.Arn || ''
        if (arn.includes(':user/')) {
          cli.info(`  Type: IAM User`)
        }
        else if (arn.includes(':assumed-role/')) {
          cli.info(`  Type: Assumed Role`)
        }
        else if (arn.includes(':root')) {
          cli.warn(`  Type: Root Account`)
          cli.warn('\n  Warning: Using root credentials is not recommended!')
        }
      }
      catch (error: any) {
        cli.error(`Failed to get identity: ${error.message}`)
        process.exit(1)
      }
    })
}
