/**
 * CDN integrations that sit in front of a ts-cloud origin.
 *
 * AWS/CloudFront fronting lives with the AWS stack (see
 * `drivers/shared/cloudfront-origin`); this module holds the Cloudflare path,
 * where the CDN and the DNS record are the same object.
 */
export type {
  CloudflareCdnReport,
  CloudflareOriginGuard,
  ReconcileCloudflareCdnOptions,
} from './cloudflare'
export { reconcileCloudflareCdn } from './cloudflare'
export type {
  CloudflareCdnPlan,
  EnvLookup,
  ResolveCloudflareCdnPlanResult,
} from './cloudflare-plan'
export { resolveCloudflareCdnPlan, resolveZoneApex } from './cloudflare-plan'
export type { CloudflareCacheRuleSettings } from './cloudflare-rules'
export {
  buildOriginGuardRule,
  buildStaticSiteCacheRules,
  DEFAULT_STATIC_ASSET_EXTENSIONS,
  hostCondition,
} from './cloudflare-rules'
export type { CloudflareHstsSettings, CloudflareZoneSettings } from './cloudflare-settings'
export { STATIC_SITE_ZONE_SETTINGS, toCloudflareZoneSettings } from './cloudflare-settings'
export type { OriginTlsProbeResult, ProbeOriginTlsOptions } from './origin-tls'
export { probeOriginTls } from './origin-tls'
