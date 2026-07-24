/**
 * loghq — log ingest + stream API.
 *
 * SDKs POST batches of captured log records to `/logs`; each record is stored
 * verbatim as a LogEntry (no grouping — loghq is a stream, not an issue
 * tracker). The dashboard reads the stream from
 * `GET /api/projects/{id}/logs`. Storage is Postgres, queried through
 * bun-query-builder's `db`.
 */

import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { response, route } from '@stacksjs/router'
import { authorizeIngest } from '../app/Errors/ingest'
import { rateLimit } from '../app/Errors/limits'

// Ingest abuse bounds. The public key gate is not enough on its own — a script
// with the key (readable from any bundle) could flood the ingest.
const MAX_BODY_BYTES = 512 * 1024 // reject payloads larger than this outright (batches are bigger than single errors)
const MAX_MESSAGE = 16 * 1024 // stored message cap
const MAX_CONTEXT_BYTES = 96 * 1024 // stored context/sdk/user JSON cap
const MAX_BATCH = 500 // most entries accepted in one POST
// Fixed-window quotas (per process): per project, and per client IP across
// projects. Logs are higher-volume than errors, so the per-project budget is
// generous; it still kills a runaway loop.
const PROJECT_LIMIT = 2000
const IP_LIMIT = 4000
const RATE_WINDOW_MS = 10_000

const LEVELS = new Set(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'])

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

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value
}

// Hard cap for varchar(255) columns — Postgres RAISES on overflow, aborting the
// INSERT. Note plain clip() is unsafe here: its suffix pushes past 255.
function col255(value: unknown): string | null {
  if (value == null)
    return null
  const s = String(value)
  return s.length > 255 ? `${s.slice(0, 254)}…` : s
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** Serialize an object field to a JSON string, bounded, or null. */
function jsonColumn(value: unknown, max = MAX_CONTEXT_BYTES): string | null {
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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-LogHQ-Key',
  'Access-Control-Max-Age': '86400',
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extraHeaders } })
}

async function userFromRequest(request: any): Promise<any | null> {
  const authHeader = request.headers?.get?.('authorization') ?? ''
  let token = request.bearerToken?.() ?? authHeader.replace(/^Bearer\s+/i, '')
  if (!token) {
    const cookie = request.headers?.get?.('cookie') ?? ''
    const m = cookie.match(/(?:^|;)\s*loghq_token=([^;]+)/)
    if (m)
      token = decodeURIComponent(m[1])
  }
  if (!token)
    return null
  try {
    return await Auth.getUserFromToken(token)
  }
  catch {
    return null
  }
}

function userEmail(user: any): string {
  return String(user?.email ?? '').trim().toLowerCase()
}

/** True when `user` can access the project (owner or invited member). */
async function ownsProject(user: any, projectId: string): Promise<boolean> {
  const row = (await db.unsafe(
    `SELECT 1 FROM projects p
     WHERE p.id = $1 AND (
       p.owner_id = $2
       OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND lower(m.email) = $3)
     ) LIMIT 1`,
    [projectId, Number(user.id), userEmail(user)],
  ))?.[0]
  return !!row
}

async function ownsLog(user: any, logId: string): Promise<boolean> {
  const row = (await db.unsafe(
    `SELECT 1 FROM log_entries l JOIN projects p ON p.id = l.project_id
     WHERE l.id = $1 AND (
       p.owner_id = $2
       OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND lower(m.email) = $3)
     ) LIMIT 1`,
    [logId, Number(user.id), userEmail(user)],
  ))?.[0]
  return !!row
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

  // Accept a batch (`{ logs: [...] }`) or a single entry object.
  const rawEntries: any[] = Array.isArray(body.logs)
    ? body.logs
    : (body.message != null ? [body] : [])
  if (!rawEntries.length)
    return json({ error: 'no log entries' }, 400)
  if (rawEntries.length > MAX_BATCH)
    rawEntries.length = MAX_BATCH // silently cap; the SDK batches well under this

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

  // Per-project quota, charged once per batch record so a fat batch can't dodge it.
  const projLimit = await rateLimit(`proj:${projectId}`, PROJECT_LIMIT, RATE_WINDOW_MS, rawEntries.length)
  if (!projLimit.ok)
    return json({ error: 'rate limited' }, 429, { 'Retry-After': String(projLimit.retryAfter) })

  const receivedAt = new Date().toISOString()
  let stored = 0

  for (const raw of rawEntries) {
    if (raw == null || raw.message == null)
      continue

    const level = LEVELS.has(String(raw.level)) ? String(raw.level) : 'info'
    const message = clip(String(raw.message), MAX_MESSAGE)
    // A per-entry key/project in a batch is ignored: the whole batch is already
    // authorized to `projectId`. `user` may arrive top-level or nested; store
    // whichever is present.
    const userContext = raw.user ?? raw.context?.user ?? null

    await db.insertInto('log_entries').values({
      id: randomId(),
      project_id: projectId,
      level: col255(level),
      message,
      channel: col255(raw.channel),
      context: jsonColumn(raw.context),
      environment: col255(raw.environment ?? 'production'),
      release: col255(raw.release),
      framework: col255(raw.framework),
      host: col255(raw.host),
      sdk: jsonColumn(raw.sdk, 4096),
      user_context: jsonColumn(userContext),
      timestamp: col255(raw.timestamp) ?? receivedAt,
    }).execute()
    stored++
  }

  return json({ ok: true, stored }, 201)
}).skipCsrf() // public ingest: SDKs POST cross-origin with no CSRF cookie

// ---------------------------------------------------------------------------
// Stream API (dashboard)
// ---------------------------------------------------------------------------

const STREAM_COLS = 'id, level, message, channel, environment, release, framework, host, timestamp, created_at'

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
  // Full-text-ish search over the message.
  if (q.q) {
    params.push(`%${String(q.q).slice(0, 200)}%`)
    where.push(`message ILIKE $${params.length}`)
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

route.get('/health', () => response.json({ status: 'ok', app: 'loghq' }))
