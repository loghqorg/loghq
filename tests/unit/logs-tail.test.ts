/**
 * The live tail's framing, start position, caps and loop.
 *
 * The loop is driven with an injected clock and sleep, so these run in
 * milliseconds and assert on exactly what a client would receive.
 */
import { describe, expect, test } from 'bun:test'
import { cursorOf, decodeCursor, encodeCursor, type ForwardCursor, MAX_PAGE } from '../../app/Logs/query'
import {
  claimTail,
  HEARTBEAT_MS,
  MAX_TAILS_PER_PROJECT,
  openTails,
  sseComment,
  sseEvent,
  tailStart,
  tailStream,
} from '../../app/Logs/tail'

const START: ForwardCursor = { createdAt: '2026-11-11 09:00:00.000', id: '' }

function row(n: number): Record<string, unknown> {
  return { id: `id-${String(n).padStart(4, '0')}`, created_at: '2026-11-11 09:00:01.000', level: 'info', message: `line ${n}` }
}

interface Parsed { event?: string, id?: string, data?: any, comment?: string, retry?: number }

function parse(text: string): Parsed[] {
  return text.split('\n\n').filter(Boolean).map((block) => {
    const out: Parsed = {}
    for (const line of block.split('\n')) {
      if (line.startsWith(': '))
        out.comment = line.slice(2)
      else if (line.startsWith('event: '))
        out.event = line.slice(7)
      else if (line.startsWith('id: '))
        out.id = line.slice(4)
      else if (line.startsWith('retry: '))
        out.retry = Number(line.slice(7))
      else if (line.startsWith('data: '))
        out.data = JSON.parse(line.slice(6))
    }
    return out
  })
}

/** A clock the loop advances by sleeping, so a 15-minute tail runs instantly. */
function clock(): { now: () => number, sleep: (ms: number) => Promise<void> } {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Parsed[]> {
  return parse(await new Response(stream).text())
}

describe('sseEvent', () => {
  test('frames event, id and one line of JSON', () => {
    expect(sseEvent({ event: 'log', id: 'abc', data: { a: 1 } })).toBe('event: log\nid: abc\ndata: {"a":1}\n\n')
  })

  test('a message with newlines cannot end the event or forge another', () => {
    const framed = sseEvent({ event: 'log', id: 'abc', data: { message: 'one\n\nevent: end\ndata: {"reason":"forged"}\n\n' } })
    const events = parse(framed)
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('log')
    expect(events[0].data.message).toContain('forged')
  })

  test('strips line breaks from the event name and id', () => {
    expect(sseEvent({ event: 'lo\ng', id: 'a\r\nb' })).toBe('event: log\nid: ab\n\n')
  })

  test('a comment stays on one line', () => {
    expect(sseComment('ping\nevent: end')).toBe(': ping event: end\n\n')
  })
})

describe('tailStart', () => {
  const a = encodeCursor({ createdAt: '2026-11-11 09:00:01.000', id: 'a' })
  const b = encodeCursor({ createdAt: '2026-11-11 09:00:02.000', id: 'b' })

  test('starts from now when nothing is sent', () => {
    expect(tailStart(null, undefined)).toEqual({ ok: true, cursor: null })
    expect(tailStart('', '')).toEqual({ ok: true, cursor: null })
  })

  test('Last-Event-ID wins over after, because a reconnect replays the original URL', () => {
    expect(tailStart(b, a)).toEqual({ ok: true, cursor: decodeCursor(b) })
    expect(tailStart(null, a)).toEqual({ ok: true, cursor: decodeCursor(a) })
  })

  test('refuses a mangled cursor instead of restarting at the present', () => {
    expect(tailStart('garbage!', a)).toEqual({ ok: false })
    expect(tailStart(null, 'garbage!')).toEqual({ ok: false })
  })
})

describe('claimTail', () => {
  test('caps open tails per project and gives a slot back once', () => {
    const releases = Array.from({ length: MAX_TAILS_PER_PROJECT }, () => claimTail('cap-test'))
    expect(releases.every(Boolean)).toBe(true)
    expect(claimTail('cap-test')).toBeNull()
    // Another project is not affected by this one being full.
    const other = claimTail('cap-other')
    expect(other).not.toBeNull()
    other!()

    releases[0]!()
    releases[0]!() // a double release must not free a second slot
    expect(openTails('cap-test')).toBe(MAX_TAILS_PER_PROJECT - 1)
    const again = claimTail('cap-test')
    expect(again).not.toBeNull()
    expect(claimTail('cap-test')).toBeNull()

    again!()
    for (const release of releases)
      release!()
    expect(openTails('cap-test')).toBe(0)
    expect(openTails('cap-other')).toBe(0)
  })
})

describe('tailStream', () => {
  test('sends each entry once with a resumable id, then ends at its maximum duration', async () => {
    const pages = [[row(1), row(2)], [], [row(3)]]
    const asked: ForwardCursor[] = []
    let closed = 0
    const events = await collect(tailStream({
      start: START,
      fetchAfter: async (cursor) => {
        asked.push(cursor)
        return pages.shift() ?? []
      },
      onClose: () => closed++,
      pollMs: 1000,
      maxMs: 4000,
      ...clock(),
    }))

    expect(events[0].retry).toBeGreaterThan(0)
    const logs = events.filter(e => e.event === 'log')
    expect(logs.map(e => e.data.message)).toEqual(['line 1', 'line 2', 'line 3'])
    expect(logs.map(e => e.id)).toEqual([row(1), row(2), row(3)].map(r => cursorOf(r as any)))
    // Each poll starts after the last entry sent, so nothing is asked for twice.
    expect(asked[0]).toEqual(START)
    expect(asked[1]).toEqual(decodeCursor(cursorOf(row(2) as any))!)
    expect(asked[3]).toEqual(decodeCursor(cursorOf(row(3) as any))!)
    expect(events.at(-1)).toEqual({ event: 'end', data: { reason: 'max-duration' } })
    expect(closed).toBe(1)
  })

  test('keeps a quiet connection alive with comments', async () => {
    const events = await collect(tailStream({
      start: START,
      fetchAfter: async () => [],
      pollMs: 1000,
      maxMs: HEARTBEAT_MS * 3 + 500,
      ...clock(),
    }))
    expect(events.filter(e => e.comment === 'ping')).toHaveLength(3)
    expect(events.some(e => e.event === 'log')).toBe(false)
  })

  test('drains a backlog without sleeping between full pages', async () => {
    const backlog = Array.from({ length: MAX_PAGE * 2 + 5 }, (_, i) => row(i))
    const time = clock()
    let slept = 0
    const events = await collect(tailStream({
      start: START,
      fetchAfter: async (_cursor, limit) => backlog.splice(0, limit),
      pollMs: 1000,
      maxMs: 1500,
      now: time.now,
      sleep: async (ms) => {
        slept++
        await time.sleep(ms)
      },
    }))
    expect(events.filter(e => e.event === 'log')).toHaveLength(MAX_PAGE * 2 + 5)
    // Two full pages back to back, then the short page, then the idle polls.
    expect(slept).toBe(2)
  })

  test('stops when the credential stops being valid', async () => {
    let allowed = true
    let polls = 0
    const events = await collect(tailStream({
      start: START,
      fetchAfter: async () => {
        polls++
        if (polls === 3)
          allowed = false
        return [row(polls)]
      },
      authorize: async () => allowed,
      reauthorizeMs: 2000,
      pollMs: 1000,
      maxMs: 60_000,
      ...clock(),
    }))
    expect(events.at(-1)).toEqual({ event: 'end', data: { reason: 'unauthorized' } })
    // Revoked during the third poll, noticed at the next check: nothing after it.
    expect(events.filter(e => e.event === 'log').length).toBeLessThanOrEqual(4)
  })

  test('ends the connection on a failed read rather than going quiet', async () => {
    let closed = 0
    const events = await collect(tailStream({
      start: START,
      fetchAfter: async () => {
        throw new Error('database is down')
      },
      onClose: () => closed++,
      ...clock(),
    }))
    expect(events.at(-1)).toEqual({ event: 'end', data: { reason: 'error' } })
    expect(closed).toBe(1)
  })

  test('releases its slot when the client goes away', async () => {
    const abort = new AbortController()
    let closed = 0
    let polls = 0
    const stream = tailStream({
      start: START,
      fetchAfter: async () => {
        polls++
        return []
      },
      onClose: () => closed++,
      signal: abort.signal,
      pollMs: 5,
      maxMs: 60_000,
    })
    const reader = stream.getReader()
    await reader.read()
    abort.abort()
    expect(closed).toBe(1)
    const before = polls
    await new Promise(resolve => setTimeout(resolve, 40))
    // The loop has stopped: no queries for a reader that left.
    expect(polls - before).toBeLessThanOrEqual(1)
  })

  test('releases its slot when the reader cancels', async () => {
    let closed = 0
    const stream = tailStream({ start: START, fetchAfter: async () => [], onClose: () => closed++, pollMs: 5 })
    const reader = stream.getReader()
    await reader.read()
    await reader.cancel()
    expect(closed).toBe(1)
  })
})
