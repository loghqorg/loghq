/**
 * loghq — log ingest + stream API.
 *
 * SDKs POST batches of captured log records to `/logs`; each record is stored
 * verbatim as a LogEntry (no grouping — loghq is a stream, not an issue
 * tracker). The dashboard reads the stream from
 * `GET /api/projects/{id}/logs`. Storage is Postgres, queried through
 * bun-query-builder's `db`.
 */

import { db } from '@stacksjs/database'
import { route } from '@stacksjs/router'
import { authorizeIngest } from '../app/Errors/ingest'
import { rateLimit } from '../app/Errors/limits'
import { extractEntries, MAX_BATCH, normalizeBatch } from '../app/Logs/normalize'
import { cursorAtHorizon, cursorOf, decodeCursor, encodeCursor, forwardQuery, newEntryId, pageLimit, receiveStamp, STREAM_COLS, streamFilters } from '../app/Logs/query'
import { claimTail, SSE_HEADERS, tailStart, tailStream } from '../app/Logs/tail'
// The owner/member predicate lives in one file so these routes and the pages
// that render the same data cannot drift on it. See app/Support/access.ts.
import { ownsProject } from '../app/Support/access'
import { healthResponse } from '../app/Support/health'
import { projectReadAccess } from '../app/Support/request-auth'

// Ingest abuse bounds. The public key gate is not enough on its own — a script
// with the key (readable from any bundle) could flood the ingest. Per-entry
// storage caps (message/context size, batch length) live in app/Logs/normalize.
const MAX_BODY_BYTES = 512 * 1024 // reject payloads larger than this outright (batches are bigger than single errors)
// Fixed-window quotas: per project, and per client IP across projects. Logs are
// higher-volume than errors, so the per-project budget is generous; it still
// kills a runaway loop. Shared across instances when Redis is configured, else
// per-process (see app/Errors/limits.ts).
const PROJECT_LIMIT = 2000
const IP_LIMIT = 4000
const RATE_WINDOW_MS = 10_000

const TRUSTED_PROXY_HOPS = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS ?? 1))

function clientIp(request: any): string {
  const direct = request.headers?.get('x-real-ip') || request.ip || 'unknown'
  if (TRUSTED_PROXY_HOPS === 0)
    return direct
  const xff = request.headers?.get('x-forwarded-for')
  if (xff) {
    const hops = String(xff).split(',').map((s: string) => s.trim()).filter(Boolean)
    if (hops.length) {
      const idx = hops.length - TRUSTED_PROXY_HOPS
      return hops[idx >= 0 ? idx : 0]
    }
  }
  return direct
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-LogHQ-Key',
  'Access-Control-Max-Age': '86400',
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extraHeaders } })
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

route.options('/logs', () => new Response(null, { status: 204, headers: CORS }))

route.post('/logs', async (request: any) => {
  const declaredLen = Number(request.headers?.get('content-length') || 0)
  if (declaredLen > MAX_BODY_BYTES)
    return json({ error: 'payload too large' }, 413)

  const body = request.jsonBody ?? {}
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES)
    return json({ error: 'payload too large' }, 413)

  // Accept a batch (`{ logs: [...] }`) or a single entry object. Overflow past
  // MAX_BATCH is not trimmed here — normalizeBatch counts it so the response can
  // report the loss instead of returning a success the client can't reconcile.
  const rawEntries = extractEntries(body)
  if (!rawEntries.length)
    return json({ error: 'no log entries' }, 400)

  // Per-IP quota across all projects.
  const ip = clientIp(request)
  const ipLimit = await rateLimit(`ip:${ip}`, IP_LIMIT, RATE_WINDOW_MS)
  if (!ipLimit.ok)
    return json({ error: 'rate limited' }, 429, { 'Retry-After': String(ipLimit.retryAfter) })

  // Resolve the project from the globally-unique ingest key (header or body).
  const providedKey = request.headers?.get('x-loghq-key') ?? body.key ?? null
  const requestedProject = body.project ?? body.p ?? null
  let project = null
  if (requestedProject) {
    project = (await db.unsafe('SELECT id, ingest_key, is_active FROM projects WHERE id = $1 LIMIT 1', [String(requestedProject)]))?.[0] ?? null
  }
  else if (providedKey) {
    project = (await db.unsafe('SELECT id, ingest_key, is_active FROM projects WHERE ingest_key = $1 LIMIT 1', [String(providedKey)]))?.[0] ?? null
  }
  const auth = authorizeIngest(project, providedKey)
  if (!auth.ok)
    return json({ error: auth.error }, auth.status)

  const projectId = String(project.id)

  // Per-project quota, charged once per batch record so a fat batch can't dodge
  // it — but only for the records we will actually store, since anything past
  // MAX_BATCH is dropped without being read.
  const charged = Math.min(rawEntries.length, MAX_BATCH)
  const projLimit = await rateLimit(`proj:${projectId}`, PROJECT_LIMIT, RATE_WINDOW_MS, charged)
  if (!projLimit.ok)
    return json({ error: 'rate limited' }, 429, { 'Retry-After': String(projLimit.retryAfter) })

  const received = new Date()
  const receivedAt = received.toISOString()
  const { rows, dropped, skipped } = normalizeBatch(body, { projectId, receivedAt, newId: newEntryId })

  // `created_at` is written here rather than left to the column default. The
  // default is CURRENT_TIMESTAMP, which is whole seconds, and readers walking
  // the stream forward order by this column (app/Logs/query.ts): a batch
  // landing in a second a reader had already passed would be skipped.
  const createdAt = receiveStamp(received)

  // One multi-row INSERT. Inserting per entry cost a round-trip each, so a full
  // 500-record batch serialized into 500 of them.
  if (rows.length)
    await db.insertInto('log_entries').values(rows.map(row => ({ ...row, created_at: createdAt }))).execute()

  // `dropped` (over MAX_BATCH) and `skipped` (no usable message) are always
  // reported: a client that believes it delivered 600 entries has no other way
  // to notice that 100 never landed.
  return json({ ok: true, stored: rows.length, dropped, skipped }, 201)
}).skipCsrf() // public ingest: SDKs POST cross-origin with no CSRF cookie

// ---------------------------------------------------------------------------
// Stream API (dashboard)
// ---------------------------------------------------------------------------

// Reading is cross-origin too: a desktop app's webview is its own origin and
// presents a read key or read token as a bearer. Allowing the header to any
// origin is safe for the same reason it is for ingest: a bearer is not an
// ambient credential, so a page can only send one it already holds, and the
// wildcard origin means a browser will not attach the session cookie.
const READ_CORS = {
  ...CORS,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID',
}
const readPreflight = (): Response => new Response(null, { status: 204, headers: READ_CORS })

route.options('/api/projects/{projectId}/logs', readPreflight)
route.options('/api/projects/{projectId}/logs/tail', readPreflight)
route.options('/api/logs/{logId}', readPreflight)

route.get('/api/projects/{projectId}/logs', async (request: any) => {
  const projectId = request.params.projectId
  // A person who can see the project, a read key issued for it (#14), or a
  // read token belonging to such a person.
  const access = await projectReadAccess(request, projectId, ownsProject)
  if (!access.ok)
    return json({ error: access.error }, access.status, READ_CORS)

  const q = request.query ?? {}
  const filters = streamFilters(projectId, q)
  const limit = pageLimit(q.limit)

  // Forward: entries that ARRIVED after the cursor, oldest first. This is the
  // polling form of the live tail and shares its query, so a client can follow
  // a project with either and get the same entries in the same order.
  if (q.after != null && q.after !== '') {
    if (q.before)
      return json({ error: 'use either before or after, not both' }, 400, READ_CORS)
    const cursor = decodeCursor(String(q.after))
    if (!cursor)
      return json({ error: 'invalid after cursor' }, 400, READ_CORS)
    const forward = forwardQuery(filters, cursor, limit)
    const logs = (await db.unsafe(forward.sql, forward.params)) ?? []
    // Always a cursor, even for an empty page: the caller polls again with it.
    const nextAfter = logs.length ? cursorOf(logs[logs.length - 1]) : String(q.after)
    return json({ logs, nextAfter, hasMore: logs.length === limit }, 200, READ_CORS)
  }

  const where = [...filters.where]
  const params = [...filters.params]
  // Keyset pagination: fetch older than this timestamp cursor.
  if (q.before) {
    params.push(String(q.before))
    where.push(`timestamp < $${params.length}`)
  }

  // Taken before the read, so anything stored while the query runs is ahead of
  // it rather than lost between this page and the first forward read.
  const nextAfter = encodeCursor(cursorAtHorizon())
  const rows = await db.unsafe(
    `SELECT ${STREAM_COLS} FROM log_entries WHERE ${where.join(' AND ')} ORDER BY timestamp DESC LIMIT ${limit}`,
    params,
  )
  const logs = rows ?? []
  // Next cursor = the oldest timestamp in this page.
  const nextCursor = logs.length === limit ? logs[logs.length - 1].timestamp : null
  return json({ logs, nextCursor, nextAfter }, 200, READ_CORS)
})

// Live tail (Server-Sent Events). Same credentials and filters as the page
// above. Starts at `Last-Event-ID` when a client is reconnecting, else `after`,
// else the present. See app/Logs/tail.ts for the events and the limits.
route.get('/api/projects/{projectId}/logs/tail', async (request: any) => {
  const projectId = request.params.projectId
  const access = await projectReadAccess(request, projectId, ownsProject)
  if (!access.ok)
    return json({ error: access.error }, access.status, READ_CORS)

  const q = request.query ?? {}
  const start = tailStart(request.headers?.get?.('last-event-id'), q.after)
  if (!start.ok)
    return json({ error: 'invalid after cursor' }, 400, READ_CORS)

  const release = claimTail(projectId)
  if (!release)
    return json({ error: 'too many open tails' }, 429, { ...READ_CORS, 'Retry-After': '30' })

  const filters = streamFilters(projectId, q)
  const body = tailStream({
    start: start.cursor ?? cursorAtHorizon(),
    fetchAfter: async (cursor, limit) => {
      const forward = forwardQuery(filters, cursor, limit)
      return (await db.unsafe(forward.sql, forward.params)) ?? []
    },
    // The credential is checked again while the stream is open: a revoked key,
    // a revoked token or a removed member stops receiving entries within
    // REAUTHORIZE_MS instead of at the next reconnect.
    authorize: async () => (await projectReadAccess(request, projectId, ownsProject)).ok,
    onClose: release,
    signal: request.signal,
  })
  return new Response(body, { status: 200, headers: { ...READ_CORS, ...SSE_HEADERS } })
})

route.get('/api/logs/{logId}', async (request: any) => {
  const logId = request.params.logId
  // The entry is read before anyone is authorised, and returned only after.
  // Authorising first would mean asking "may you read project X?" without
  // knowing which project this entry is in; answering 404 for a missing entry
  // before checking the caller would tell an unauthenticated one which log ids
  // exist. So: fetch, authorise against the entry's project (an empty id when
  // there is no entry, which no key and no user can read), then answer.
  const entry = (await db.unsafe('SELECT * FROM log_entries WHERE id = $1 LIMIT 1', [logId]))?.[0]
  const access = await projectReadAccess(request, entry ? String(entry.project_id) : '', ownsProject)
  if (!access.ok)
    return json({ error: access.error }, access.status, READ_CORS)
  if (!entry)
    return json({ error: 'not found' }, 404)
  return json({ entry }, 200, READ_CORS)
})

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

// Registered twice, and both are load-bearing. The public origin routes `/api/*`
// to this server and everything else to the web app, so a bare `GET /health`
// never arrives here in production — it reaches the page handler, finds no page
// and answers the 404 HTML document. `/api/health` is the one an uptime check on
// loghq.org can actually see; the bare path stays for anything talking to this
// process directly (local dev, a probe on the box itself).
//
// See app/Support/health.ts for why this is hand-registered rather than left to
// the framework's `route.health()`, and why it answers 503 rather than a
// cheerful 200 when a dependency is down.
route.get('/health', () => healthResponse())
route.get('/api/health', () => healthResponse())
