import type { Admission, UsageCounter } from '@stacksjs/hq/meter'
import { db } from '@stacksjs/database'
import { createCounter, droppedMeter, evaluate, formatUsageHeader, sqlCounterStore, USAGE_HEADER } from '@stacksjs/hq/meter'
import { deferredStore, detectDialect } from '../Support/sql-dialect'
import { appUrl } from '../Support/urls'
import { LOG_LINES_METER, logLinesPerMonth } from './plans'

/**
 * Per-account monthly log line metering, and the decision the ingest makes
 * with it.
 *
 * The counting is `@stacksjs/hq/meter`'s: `admit` touches Maps and returns,
 * and a timer folds the buffered deltas into `usage_counters` every ten
 * seconds with an additive upsert. Nothing here adds a database round-trip to
 * `POST /logs`. A crash loses at most one interval of counts.
 *
 * What this file owns is the LogHQ side: lines rather than requests, which
 * allowance (app/Billing/plans.ts) and what the response says about it.
 */

/** Where this service sells its plan. Absolute, because it travels in a header. */
export function upgradeUrl(): string {
  return `${appUrl()}/pricing`
}

export const usageCounter: UsageCounter = createCounter({
  // The dialect is asked of the database itself on the first flush, not read
  // from configuration: see app/Support/sql-dialect.ts.
  store: deferredStore(async () => sqlCounterStore(db, { dialect: await detectDialect(db) })),
})

/**
 * Load an account's stored totals before its first batch is decided.
 *
 * `admit` never waits: the first time a process sees an account it decides
 * from zero and loads the real total behind the request. For a service that
 * admits one event per request that is one event. Here a request is a batch,
 * and every line of it would be decided before the total arrived, so after
 * each restart an account past its allowance would get up to 500 lines stored
 * in full and a header reporting a count of a few hundred.
 *
 * So the route awaits this first. It costs two reads the first time a process
 * sees an account in a month and nothing after that, and it never rejects: a
 * failed read is logged by the counter and the batch is decided from zero, as
 * before.
 */
export async function primeLines(counter: UsageCounter, ownerId: number | string | null | undefined): Promise<void> {
  if (ownerId == null)
    return
  await Promise.all([counter.prime(ownerId, LOG_LINES_METER), counter.prime(ownerId, droppedMeter(LOG_LINES_METER))])
}

export interface LinesAdmission {
  /** One verdict per line, in the order given: whether to store it. */
  keep: boolean[]
  /** Lines to store. */
  stored: number
  /** Lines dropped by sampling past 120% of the allowance. */
  sampled: number
  /** Where the account stands after this batch. */
  usage: Pick<Admission, 'meter' | 'used' | 'limit' | 'state'>
  /** `X-HQ-Usage`, to merge into the response. */
  headers: Record<string, string>
}

/**
 * Decide a batch of log lines against the owning account's allowance, and
 * count them.
 *
 * The unit is the LINE: a batch of 50 is 50 against the allowance, decided one
 * by one, so a batch that straddles a threshold is stored up to it and sampled
 * after it rather than being taken or dropped whole.
 *
 * A Free account is stored in full to 120% of the allowance, then one line in
 * ten. A Pro account is unlimited and still counted. Lines for a project with
 * no owner are not metered and never dropped.
 *
 * The caller answers 2xx whatever this says. A refusal would only make the
 * SDK retry, which is more load for the same data, so the account is told
 * through the header instead.
 */
export function admitLines(
  counter: UsageCounter,
  ownerId: number | string | null | undefined,
  pro: boolean,
  lines: number,
  upgrade: string = upgradeUrl(),
): LinesAdmission {
  const limit = logLinesPerMonth(pro)
  const count = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 0
  const keep: boolean[] = []
  let last: Admission | null = null
  for (let i = 0; i < count; i++) {
    last = counter.admit(ownerId, LOG_LINES_METER, limit)
    keep.push(last.accept)
  }

  // An empty batch decides nothing, but the caller still gets told where the
  // account stands.
  const usage = last
    ? { meter: last.meter, used: last.used, limit: last.limit, state: last.state }
    : { meter: LOG_LINES_METER, ...standing(counter, ownerId, limit) }
  const stored = keep.filter(Boolean).length

  return {
    keep,
    stored,
    sampled: count - stored,
    usage,
    headers: { [USAGE_HEADER]: formatUsageHeader({ ...usage, upgradeUrl: upgrade }) },
  }
}

function standing(counter: UsageCounter, ownerId: number | string | null | undefined, limit: number | null): Pick<Admission, 'used' | 'limit' | 'state'> {
  const { used, state, limit: allowance } = evaluate(counter.usageOf(ownerId, LOG_LINES_METER) ?? 0, ownerId == null ? null : limit)
  return { used, limit: allowance, state }
}
