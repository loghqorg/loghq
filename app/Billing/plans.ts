/**
 * What each plan allows. One place, so the pricing page, the ingest and the
 * retention prune cannot drift apart.
 *
 * resources/views/pricing.stx prints these values instead of restating them,
 * app/Billing/meter.ts enforces the line allowance, and app/Billing/retention.ts
 * and app/Archive/config.ts read the retention window. Change a number here
 * and the copy and the enforcement move together.
 */

/** The meter log lines are counted under in `usage_counters` and `X-HQ-Usage`. */
export const LOG_LINES_METER = 'log_lines'

/** Free's monthly log line allowance, per ACCOUNT (not per project). */
export const FREE_LOG_LINES_PER_MONTH = 10_000

/** How many days of logs a Free account keeps. */
export const FREE_RETENTION_DAYS = 30

/**
 * A plan's monthly log line allowance. `null` is unlimited.
 *
 * What happens past it is not decided here: the ingest stores everything up to
 * 120% of the allowance and then keeps one line in ten (`SOFT_INGEST` in
 * `@stacksjs/hq/meter`), and it never refuses a request over quota.
 */
export function logLinesPerMonth(pro: boolean): number | null {
  return pro ? null : FREE_LOG_LINES_PER_MONTH
}

/** A plan's retention in days. `null` keeps everything. */
export function retentionDays(pro: boolean): number | null {
  return pro ? null : FREE_RETENTION_DAYS
}

/** "10,000": an allowance as the pricing page prints it. */
export function formatAllowance(value: number): string {
  return value.toLocaleString('en-US')
}
