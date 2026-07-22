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
  async inspect() {
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
}

describe('Docker data transport', () => {
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
    expect(runtime.calls.map((call) => call.method)).toEqual([
      'network',
      'secret',
      'run',
    ])
    expect(
      runtime.calls.find((call) => call.method === 'secret')?.content,
    ).toBe('generated-password')
    const args = runtime.calls.find((call) => call.method === 'run')?.args ?? []
    expect(args.join(' ')).not.toContain('generated-password')
    expect(args).toContain('127.0.0.1:5432:5432')
    expect(args).toContain(
      'POSTGRES_PASSWORD_FILE=/run/ts-cloud-secrets/credential',
    )
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
    await new DockerDataTransport(runtime).execute(
      'orders',
      'rotate',
      {},
      'next-password',
    )
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
})
