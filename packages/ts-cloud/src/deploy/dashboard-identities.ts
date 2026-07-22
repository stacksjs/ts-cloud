import type { AuthenticationStore } from '../auth'
import type { DashboardControlPlane } from './dashboard-control-plane'
import type { DashboardUser } from './dashboard-auth'
import { ensureDashboardActor } from './dashboard-control-plane'

/**
 * Non-breaking bridge from the original local user file into durable auth.
 * The control-plane identity becomes authoritative after the first migration;
 * memberships remain a separate authorization concern.
 */
export function synchronizeDashboardIdentities(
  authentication: AuthenticationStore,
  controlPlane: DashboardControlPlane,
  users: DashboardUser[],
): void {
  for (const user of users) {
    const actor = ensureDashboardActor(controlPlane.store, user)
    if (authentication.getIdentityByActor(actor.id))
      continue
    authentication.createIdentity({
      actorId: actor.id,
      username: user.username,
      email: user.email,
      emailVerified: !!user.email,
      passwordHash: user.passwordHash,
      requiresPasswordUpgrade: true,
    })
  }
}
