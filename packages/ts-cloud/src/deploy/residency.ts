export interface ResidencyPolicy { countries: string[], locations?: string[] }
export interface ResidencyEvidence { country?: string, location?: string }

/** Missing provider evidence is a refusal, never permission to use an arbitrary location. */
export function assertComputeResidency(policy: ResidencyPolicy, evidence: ResidencyEvidence): void {
  if (!Array.isArray(policy.countries) || !policy.countries.length || policy.countries.some(country => !/^[A-Z]{2}$/.test(country)))
    throw new Error('Residency requires an explicit country allowlist')
  if (!evidence.country || !policy.countries.includes(evidence.country)
    || (policy.locations && (!policy.locations.length || !evidence.location || !policy.locations.includes(evidence.location))))
    throw new Error('Compute target is outside the required residency policy, or its provider location is unknown')
}
