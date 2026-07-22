import * as cli from '../utils/cli'
import { CloudFrontClient } from '../aws/cloudfront'

function normalizeAliases(aliases: unknown): string[] {
  if (!aliases) return []
  if (Array.isArray(aliases)) return aliases.map(String)

  const record = aliases as { Items?: unknown; Item?: unknown }
  const items = record.Items ?? record.Item
  if (!items) return []

  if (Array.isArray(items)) return items.map(String)

  if (typeof items === 'object' && items !== null) {
    const objectItems = items as Record<string, unknown>
    if ('Item' in objectItems) {
      const nested = objectItems.Item
      if (!nested) return []
      return Array.isArray(nested) ? nested.map(String) : [String(nested)]
    }
    if ('CNAME' in objectItems) {
      const cnames = objectItems.CNAME
      if (!cnames) return []
      return Array.isArray(cnames) ? cnames.map(String) : [String(cnames)]
    }
    return Object.values(objectItems).flatMap((value) => {
      if (Array.isArray(value)) return value.map(String)
      return typeof value === 'string' ? [value] : []
    })
  }

  return [String(items)]
}

/**
 * Ensure CloudFront distributions serving app domains allow POST/PUT/PATCH/DELETE
 * on cache behaviors that target compute (default behavior and API path patterns).
 */
export async function ensureDynamicMethodsForDomains(domains: string[]): Promise<void> {
  if (domains.length === 0) return

  const cf = new CloudFrontClient()
  const distributions = await cf.listDistributions()
  const uniqueDomains = [...new Set(domains.map((d) => d.toLowerCase()))]

  for (const domain of uniqueDomains) {
    const distribution = distributions.find((entry) => {
      const aliases = normalizeAliases(entry.Aliases)
      return aliases.some((alias) => alias.toLowerCase() === domain)
    })

    if (!distribution?.Id) {
      cli.warn(`No CloudFront distribution found for ${domain} — skipping dynamic HTTP method sync`)
      continue
    }

    const updated = await cf.ensureDynamicHttpMethods(distribution.Id)
    if (updated) {
      cli.success(`CloudFront ${distribution.Id} (${domain}): enabled POST/PUT/PATCH/DELETE on dynamic paths`)
    } else {
      cli.info(`CloudFront ${distribution.Id} (${domain}): already allows dynamic HTTP methods`)
    }
  }
}
