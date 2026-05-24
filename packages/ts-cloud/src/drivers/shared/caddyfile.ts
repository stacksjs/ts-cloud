import type { SiteConfig } from '@ts-cloud/core'

/**
 * Build a Caddyfile from site configs. Sites sharing a domain are grouped;
 * explicit paths are ordered before catch-all routes.
 */
export function buildCaddyfile(sites: Record<string, SiteConfig>): string | undefined {
  const allSites = Object.entries(sites)
  const sitesWithDomain = allSites.filter(([, s]) => typeof s.domain === 'string' && s.domain && typeof s.port === 'number')
  if (sitesWithDomain.length === 0) return undefined

  const byDomain = new Map<string, Array<{ port: number, path?: string }>>()
  for (const [, site] of sitesWithDomain) {
    const list = byDomain.get(site.domain!) ?? []
    list.push({ port: site.port!, path: site.path })
    byDomain.set(site.domain!, list)
  }

  const blocks: string[] = []
  for (const [domain, domainSites] of byDomain) {
    const sorted = [...domainSites].sort((a, b) => {
      const aIsCatchAll = !a.path || a.path === '/'
      const bIsCatchAll = !b.path || b.path === '/'
      if (aIsCatchAll && !bIsCatchAll) return 1
      if (!aIsCatchAll && bIsCatchAll) return -1
      return (b.path?.length ?? 0) - (a.path?.length ?? 0)
    })

    const handles = sorted.map((s) => {
      const isCatchAll = !s.path || s.path === '/'
      const inner = `reverse_proxy localhost:${s.port}`
      return isCatchAll
        ? `  handle {\n    ${inner}\n  }`
        : `  handle ${s.path} {\n    ${inner}\n  }`
    })

    blocks.push(`${domain} {\n${handles.join('\n')}\n}`)
  }

  return blocks.join('\n\n')
}
