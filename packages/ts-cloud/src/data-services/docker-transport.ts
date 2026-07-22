import type { JsonValue } from '../control-plane'
import type { DataAction, DataEngine } from './model'
import type { DataProviderTransport } from './adapters'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

type Input = Record<string, JsonValue>

export interface DockerRuntime {
  ensureNetwork(name: string): Promise<void>
  seedSecret(volume: string, content: string): Promise<void>
  removeVolume(name: string): Promise<void>
  inspect(name: string): Promise<Record<string, any> | undefined>
  run(args: string[]): Promise<void>
  exec(name: string, args: string[], stdin?: string): Promise<string>
  update(name: string, args: string[]): Promise<void>
  restart(name: string): Promise<void>
  remove(name: string): Promise<void>
  logs(name: string, lines: number): Promise<string>
  stats(name: string): Promise<Record<string, JsonValue>>
}

async function docker(
  args: string[],
  stdin?: string,
  allowFailure = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(['docker', ...args], {
      stdin: stdin == null ? 'ignore' : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }),
    stdout = new Response(process.stdout).text(),
    stderr = new Response(process.stderr).text()
  if (stdin != null) {
    process.stdin!.write(stdin)
    process.stdin!.end()
  }
  const [code, out, error] = await Promise.all([process.exited, stdout, stderr])
  if (code !== 0 && !allowFailure)
    throw new Error(
      `Docker command failed (${code}): ${error.trim() || out.trim()}`,
    )
  return { code, stdout: out, stderr: error }
}

export class BunDockerRuntime implements DockerRuntime {
  async ensureNetwork(name: string): Promise<void> {
    if (
      (await docker(['network', 'inspect', name], undefined, true)).code !== 0
    )
      await docker(['network', 'create', '--internal', name])
  }
  async seedSecret(volume: string, content: string): Promise<void> {
    await docker(['volume', 'create', volume])
    await docker(
      [
        'run',
        '--rm',
        '-i',
        '-v',
        `${volume}:/run/target`,
        'alpine:3.21',
        'sh',
        '-c',
        'umask 077; cat > /run/target/credential',
      ],
      content,
    )
  }
  async removeVolume(name: string): Promise<void> {
    await docker(['volume', 'rm', name], undefined, true)
  }
  async inspect(name: string): Promise<Record<string, any> | undefined> {
    const result = await docker(['inspect', name], undefined, true)
    if (result.code !== 0) return undefined
    return JSON.parse(result.stdout)[0]
  }
  async run(args: string[]): Promise<void> {
    await docker(['run', ...args])
  }
  async exec(name: string, args: string[], stdin?: string): Promise<string> {
    return (await docker(['exec', '-i', name, ...args], stdin)).stdout
  }
  async update(name: string, args: string[]): Promise<void> {
    await docker(['update', ...args, name])
  }
  async restart(name: string): Promise<void> {
    await docker(['restart', name])
  }
  async remove(name: string): Promise<void> {
    await docker(['rm', '--force', name], undefined, true)
  }
  async logs(name: string, lines: number): Promise<string> {
    const result = await docker(
      ['logs', '--tail', String(Math.min(2000, Math.max(1, lines))), name],
      undefined,
      true,
    )
    return `${result.stdout}${result.stderr}`.slice(-256 * 1024)
  }
  async stats(name: string): Promise<Record<string, JsonValue>> {
    const result = await docker(
      ['stats', '--no-stream', '--format', '{{json .}}', name],
      undefined,
      true,
    )
    if (result.code !== 0 || !result.stdout.trim()) return {}
    const value = JSON.parse(result.stdout.trim()) as Record<string, unknown>
    return {
      cpuPercent: String(value.CPUPerc ?? ''),
      memoryUsage: String(value.MemUsage ?? ''),
      memoryPercent: String(value.MemPerc ?? ''),
      networkIo: String(value.NetIO ?? ''),
      blockIo: String(value.BlockIO ?? ''),
      pids: Number(value.PIDs ?? 0),
    }
  }
}

const engineConfig: Record<
  Exclude<DataEngine, 'libsql'>,
  { image: string; port: number; dataPath: string }
> = {
  postgres: {
    image: 'postgres:17-alpine',
    port: 5432,
    dataPath: '/var/lib/postgresql/data',
  },
  mysql: { image: 'mysql:8.4', port: 3306, dataPath: '/var/lib/mysql' },
  mariadb: { image: 'mariadb:11.7', port: 3306, dataPath: '/var/lib/mysql' },
  redis: { image: 'redis:7.4-alpine', port: 6379, dataPath: '/data' },
  mongodb: { image: 'mongo:8.0', port: 27017, dataPath: '/data/db' },
}

function identifier(value: JsonValue | undefined, fallback = 'app'): string {
  const result = String(value ?? fallback)
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(result))
    throw new Error(
      'Database identifiers must be letters, numbers, or underscores.',
    )
  return result
}

function runtimeId(id: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]{1,62}$/i.test(id))
    throw new Error('Runtime placement must be a valid container identifier.')
  return `tscloud-data-${id.toLowerCase()}`
}

function desired(input: Input, key: string): JsonValue | undefined {
  const document = input.desiredState
  return (
    input[key] ??
    (document && typeof document === 'object' && !Array.isArray(document)
      ? document[key]
      : undefined)
  )
}

function labels(inspect: Record<string, any>): Record<string, string> {
  return inspect.Config?.Labels ?? {}
}

export class DockerDataTransport implements DataProviderTransport {
  constructor(
    private readonly runtime: DockerRuntime = new BunDockerRuntime(),
    private readonly backupRoot: string = resolve('.ts-cloud/backups/data'),
  ) {}
  async observe(id: string): Promise<Input> {
    const name = runtimeId(id),
      inspect = await this.runtime.inspect(name)
    if (!inspect) throw new Error(`Data container ${name} was not found.`)
    const metadata = labels(inspect),
      metrics = await this.runtime.stats(name),
      ports = inspect.NetworkSettings?.Ports ?? {},
      binding = Object.values(ports).flat().find(Boolean) as
        { HostIp?: string; HostPort?: string } | undefined
    return {
      providerId: name,
      status: inspect.State?.Status ?? 'unknown',
      healthy: inspect.State?.Health?.Status ?? null,
      engine: metadata['ts-cloud.engine'] ?? null,
      engineVersion: metadata['ts-cloud.engine-version'] ?? null,
      username: metadata['ts-cloud.username'] ?? null,
      database: metadata['ts-cloud.database'] ?? null,
      endpoint: binding?.HostIp || '127.0.0.1',
      port: binding?.HostPort ? Number(binding.HostPort) : null,
      image: inspect.Config?.Image ?? null,
      startedAt: inspect.State?.StartedAt ?? null,
      metrics,
    }
  }
  async apply(input: Input, credential?: string): Promise<Input> {
    const id = String(input.id),
      name = runtimeId(id),
      engine = String(input.engine) as DataEngine
    if (engine === 'libsql')
      throw new Error('libSQL requires an explicitly configured runtime image.')
    const config = engineConfig[engine]
    if (!config) throw new Error(`Unsupported runtime data engine ${engine}.`)
    if (!credential) throw new Error(`${engine} requires a managed credential.`)
    if (input.publicExposure === true)
      throw new Error(
        'Container public exposure requires an external reviewed firewall policy; direct publishing is refused.',
      )
    const username = identifier(input.username),
      database = identifier(desired(input, 'database')),
      secretVolume = `${name}-secret`,
      dataVolume = `${name}-data`,
      secretContent =
        engine === 'redis'
          ? `appendonly yes\nprotected-mode yes\nrequirepass ${credential.replaceAll('\\', '\\\\').replaceAll('\n', '')}\n`
          : credential
    await this.runtime.ensureNetwork('ts-cloud-data')
    await this.runtime.seedSecret(secretVolume, secretContent)
    const args = [
      '-d',
      '--name',
      name,
      '--restart',
      'unless-stopped',
      '--network',
      'ts-cloud-data',
      '--label',
      'managed-by=ts-cloud',
      '--label',
      `ts-cloud.engine=${engine}`,
      '--label',
      `ts-cloud.engine-version=${input.engineVersion ?? ''}`,
      '--label',
      `ts-cloud.username=${username}`,
      '--label',
      `ts-cloud.database=${database}`,
      '-p',
      `127.0.0.1:${config.port}:${config.port}`,
      '-v',
      `${dataVolume}:${config.dataPath}`,
      '-v',
      `${secretVolume}:/run/ts-cloud-secrets:ro`,
    ]
    if (engine === 'postgres')
      args.push(
        '-e',
        `POSTGRES_USER=${username}`,
        '-e',
        `POSTGRES_DB=${database}`,
        '-e',
        'POSTGRES_PASSWORD_FILE=/run/ts-cloud-secrets/credential',
      )
    if (engine === 'mysql' || engine === 'mariadb')
      args.push(
        '-e',
        `MYSQL_USER=${username}`,
        '-e',
        `MYSQL_DATABASE=${database}`,
        '-e',
        'MYSQL_PASSWORD_FILE=/run/ts-cloud-secrets/credential',
        '-e',
        'MYSQL_ROOT_PASSWORD_FILE=/run/ts-cloud-secrets/credential',
      )
    if (engine === 'mongodb')
      args.push(
        '-e',
        `MONGO_INITDB_ROOT_USERNAME=${username}`,
        '-e',
        'MONGO_INITDB_ROOT_PASSWORD_FILE=/run/ts-cloud-secrets/credential',
      )
    args.push(config.image)
    if (engine === 'redis')
      args.push('redis-server', '/run/ts-cloud-secrets/credential')
    await this.runtime.run(args)
    return {
      providerId: name,
      status: 'starting',
      engine,
      endpoint: '127.0.0.1',
      port: config.port,
      username,
      database,
    }
  }
  async exportLogicalBackup(id: string): Promise<{
    body: Uint8Array
    engine: 'postgres' | 'mysql' | 'mariadb'
    database: string
    username: string
    engineVersion?: string
  }> {
    const name = runtimeId(id),
      inspect = await this.runtime.inspect(name)
    if (!inspect) throw new Error(`Data container ${name} was not found.`)
    const metadata = labels(inspect),
      engine = metadata['ts-cloud.engine'] as DataEngine,
      username = identifier(metadata['ts-cloud.username']),
      database = identifier(metadata['ts-cloud.database'])
    let dump: string
    if (engine === 'postgres')
      dump = await this.runtime.exec(name, [
        'sh',
        '-c',
        'export PGPASSWORD="$(cat /run/ts-cloud-secrets/credential)"; exec pg_dumpall --clean --if-exists -U "$POSTGRES_USER"',
      ])
    else if (engine === 'mysql' || engine === 'mariadb')
      dump = await this.runtime.exec(name, [
        'sh',
        '-c',
        'export MYSQL_PWD="$(cat /run/ts-cloud-secrets/credential)"; exec mysqldump -u root --all-databases --single-transaction --add-drop-database --routines --events --triggers',
      ])
    else
      throw new Error(`${engine} does not support engine-native SQL backups.`)
    return {
      body: new TextEncoder().encode(dump),
      engine,
      database,
      username,
      engineVersion: metadata['ts-cloud.engine-version'] || undefined,
    }
  }
  async restoreLogicalBackup(input: {
    sourceId: string
    targetId: string
    body: Uint8Array
    credential: string
    inPlace?: boolean
  }): Promise<Input> {
    const sourceName = runtimeId(input.sourceId),
      targetName = runtimeId(input.targetId),
      source = await this.runtime.inspect(sourceName)
    if (!source) throw new Error(`Data container ${sourceName} was not found.`)
    const metadata = labels(source),
      engine = metadata['ts-cloud.engine'] as DataEngine,
      username = identifier(metadata['ts-cloud.username']),
      database = identifier(metadata['ts-cloud.database'])
    if (!['postgres', 'mysql', 'mariadb'].includes(engine))
      throw new Error(`${engine} does not support engine-native SQL restores.`)
    if (!input.inPlace) {
      if (input.sourceId === input.targetId)
        throw new Error('An isolated restore requires a distinct target identifier.')
      if (await this.runtime.inspect(targetName))
        throw new Error(`Restore target ${targetName} already exists.`)
      await this.apply(
        {
          id: input.targetId,
          engine,
          engineVersion: metadata['ts-cloud.engine-version'] ?? '',
          username,
          database,
          publicExposure: false,
        },
        input.credential,
      )
    }
    const command =
        engine === 'postgres'
          ? [
              'sh',
              '-c',
              'export PGPASSWORD="$(cat /run/ts-cloud-secrets/credential)"; exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres',
            ]
          : [
              'sh',
              '-c',
                'export MYSQL_PWD="$(cat /run/ts-cloud-secrets/credential)"; exec mysql -u root',
            ],
      sql = new TextDecoder('utf-8', { fatal: true }).decode(input.body)
    let lastError: unknown
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await this.runtime.exec(targetName, command, sql)
        const probe =
          engine === 'postgres'
            ? [
                'sh',
                '-c',
                'export PGPASSWORD="$(cat /run/ts-cloud-secrets/credential)"; exec psql -U "$POSTGRES_USER" -Atc "SELECT 1"',
              ]
            : [
                'sh',
                '-c',
                'export MYSQL_PWD="$(cat /run/ts-cloud-secrets/credential)"; exec mysql -u root -N -e "SELECT 1"',
              ]
        if ((await this.runtime.exec(targetName, probe)).trim() !== '1')
          throw new Error('Restored database health probe returned an unexpected result.')
        return {
          status: 'available',
          providerId: targetName,
          engine,
          database,
          username,
          healthy: true,
        }
      } catch (error) {
        lastError = error
        if (attempt < 29) await Bun.sleep(1000)
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Restored database did not become ready.')
  }
  async removeRestoredService(id: string): Promise<void> {
    const name = runtimeId(id)
    await this.runtime.remove(name)
    await this.runtime.removeVolume(`${name}-secret`)
    await this.runtime.removeVolume(`${name}-data`)
  }
  private async backup(id: string, input: Input): Promise<Input> {
    const exported = await this.exportLogicalBackup(id),
      { engine, database, username } = exported,
      backupId = String(
        input.snapshotId ??
          `${id}-${new Date()
            .toISOString()
            .replace(/[^0-9]/g, '')
            .slice(0, 14)}`,
      )
    if (!/^[A-Za-z0-9_.-]{2,120}$/.test(backupId))
      throw new Error('Backup identifier contains unsupported characters.')
    await mkdir(this.backupRoot, { recursive: true, mode: 0o700 })
    const path = join(this.backupRoot, `${backupId}.sql`)
    await writeFile(path, exported.body, { mode: 0o600 })
    return { status: 'available', backupId, path, engine, database, username }
  }
  async execute(
    id: string,
    action: DataAction,
    input: Input,
    credential?: string,
  ): Promise<Input> {
    const name = runtimeId(id)
    if (action === 'observe') return this.observe(id)
    if (action === 'backup') return this.backup(id, input)
    if (action === 'restart') {
      await this.runtime.restart(name)
      return { status: 'restarting' }
    }
    if (action === 'logs' || action === 'slow_queries')
      return { logs: await this.runtime.logs(name, Number(input.lines) || 500) }
    if (action === 'databases' || action === 'users') {
      const inspect = await this.runtime.inspect(name)
      if (!inspect) throw new Error(`Data container ${name} was not found.`)
      const metadata = labels(inspect),
        engine = metadata['ts-cloud.engine'] as DataEngine,
        username = identifier(metadata['ts-cloud.username']),
        operation = String(input.operation ?? 'list')
      if (!['postgres', 'mysql', 'mariadb'].includes(engine))
        throw new Error(`${action} is available only for SQL runtime engines.`)
      if (action === 'users' && operation !== 'list')
        throw new Error(
          'Creating users requires a referenced secondary credential.',
        )
      if (operation === 'list') {
        const command =
          engine === 'postgres'
            ? [
                'sh',
                '-c',
                `export PGPASSWORD="$(cat /run/ts-cloud-secrets/credential)"; exec psql -U "$POSTGRES_USER" -Atc '${
                  action === 'databases'
                    ? 'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname'
                    : 'SELECT usename FROM pg_user ORDER BY usename'
                }'`,
              ]
            : [
                'sh',
                '-c',
                `export MYSQL_PWD="$(cat /run/ts-cloud-secrets/credential)"; exec mysql -u root -N -e '${
                  action === 'databases'
                    ? 'SHOW DATABASES'
                    : 'SELECT User FROM mysql.user ORDER BY User'
                }'`,
              ]
        const result = await this.runtime.exec(name, command)
        return {
          [action]: result
            .split('\n')
            .map((item) => item.trim())
            .filter(Boolean),
        }
      }
      if (action === 'databases' && ['create', 'delete'].includes(operation)) {
        const database = identifier(input.database)
        if (operation === 'delete' && input.confirm !== database)
          throw new Error(
            `Type ${database} to confirm logical database deletion.`,
          )
        const sql =
          engine === 'postgres'
            ? `${operation === 'create' ? 'CREATE' : 'DROP'} DATABASE "${database}";\n`
            : `${operation === 'create' ? 'CREATE' : 'DROP'} DATABASE \`${database}\`;\n`
        const command =
          engine === 'postgres'
            ? [
                'sh',
                '-c',
                'export PGPASSWORD="$(cat /run/ts-cloud-secrets/credential)"; exec psql -U "$POSTGRES_USER"',
              ]
            : [
                'sh',
                '-c',
                'export MYSQL_PWD="$(cat /run/ts-cloud-secrets/credential)"; exec mysql -u root',
              ]
        await this.runtime.exec(name, command, sql)
        return { status: 'available', database, operation }
      }
      throw new Error(`Unsupported ${action} operation ${operation}.`)
    }
    if (action === 'resize') {
      const args: string[] = []
      if (input.memoryMb) args.push('--memory', `${Number(input.memoryMb)}m`)
      if (input.cpus) args.push('--cpus', String(Number(input.cpus)))
      if (!args.length) throw new Error('Resize requires memoryMb or cpus.')
      await this.runtime.update(name, args)
      return {
        status: 'running',
        memoryMb: input.memoryMb ?? null,
        cpus: input.cpus ?? null,
      }
    }
    if (action === 'rotate') {
      if (!credential)
        throw new Error('Credential rotation requires a generated secret.')
      const inspect = await this.runtime.inspect(name)
      if (!inspect) throw new Error(`Data container ${name} was not found.`)
      const metadata = labels(inspect),
        engine = metadata['ts-cloud.engine'] as DataEngine,
        username = identifier(metadata['ts-cloud.username']),
        escaped = credential.replaceAll("'", "''").replaceAll('\n', '')
      if (engine === 'postgres')
        await this.runtime.exec(
          name,
          [
            'sh',
            '-c',
            'export PGPASSWORD="$(cat /run/ts-cloud-secrets/credential)"; exec psql -U "$POSTGRES_USER"',
          ],
          `ALTER USER "${username}" PASSWORD '${escaped}';\n`,
        )
      else if (engine === 'mysql' || engine === 'mariadb')
        await this.runtime.exec(
          name,
          [
            'sh',
            '-c',
            'export MYSQL_PWD="$(cat /run/ts-cloud-secrets/credential)"; exec mysql -u root',
          ],
          `ALTER USER '${username}'@'%' IDENTIFIED BY '${escaped}';\n`,
        )
      else if (engine !== 'redis')
        throw new Error(
          `${engine} credential rotation requires an engine runner.`,
        )
      const content =
        engine === 'redis'
          ? `appendonly yes\nprotected-mode yes\nrequirepass ${credential.replaceAll('\\', '\\\\').replaceAll('\n', '')}\n`
          : credential
      await this.runtime.seedSecret(`${name}-secret`, content)
      if (engine === 'redis') await this.runtime.restart(name)
      return { status: engine === 'redis' ? 'restarting' : 'running', username }
    }
    if (action === 'delete') {
      if (input.retention === 'retain') return { status: 'retained' }
      const backup = await this.backup(id, input)
      await this.runtime.remove(name)
      await this.runtime.removeVolume(`${name}-secret`)
      await this.runtime.removeVolume(`${name}-data`)
      return {
        status: 'deleted',
        finalBackupId: backup.backupId ?? null,
        backupPath: backup.path ?? null,
      }
    }
    if (action === 'expose')
      throw new Error(
        'Direct container exposure is refused; use a reviewed firewall and proxy policy.',
      )
    throw new Error(`${action} requires a configured engine lifecycle runner.`)
  }
}
