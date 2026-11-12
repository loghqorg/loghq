/**
 * The log stream's filters and its forward cursor.
 *
 * Extracted from routes/logs.ts when the stream grew a second reader. The page
 * endpoint and the live tail must agree on what `level=error,critical` or
 * `q=timeout` selects, and two copies of the WHERE clause would drift the first
 * time a filter was added to one of them.
 *
 * Everything here builds SQL text and bind values and touches no database, so
 * it can be executed against a throwaway SQLite in tests/unit/logs-query.test.ts.
 */
import { LEVELS, MAX_CORRELATION } from './normalize'

/** The columns a stream reader gets. `context` and friends stay behind `GET /api/logs/{id}`. */
export const STREAM_COLS = 'id, level, message, channel, environment, release, framework, host, timestamp, created_at, trace_id, request_id'

export interface StreamFilters {
  where: string[]
  params: unknown[]
}

/**
 * The WHERE clause every stream reader shares: one project, narrowed by
 * whichever of `level`, `channel`, `environment`, `trace`, `request` and `q`
 * the caller sent.
 */
export function streamFilters(projectId: string, q: Record<string, unknown>): StreamFilters {
  const where: string[] = ['project_id = $1']
  const params: unknown[] = [projectId]

  // Level filter: exact, or comma-separated set (e.g. ?level=error,critical).
  // Expanded to individual placeholders (`IN ($n,$n+1,…)`) rather than a single
  // array param — db.unsafe binds a JS array as a malformed Postgres array
  // literal, so `= ANY($n)` fails.
  if (q.level) {
    const levels = String(q.level).split(',').map(s => s.trim().toLowerCase()).filter(l => LEVELS.has(l))
    if (levels.length) {
      const placeholders = levels.map((_, i) => `$${params.length + i + 1}`).join(',')
      levels.forEach(l => params.push(l))
      where.push(`level IN (${placeholders})`)
    }
  }
  if (q.channel) {
    params.push(String(q.channel))
    where.push(`channel = $${params.length}`)
  }
  if (q.environment) {
    params.push(String(q.environment))
    where.push(`environment = $${params.length}`)
  }
  // Correlation: "show me the rest of this trace / request". Both are backed by
  // the partial indexes from migration 0000000010, so these stay cheap.
  if (q.trace) {
    params.push(String(q.trace).slice(0, MAX_CORRELATION))
    where.push(`trace_id = $${params.length}`)
  }
  if (q.request) {
    params.push(String(q.request).slice(0, MAX_CORRELATION))
    where.push(`request_id = $${params.length}`)
  }
  // Full-text-ish search over the message.
  //
  // lower(...) LIKE lower(...), not ILIKE. ILIKE is Postgres-only and this app
  // runs SQLite, where it is a parse error rather than a slow path: every
  // search request through this endpoint threw. A bare LIKE would fix SQLite
  // and quietly become case-sensitive the day this moves to Postgres, so both
  // sides are folded instead. Same shape as the dashboard's own search.
  if (q.q) {
    params.push(`%${String(q.q).slice(0, 200).toLowerCase()}%`)
    where.push(`lower(message) LIKE $${params.length}`)
  }
  return { where, params }
}

// ---------------------------------------------------------------------------
// Forward cursor
// ---------------------------------------------------------------------------

/**
 * A position in the order entries ARRIVED, not the order they claim to have
 * happened.
 *
 * `timestamp` is whatever instant the SDK reported, so it is the right order
 * for reading history and the wrong one for following a stream: a batch that
 * was buffered on a client for a minute lands with timestamps a minute old,
 * behind anything a `timestamp > cursor` reader has already passed, and is
 * never seen. `created_at` is stamped here when the batch is stored, so a
 * reader walking it forward meets every entry exactly once. Rows in one batch
 * share a stamp, and `id` breaks the tie.
 */
export interface ForwardCursor {
  createdAt: string
  id: string
}

/** `created_at` as this app writes it: `YYYY-MM-DD HH:MM:SS`, with milliseconds on rows stored since the tail landed. */
const CREATED_AT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?$/
const MAX_CURSOR_LENGTH = 512

/**
 * The receive stamp for a batch: `utcNow()`'s shape with milliseconds kept.
 *
 * The extra digits sort after the bare second (`…:07` < `…:07.000`), so rows
 * stored before this existed stay behind every row stored after it, and every
 * comparison written against the `YYYY-MM-DD HH:MM:SS` shape still holds.
 */
export function receiveStamp(date: Date = new Date()): string {
  return date.toISOString().slice(0, 23).replace('T', ' ')
}

/**
 * An id for a stored entry: a UUIDv7, which is time-ordered and counts up
 * within a millisecond.
 *
 * The order matters to forward readers. Every row of a batch carries the same
 * stamp, so the id is all that orders them, and with the random ids this used
 * to mint a batch was delivered shuffled: line 3 of a stack trace ahead of
 * line 1. Ids minted in the order the SDK sent the entries sort back into it.
 */
export function newEntryId(): string {
  return Bun.randomUUIDv7()
}

/** Opaque to clients: base64url of the stamp and the id, so nobody builds one by hand and the shape can change. */
export function encodeCursor(cursor: ForwardCursor): string {
  return Buffer.from(`${cursor.createdAt}\n${cursor.id}`, 'utf8').toString('base64url')
}

export function decodeCursor(value: unknown): ForwardCursor | null {
  if (typeof value !== 'string' || !value || value.length > MAX_CURSOR_LENGTH || !/^[\w-]+$/.test(value))
    return null
  const text = Buffer.from(value, 'base64url').toString('utf8')
  const split = text.indexOf('\n')
  if (split === -1)
    return null
  const createdAt = text.slice(0, split)
  const id = text.slice(split + 1)
  if (!CREATED_AT.test(createdAt) || id.length > 255 || id.includes('\n'))
    return null
  return { createdAt, id }
}

export function cursorOf(row: { created_at: unknown, id: unknown }): string {
  return encodeCursor({ createdAt: String(row.created_at), id: String(row.id) })
}

/**
 * How far behind "now" a forward read stops.
 *
 * A batch is stamped a moment before its INSERT lands. A reader that ran right
 * up to the present could pass a stamp whose rows are not visible yet and never
 * come back for them. Holding the reader this far back gives every stamped
 * batch time to land first. It is the price of a cursor that cannot skip, and
 * it bounds how live the tail is: an entry shows up between this and this plus
 * one poll after it is stored.
 */
export const SETTLE_MS = 750

/** The newest stamp a forward read may return right now. */
export function settledHorizon(now: Date = new Date()): string {
  return receiveStamp(new Date(now.getTime() - SETTLE_MS))
}

/**
 * A cursor at the present, for a reader that wants only what arrives from here on.
 *
 * The empty id sorts before every real id, so entries sharing the horizon's
 * millisecond are still ahead of it.
 */
export function cursorAtHorizon(now: Date = new Date()): ForwardCursor {
  return { createdAt: settledHorizon(now), id: '' }
}

export const MAX_PAGE = 200

export function pageLimit(value: unknown, fallback = 100): number {
  return Math.min(MAX_PAGE, Math.max(1, Number(value) || fallback))
}

/**
 * Entries after `cursor`, oldest first, up to the settled horizon.
 *
 * The row comparison is spelled out rather than written `(created_at, id) > ($a, $b)`
 * so it reads the same on SQLite and Postgres and uses the
 * `(project_id, created_at, id)` index on both.
 */
export function forwardQuery(filters: StreamFilters, cursor: ForwardCursor, limit: number, now: Date = new Date()): { sql: string, params: unknown[] } {
  const params = [...filters.params]
  const where = [...filters.where]
  params.push(cursor.createdAt)
  const at = `$${params.length}`
  params.push(cursor.id)
  const id = `$${params.length}`
  where.push(`(created_at > ${at} OR (created_at = ${at} AND id > ${id}))`)
  params.push(settledHorizon(now))
  where.push(`created_at <= $${params.length}`)
  return {
    sql: `SELECT ${STREAM_COLS} FROM log_entries WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC LIMIT ${pageLimit(limit)}`,
    params,
  }
}
