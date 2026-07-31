import { describe, expect, test } from 'bun:test'
import {
  clip,
  col64,
  col255,
  extractEntries,
  jsonColumn,
  LEVELS,
  MAX_BATCH,
  MAX_CONTEXT_BYTES,
  MAX_CORRELATION,
  MAX_MESSAGE,
  normalizeBatch,
  normalizeEntry,
} from '../../app/Logs/normalize'

/** Deterministic ids so rows can be asserted whole. */
function ctx(projectId = 'demo', receivedAt = '2026-07-30T00:00:00.000Z') {
  let n = 0
  return { projectId, receivedAt, newId: () => `id-${++n}` }
}

describe('clip', () => {
  test('leaves a short string untouched', () => {
    expect(clip('hello', 10)).toBe('hello')
  })

  test('marks the cut when over the limit', () => {
    const out = clip('x'.repeat(20), 10)
    expect(out).toBe(`${'x'.repeat(10)}…[truncated]`)
  })

  test('is exclusive at the boundary — exactly max is not clipped', () => {
    expect(clip('x'.repeat(10), 10)).toBe('x'.repeat(10))
  })
})

describe('col255', () => {
  test('passes null and undefined through as null', () => {
    expect(col255(null)).toBeNull()
    expect(col255(undefined)).toBeNull()
  })

  test('never exceeds 255 chars — the varchar cap Postgres RAISES on', () => {
    const out = col255('a'.repeat(300))
    expect(out).not.toBeNull()
    expect(out!.length).toBe(255)
    expect(out!.endsWith('…')).toBe(true)
  })

  test('leaves exactly 255 alone', () => {
    expect(col255('a'.repeat(255))!.length).toBe(255)
  })

  test('stringifies non-strings', () => {
    expect(col255(42)).toBe('42')
    expect(col255(true)).toBe('true')
  })

  test('preserves empty string rather than nulling it', () => {
    expect(col255('')).toBe('')
  })
})

describe('col64', () => {
  test('passes a 32-hex W3C trace-id through untouched', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    expect(col64(traceId)).toBe(traceId)
  })

  test('never exceeds the varchar(64) column width', () => {
    const out = col64('t'.repeat(200))
    expect(out!.length).toBe(MAX_CORRELATION)
    expect(out!.endsWith('…')).toBe(true)
  })

  test('leaves exactly 64 alone', () => {
    expect(col64('t'.repeat(64))).toBe('t'.repeat(64))
  })

  test('nulls a missing id', () => {
    expect(col64(null)).toBeNull()
    expect(col64(undefined)).toBeNull()
  })
})

describe('jsonColumn', () => {
  test('serializes an object', () => {
    expect(jsonColumn({ a: 1 })).toBe('{"a":1}')
  })

  test('nulls non-objects, empty objects, and empty arrays', () => {
    expect(jsonColumn('a string')).toBeNull()
    expect(jsonColumn(42)).toBeNull()
    expect(jsonColumn(null)).toBeNull()
    expect(jsonColumn({})).toBeNull()
    expect(jsonColumn([])).toBeNull()
  })

  test('replaces an oversized payload wholesale — a half-cut JSON string would not parse', () => {
    const fat = { blob: 'x'.repeat(MAX_CONTEXT_BYTES + 100) }
    const out = jsonColumn(fat)
    expect(out).toBe('{"_truncated":"oversized context dropped"}')
    expect(() => JSON.parse(out!)).not.toThrow()
  })

  test('survives a circular reference instead of failing the row', () => {
    const circular: any = { name: 'loop' }
    circular.self = circular
    expect(jsonColumn(circular)).toBeNull()
  })

  test('survives a BigInt instead of failing the row', () => {
    expect(jsonColumn({ big: BigInt(1) })).toBeNull()
  })

  test('honours a custom max — the sdk column is capped at 4096', () => {
    expect(jsonColumn({ v: 'x'.repeat(5000) }, 4096)).toBe('{"_truncated":"oversized context dropped"}')
  })
})

describe('extractEntries', () => {
  test('reads a batch', () => {
    expect(extractEntries({ logs: [{ message: 'a' }, { message: 'b' }] })).toHaveLength(2)
  })

  test('wraps a single bare entry', () => {
    expect(extractEntries({ message: 'solo' })).toEqual([{ message: 'solo' }])
  })

  test('returns empty for a body with neither', () => {
    expect(extractEntries({})).toEqual([])
    expect(extractEntries({ key: 'loghq_abc' })).toEqual([])
    expect(extractEntries(null)).toEqual([])
    expect(extractEntries(undefined)).toEqual([])
  })

  test('prefers logs[] over a top-level message', () => {
    expect(extractEntries({ logs: [{ message: 'batched' }], message: 'ignored' })).toEqual([{ message: 'batched' }])
  })
})

describe('normalizeEntry', () => {
  test('rejects an entry with no message', () => {
    expect(normalizeEntry({}, ctx())).toBeNull()
    expect(normalizeEntry(null, ctx())).toBeNull()
    expect(normalizeEntry(undefined, ctx())).toBeNull()
  })

  test('accepts all eight RFC 5424 levels verbatim', () => {
    for (const level of LEVELS)
      expect(normalizeEntry({ message: 'm', level }, ctx())!.level).toBe(level)
  })

  test('falls back to info for an unknown level', () => {
    expect(normalizeEntry({ message: 'm', level: 'trace' }, ctx())!.level).toBe('info')
    expect(normalizeEntry({ message: 'm', level: 'success' }, ctx())!.level).toBe('info')
    expect(normalizeEntry({ message: 'm' }, ctx())!.level).toBe('info')
    expect(normalizeEntry({ message: 'm', level: 42 }, ctx())!.level).toBe('info')
  })

  test('clips an oversized message', () => {
    const row = normalizeEntry({ message: 'x'.repeat(MAX_MESSAGE + 500) }, ctx())!
    expect(row.message.endsWith('…[truncated]')).toBe(true)
    expect(row.message.length).toBe(MAX_MESSAGE + '…[truncated]'.length)
  })

  test('bounds every varchar(255) column so the INSERT cannot abort', () => {
    const long = 'a'.repeat(400)
    const row = normalizeEntry(
      { message: 'm', channel: long, environment: long, release: long, framework: long, host: long },
      ctx(),
    )!
    for (const col of [row.channel, row.environment, row.release, row.framework, row.host, row.level, row.timestamp])
      expect(col!.length).toBeLessThanOrEqual(255)
  })

  test('defaults environment to production', () => {
    expect(normalizeEntry({ message: 'm' }, ctx())!.environment).toBe('production')
  })

  test('falls back to the server receive time when no timestamp is sent', () => {
    expect(normalizeEntry({ message: 'm' }, ctx())!.timestamp).toBe('2026-07-30T00:00:00.000Z')
  })

  test('keeps a client-supplied timestamp, even a skewed one', () => {
    const future = '2099-01-01T00:00:00.000Z'
    expect(normalizeEntry({ message: 'm', timestamp: future }, ctx())!.timestamp).toBe(future)
  })

  test('takes user context from the top level', () => {
    const row = normalizeEntry({ message: 'm', user: { id: 8821 } }, ctx())!
    expect(row.user_context).toBe('{"id":8821}')
  })

  test('falls back to context.user when there is no top-level user', () => {
    const row = normalizeEntry({ message: 'm', context: { user: { id: 7 } } }, ctx())!
    expect(row.user_context).toBe('{"id":7}')
  })

  test('prefers the top-level user over context.user', () => {
    const row = normalizeEntry({ message: 'm', user: { id: 1 }, context: { user: { id: 2 } } }, ctx())!
    expect(row.user_context).toBe('{"id":1}')
  })

  test('stamps the project from the context, ignoring any per-entry project or key', () => {
    const row = normalizeEntry({ message: 'm', project: 'other', key: 'loghq_evil' }, ctx('demo'))!
    expect(row.project_id).toBe('demo')
  })

  test('coerces a non-string message rather than dropping it', () => {
    expect(normalizeEntry({ message: 42 }, ctx())!.message).toBe('42')
  })

  test('leaves correlation ids null when the client sends none', () => {
    const row = normalizeEntry({ message: 'm' }, ctx())!
    expect(row.trace_id).toBeNull()
    expect(row.request_id).toBeNull()
  })

  test('accepts correlation ids in wire casing', () => {
    const row = normalizeEntry({ message: 'm', trace_id: 'abc123', request_id: 'req-9' }, ctx())!
    expect(row.trace_id).toBe('abc123')
    expect(row.request_id).toBe('req-9')
  })

  test('accepts correlation ids in idiomatic JS casing', () => {
    const row = normalizeEntry({ message: 'm', traceId: 'abc123', requestId: 'req-9' }, ctx())!
    expect(row.trace_id).toBe('abc123')
    expect(row.request_id).toBe('req-9')
  })

  test('prefers wire casing when both are sent', () => {
    const row = normalizeEntry({ message: 'm', trace_id: 'wire', traceId: 'js' }, ctx())!
    expect(row.trace_id).toBe('wire')
  })

  test('bounds a hostile correlation id to the column width', () => {
    // trace_id arrives over public ingest — untrusted, and varchar(64) RAISES.
    const row = normalizeEntry({ message: 'm', trace_id: 'x'.repeat(5000) }, ctx())!
    expect(row.trace_id!.length).toBe(MAX_CORRELATION)
  })
})

describe('normalizeBatch', () => {
  test('shapes every usable entry', () => {
    const out = normalizeBatch({ logs: [{ message: 'a' }, { message: 'b' }] }, ctx())
    expect(out.rows).toHaveLength(2)
    expect(out.rows.map(r => r.id)).toEqual(['id-1', 'id-2'])
    expect(out.dropped).toBe(0)
    expect(out.skipped).toBe(0)
  })

  test('counts entries past MAX_BATCH as dropped instead of silently trimming', () => {
    const logs = Array.from({ length: MAX_BATCH + 100 }, (_, i) => ({ message: `m${i}` }))
    const out = normalizeBatch({ logs }, ctx())
    expect(out.rows).toHaveLength(MAX_BATCH)
    expect(out.dropped).toBe(100)
    expect(out.skipped).toBe(0)
  })

  test('counts unusable entries as skipped', () => {
    const out = normalizeBatch({ logs: [{ message: 'ok' }, {}, null, { level: 'error' }] }, ctx())
    expect(out.rows).toHaveLength(1)
    expect(out.skipped).toBe(3)
    expect(out.dropped).toBe(0)
  })

  test('reports dropped and skipped independently', () => {
    const logs: any[] = Array.from({ length: MAX_BATCH }, (_, i) => (i % 2 === 0 ? { message: `m${i}` } : {}))
    logs.push(...Array.from({ length: 10 }, () => ({ message: 'overflow' })))
    const out = normalizeBatch({ logs }, ctx())
    expect(out.rows).toHaveLength(MAX_BATCH / 2)
    expect(out.skipped).toBe(MAX_BATCH / 2)
    expect(out.dropped).toBe(10)
  })

  test('handles a single bare entry', () => {
    const out = normalizeBatch({ message: 'solo', level: 'error' }, ctx())
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0].level).toBe('error')
  })

  test('returns nothing for an empty body', () => {
    expect(normalizeBatch({}, ctx())).toEqual({ rows: [], dropped: 0, skipped: 0 })
  })

  test('every row carries the full column set, so a multi-row INSERT stays uniform', () => {
    const out = normalizeBatch({ logs: [{ message: 'a' }, { message: 'b', channel: 'billing' }] }, ctx())
    const [first, second] = out.rows
    expect(Object.keys(first).sort()).toEqual(Object.keys(second).sort())
  })
})
