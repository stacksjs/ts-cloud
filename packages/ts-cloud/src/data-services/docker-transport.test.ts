import { describe, expect, it } from 'bun:test'
import type { DockerRuntime } from './docker-transport'
import { DockerDataTransport } from './docker-transport'

class Runtime implements DockerRuntime {
  calls: Array<{ method: string; args?: string[]; content?: string }> = []
  metadata: Record<string, any> | undefined
  async ensureNetwork(name: string) {
    this.calls.push({ method: 'network', args: [name] })
  }
  async seedSecret(volume: string, content: string) {
    this.calls.push({ method: 'secret', args: [volume], content })
  }
  async removeVolume(name: string) {
    this.calls.push({ method: 'remove-volume', args: [name] })
  }
  async inspect(_name: string) {
    return this.metadata
  }
  async run(args: string[]) {
    this.calls.push({ method: 'run', args })
  }
  async exec(_name: string, args: string[], stdin?: string) {
    this.calls.push({ method: 'exec', args, content: stdin })
    return '-- dump'
  }
  async update(_name: string, args: string[]) {
    this.calls.push({ method: 'update', args })
  }
  async restart(name: string) {
    this.calls.push({ method: 'restart', args: [name] })
  }
  async remove(name: string) {
    this.calls.push({ method: 'remove', args: [name] })
  }
  async logs() {
    return 'bounded logs'
  }
  async stats() {
    return {
      cpuPercent: '1.5%',
      memoryUsage: '32MiB / 1GiB',
      pids: 12,
    }
  }
}

describe('Docker data transport', () => {
  it('observes bounded runtime health, endpoint, and metrics', async () => {
    const runtime = new Runtime()
    runtime.metadata = {
      Config: {
        Image: 'postgres:17-alpine',
        Labels: { 'ts-cloud.engine': 'postgres' },
      },
      State: { Status: 'running', Health: { Status: 'healthy' } },
      NetworkSettings: {
        Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] },
      },
    }
    runtime.inspect = async (name: string) => (name === 'tscloud-data-orders' ? runtime.metadata : undefined)
    expect(await new DockerDataTransport(runtime).observe('orders')).toMatchObject({
      status: 'running',
      healthy: 'healthy',
      endpoint: '127.0.0.1',
      port: 5432,
      metrics: { cpuPercent: '1.5%', pids: 12 },
    })
  })
  it('provisions private Postgres without placing credentials in arguments', async () => {
    const runtime = new Runtime(),
      transport = new DockerDataTransport(runtime, '/tmp/ts-cloud-data-test')
    await transport.apply(
      {
        id: 'orders',
        engine: 'postgres',
        engineVersion: '17',
        username: 'app',
        plan: 'small',
        publicExposure: false,
        desiredState: { database: 'orders' },
      },
      'generated-password',
    )
    expect(runtime.calls.map((call) => call.method)).toEqual(['network', 'secret', 'run'])
    expect(runtime.calls.find((call) => call.method === 'secret')?.content).toBe('generated-password')
    const args = runtime.calls.find((call) => call.method === 'run')?.args ?? []
    expect(args.join(' ')).not.toContain('generated-password')
    expect(args).toContain('127.0.0.1:5432:5432')
    expect(args).toContain('POSTGRES_PASSWORD_FILE=/run/ts-cloud-secrets/credential')
  })
  it('refuses public publishing without an external firewall policy', async () => {
    await expect(
      new DockerDataTransport(new Runtime()).apply(
        {
          id: 'orders',
          engine: 'postgres',
          username: 'app',
          plan: 'small',
          publicExposure: true,
          desiredState: {},
        },
        'secret',
      ),
    ).rejects.toThrow('direct publishing is refused')
  })
  it('rotates through stdin and replaces the secret only after the engine accepts it', async () => {
    const runtime = new Runtime()
    runtime.metadata = {
      Config: {
        Labels: { 'ts-cloud.engine': 'postgres', 'ts-cloud.username': 'app' },
      },
    }
    await new DockerDataTransport(runtime).execute('orders', 'rotate', {}, 'next-password')
    const command = runtime.calls.find((call) => call.method === 'exec')!
    expect(command.args?.join(' ')).not.toContain('next-password')
    expect(command.content).toContain('next-password')
    expect(runtime.calls.map((call) => call.method)).toEqual(['exec', 'secret'])
  })
  it('manages validated logical databases through stdin', async () => {
    const runtime = new Runtime()
    runtime.metadata = {
      Config: {
        Labels: {
          'ts-cloud.engine': 'postgres',
          'ts-cloud.username': 'app',
        },
      },
    }
    await new DockerDataTransport(runtime).execute('orders', 'databases', {
      operation: 'create',
      database: 'analytics',
    })
    expect(runtime.calls[0].args?.join(' ')).not.toContain('analytics')
    expect(runtime.calls[0].content).toBe('CREATE DATABASE "analytics";\n')
    await expect(
      new DockerDataTransport(runtime).execute('orders', 'databases', {
        operation: 'delete',
        database: 'analytics',
      }),
    ).rejects.toThrow('Type analytics')
  })
  it('exports and restores an engine-native dump into a private isolated target', async () => {
    const runtime = new Runtime(),
      transport = new DockerDataTransport(runtime)
    runtime.metadata = {
      Config: {
        Labels: {
          'ts-cloud.engine': 'postgres',
          'ts-cloud.engine-version': '17',
          'ts-cloud.username': 'app',
          'ts-cloud.database': 'orders',
        },
      },
    }
    runtime.inspect = async (name: string) => (name === 'tscloud-data-orders' ? runtime.metadata : undefined)
    runtime.exec = async (_name: string, args: string[], stdin?: string) => {
      runtime.calls.push({ method: 'exec', args, content: stdin })
      return args.join(' ').includes('SELECT 1') ? '1\n' : '-- database dump'
    }
    const exported = await transport.exportLogicalBackup('orders')
    expect(new TextDecoder().decode(exported.body)).toBe('-- database dump')
    await transport.restoreLogicalBackup({
      sourceId: 'orders',
      targetId: 'orders-drill',
      body: exported.body,
      credential: 'managed-password',
    })
    expect(runtime.calls.find((call) => call.method === 'run')?.args).toContain('127.0.0.1:5432:5432')
    expect(runtime.calls.find((call) => call.method === 'exec' && call.content === '-- database dump')).toBeDefined()
    expect(runtime.calls.flatMap((call) => call.args ?? []).join(' ')).not.toContain('managed-password')
    await transport.removeRestoredService('orders-drill')
    expect(runtime.calls.slice(-3).map((call) => call.method)).toEqual(['remove', 'remove-volume', 'remove-volume'])
  })
})
