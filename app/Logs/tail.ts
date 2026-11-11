/**
 * The live tail: a project's stream as Server-Sent Events.
 *
 * There is no pub/sub underneath. Each open tail polls the same forward query
 * `GET /api/projects/{id}/logs?after=` runs (app/Logs/query.ts), which is why
 * the two cannot disagree about filters or order, and why a tail survives the
 * API restarting: the client reconnects with the id of the last event it saw
 * and the next poll starts there. One indexed query a second per open tail is
 * what that costs, and the caps below bound how many there can be.
 *
 * The loop takes its database read and its clock as arguments so
 * tests/unit/logs-tail.test.ts can drive it without a server or a sleep.
 */
import type { ForwardCursor } from './query'
import { cursorOf, decodeCursor, MAX_PAGE } from './query'

/** How often an idle tail looks for new entries. */
export const POLL_MS = 1000
/**
 * How often a quiet tail says so. Bun closes a connection that has been silent
 * for ten seconds by default and proxies do the same on their own clocks, so
 * this stays well inside the shortest of them.
 */
export const HEARTBEAT_MS = 5000
/**
 * How long one connection lives. A tail ends itself after this and the client
 * reconnects from its last event id, so a revoked credential, a removed member
 * or a forgotten browser tab cannot hold a stream open indefinitely.
 */
export const MAX_TAIL_MS = 15 * 60_000
/** How often an open tail re-checks that its credential may still read the project. */
export const REAUTHORIZE_MS = 30_000
/** What a client is told to wait before reconnecting. */
export const RETRY_MS = 2000

export const MAX_TAILS_PER_PROJECT = 25
export const MAX_TAILS_TOTAL = 500

export interface SseEvent {
  event?: string
  id?: string
  data?: unknown
  retry?: number
}

/**
 * One event in the wire format. `data` is JSON on a single line: JSON.stringify
 * escapes newlines, so a log message can never end the event early or start a
 * forged one.
 */
export function sseEvent(e: SseEvent): string {
  let out = ''
  if (e.retry != null)
    out += `retry: ${Math.max(0, Math.floor(e.retry))}\n`
  if (e.event)
    out += `event: ${e.event.replace(/[\r\n]/g, '')}\n`
  if (e.id)
    out += `id: ${e.id.replace(/[\r\n]/g, '')}\n`
  if (e.data !== undefined)
    out += `data: ${JSON.stringify(e.data)}\n`
  return `${out}\n`
}

/** A comment line: ignored by every SSE parser, and enough traffic to keep the connection open. */
export function sseComment(text: string): string {
  return `: ${text.replace(/[\r\n]/g, ' ')}\n\n`
}

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // no-transform as well as no-cache: a proxy that compresses or rewrites the
  // body has to buffer it first, and a buffered tail delivers nothing.
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  // nginx-style proxies buffer responses unless told otherwise.
  'X-Accel-Buffering': 'no',
}

/**
 * Where a tail starts: the `Last-Event-ID` a reconnecting client sends, else
 * `after`, else null for "from now". The header wins because it is newer by
 * construction: the browser's EventSource replays the original URL, `after`
 * included, on every reconnect.
 *
 * `invalid` is separate from null so a mangled cursor is refused instead of
 * silently restarting the stream at the present and hiding a gap.
 */
export function tailStart(lastEventId: unknown, after: unknown): { ok: true, cursor: ForwardCursor | null } | { ok: false } {
  for (const value of [lastEventId, after]) {
    if (value == null || value === '')
      continue
    const cursor = decodeCursor(String(value))
    return cursor ? { ok: true, cursor } : { ok: false }
  }
  return { ok: true, cursor: null }
}

// ---------------------------------------------------------------------------
// Connection caps
// ---------------------------------------------------------------------------

const open = new Map<string, number>()
let openTotal = 0

/** Claim a slot for one tail, or null when the project or the process is full. The returned function gives it back, once. */
export function claimTail(projectId: string): (() => void) | null {
  const current = open.get(projectId) ?? 0
  if (current >= MAX_TAILS_PER_PROJECT || openTotal >= MAX_TAILS_TOTAL)
    return null
  open.set(projectId, current + 1)
  openTotal++
  let released = false
  return () => {
    if (released)
      return
    released = true
    openTotal--
    const left = (open.get(projectId) ?? 1) - 1
    if (left <= 0)
      open.delete(projectId)
    else
      open.set(projectId, left)
  }
}

export function openTails(projectId?: string): number {
  return projectId == null ? openTotal : open.get(projectId) ?? 0
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

export interface TailOptions {
  /** Where to start. Entries strictly after this are sent. */
  start: ForwardCursor
  /** Entries after `cursor`, oldest first, at most `limit`. */
  fetchAfter: (cursor: ForwardCursor, limit: number) => Promise<Array<Record<string, unknown>>>
  /** Whether the credential that opened the tail may still read the project. */
  authorize?: () => Promise<boolean>
  /** Called exactly once when the stream ends, however it ends. */
  onClose?: () => void
  /** Aborts when the client goes away. */
  signal?: AbortSignal
  pollMs?: number
  heartbeatMs?: number
  maxMs?: number
  reauthorizeMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * The body of a tail response.
 *
 * Events: `log` (data is one entry, id is the cursor to resume after it) and
 * `end` (data is `{ reason }`; the server is closing and the client should
 * reconnect unless the reason is `unauthorized`). Comments are heartbeats.
 */
export function tailStream(options: TailOptions): ReadableStream<Uint8Array> {
  const pollMs = options.pollMs ?? POLL_MS
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const maxMs = options.maxMs ?? MAX_TAIL_MS
  const reauthorizeMs = options.reauthorizeMs ?? REAUTHORIZE_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const encoder = new TextEncoder()

  let closed = false
  const finish = (): void => {
    if (closed)
      return
    closed = true
    options.signal?.removeEventListener('abort', finish)
    options.onClose?.()
  }
  options.signal?.addEventListener('abort', finish)
  if (options.signal?.aborted)
    finish()

  async function run(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    const send = (text: string): void => {
      if (!closed)
        controller.enqueue(encoder.encode(text))
    }
    const end = (reason: string): void => {
      send(sseEvent({ event: 'end', data: { reason } }))
    }

    let cursor = options.start
    const startedAt = now()
    let lastSent = startedAt
    let lastAuthorized = startedAt

    // Sent at once, so the client's fetch resolves and a proxy has bytes to
    // forward before the first entry exists.
    send(sseEvent({ retry: RETRY_MS }) + sseComment('connected'))

    try {
      while (!closed) {
        if (now() - startedAt >= maxMs) {
          end('max-duration')
          break
        }
        if (options.authorize && now() - lastAuthorized >= reauthorizeMs) {
          lastAuthorized = now()
          if (!(await options.authorize())) {
            end('unauthorized')
            break
          }
        }

        // A reader that is not draining gets nothing new queued behind what it
        // already has. The cursor does not move, so nothing is lost: it just
        // arrives when they catch up.
        const backedUp = (controller.desiredSize ?? 1) <= 0
        const rows = backedUp ? [] : await options.fetchAfter(cursor, MAX_PAGE)
        if (closed)
          break
        for (const row of rows) {
          const id = cursorOf(row as { created_at: unknown, id: unknown })
          send(sseEvent({ event: 'log', id, data: row }))
          cursor = decodeCursor(id) ?? cursor
        }
        if (rows.length) {
          lastSent = now()
          // A full page means there is more waiting: read on without sleeping.
          if (rows.length >= MAX_PAGE)
            continue
        }
        else if (now() - lastSent >= heartbeatMs) {
          send(sseComment('ping'))
          lastSent = now()
        }
        await sleep(pollMs)
      }
    }
    catch {
      // A failed read ends this connection and the client reconnects from its
      // last event id. Retrying in place would hide a database that is down
      // behind a stream that merely looks quiet.
      end('error')
    }
    finally {
      const wasOpen = !closed
      finish()
      if (wasOpen) {
        try {
          controller.close()
        }
        catch {}
      }
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      void run(controller)
    },
    cancel() {
      finish()
    },
  // Counted in bytes, with room for a burst. The default strategy counts chunks
  // with a mark of one, which would read as "backed up" after every event.
  }, { highWaterMark: 1 << 20, size: chunk => chunk.byteLength })
}
