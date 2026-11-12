import { db } from '@stacksjs/database'
import { utcNow } from '../Support/time'

/**
 * "Is this account Pro", answerable from a user id alone and cheap enough to
 * ask on every ingest request.
 *
 * The ingest resolves a project, not a user, and it cannot afford a query per
 * batch, so verdicts are cached. A Free verdict is held for a shorter time
 * than a Pro one: the expensive mistake is telling somebody who has just paid
 * that they are still limited.
 *
 * When the lookup fails the last known plan answers, and with none known the
 * account is Free. Free still ingests, so the cost of being wrong is sampling
 * past the allowance, never a refused request. Anything destructive must not
 * rely on that default: the retention prune asks `known`, which answers
 * `null` instead of guessing.
 */

const PRO_TTL_MS = 60_000
const FREE_TTL_MS = 10_000
/** How long the last known plan is trusted after the lookup itself failed. */
const STALE_TTL_MS = 300_000
/** A bound on the remembered plans, far above what a process sees between deploys. */
const MAX_REMEMBERED = 50_000

export interface PlanResolverOptions {
  /** Whether this account has a live subscription. Throws when it cannot tell. */
  lookup: (userId: number) => Promise<boolean>
  now?: () => number
  onError?: (error: unknown) => void
}

export interface PlanResolver {
  /** Cached. A project with no owner has nobody to bill and is never limited. */
  isPro: (userId: number | null | undefined) => Promise<boolean>
  /** Uncached and strict: `null` when the lookup failed or there is no owner. */
  known: (userId: number | null | undefined) => Promise<boolean | null>
  forget: (userId: number | null | undefined) => void
}

function idOf(userId: number | null | undefined): number | null {
  if (userId == null)
    return null
  const id = Number(userId)
  return Number.isFinite(id) ? id : null
}

export function createPlanResolver(options: PlanResolverOptions): PlanResolver {
  const now = options.now ?? Date.now
  const onError = options.onError ?? ((error) => {
    console.error('[billing] plan lookup failed:', error instanceof Error ? error.message : error)
  })

  const cache = new Map<number, { pro: boolean, until: number }>()
  /** The last answer a lookup actually gave, kept past the cache's TTL. */
  const lastKnown = new Map<number, boolean>()

  function remember(id: number, pro: boolean): void {
    // Re-inserting moves the account to the end, so eviction drops whoever was
    // resolved longest ago.
    lastKnown.delete(id)
    lastKnown.set(id, pro)
    if (lastKnown.size > MAX_REMEMBERED) {
      const oldest = lastKnown.keys().next().value
      if (oldest !== undefined) {
        lastKnown.delete(oldest)
        cache.delete(oldest)
      }
    }
  }

  async function isPro(userId: number | null | undefined): Promise<boolean> {
    const id = idOf(userId)
    if (id === null)
      return true

    const hit = cache.get(id)
    if (hit && now() < hit.until)
      return hit.pro

    try {
      const pro = await options.lookup(id)
      remember(id, pro)
      cache.set(id, { pro, until: now() + (pro ? PRO_TTL_MS : FREE_TTL_MS) })
      return pro
    }
    catch (error) {
      onError(error)
      const last = lastKnown.get(id)
      const pro = last ?? false
      // Stop asking a database that is already struggling on every request.
      cache.set(id, { pro, until: now() + (last === undefined ? FREE_TTL_MS : STALE_TTL_MS) })
      return pro
    }
  }

  async function known(userId: number | null | undefined): Promise<boolean | null> {
    const id = idOf(userId)
    if (id === null)
      return null
    try {
      const pro = await options.lookup(id)
      remember(id, pro)
      return pro
    }
    catch (error) {
      onError(error)
      return null
    }
  }

  function forget(userId: number | null | undefined): void {
    const id = idOf(userId)
    if (id === null)
      return
    cache.delete(id)
    lastKnown.delete(id)
  }

  return { isPro, known, forget }
}

/**
 * The same rule `Payment.hasActiveSubscription(user, 'default')` applies (an
 * active or trialing `default` subscription), asked as one query that needs
 * only the id. `ends_at` is honoured so cancelling mid-period does not cut off
 * time that has been paid for. The timestamp is bound rather than `NOW()`,
 * which SQLite does not have (app/Support/time.ts).
 */
export async function hasLiveSubscription(userId: number): Promise<boolean> {
  const row = (await db.unsafe(
    `SELECT 1 AS live FROM subscriptions
      WHERE user_id = $1 AND type = 'default'
        AND provider_status IN ('active', 'trialing')
        AND (ends_at IS NULL OR ends_at > $2)
      LIMIT 1`,
    [userId, utcNow()],
  ))?.[0]
  return !!row
}

const resolver = createPlanResolver({ lookup: hasLiveSubscription })

export function isPro(userId: number | null | undefined): Promise<boolean> {
  return resolver.isPro(userId)
}

/** Strict: `null` when the plan could not be determined. */
export function knownPlan(userId: number | null | undefined): Promise<boolean | null> {
  return resolver.known(userId)
}

/** Drop what is cached about an account, so a plan change applies at once. */
export function forgetPlan(userId: number | null | undefined): void {
  resolver.forget(userId)
}
