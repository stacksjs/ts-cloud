import type { QueueOperationHandler } from '../queue'
import type { FleetDriver, FleetStore } from './index'

export function createFleetQueueHandlers(
  store: FleetStore,
  drivers: readonly FleetDriver[],
): Record<string, QueueOperationHandler> {
  return {
    'fleet.bootstrap': async (context) => {
      const input =
          context.operation.input &&
          typeof context.operation.input === 'object' &&
          !Array.isArray(context.operation.input)
            ? (context.operation.input as Record<string, unknown>)
            : {},
        server = store.get(String(input.serverId ?? ''))
      if (!server) throw new Error('Queued fleet server was not found.')
      const driver = drivers.find((item) => item.provider === server.provider)
      if (!driver) throw new Error(`No ${server.provider} fleet driver is configured.`)
      const steps = Array.isArray(input.steps) ? input.steps.map(String) : []
      context.checkpoint('preflight', 'Rechecking pinned trust and healthy validation.')
      if (server.trustState !== 'pinned' || !server.validation?.valid)
        throw new Error('Fleet bootstrap requires pinned trust and a healthy validation report.')
      context.checkpoint('bootstrap', 'Applying the reviewed idempotent bootstrap plan.')
      const result = await driver.bootstrap(server, steps)
      store.update(server.id, { bootstrapVersion: result.version, status: 'ready' })
      context.checkpoint('verify', 'Bootstrap completed; heartbeat can now establish freshness.')
      return { serverId: server.id, bootstrapVersion: result.version, steps: steps.length }
    },
  }
}
