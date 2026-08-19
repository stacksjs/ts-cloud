import type { SpendEnforcementTransport } from './appliers'
import type { RemoteExec } from './transports'
import { describe, expect, it } from 'bun:test'
import { renderDdosInstallScript } from '../protection/ddos'
import { AwsSpendTransport, ComputeSpendTransport, compositeSpendTransport } from './transports'

const SCOPE = { projectId: 'proj-1', environmentId: 'env-1' }

/** A Lambda client stubbed down to exactly what the transport touches. */
function lambdaStub(initial: Record<string, { reserved?: number | null; env?: Record<string, string> }> = {}) {
  const state = new Map(
    Object.entries(initial).map(([name, value]) => [name, { reserved: value.reserved ?? null, env: value.env ?? {} }]),
  )
  const calls: string[] = []
  const entry = (name: string) => {
    if (!state.has(name)) state.set(name, { reserved: null, env: {} })
    return state.get(name)!
  }
  return {
    state,
    calls,
    client: {
      getFunctionConcurrency: async (name: string) => {
        calls.push(`get:${name}`)
        return entry(name).reserved
      },
      putFunctionConcurrency: async (name: string, value: number) => {
        calls.push(`put:${name}:${value}`)
        entry(name).reserved = value
      },
      deleteFunctionConcurrency: async (name: string) => {
        calls.push(`delete:${name}`)
        entry(name).reserved = null
      },
      getFunction: async (name: string) => ({
        Configuration: { Environment: { Variables: { ...entry(name).env } } },
      }),
      updateFunctionConfiguration: async (params: any) => {
        calls.push(`env:${params.FunctionName}`)
        entry(params.FunctionName).env = { ...params.Environment.Variables }
      },
    } as any,
  }
}

/** A recording SSH stub. `systemctl list-units` answers from `active`. */
function execStub(active: string[] = [], failOn?: RegExp) {
  const commands: string[] = []
  const exec: RemoteExec = async (_host, command) => {
    commands.push(command)
    if (failOn?.test(command)) return { code: 1, stdout: '', stderr: 'boom' }
    if (command.includes('list-units')) return { code: 0, stdout: `${active.join('\n')}\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { exec, commands }
}

describe('AWS transport: suspending functions', () => {
  it('sets reserved concurrency to zero on every function in scope', async () => {
    const lambda = lambdaStub({ 'app-http': {}, 'app-queue': {} })
    const transport = new AwsSpendTransport({
      lambda: lambda.client,
      functions: () => ['app-http', 'app-queue'],
    })
    const restore = await transport.suspendFunctions(SCOPE)
    expect(lambda.state.get('app-http')!.reserved).toBe(0)
    expect(lambda.state.get('app-queue')!.reserved).toBe(0)
    expect(restore).toMatchObject({ kind: 'lambda_reserved_concurrency' })
  })

  it('reads the previous limit before overwriting it', async () => {
    const lambda = lambdaStub({ 'app-http': { reserved: 50 } })
    const transport = new AwsSpendTransport({ lambda: lambda.client, functions: () => ['app-http'] })
    const restore = await transport.suspendFunctions(SCOPE)
    // Read must precede the write, or the prior limit is lost.
    expect(lambda.calls.indexOf('get:app-http')).toBeLessThan(lambda.calls.indexOf('put:app-http:0'))
    expect((restore.previous as any)['app-http']).toBe(50)
  })

  it('restores an existing limit rather than removing it', async () => {
    const lambda = lambdaStub({ 'app-http': { reserved: 50 } })
    const transport = new AwsSpendTransport({ lambda: lambda.client, functions: () => ['app-http'] })
    await transport.resumeFunctions(await transport.suspendFunctions(SCOPE))
    expect(lambda.state.get('app-http')!.reserved).toBe(50)
    expect(lambda.calls).not.toContain('delete:app-http')
  })

  it('removes the limit entirely when there was none', async () => {
    const lambda = lambdaStub({ 'app-http': { reserved: null } })
    const transport = new AwsSpendTransport({ lambda: lambda.client, functions: () => ['app-http'] })
    await transport.resumeFunctions(await transport.suspendFunctions(SCOPE))
    expect(lambda.calls).toContain('delete:app-http')
    expect(lambda.state.get('app-http')!.reserved).toBeNull()
  })

  it('refuses to act when no function resolves, instead of silently succeeding', async () => {
    const transport = new AwsSpendTransport({ lambda: lambdaStub().client, functions: () => [] })
    await expect(transport.suspendFunctions(SCOPE)).rejects.toThrow('No Lambda functions')
  })
})

describe('AWS transport: static and maintenance', () => {
  it('serves static through the same lever but records which rung applied it', async () => {
    const lambda = lambdaStub({ 'app-http': {} })
    const transport = new AwsSpendTransport({ lambda: lambda.client, functions: () => ['app-http'] })
    const restore = await transport.serveStatic(SCOPE)
    expect(restore.via).toBe('serve_static')
    expect(lambda.state.get('app-http')!.reserved).toBe(0)
    await transport.restoreDynamic(restore)
    expect(lambda.state.get('app-http')!.reserved).toBeNull()
  })

  it('sets maintenance mode without dropping the rest of the environment', async () => {
    const lambda = lambdaStub({ 'app-http': { env: { APP_KEY: 'secret', LOG_LEVEL: 'info' } } })
    const transport = new AwsSpendTransport({ lambda: lambda.client, functions: () => ['app-http'] })
    await transport.suspendProject(SCOPE)
    expect(lambda.state.get('app-http')!.env).toMatchObject({
      APP_KEY: 'secret',
      LOG_LEVEL: 'info',
      MAINTENANCE_MODE: '1',
    })
  })

  it('restores the prior maintenance value, defaulting to off', async () => {
    const lambda = lambdaStub({ 'app-http': { env: { MAINTENANCE_MODE: '0' } } })
    const transport = new AwsSpendTransport({ lambda: lambda.client, functions: () => ['app-http'] })
    await transport.resumeProject(await transport.suspendProject(SCOPE))
    expect(lambda.state.get('app-http')!.env.MAINTENANCE_MODE).toBe('0')
  })

  it('republishes when the stack uses provisioned concurrency', async () => {
    const lambda = lambdaStub({ 'app-http': {} })
    const republished: string[] = []
    const transport = new AwsSpendTransport({
      lambda: lambda.client,
      functions: () => ['app-http'],
      republish: async (name) => {
        republished.push(name)
      },
    })
    await transport.suspendProject(SCOPE)
    expect(republished).toEqual(['app-http'])
  })

  it('does not implement request throttling, so the applier reports it unsupported', () => {
    const transport = new AwsSpendTransport({ lambda: lambdaStub().client, functions: () => ['app-http'] })
    expect((transport as SpendEnforcementTransport).throttleRequests).toBeUndefined()
  })
})

describe('compute transport: stopping units', () => {
  it('stops the release instances that are actually active', async () => {
    const ssh = execStub(['acme-web@r42.service', 'acme-worker@r42.service'])
    const transport = new ComputeSpendTransport({ host: 'box', exec: ssh.exec, units: () => ['acme-web'] })
    const restore = await transport.suspendFunctions(SCOPE)
    expect(restore.stopped).toEqual(['acme-web@r42.service', 'acme-worker@r42.service'])
    expect(ssh.commands).toContain("systemctl stop 'acme-web@r42.service'")
  })

  it('never stops the shared gateway', async () => {
    const ssh = execStub(['acme-web@r42.service'])
    const transport = new ComputeSpendTransport({ host: 'box', exec: ssh.exec, units: () => ['acme-web'] })
    await transport.suspendProject(SCOPE)
    // Capping one project must not take every other tenant off the box.
    expect(ssh.commands.join(' ')).not.toContain('rpx-gateway')
    expect(ssh.commands.join(' ')).not.toContain('stop nginx')
  })

  it('restarts exactly the units it stopped', async () => {
    const ssh = execStub(['acme-web@r42.service'])
    const transport = new ComputeSpendTransport({ host: 'box', exec: ssh.exec, units: () => ['acme-web'] })
    await transport.resumeFunctions(await transport.suspendFunctions(SCOPE))
    expect(ssh.commands).toContain("systemctl start 'acme-web@r42.service'")
  })

  it('records the running instance rather than the unit base, so the right release restarts', async () => {
    const ssh = execStub(['acme-web@release-99.service'])
    const transport = new ComputeSpendTransport({ host: 'box', exec: ssh.exec, units: () => ['acme-web'] })
    const restore = await transport.serveStatic(SCOPE)
    expect(restore.stopped).toEqual(['acme-web@release-99.service'])
    expect(restore.via).toBe('serve_static')
  })

  it('refuses an unsafe unit name instead of interpolating it into a shell command', async () => {
    const ssh = execStub([])
    const transport = new ComputeSpendTransport({
      host: 'box',
      exec: ssh.exec,
      units: () => ['acme-web; rm -rf /'],
    })
    await expect(transport.suspendProject(SCOPE)).rejects.toThrow('unsafe unit name')
    expect(ssh.commands).toEqual([])
  })

  it('ignores an unsafe unit name smuggled into a restore payload', async () => {
    const ssh = execStub([])
    const transport = new ComputeSpendTransport({ host: 'box', exec: ssh.exec, units: () => ['acme-web'] })
    await transport.resumeFunctions({ kind: 'systemd_units', stopped: ['ok.service; curl evil'] as never })
    expect(ssh.commands).toEqual([])
  })

  it('surfaces a failed stop instead of reporting the cap as applied', async () => {
    const ssh = execStub(['acme-web@r42.service'], /systemctl stop/)
    const transport = new ComputeSpendTransport({ host: 'box', exec: ssh.exec, units: () => ['acme-web'] })
    await expect(transport.suspendFunctions(SCOPE)).rejects.toThrow('stopping acme-web@r42.service failed')
  })

  it('refuses when no unit resolves', async () => {
    const transport = new ComputeSpendTransport({ host: 'box', exec: execStub().exec, units: () => [] })
    await expect(transport.suspendProject(SCOPE)).rejects.toThrow('No systemd units')
  })
})

describe('compute transport: throttling', () => {
  const base = { ports: [80, 443], thresholds: { newConnectionsPerSecond: 50, concurrentPerSource: 100 } }

  it('re-renders the firewall with scaled limits', async () => {
    const ssh = execStub()
    const transport = new ComputeSpendTransport({
      host: 'box',
      exec: ssh.exec,
      units: () => ['acme-web'],
      ddos: base,
      renderDdos: renderDdosInstallScript,
    })
    const restore = await transport.throttleRequests({ ...SCOPE, factor: 0.5 })
    expect(ssh.commands[0]).toContain('limit rate over 25/second')
    expect(ssh.commands[0]).toContain('ct count over 50')
    expect(restore).toMatchObject({ kind: 'nftables_throttle', factor: 0.5 })
  })

  it('never scales a limit below one', async () => {
    const ssh = execStub()
    const transport = new ComputeSpendTransport({
      host: 'box',
      exec: ssh.exec,
      units: () => ['acme-web'],
      ddos: { thresholds: { newConnectionsPerSecond: 2, concurrentPerSource: 2 } },
      renderDdos: renderDdosInstallScript,
    })
    await transport.throttleRequests({ ...SCOPE, factor: 0.1 })
    expect(ssh.commands[0]).toContain('limit rate over 1/second')
  })

  it('restores the original thresholds', async () => {
    const ssh = execStub()
    const transport = new ComputeSpendTransport({
      host: 'box',
      exec: ssh.exec,
      units: () => ['acme-web'],
      ddos: base,
      renderDdos: renderDdosInstallScript,
    })
    await transport.restoreRequests(await transport.throttleRequests({ ...SCOPE, factor: 0.5 }))
    expect(ssh.commands[1]).toContain('limit rate over 50/second')
    expect(ssh.commands[1]).toContain('ct count over 100')
  })

  it('says so plainly when it has no firewall config to work from', async () => {
    const transport = new ComputeSpendTransport({ host: 'box', exec: execStub().exec, units: () => ['acme-web'] })
    await expect(transport.throttleRequests({ ...SCOPE, factor: 0.5 })).rejects.toThrow('needs a DDoS config')
  })
})

describe('composite transport', () => {
  function leg(name: string, log: string[], failing = false): SpendEnforcementTransport {
    return {
      suspendFunctions: async () => {
        log.push(`apply:${name}`)
        if (failing) throw new Error(`${name} unreachable`)
        return { marker: name }
      },
      resumeFunctions: async () => {
        log.push(`release:${name}`)
      },
    }
  }

  it('applies to every leg and keeps each restore separate', async () => {
    const log: string[] = []
    const composite = compositeSpendTransport([leg('aws', log), leg('box', log)])
    const restore = await composite.suspendFunctions!({})
    expect(log).toEqual(['apply:aws', 'apply:box'])
    expect((restore.legs as any)['0']).toMatchObject({ marker: 'aws' })
    expect((restore.legs as any)['1']).toMatchObject({ marker: 'box' })
  })

  it('tries every leg even when one fails, then reports the failure', async () => {
    const log: string[] = []
    const composite = compositeSpendTransport([leg('aws', log, true), leg('box', log)])
    // Stopping at the first failure would leave the box uncapped and unrecorded.
    await expect(composite.suspendFunctions!({})).rejects.toThrow('aws unreachable')
    expect(log).toEqual(['apply:aws', 'apply:box'])
  })

  it('does not try to release a leg that never applied', async () => {
    const log: string[] = []
    const composite = compositeSpendTransport([leg('aws', log, true), leg('box', log)])
    // The failing leg records its error in place of a restore payload, so the
    // release pass must skip it rather than undo something never applied.
    const restore = { kind: 'composite', legs: { 0: { error: 'aws unreachable' }, 1: { marker: 'box' } } }
    await composite.resumeFunctions!(restore as never)
    expect(log).toEqual(['release:box'])
  })

  it('refuses an action no leg implements, rather than reporting success', async () => {
    const composite = compositeSpendTransport([{ suspendFunctions: async () => ({}) }])
    await expect(composite.suspendProject!({})).rejects.toThrow('No transport implements suspendProject')
  })
})
