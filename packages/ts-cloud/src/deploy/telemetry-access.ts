export interface TelemetryResourceReference {
  id: string
  slug: string
}

export function resolveTelemetryResourceIds(
  resources: TelemetryResourceReference[],
  environmentWide: boolean,
  value: unknown,
): string[] | undefined {
  const requested = (Array.isArray(value) ? value : String(value ?? '').split(',')).map(String).filter(Boolean)
  if (!requested.length) {
    if (environmentWide) return undefined
    const allowed = resources.map((resource) => resource.id)
    return allowed.length ? allowed : ['__no_authorized_telemetry_resources__']
  }
  const resolved = requested
    .map((item) => resources.find((resource) => resource.id === item || resource.slug === item)?.id)
    .filter((item): item is string => !!item)
  if (resolved.length !== requested.length)
    throw new Error('One or more telemetry resources are outside your authorized scope.')
  return [...new Set(resolved)]
}
