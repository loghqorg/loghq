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
import { extractEntries, LEVELS, MAX_BATCH, MAX_CORRELATION, normalizeBatch } from '../app/Logs/normalize'
// The owner/member predicate lives in one file so these routes and the pages
// that render the same data cannot drift on it. See app/Support/access.ts.
import { ownsLog, ownsProject } from '../app/Support/access'
import { healthResponse } from '../app/Support/health'
import { userFromRequest } from '../app/Support/request-auth'

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

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
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

  const receivedAt = new Date().toISOString()
  const { rows, dropped, skipped } = normalizeBatch(body, { projectId, receivedAt, newId: randomId })

  // One multi-row INSERT. Inserting per entry cost a round-trip each, so a full
  // 500-record batch serialized into 500 of them.
  if (rows.length)
    await db.insertInto('log_entries').values(rows).execute()

  // `dropped` (over MAX_BATCH) and `skipped` (no usable message) are always
  // reported: a client that believes it delivered 600 entries has no other way
  // to notice that 100 never landed.
  return json({ ok: true, stored: rows.length, dropped, skipped }, 201)
}).skipCsrf() // public ingest: SDKs POST cross-origin with no CSRF cookie

// ---------------------------------------------------------------------------
// Stream API (dashboard)
// ---------------------------------------------------------------------------

const STREAM_COLS = 'id, level, message, channel, environment, release, framework, host, timestamp, created_at, trace_id, request_id'

route.get('/api/projects/{projectId}/logs', async (request: any) => {
  const projectId = request.params.projectId
  const user = await userFromRequest(request)
  if (!user)
    return json({ error: 'unauthorized' }, 401)
  if (!(await ownsProject(user, projectId)))
    return json({ error: 'not found' }, 404)

  const q = request.query ?? {}
  const where: string[] = ['project_id = $1']
  const params: any[] = [projectId]

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
  // Keyset pagination: fetch older than this timestamp cursor.
  if (q.before) {
    params.push(String(q.before))
    where.push(`timestamp < $${params.length}`)
  }

  const limit = Math.min(200, Math.max(1, Number(q.limit) || 100))
  const rows = await db.unsafe(
    `SELECT ${STREAM_COLS} FROM log_entries WHERE ${where.join(' AND ')} ORDER BY timestamp DESC LIMIT ${limit}`,
    params,
  )
  const logs = rows ?? []
  // Next cursor = the oldest timestamp in this page.
  const nextCursor = logs.length === limit ? logs[logs.length - 1].timestamp : null
  return json({ logs, nextCursor })
})

route.get('/api/logs/{logId}', async (request: any) => {
  const logId = request.params.logId
  const user = await userFromRequest(request)
  if (!user)
    return json({ error: 'unauthorized' }, 401)
  if (!(await ownsLog(user, logId)))
    return json({ error: 'not found' }, 404)
  const entry = (await db.unsafe('SELECT * FROM log_entries WHERE id = $1 LIMIT 1', [logId]))?.[0]
  if (!entry)
    return json({ error: 'not found' }, 404)
  return json({ entry })
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
