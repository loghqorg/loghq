/**
 * Storage shaping for the log ingest.
 *
 * `POST /logs` accepts JSON from anyone holding a project's public ingest key,
 * so every field is bounded here before it reaches Postgres — an unbounded
 * `context` blob or a 300-character `host` would otherwise abort the INSERT and
 * lose the whole batch.
 *
 * Kept pure and IO-free, mirroring app/Errors/ingest.ts: the route owns the
 * project lookup, the quota, and the insert, and delegates *shaping* to this
 * module so the storage rules can be unit-tested without a database or a
 * running server.
 */

/** The eight PSR-3 / RFC 5424 severities. Anything else falls back to `info`. */
export const LEVELS: ReadonlySet<string> = new Set([
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
])

/** Stored message cap. The column is `text`; this is a policy limit, not a schema one. */
export const MAX_MESSAGE = 16 * 1024
/** Stored context/sdk/user JSON cap. */
export const MAX_CONTEXT_BYTES = 96 * 1024
/** Most entries accepted from one POST. */
export const MAX_BATCH = 500
/** Width of the `trace_id`/`request_id` columns — fits a 32-hex W3C trace-id. */
export const MAX_CORRELATION = 64

/** A raw, untrusted entry as it arrives on the wire. Every field is optional but `message`. */
export interface RawEntry {
  message?: unknown
  level?: unknown
  channel?: unknown
  context?: any
  environment?: unknown
  release?: unknown
  framework?: unknown
  host?: unknown
  sdk?: unknown
  user?: unknown
  timestamp?: unknown
  trace_id?: unknown
  traceId?: unknown
  request_id?: unknown
  requestId?: unknown
  [key: string]: unknown
}

/** A row shaped for `INSERT INTO log_entries`. */
export interface LogRow {
  id: string
  project_id: string
  level: string | null
  message: string
  channel: string | null
  context: string | null
  environment: string | null
  release: string | null
  framework: string | null
  host: string | null
  sdk: string | null
  user_context: string | null
  timestamp: string
  trace_id: string | null
  request_id: string | null
}

export interface NormalizeContext {
  projectId: string
  /** Server receive time, ISO-8601. Used when the client sends no `timestamp`. */
  receivedAt: string
  /** Row-id factory. Injected so tests can make ids deterministic. */
  newId: () => string
}

export interface NormalizedBatch {
  rows: LogRow[]
  /** Entries present in the payload but beyond `MAX_BATCH` — never looked at. */
  dropped: number
  /** Entries examined and rejected as unusable (null, or no `message`). */
  skipped: number
}

/**
 * Truncate to `max`, marking the cut. The `…[truncated]` suffix pushes the
 * result past `max` — safe for `text` columns, never use this for a varchar.
 */
export function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value
}

/**
 * Hard cap for a varchar(n) column. Postgres RAISES on overflow, aborting the
 * INSERT, so the result is guaranteed to fit — unlike `clip`, whose suffix
 * would push it back over.
 */
export function varcharCol(value: unknown, max: number): string | null {
  if (value == null)
    return null
  const s = String(value)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Cap for the varchar(255) columns (level, channel, environment, release, …). */
export function col255(value: unknown): string | null {
  return varcharCol(value, 255)
}

/** Cap for the varchar(64) correlation columns (trace_id, request_id). */
export function col64(value: unknown): string | null {
  return varcharCol(value, MAX_CORRELATION)
}

/**
 * Serialize an object field to a bounded JSON string, or null.
 *
 * Non-objects, empty objects/arrays, and anything unserializable (circular
 * refs, BigInt) become null rather than failing the row. Oversized payloads are
 * replaced wholesale — a half-truncated JSON string would not parse on read.
 */
export function jsonColumn(value: unknown, max = MAX_CONTEXT_BYTES): string | null {
  if (value == null || typeof value !== 'object')
    return null
  try {
    const s = JSON.stringify(value)
    if (!s || s === '{}' || s === '[]')
      return null
    return s.length > max ? JSON.stringify({ _truncated: 'oversized context dropped' }) : s
  }
  catch {
    return null
  }
}

/**
 * Pull the batch out of a request body.
 *
 * Accepts either a batch (`{ logs: [...] }`) or a single bare entry (an object
 * carrying a `message`). Anything else yields an empty list, which the route
 * turns into a 400.
 */
export function extractEntries(body: any): RawEntry[] {
  if (Array.isArray(body?.logs))
    return body.logs
  return body?.message != null ? [body] : []
}

/**
 * Shape one raw entry into a row, or null when it is unusable.
 *
 * A per-entry `key`/`project` in a batch is deliberately ignored: the whole
 * batch is already authorized to one project by the route.
 */
export function normalizeEntry(raw: RawEntry | null | undefined, ctx: NormalizeContext): LogRow | null {
  if (raw == null || raw.message == null)
    return null

  // `user` may arrive top-level or nested under `context`; store whichever is present.
  const userContext = raw.user ?? raw.context?.user ?? null

  return {
    id: ctx.newId(),
    project_id: ctx.projectId,
    level: col255(LEVELS.has(String(raw.level)) ? String(raw.level) : 'info'),
    message: clip(String(raw.message), MAX_MESSAGE),
    channel: col255(raw.channel),
    context: jsonColumn(raw.context),
    environment: col255(raw.environment ?? 'production'),
    release: col255(raw.release),
    framework: col255(raw.framework),
    host: col255(raw.host),
    sdk: jsonColumn(raw.sdk, 4096),
    user_context: jsonColumn(userContext),
    timestamp: col255(raw.timestamp) ?? ctx.receivedAt,
    // Accepted in either casing: `trace_id` matches the wire/column name, while
    // `traceId` is what an idiomatic JS SDK will hand us.
    trace_id: col64(raw.trace_id ?? raw.traceId),
    request_id: col64(raw.request_id ?? raw.requestId),
  }
}

/**
 * Shape a whole request body into rows, reporting what was lost.
 *
 * Overflow past `MAX_BATCH` is counted rather than silently discarded so the
 * route can tell the client it dropped data — a client that thinks it delivered
 * 600 entries when 100 vanished has no way to detect the gap.
 */
export function normalizeBatch(body: any, ctx: NormalizeContext): NormalizedBatch {
  const entries = extractEntries(body)
  const dropped = Math.max(0, entries.length - MAX_BATCH)
  const considered = dropped > 0 ? entries.slice(0, MAX_BATCH) : entries

  const rows: LogRow[] = []
  let skipped = 0
  for (const raw of considered) {
    const row = normalizeEntry(raw, ctx)
    if (row)
      rows.push(row)
    else
      skipped++
  }

  return { rows, dropped, skipped }
}
