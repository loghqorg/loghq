/**
 * UTC timestamps for SQL, computed in JS rather than by the database.
 *
 * These exist because `NOW()` is Postgres-only and this app runs SQLite in
 * production. SQLite raises `no such function: NOW`, and `AT TIME ZONE` is a
 * syntax error there, so every statement written as
 * `(NOW() AT TIME ZONE 'UTC')` failed at runtime rather than at deploy. That is
 * why log_fix_runs held zero rows on production: "Fix with AI" could not insert
 * its own run, and the same applied to rotate-key, archive, and channel updates.
 *
 * Binding a value computed here keeps the query dialect-free, so the same SQL is
 * correct on both engines.
 *
 * The format is `YYYY-MM-DD HH:MM:SS`, which is exactly what CURRENT_TIMESTAMP
 * produces and what the existing rows already hold, so nothing that renders or
 * compares these columns changes.
 *
 * Deliberately NOT `toISOString()` in full: that carries a `T` and a trailing
 * `Z`, and string comparisons against the stored format (`created_at > $1`)
 * would then be comparing two different shapes.
 */

function toSqlUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

/** Now, in UTC, as the timestamp columns store it. */
export function utcNow(): string {
  return toSqlUtc(new Date())
}

/** A point `hours` in the past, in the same format, for window comparisons. */
export function utcHoursAgo(hours: number): string {
  return toSqlUtc(new Date(Date.now() - hours * 60 * 60 * 1000))
}

/**
 * A point `hours` in the past as a full ISO-8601 string, for comparisons against
 * `log_entries.timestamp`.
 *
 * That column is a varchar holding whatever ISO-8601 instant the SDK reported,
 * so it carries the `T` and the trailing `Z` that `utcHoursAgo` deliberately
 * strips. The two are not interchangeable: comparing an ISO value against a
 * `created_at`-shaped bound (or the reverse) compares two different string
 * shapes and quietly matches the wrong rows, because `'2026-08-26T12:00:00Z'`
 * and `'2026-08-26 12:00:00'` diverge at the eleventh character.
 *
 * Use this one for `timestamp`, `utcHoursAgo` for `created_at`/`updated_at`.
 */
export function utcIsoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
}
