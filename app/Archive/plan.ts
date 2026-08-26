/**
 * Which retention a project gets.
 *
 * The pricing page sells a 30-day window on the free plan and full retention on
 * Pro (resources/views/pricing.stx). This module is what makes that true: the
 * nightly run asks it per project, and archives or prunes accordingly.
 *
 * Plans belong to users, not projects. There is no `plan` column on `projects`,
 * and subscriptions are keyed by `user_id`, so a project's entitlement is its
 * owner's entitlement. Members inherit whatever the owner pays for, which is the
 * same rule the rest of the app already applies to every project-scoped feature.
 */
import { db } from '@stacksjs/database'
import { log } from '@stacksjs/logging'
import { Payment } from '@stacksjs/payments'

export type ProjectPlan = 'pro' | 'free'

/**
 * True when the project's owner holds an active or trialing subscription.
 *
 * Failure means free, never an exception. `hasActiveSubscription` reaches Stripe
 * config on the way in, and a billing outage must not stop the nightly run: the
 * cost of guessing wrong for one night is that a day's logs stay in the hot
 * database and get archived tomorrow, which is strictly better than the
 * scheduler dying. The same try/catch shape guards the call in
 * app/Actions/MeAction.ts.
 *
 * Only `user.id` is read downstream (manageSubscription.isValid queries
 * subscriptions by user_id), so the owner row is passed as-is rather than being
 * rehydrated into a User model.
 */
export async function projectOwnerIsPro(projectId: string): Promise<boolean> {
  const project = (await db.unsafe(
    'SELECT owner_id FROM projects WHERE id = $1 LIMIT 1',
    [projectId],
  ))?.[0]

  const ownerId = project?.owner_id
  if (ownerId == null)
    return false

  try {
    return await Payment.hasActiveSubscription({ id: ownerId } as any, 'default')
  }
  catch (error) {
    log.warn(`[archive] plan lookup failed for project ${projectId}, treating as free: ${error}`)
    return false
  }
}

export async function projectPlan(projectId: string): Promise<ProjectPlan> {
  return (await projectOwnerIsPro(projectId)) ? 'pro' : 'free'
}

/**
 * Plans for many projects at once.
 *
 * The nightly run touches every project with aged logs, and each lookup is two
 * round trips, so resolving once per project rather than once per partition
 * keeps a month of backlog from turning into hundreds of duplicate queries.
 */
export async function plansFor(projectIds: string[]): Promise<Map<string, ProjectPlan>> {
  const plans = new Map<string, ProjectPlan>()
  for (const id of new Set(projectIds))
    plans.set(id, await projectPlan(id))
  return plans
}
