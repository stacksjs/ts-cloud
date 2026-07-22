import type { CLI } from '@stacksjs/clapp'
import type { ServerProvider, ServerRole } from '../../src/fleet'
import * as cli from '../../src/utils/cli'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { FleetService, FleetStore, SshFleetDriver } from '../../src/fleet'
import { unsupportedCommand } from './capability-command'
import { loadValidatedConfig } from './shared'

async function context() {
  const config = await loadValidatedConfig(),
    controlPlane = initializeDashboardControlPlane(process.cwd(), config),
    store = new FleetStore(controlPlane.store),
    service = new FleetService(store, [
      new SshFleetDriver('aws'),
      new SshFleetDriver('hetzner'),
      new SshFleetDriver('ssh'),
    ])
  return { controlPlane, store, service }
}
async function use<T>(callback: (value: Awaited<ReturnType<typeof context>>) => Promise<T>) {
  const value = await context()
  try {
    return await callback(value)
  } finally {
    value.controlPlane.store.close()
  }
}
const find = (value: Awaited<ReturnType<typeof context>>, name: string) => {
  const server = value.store.list(value.controlPlane.project.id).find((item) => item.id === name || item.name === name)
  if (!server) throw new Error(`Server ${name} was not found.`)
  return server
}
const fail = (error: unknown) => {
  cli.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
export function registerServerCommands(app: CLI): void {
  app
    .command('capabilities [server]', 'Show provider and target operation support')
    .option('--json', 'Print structured JSON')
    .action(async (name: string | undefined, options: { json?: boolean }) => {
      try {
        await use(async (value) => {
          const targets = name ? [find(value, name)] : value.store.list(value.controlPlane.project.id),
            rows = targets.flatMap((server) =>
              Object.entries(server.capabilities).map(([action, capability]) => ({
                server: server.name,
                provider: server.provider,
                action,
                ...capability,
              })),
            )
          if (options.json) console.log(JSON.stringify({ schemaVersion: 1, targets: rows }, null, 2))
          else
            cli.table(
              ['Server', 'Provider', 'Action', 'Support', 'Explanation'],
              rows.map((item) => [
                item.server,
                item.provider,
                item.action,
                item.supported ? 'supported' : 'unsupported',
                item.reason ?? '—',
              ]),
            )
        })
      } catch (error) {
        fail(error)
      }
    })
  app
    .command('server:list', 'List fleet servers')
    .option('--json', 'Print structured JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        await use(async (value) => {
          const servers = value.store.list(value.controlPlane.project.id)
          if (options.json) console.log(JSON.stringify(servers, null, 2))
          else
            cli.table(
              ['Name', 'Provider ID', 'Provider / region', 'Status / trust', 'Roles', 'CPU / memory', 'Heartbeat'],
              servers.map((item) => [
                item.name,
                item.providerId ?? '—',
                `${item.provider} / ${item.region ?? 'external'}`,
                `${item.status} / ${item.trustState}`,
                item.roles.join(','),
                `${item.capacity.cpu ?? 0} / ${item.capacity.memoryBytes ?? 0}`,
                item.heartbeatAt ?? 'never',
              ]),
            )
        })
      } catch (error) {
        fail(error)
      }
    })
  app
    .command('server:create <name>', 'Enroll a provisioned or existing server')
    .option('--provider <provider>', 'aws, hetzner, or ssh', { default: 'ssh' })
    .option('--provider-id <id>', 'Stable provider identity')
    .option('--endpoint <host>', 'SSH hostname or IP')
    .option('--user <user>', 'Non-root SSH user', { default: 'deploy' })
    .option('--credential-ref <ref>', 'Secret reference', { default: 'secret://fleet/agent' })
    .option('--region <region>', 'Provider region')
    .option('--roles <roles>', 'Comma-separated roles', { default: 'application' })
    .option('--labels <labels>', 'Comma-separated key=value labels')
    .action(async (name: string, options: any) => {
      try {
        await use(async (value) => {
          const provider = options.provider as ServerProvider
          if (!['aws', 'hetzner', 'ssh'].includes(provider) || !options.endpoint)
            throw new Error(
              'A supported --provider and --endpoint are required; provisioning and enrollment are separate operations.',
            )
          const server = value.service.enroll({
            organizationId: value.controlPlane.organization.id,
            projectId: value.controlPlane.project.id,
            name,
            provider,
            providerId: options.providerId,
            endpoint: options.endpoint,
            sshUser: options.user ?? 'deploy',
            credentialRef: options.credentialRef ?? 'secret://fleet/agent',
            region: options.region,
            roles: String(options.roles ?? 'application').split(',') as ServerRole[],
            labels: Object.fromEntries(
              String(options.labels ?? '')
                .split(',')
                .map((v) => v.split('='))
                .filter((v) => v[0] && v[1]),
            ),
          })
          cli.success(`Enrolled ${server.name} as ${server.id}; no remote mutation was performed.`)
        })
      } catch (error) {
        fail(error)
      }
    })
  app
    .command('server:validate <name>', 'Pin trust and validate a server')
    .option('--accept-host-key <fingerprint>', 'Accept reviewed rotation')
    .option('--json', 'Print JSON')
    .action(async (name: string, options: any) => {
      try {
        await use(async (value) => {
          let server = find(value, name)
          server = await value.service.test(server.id)
          if (server.trustState === 'rotation_pending') {
            if (!options.acceptHostKey)
              throw new Error(`Host key changed to ${server.pendingHostKey}; review it first.`)
            server = value.service.reviewHostKey(server.id, options.acceptHostKey)
          }
          const result = await value.service.validate(server.id)
          if (options.json) console.log(JSON.stringify(result.validation, null, 2))
          else
            cli.table(
              ['Severity', 'Code', 'Finding', 'Remediation'],
              (result.validation?.findings ?? []).map((v) => [v.severity, v.code, v.message, v.remediation ?? '—']),
            )
          if (!result.validation?.valid) process.exitCode = 1
        })
      } catch (error) {
        fail(error)
      }
    })
  app
    .command('server:bootstrap <name>', 'Preview or queue bootstrap')
    .option('--apply', 'Apply reviewed plan')
    .action(async (name: string, options: any) => {
      try {
        await use(async (value) => {
          const result = value.service.bootstrap(find(value, name).id, !!options.apply)
          if (result.preview)
            cli.table(
              ['Step'],
              result.steps.map((v) => [v]),
            )
          else cli.success(`Bootstrap queued: ${result.operation?.id}`)
        })
      } catch (error) {
        fail(error)
      }
    })
  app
    .command('server:drain <name>', 'Drain without terminating')
    .option('--complete', 'Mark movement complete')
    .action(async (name: string, options: any) => {
      try {
        await use(async (value) => cli.success(value.service.drain(find(value, name).id, !!options.complete).status))
      } catch (error) {
        fail(error)
      }
    })
  app.command('server:uncordon <name>', 'Return a server to scheduling').action(async (name: string) => {
    try {
      await use(async (value) => {
        value.service.uncordon(find(value, name).id)
        cli.success(`Uncordoned ${name}.`)
      })
    } catch (error) {
      fail(error)
    }
  })
  app
    .command('server:archive <name>', 'Archive inventory without termination')
    .option('--confirm <name>', 'Exact name')
    .action(async (name: string, options: any) => {
      try {
        await use(async (value) => {
          value.service.archive(find(value, name).id, options.confirm ?? '')
          cli.success(`Archived ${name}; provider infrastructure was not terminated.`)
        })
      } catch (error) {
        fail(error)
      }
    })
  app.command('server:ssh <name>', 'Open strict SSH using the enrolled endpoint').action(async (name: string) => {
    try {
      await use(async (value) => {
        const server = find(value, name)
        if (server.trustState !== 'pinned') throw new Error('Validate and pin the server host key first.')
        const child = Bun.spawn(
            [
              'ssh',
              '-p',
              String(server.sshPort),
              '-o',
              'StrictHostKeyChecking=yes',
              `${server.sshUser}@${server.endpoint}`,
            ],
            { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
          ),
          code = await child.exited
        if (code) process.exitCode = code
      })
    } catch (error) {
      fail(error)
    }
  })
  for (const [name, description] of [
    ['server:logs <name>', 'Use the runtime log service'],
    ['server:deploy <name>', 'Use immutable release deployment'],
    ['server:resize <name> <type>', 'Resize provider compute'],
    ['server:reboot <name>', 'Reboot provider compute'],
    ['server:destroy <name>', 'Terminate provider compute'],
    ['server:recipe <name> <recipe>', 'Apply a server recipe'],
    ['server:firewall:add <name> <rule>', 'Add firewall rule'],
    ['server:firewall:list <name>', 'List firewall rules'],
    ['server:firewall:remove <name> <rule>', 'Remove firewall rule'],
    ['server:ssl:install <domain>', 'Install TLS'],
    ['server:ssl:renew <domain>', 'Renew TLS'],
    ['server:monitoring <name>', 'Read server metrics'],
    ['server:snapshot <name>', 'Create provider snapshot'],
    ['server:snapshot:restore <name> <snapshot-id>', 'Restore provider snapshot'],
    ['server:update <name>', 'Update OS packages'],
    ['server:secure <name>', 'Apply OS hardening'],
  ] as const)
    app.command(name, description).action(async (...args: any[]) =>
      unsupportedCommand(name.split(' ')[0]!, {
        target: String(args[0] ?? ''),
        nextAction:
          'Use the dashboard capability view or the corresponding runtime, release, firewall, backup, or maintenance service.',
      }),
    )
}
