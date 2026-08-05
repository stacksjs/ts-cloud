import type { CloudConfig, EnvironmentType, VitessServiceConfig } from '@ts-cloud/core'
import { buildPantryBootstrapScript } from '../drivers/shared/package-manager'
import { buildVitessProvisionScript } from '../drivers/shared/vitess-provision'
import type { DbRunResult } from './dashboard-database'
import { isValidDbIdentifier, runDb } from './dashboard-database'

export interface DashboardVitessProvisionInput {
  keyspace: string
  username: string
  password: string
  sharded?: boolean
  confirm: string
}

export interface DashboardVitessProvisionPlan {
  service: VitessServiceConfig
  appDatabase: {
    engine: 'vitess'
    name: string
    username: string
    host: '127.0.0.1'
    port: 15306
    ssl: false
  }
  commands: string[]
}

export interface DashboardVitessProvisionResult extends DbRunResult {
  database: DashboardVitessProvisionPlan['appDatabase']
  service: Omit<VitessServiceConfig, 'password'>
}

function conflict(config: CloudConfig): string | undefined {
  const database = config.infrastructure?.appDatabase
  if (database?.engine && database.engine !== 'vitess')
    return `This project already declares ${database.engine} as its application database.`

  const services = config.infrastructure?.compute?.managedServices
  const other = services
    ? (['mysql', 'mariadb', 'postgres'] as const).find((engine) => Boolean(services[engine]))
    : undefined
  if (other) return `This server already declares the ${other} database service.`
  return undefined
}

/**
 * Build the exact same typed Vitess service consumed by cold-boot provisioning.
 * The dashboard only supplies the few application-specific values; topology,
 * bind address, and vtgate port stay on production-safe defaults.
 */
export function planDashboardVitessProvision(
  config: CloudConfig,
  input: DashboardVitessProvisionInput,
): DashboardVitessProvisionPlan {
  const keyspace = input.keyspace.trim()
  const username = input.username.trim()
  const password = input.password
  const configuredConflict = conflict(config)

  if (configuredConflict) throw new Error(configuredConflict)
  if (!isValidDbIdentifier(keyspace))
    throw new Error('Keyspace must contain letters, numbers, or underscores and cannot start with a number.')
  if (!isValidDbIdentifier(username))
    throw new Error('Username must contain letters, numbers, or underscores and cannot start with a number.')
  if (password.length < 16) throw new Error('Password must contain at least 16 characters.')
  if (input.confirm !== keyspace) throw new Error(`Type "${keyspace}" to confirm Vitess provisioning.`)

  const service: VitessServiceConfig = {
    mode: 'cluster',
    cell: 'zone1',
    keyspaces: [{ name: keyspace, sharded: input.sharded === true }],
    vtgatePort: 15306,
    username,
    password,
    bindAddress: '127.0.0.1',
  }

  return {
    service,
    appDatabase: {
      engine: 'vitess',
      name: keyspace,
      username,
      host: '127.0.0.1',
      port: 15306,
      ssl: false,
    },
    commands: [...buildPantryBootstrapScript(), ...buildVitessProvisionScript(service)],
  }
}

export async function provisionVitessFromDashboard(
  config: CloudConfig,
  environment: EnvironmentType,
  input: DashboardVitessProvisionInput,
): Promise<DashboardVitessProvisionResult> {
  const plan = planDashboardVitessProvision(config, input)
  const result = await runDb(config, environment, plan.commands, `ts-cloud vitess:provision ${plan.appDatabase.name}`)

  return {
    ...result,
    database: plan.appDatabase,
    service: Object.fromEntries(Object.entries(plan.service).filter(([key]) => key !== 'password')),
  }
}
