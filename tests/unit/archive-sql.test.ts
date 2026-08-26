/**
 * The archive builds SQL as text, so this is where the escaping is held down.
 *
 * Every other query in loghq binds its values as `$n` parameters and the driver
 * keeps data and code apart. The DuckDB CLI takes a script on stdin and offers
 * no binding at all, so app/Archive/sql.ts has to do that job itself, and these
 * tests are the proof it does: a filter that arrives from a dashboard query
 * string reaches DuckDB as an inert literal or not at all.
 */
import { describe, expect, test } from 'bun:test'
import {
  ARCHIVE_COLUMNS,
  buildExportSql,
  buildLevelsByReleaseSql,
  buildSearchSql,
  buildVerifySql,
  buildVolumeSql,
  clampLimit,
  ISO_DAY,
  ISO_TS,
  MAX_LITERAL,
  nextDay,
  SAFE_ID,
  safeDay,
  safeKey,
  sqlQuote,
} from '../../app/Archive/sql'

const BUCKET = 'loghq-archive'
const KEYS = ['logs/project_id=demo/date=2026-07-27/part-000.parquet']

describe('sqlQuote', () => {
  test('wraps a plain value in single quotes', () => {
    expect(sqlQuote('billing')).toBe('\'billing\'')
  })

  test('doubles an embedded quote rather than escaping with a backslash', () => {
    // Backslash escapes are not universal in SQL. Doubling is.
    expect(sqlQuote('it\'s')).toBe('\'it\'\'s\'')
  })

  test('renders a classic injection payload as one inert literal', () => {
    const out = sqlQuote('x\'; DROP TABLE log_entries; --')
    expect(out).toBe('\'x\'\'; DROP TABLE log_entries; --\'')
    // The dangerous reading requires an odd number of quotes. Count them.
    expect((out.match(/'/g) ?? []).length % 2).toBe(0)
  })

  test('rejects a newline, which would break the one-statement convention', () => {
    expect(() => sqlQuote('a\nb')).toThrow(/control character/)
  })

  test('rejects a NUL, which truncates the script inside the CLI', () => {
    expect(() => sqlQuote('a\0b')).toThrow(/control character/)
  })

  test('rejects DEL as well as the low control range', () => {
    expect(() => sqlQuote(`a\x7Fb`)).toThrow(/control character/)
  })

  test('rejects an over-long literal', () => {
    expect(() => sqlQuote('x'.repeat(MAX_LITERAL + 1))).toThrow(/exceeds/)
  })

  test('accepts a literal exactly at the limit', () => {
    expect(() => sqlQuote('x'.repeat(MAX_LITERAL))).not.toThrow()
  })

  test('passes unicode through untouched', () => {
    expect(sqlQuote('naïve 日本語 🙂')).toBe('\'naïve 日本語 🙂\'')
  })
})

describe('validators', () => {
  test('ISO_DAY accepts a real day and rejects a crafted one', () => {
    expect(ISO_DAY.test('2026-07-27')).toBe(true)
    expect(ISO_DAY.test('2026-07-27\' OR 1=1')).toBe(false)
    expect(ISO_DAY.test('2026-7-7')).toBe(false)
  })

  test('safeDay throws rather than passing an invalid day through', () => {
    expect(() => safeDay('2026-07-27')).not.toThrow()
    expect(() => safeDay('\' OR 1=1 --')).toThrow(/invalid day/)
  })

  test('ISO_TS accepts the shape log_entries.timestamp holds', () => {
    expect(ISO_TS.test('2026-07-27T13:45:12.345Z')).toBe(true)
    expect(ISO_TS.test('2026-07-27T13:45:12Z')).toBe(true)
    expect(ISO_TS.test('yesterday')).toBe(false)
  })

  test('SAFE_ID rejects anything with quoting potential', () => {
    expect(SAFE_ID.test('demo-a1b2c3')).toBe(true)
    expect(SAFE_ID.test('a\'b')).toBe(false)
    expect(SAFE_ID.test('a b')).toBe(false)
  })

  test('safeKey rejects a traversal segment', () => {
    // A crafted partition row must not be able to read outside its prefix.
    expect(() => safeKey('logs/../../etc/passwd')).toThrow(/invalid object key/)
  })

  test('safeKey rejects spaces and quotes', () => {
    expect(() => safeKey('logs/a b.parquet')).toThrow(/invalid object key/)
    expect(() => safeKey('logs/a\'b.parquet')).toThrow(/invalid object key/)
  })

  test('safeKey accepts the hive-style keys the exporter mints', () => {
    expect(() => safeKey(KEYS[0])).not.toThrow()
  })
})

describe('clampLimit', () => {
  test('holds the page at the same 200 ceiling as the hot stream', () => {
    expect(clampLimit(5000)).toBe(200)
  })

  test('falls back for nonsense rather than emitting it', () => {
    expect(clampLimit('; DROP TABLE x')).toBe(100)
    expect(clampLimit(-4)).toBe(100)
    expect(clampLimit(0)).toBe(100)
  })

  test('truncates a fractional limit', () => {
    expect(clampLimit(10.9)).toBe(10)
  })
})

describe('nextDay', () => {
  test('crosses a month boundary', () => {
    expect(nextDay('2026-07-31')).toBe('2026-08-01')
  })

  test('crosses a year boundary', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
  })

  test('handles a leap day', () => {
    expect(nextDay('2028-02-28')).toBe('2028-02-29')
  })
})

describe('buildSearchSql', () => {
  test('drops a level that is not one of the eight severities', () => {
    const sql = buildSearchSql(BUCKET, KEYS, { levels: ['error', 'bogus'] })
    expect(sql).toContain('\'error\'')
    expect(sql).not.toContain('bogus')
  })

  test('emits no level clause at all when every level is unknown', () => {
    const sql = buildSearchSql(BUCKET, KEYS, { levels: ['nope'] })
    expect(sql).not.toContain('"level" IN')
  })

  test('neutralizes a quote in the free-text search', () => {
    const sql = buildSearchSql(BUCKET, KEYS, { q: 'it\'s broken' })
    expect(sql).toContain('\'%it\'\'s broken%\'')
    expect((sql.match(/'/g) ?? []).length % 2).toBe(0)
  })

  test('neutralizes a quote in the channel filter', () => {
    const sql = buildSearchSql(BUCKET, KEYS, { channel: 'a\' OR \'1\'=\'1' })
    expect((sql.match(/'/g) ?? []).length % 2).toBe(0)
    expect(sql).not.toMatch(/OR '1'='1'/)
  })

  test('pages on the whole (timestamp, id) pair, not timestamp alone', () => {
    // Entries share a millisecond routinely, and a cursor on a non-unique column
    // either repeats or skips rows at the page boundary.
    const sql = buildSearchSql(BUCKET, KEYS, { beforeTs: '2026-07-27T10:00:00Z', beforeId: 'abc-123' })
    expect(sql).toContain('("timestamp", "id") < (\'2026-07-27T10:00:00Z\', \'abc-123\')')
  })

  test('refuses a crafted cursor', () => {
    expect(() => buildSearchSql(BUCKET, KEYS, { beforeTs: '\' OR 1=1 --' })).toThrow(/cursor timestamp/)
  })

  test('makes the day range half-open so the to-day is included whole', () => {
    const sql = buildSearchSql(BUCKET, KEYS, { fromDay: '2026-07-01', toDay: '2026-07-31' })
    expect(sql).toContain('"timestamp" >= \'2026-07-01\'')
    expect(sql).toContain('"timestamp" < \'2026-08-01\'')
  })

  test('orders newest first and clamps the limit', () => {
    const sql = buildSearchSql(BUCKET, KEYS, { limit: 9999 })
    expect(sql).toContain('ORDER BY "timestamp" DESC, "id" DESC LIMIT 200')
  })

  test('reads every listed parquet file', () => {
    const sql = buildSearchSql(BUCKET, [KEYS[0], 'logs/project_id=demo/date=2026-07-28/part-000.parquet'], {})
    expect(sql).toContain('read_parquet([')
    expect(sql).toContain('s3://loghq-archive/logs/project_id=demo/date=2026-07-28/part-000.parquet')
  })
})

describe('buildExportSql', () => {
  test('pins every column to VARCHAR rather than letting read_json infer', () => {
    // Inference would turn a day of numeric-looking messages into doubles.
    const sql = buildExportSql(BUCKET, KEYS[0], '/tmp/x/part.ndjson')
    for (const c of ARCHIVE_COLUMNS)
      expect(sql).toContain(`"${c}": 'VARCHAR'`)
  })

  test('writes zstd parquet to the s3 url', () => {
    const sql = buildExportSql(BUCKET, KEYS[0], '/tmp/x/part.ndjson')
    expect(sql).toContain(`TO 's3://${BUCKET}/${KEYS[0]}'`)
    expect(sql).toContain('(FORMAT parquet, COMPRESSION zstd)')
  })

  test('sorts the file the way it is read back', () => {
    expect(buildExportSql(BUCKET, KEYS[0], '/tmp/x.ndjson')).toContain('ORDER BY "timestamp", "id"')
  })
})

describe('buildVerifySql', () => {
  test('returns count and size as one row, so verification is one process', () => {
    const sql = buildVerifySql(BUCKET, KEYS[0])
    expect(sql).toContain('count(*)')
    expect(sql).toContain('parquet_metadata')
    // One statement: the runner parses a single result set per invocation.
    expect(sql).not.toContain(';')
  })
})

describe('aggregations', () => {
  test('volume buckets by day with a ten character prefix', () => {
    expect(buildVolumeSql(BUCKET, KEYS, 'day')).toContain('substr("timestamp", 1, 10)')
  })

  test('volume buckets by hour with a thirteen character prefix', () => {
    expect(buildVolumeSql(BUCKET, KEYS, 'hour')).toContain('substr("timestamp", 1, 13)')
  })

  test('levels-by-release names the null release rather than dropping it', () => {
    expect(buildLevelsByReleaseSql(BUCKET, KEYS)).toContain('coalesce("release", \'(none)\')')
  })
})

describe('the dialect ban holds for generated SQL too', () => {
  // tests/unit/sql-dialect.test.ts scans source files for these tokens. The SQL
  // these builders produce at runtime is not in any file, so it is checked here.
  const built = [
    buildSearchSql(BUCKET, KEYS, { levels: ['error'], q: 'boom', fromDay: '2026-07-01', toDay: '2026-07-31' }),
    buildVolumeSql(BUCKET, KEYS, 'day', { fromDay: '2026-07-01' }),
    buildLevelsByReleaseSql(BUCKET, KEYS),
    buildVerifySql(BUCKET, KEYS[0]),
    buildExportSql(BUCKET, KEYS[0], '/tmp/x.ndjson'),
  ]

  for (const token of ['NOW()', 'AT TIME ZONE', '::interval']) {
    test(`no builder emits ${token}`, () => {
      for (const sql of built)
        expect(sql).not.toContain(token)
    })
  }
})
