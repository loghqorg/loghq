import { db } from '@stacksjs/database'

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
 * rely on that default: the retention prune asks `planForPrune`, which
 * answers `null` instead of guessing.
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

  function forget(userId: number | null | undefined): void {
    const id = idOf(userId)
    if (id === null)
      return
    cache.delete(id)
    lastKnown.delete(id)
  }

  return { isPro, forget }
}

/**
 * The statuses that entitle an account to Pro. The same two
 * `@stacksjs/payments` calls `ENTITLING_STATUSES`, and the only rule in this
 * app: the ingest, `/api/me`, the archive and the retention prune all ask
 * `hasLiveSubscription`.
 *
 * Status only, deliberately. `ends_at` is NOT consulted. Stripe keeps a
 * subscription `active` until the period it was cancelled in has run out, and
 * the webhook copies that status, so the status already says whether the time
 * is paid for. An `ends_at` in the past on an `active` row is stale data, not
 * a lapsed customer, and reading it as lapsed would take Pro away from
 * somebody who is paying.
 */
export const ENTITLING_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing'])

/** Statuses that can only mean the subscription is over. Everything else is "maybe". */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['canceled', 'cancelled', 'incomplete_expired'])

/**
 * Whether this account has a live `default` subscription. Throws when it
 * cannot tell. One query, answerable from an id alone, and unlike
 * `Payment.hasActiveSubscription` it does not depend on WHICH row comes back
 * first when an account has more than one (cancel, then resubscribe).
 */
export async function hasLiveSubscription(userId: number): Promise<boolean> {
  const row = (await db.unsafe(
    `SELECT 1 AS live FROM subscriptions
      WHERE user_id = $1 AND type = 'default'
        AND provider_status IN ('active', 'trialing')
      LIMIT 1`,
    [userId],
  ))?.[0]
  return !!row
}

export interface SubscriptionRow {
  type?: unknown
  provider_status?: unknown
  ends_at?: unknown
}

/**
 * The plan as the retention prune needs it: `true` Pro, `false` Free, and
 * `null` for anything in between. Pure.
 *
 * `false` here means "nothing in this account's billing history could be read
 * as paying": no subscription at all, or only ones that have unambiguously
 * ended. Anything else that is not plainly Pro answers `null`, and the prune
 * skips on `null`. That covers every way the entitlement rule above and a
 * different reading of the same rows could disagree:
 *
 * - a status that is neither entitling nor ended (`past_due`, `unpaid`,
 *   `paused`, `incomplete`, or one this code has never seen);
 * - an ended subscription whose `ends_at` is still in the future, or cannot
 *   be parsed: the period may still be paid for;
 * - an entitling subscription of a type other than `default`.
 */
export function pruneVerdict(subscriptions: SubscriptionRow[], now: Date = new Date()): boolean | null {
  let ambiguous = false
  for (const subscription of subscriptions) {
    const status = String(subscription.provider_status ?? '').trim().toLowerCase()
    const isDefault = String(subscription.type ?? 'default') === 'default'
    if (ENTITLING_STATUSES.has(status)) {
      if (isDefault)
        return true
      ambiguous = true
      continue
    }
    if (!ENDED_STATUSES.has(status)) {
      ambiguous = true
      continue
    }
    if (subscription.ends_at != null && subscription.ends_at !== '') {
      const raw = subscription.ends_at
      const text = raw instanceof Date ? raw.toISOString() : String(raw)
      // Stored as `YYYY-MM-DD HH:MM:SS` in UTC (app/Support/time.ts).
      const ends = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`)
      if (Number.isNaN(ends) || ends > now.getTime())
        ambiguous = true
    }
  }
  return ambiguous ? null : false
}

/**
 * `pruneVerdict` over this account's subscriptions. `null` when they cannot
 * be read, when there is no owner, or when the verdict is ambiguous.
 */
export async function planForPrune(userId: number | null | undefined): Promise<boolean | null> {
  const id = idOf(userId)
  if (id === null)
    return null
  try {
    const found = await db.unsafe('SELECT type, provider_status, ends_at FROM subscriptions WHERE user_id = $1', [id])
    return pruneVerdict(Array.isArray(found) ? found : [])
  }
  catch (error) {
    console.error('[billing] subscriptions could not be read for the retention prune:', error instanceof Error ? error.message : error)
    return null
  }
}

const resolver = createPlanResolver({ lookup: hasLiveSubscription })

export function isPro(userId: number | null | undefined): Promise<boolean> {
  return resolver.isPro(userId)
}

/** Drop what is cached about an account, so a plan change applies at once. */
export function forgetPlan(userId: number | null | undefined): void {
  resolver.forget(userId)
}
