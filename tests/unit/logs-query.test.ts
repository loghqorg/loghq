/**
 * The stream's filters and forward cursor, executed against a real SQLite.
 *
 * The SQL is run rather than string-matched: the forward read is only worth
 * having if it returns every entry exactly once, and that is a property of
 * what the database answers.
 */
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cursorAtHorizon,
  cursorOf,
  decodeCursor,
  encodeCursor,
  type ForwardCursor,
  forwardQuery,
  MAX_PAGE,
  newEntryId,
  pageLimit,
  receiveStamp,
  SETTLE_MS,
  settledHorizon,
  streamFilters,
} from '../../app/Logs/query'

const ROOT = join(import.meta.dir, '..', '..')
const LATER = new Date('2026-11-11T12:00:00.000Z')
const START: ForwardCursor = { createdAt: '2000-01-01 00:00:00', id: '' }

interface Seed {
  id: string
  created_at: string
  project_id?: string
  level?: string
  message?: string
  channel?: string | null
  environment?: string
  trace_id?: string | null
  request_id?: string | null
  timestamp?: string
}

function database(seeds: Seed[]): Database {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE log_entries (
    id varchar(255) PRIMARY KEY, project_id varchar(255) NOT NULL, level varchar(255), message text NOT NULL,
    channel varchar(255), context text, environment varchar(255), release varchar(255), framework varchar(255),
    host varchar(255), sdk text, user_context text, timestamp varchar(255) NOT NULL,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamp, trace_id varchar(64), request_id varchar(64)
  )`)
  const insert = db.prepare(`INSERT INTO log_entries (id, project_id, level, message, channel, environment, timestamp, created_at, trace_id, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const s of seeds) {
    insert.run(
      s.id,
      s.project_id ?? 'demo',
      s.level ?? 'info',
      s.message ?? `message ${s.id}`,
      s.channel ?? null,
      s.environment ?? 'production',
      s.timestamp ?? '2026-11-11T10:00:00.000Z',
      s.created_at,
      s.trace_id ?? null,
      s.request_id ?? null,
    )
  }
  return db
}

/** db.unsafe takes `$n` placeholders; bun:sqlite takes `?n`. Same statement, same order. */
function run(db: Database, built: { sql: string, params: unknown[] }): any[] {
  return db.prepare(built.sql.replace(/\$(\d+)/g, '?$1')).all(...(built.params as any[]))
}

function readAll(db: Database, query: Record<string, unknown>, limit: number, now = LATER): string[] {
  const filters = streamFilters('demo', query)
  const seen: string[] = []
  let cursor = START
  for (let page = 0; page < 100; page++) {
    const rows = run(db, forwardQuery(filters, cursor, limit, now))
    if (!rows.length)
      break
    for (const row of rows)
      seen.push(row.id)
    cursor = decodeCursor(cursorOf(rows[rows.length - 1]))!
  }
  return seen
}

describe('cursor', () => {
  test('round-trips a stamp and an id', () => {
    const cursor = { createdAt: '2026-11-11 09:30:00.123', id: 'b1f6-uuid' }
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  test('accepts the whole-second stamp older rows carry', () => {
    expect(decodeCursor(encodeCursor({ createdAt: '2026-03-03 00:00:00', id: 'x' }))?.createdAt).toBe('2026-03-03 00:00:00')
  })

  test('refuses anything it did not mint', () => {
    for (const value of [
      '',
      null,
      undefined,
      42,
      'not base64 at all!',
      Buffer.from('no separator').toString('base64url'),
      Buffer.from('2026-11-11T09:30:00.123Z\nid').toString('base64url'),
      Buffer.from(`2026-11-11 09:30:00' OR 1=1 --\nid`).toString('base64url'),
      Buffer.from('2026-11-11 09:30:00\nid\nextra').toString('base64url'),
      'A'.repeat(600),
    ])
      expect(decodeCursor(value)).toBeNull()
  })

  test('is a bound value, never SQL', () => {
    const built = forwardQuery(streamFilters('demo', {}), { createdAt: '2026-11-11 09:30:00', id: `x'; DROP TABLE log_entries; --` }, 10, LATER)
    expect(built.sql).not.toContain('DROP')
    expect(built.params).toContain(`x'; DROP TABLE log_entries; --`)
  })
})

describe('receiveStamp', () => {
  test('keeps milliseconds in the created_at shape', () => {
    expect(receiveStamp(new Date('2026-11-11T09:30:07.045Z'))).toBe('2026-11-11 09:30:07.045')
  })

  test('sorts after the whole-second rows stored before it existed', () => {
    const legacy = '2026-11-11 09:30:07'
    expect(legacy < receiveStamp(new Date('2026-11-11T09:30:07.000Z'))).toBe(true)
    expect(receiveStamp(new Date('2026-11-11T09:30:06.999Z')) < legacy).toBe(true)
  })
})

describe('newEntryId', () => {
  test('sorts in the order it was minted, so a batch reads back in the order it was sent', () => {
    const ids = Array.from({ length: 500 }, () => newEntryId())
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(500)
  })

  test('a batch stored under one stamp is read forward in sent order', () => {
    const stamp = '2026-11-11 09:00:01.000'
    const sent = Array.from({ length: 7 }, (_, i) => ({ id: newEntryId(), created_at: stamp, message: `line ${i}` }))
    const db = database(sent)
    expect(readAll(db, {}, 3)).toEqual(sent.map(s => s.id))
  })
})

describe('forward read', () => {
  test('returns every entry once, oldest first, across pages', () => {
    const db = database([
      { id: 'c', created_at: '2026-11-11 09:00:02.000' },
      { id: 'a', created_at: '2026-11-11 09:00:01.000' },
      { id: 'b', created_at: '2026-11-11 09:00:01.500' },
      { id: 'e', created_at: '2026-11-11 09:00:04.000' },
      { id: 'd', created_at: '2026-11-11 09:00:03.000' },
    ])
    expect(readAll(db, {}, 2)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  test('a batch sharing one stamp is not split or repeated at a page edge', () => {
    // One INSERT stamps every row alike, so the id is the only thing ordering
    // them: a page ending mid-batch must resume mid-batch.
    const stamp = '2026-11-11 09:00:01.000'
    const ids = ['m3', 'm1', 'm5', 'm2', 'm4']
    const db = database(ids.map(id => ({ id, created_at: stamp })))
    expect(readAll(db, {}, 2)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
  })

  test('follows arrival, so a late batch with old timestamps is still delivered', () => {
    const db = database([{ id: 'first', created_at: '2026-11-11 09:00:05.000', timestamp: '2026-11-11T09:00:05.000Z' }])
    const filters = streamFilters('demo', {})
    const page = run(db, forwardQuery(filters, START, 10, LATER))
    const cursor = decodeCursor(cursorOf(page[0]))!

    // Buffered on a client for a minute: reported time is before the cursor's
    // entry, arrival is after it.
    db.run(`INSERT INTO log_entries (id, project_id, message, timestamp, created_at) VALUES ('late', 'demo', 'm', '2026-11-11T08:59:00.000Z', '2026-11-11 09:00:09.000')`)
    expect(run(db, forwardQuery(filters, cursor, 10, LATER)).map(r => r.id)).toEqual(['late'])
  })

  test('reads on from a whole-second row into millisecond rows', () => {
    const db = database([
      { id: 'old-1', created_at: '2026-11-11 09:00:01' },
      { id: 'old-2', created_at: '2026-11-11 09:00:01' },
      { id: 'new-1', created_at: '2026-11-11 09:00:01.200' },
      { id: 'new-2', created_at: '2026-11-11 09:00:02.000' },
    ])
    expect(readAll(db, {}, 1)).toEqual(['old-1', 'old-2', 'new-1', 'new-2'])
  })

  test('stops at the settled horizon and picks the rest up later', () => {
    const now = new Date('2026-11-11T09:00:10.000Z')
    const db = database([
      { id: 'settled', created_at: receiveStamp(new Date(now.getTime() - SETTLE_MS - 1)) },
      { id: 'landing', created_at: receiveStamp(new Date(now.getTime() - 5)) },
    ])
    expect(readAll(db, {}, 10, now)).toEqual(['settled'])
    expect(readAll(db, {}, 10, new Date(now.getTime() + SETTLE_MS))).toEqual(['settled', 'landing'])
  })

  test('a cursor at the present is ahead of everything settled and behind everything after', () => {
    const now = new Date('2026-11-11T09:00:10.000Z')
    const cursor = cursorAtHorizon(now)
    expect(cursor.createdAt).toBe(settledHorizon(now))
    const db = database([
      { id: 'before', created_at: receiveStamp(new Date(now.getTime() - SETTLE_MS - 1)) },
      // Same millisecond as the horizon: the empty id sorts first, so it is still ahead.
      { id: 'at', created_at: settledHorizon(now) },
      { id: 'after', created_at: receiveStamp(new Date(now.getTime() + 20)) },
    ])
    expect(run(db, forwardQuery(streamFilters('demo', {}), cursor, 10, LATER)).map(r => r.id)).toEqual(['at', 'after'])
  })

  test('never crosses into another project', () => {
    const db = database([
      { id: 'mine', created_at: '2026-11-11 09:00:01.000' },
      { id: 'theirs', created_at: '2026-11-11 09:00:02.000', project_id: 'other' },
    ])
    expect(readAll(db, {}, 10)).toEqual(['mine'])
  })
})

describe('filters apply to the forward read exactly as to the page', () => {
  const seeds: Seed[] = [
    { id: '1', created_at: '2026-11-11 09:00:01.000', level: 'error', channel: 'queue', environment: 'production', message: 'Job TIMEOUT after 30s', trace_id: 't1', request_id: 'r1' },
    { id: '2', created_at: '2026-11-11 09:00:02.000', level: 'info', channel: 'http', environment: 'staging', message: 'GET /health', trace_id: 't1' },
    { id: '3', created_at: '2026-11-11 09:00:03.000', level: 'critical', channel: 'queue', environment: 'production', message: 'worker died', request_id: 'r1' },
    { id: '4', created_at: '2026-11-11 09:00:04.000', level: 'debug', channel: 'http', environment: 'production', message: 'timeout budget 5s' },
  ]

  test.each([
    [{ level: 'error' }, ['1']],
    [{ level: 'error, CRITICAL' }, ['1', '3']],
    [{ level: 'nonsense' }, ['1', '2', '3', '4']],
    [{ channel: 'http' }, ['2', '4']],
    [{ environment: 'staging' }, ['2']],
    [{ trace: 't1' }, ['1', '2']],
    [{ request: 'r1' }, ['1', '3']],
    [{ q: 'timeout' }, ['1', '4']],
    [{ q: 'TIMEOUT', channel: 'queue' }, ['1']],
    [{ level: 'error,critical', environment: 'production', request: 'r1' }, ['1', '3']],
  ] as Array<[Record<string, unknown>, string[]]>)('%j', (query, expected) => {
    expect(readAll(database(seeds), query, 2)).toEqual(expected)
  })

  test('a search term is matched literally, not as SQL', () => {
    expect(readAll(database(seeds), { q: `' OR '1'='1` }, 10)).toEqual([])
  })
})

describe('pageLimit', () => {
  test('clamps to the page maximum and falls back on nonsense', () => {
    expect(pageLimit(undefined)).toBe(100)
    expect(pageLimit('5')).toBe(5)
    expect(pageLimit(0)).toBe(100)
    expect(pageLimit(-3)).toBe(1)
    expect(pageLimit(100000)).toBe(MAX_PAGE)
    expect(pageLimit('abc')).toBe(100)
  })
})

describe('migration 26', () => {
  const sql = readFileSync(join(ROOT, 'database/migrations/0000000026-create-read_tokens-and-forward-index.sql'), 'utf8')

  test('runs on SQLite and gives the forward read its index', () => {
    const db = database([{ id: 'a', created_at: '2026-11-11 09:00:01.000' }])
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, email varchar(255))')
    db.exec(sql)
    const built = forwardQuery(streamFilters('demo', {}), START, 50, LATER)
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${built.sql.replace(/\$(\d+)/g, '?$1')}`).all(...(built.params as any[])) as Array<{ detail: string }>
    const detail = plan.map(p => p.detail).join(' | ')
    expect(detail).toContain('log_entries_le_project_created')
    // Served in index order: no sort of the project's stream on every poll.
    expect(detail).not.toContain('TEMP B-TREE')
  })

  test('stores one row per token hash', () => {
    const db = new Database(':memory:')
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, email varchar(255))')
    db.run('CREATE TABLE log_entries (id varchar(255) PRIMARY KEY, project_id varchar(255), created_at timestamp)')
    db.exec(sql)
    db.run(`INSERT INTO users (id, email) VALUES (1, 'a@example.com')`)
    db.run(`INSERT INTO read_tokens (id, user_id, name, token_hash) VALUES ('rtk_1', 1, 'laptop', 'abc')`)
    expect(() => db.run(`INSERT INTO read_tokens (id, user_id, name, token_hash) VALUES ('rtk_2', 1, 'desktop', 'abc')`)).toThrow()
  })
})
