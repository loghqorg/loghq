/**
 * DuckDB SQL construction for the log archive.
 *
 * This module is the injection boundary of the whole archive feature, and the
 * reason it exists as a separate pure file.
 *
 * Everywhere else in loghq, untrusted values reach the database as bound `$n`
 * parameters (see routes/logs.ts). DuckDB is driven here as a command-line
 * process reading a script on stdin, and that interface has no parameter
 * binding at all: every filter a user types has to be spliced into the SQL text.
 * So every value that crosses into a statement goes through either `sqlQuote`
 * or a whitelist in this file, and nothing else in app/Archive/ is allowed to
 * concatenate a user value into SQL.
 *
 * Kept IO-free so the escaping rules can be unit-tested without a duckdb binary,
 * an object store, or a database, mirroring app/Logs/normalize.ts.
 *
 * One further rule: none of the SQL emitted here may use `NOW()`,
 * `AT TIME ZONE`, or `::interval`. Those are Postgres-only spellings that
 * tests/unit/sql-dialect.test.ts scans every file under app/ for, after they
 * took production down once (see app/Support/time.ts). DuckDB would in fact
 * accept some of them, but keeping the ban absolute means nobody has to
 * remember which files the rule applies to.
 */

import { LEVELS } from '../Logs/normalize'

/** Widest value accepted into a quoted literal. Filters are short by nature. */
export const MAX_LITERAL = 4096

/** `YYYY-MM-DD`, the partition day format. */
export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
/** An ISO-8601 instant, the shape `log_entries.timestamp` holds. */
export const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ][\d:.]{4,15}Z?$/
/** Project and entry ids: the slug-with-suffix and uuid shapes this app mints. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
/** An object key inside the bucket. Deliberately excludes quotes and spaces. */
export const SAFE_KEY = /^[A-Za-z0-9._/=-]{1,512}$/

/** Columns carried into Parquet: the LogRow shape plus the row's insert time. */
export const ARCHIVE_COLUMNS = [
  'id',
  'project_id',
  'level',
  'message',
  'channel',
  'context',
  'environment',
  'release',
  'framework',
  'host',
  'sdk',
  'user_context',
  'timestamp',
  'trace_id',
  'request_id',
  'created_at',
] as const

/** `release` is quoted everywhere: it reads as a keyword in enough dialects to be worth not finding out. */
function col(name: string): string {
  return `"${name}"`
}

const SELECT_LIST = ARCHIVE_COLUMNS.map(col).join(', ')

/**
 * Wrap a value as a single-quoted SQL literal.
 *
 * Doubling the quote is the whole escape, which is why the control-character
 * check matters as much as it does: a newline cannot break out of a quoted
 * literal by itself, but it can break the one-statement-per-invocation
 * convention the runner relies on to parse output, and a NUL truncates the
 * script at the C-string boundary inside the CLI. Rejecting rather than
 * stripping keeps a mangled filter loud instead of silently matching the wrong
 * rows.
 */
export function sqlQuote(value: string): string {
  const s = String(value)

  if (s.length > MAX_LITERAL)
    throw new Error(`archive: literal exceeds ${MAX_LITERAL} characters`)

  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 || code === 0x7F)
      throw new Error('archive: literal contains a control character')
  }

  return `'${s.replaceAll('\'', '\'\'')}'`
}

/** Validate against a pattern, or throw naming the field. */
function checked(value: string, pattern: RegExp, field: string): string {
  const s = String(value)
  if (!pattern.test(s))
    throw new Error(`archive: invalid ${field}`)
  return s
}

export function safeDay(day: string): string {
  return checked(day, ISO_DAY, 'day')
}

export function safeId(id: string): string {
  return checked(id, SAFE_ID, 'id')
}

export function safeKey(key: string): string {
  // `..` never appears in a key this app mints, and a traversal segment reaching
  // read_parquet would let a crafted partition row read outside its prefix.
  if (key.includes('..'))
    throw new Error('archive: invalid object key')
  return checked(key, SAFE_KEY, 'object key')
}

/** The bucket comes from operator config rather than a request, but it is spliced into SQL all the same. */
export function safeBucket(bucket: string): string {
  return checked(bucket, /^[A-Za-z0-9._-]{1,255}$/, 'bucket')
}

/** `s3://bucket/key`, both halves validated. */
export function s3Url(bucket: string, key: string): string {
  return `s3://${safeBucket(bucket)}/${safeKey(key)}`
}

/**
 * The file list for a read_parquet call.
 *
 * DuckDB raises when a listed file does not exist, which is the behavior we
 * want: a partition row claiming a Parquet file that is gone is a real problem,
 * not something to paper over with an empty result.
 */
function parquetSource(bucket: string, objectKeys: string[]): string {
  const urls = objectKeys.map(k => sqlQuote(s3Url(bucket, k)))
  return `read_parquet([${urls.join(', ')}])`
}

export interface ArchiveFilters {
  levels?: string[]
  channel?: string
  environment?: string
  release?: string
  /** Free text matched against the message. */
  q?: string
  fromDay?: string
  toDay?: string
  /** Keyset cursor: return rows strictly older than this (timestamp, id) pair. */
  beforeTs?: string
  beforeId?: string
  limit?: number
}

/** Clamp to a sane page. Mirrors the hot stream endpoint's 200 ceiling. */
export function clampLimit(limit: unknown, fallback = 100): number {
  const n = Math.trunc(Number(limit))
  if (!Number.isFinite(n) || n < 1)
    return fallback
  return Math.min(200, n)
}

/**
 * Build the WHERE fragments shared by search and the aggregations.
 *
 * Level values are matched against the same `LEVELS` set the ingest validates
 * against, so an unknown level is dropped rather than quoted: the archive can
 * only ever contain the eight severities, and passing a ninth through as a
 * literal would just be a guaranteed-empty comparison.
 */
function filterClauses(f: ArchiveFilters): string[] {
  const where: string[] = []

  if (f.levels?.length) {
    const levels = f.levels
      .map(l => String(l).trim().toLowerCase())
      .filter(l => LEVELS.has(l))
    if (levels.length)
      where.push(`"level" IN (${levels.map(sqlQuote).join(', ')})`)
  }

  if (f.channel)
    where.push(`"channel" = ${sqlQuote(String(f.channel).slice(0, 255))}`)

  if (f.environment)
    where.push(`"environment" = ${sqlQuote(String(f.environment).slice(0, 255))}`)

  if (f.release)
    where.push(`"release" = ${sqlQuote(String(f.release).slice(0, 255))}`)

  if (f.q) {
    // `%` and `_` are left literal rather than escaped: a user typing them into
    // a log search means them as wildcards more often than not, and this reads
    // an immutable archive, so a broad pattern costs a scan and nothing else.
    const needle = String(f.q).slice(0, 200)
    where.push(`"message" ILIKE ${sqlQuote(`%${needle}%`)}`)
  }

  if (f.fromDay)
    where.push(`"timestamp" >= ${sqlQuote(safeDay(f.fromDay))}`)

  if (f.toDay) {
    // Exclusive upper bound on the day AFTER toDay, so the caller's `to` day is
    // itself included whatever time the entries carry.
    where.push(`"timestamp" < ${sqlQuote(nextDay(safeDay(f.toDay)))}`)
  }

  return where
}

/** The UTC day after `day`, as `YYYY-MM-DD`. */
export function nextDay(day: string): string {
  const d = new Date(`${safeDay(day)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * A page of archived entries, newest first.
 *
 * Ordered and paged by `(timestamp, id)` rather than timestamp alone: entries
 * arriving in the same millisecond are common in a log stream, and a cursor on
 * a non-unique column either repeats or skips rows at the page boundary.
 */
export function buildSearchSql(bucket: string, objectKeys: string[], f: ArchiveFilters): string {
  const where = filterClauses(f)

  if (f.beforeTs) {
    const ts = sqlQuote(checked(f.beforeTs, ISO_TS, 'cursor timestamp'))
    // Row-value comparison: DuckDB supports it, and it says "strictly older than
    // this exact row" without the three-way OR spelling.
    const id = f.beforeId ? sqlQuote(safeId(f.beforeId)) : null
    where.push(id ? `("timestamp", "id") < (${ts}, ${id})` : `"timestamp" < ${ts}`)
  }

  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''

  return `SELECT ${SELECT_LIST} FROM ${parquetSource(bucket, objectKeys)}${clause} `
    + `ORDER BY "timestamp" DESC, "id" DESC LIMIT ${clampLimit(f.limit)}`
}

/**
 * Entry counts bucketed by day or hour.
 *
 * The bucket is a string prefix of the ISO timestamp rather than a date
 * conversion: the column is text, the prefix sorts correctly, and it keeps the
 * archive query producing exactly the same bucket keys as the hot-side query in
 * app/Archive/query.ts, which is what lets the two be merged by key.
 */
export function buildVolumeSql(
  bucket: string,
  objectKeys: string[],
  unit: 'day' | 'hour',
  f: ArchiveFilters = {},
): string {
  const width = unit === 'hour' ? 13 : 10
  const where = filterClauses(f)
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''

  return `SELECT substr("timestamp", 1, ${width}) AS bucket, count(*) AS n `
    + `FROM ${parquetSource(bucket, objectKeys)}${clause} GROUP BY 1 ORDER BY 1`
}

/** Level counts per release, for the analytics view. */
export function buildLevelsByReleaseSql(bucket: string, objectKeys: string[], f: ArchiveFilters = {}): string {
  const where = filterClauses(f)
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''

  return `SELECT coalesce("release", '(none)') AS release, "level" AS level, count(*) AS n `
    + `FROM ${parquetSource(bucket, objectKeys)}${clause} GROUP BY 1, 2 ORDER BY 1, 2`
}

/**
 * Row count and compressed size of one written partition.
 *
 * Both halves of the verification in a single statement, because the runner
 * parses one result set per invocation and this saves a second process launch
 * on the hot path of every export.
 */
export function buildVerifySql(bucket: string, key: string): string {
  const url = sqlQuote(s3Url(bucket, key))
  return `SELECT (SELECT count(*) FROM read_parquet(${url})) AS n, `
    + `(SELECT coalesce(sum(total_compressed_size), 0) FROM parquet_metadata(${url})) AS bytes`
}

/**
 * Copy a staged NDJSON file into Parquet on object storage.
 *
 * Every column is pinned to VARCHAR rather than inferred. Left to itself,
 * read_json samples the file and picks types, so a day where every `message`
 * happened to look numeric would come back as a column of doubles, and a
 * `context` blob whose keys vary between rows would either be coerced into one
 * struct or error. The archive schema is exactly what log_entries holds, and
 * log_entries holds text.
 *
 * Sorted by (timestamp, id) so the file is laid out the way it is read back,
 * which is what makes the row-group statistics useful to a filtered scan.
 */
export function buildExportSql(bucket: string, key: string, ndjsonPath: string): string {
  const columns = ARCHIVE_COLUMNS.map(c => `${col(c)}: 'VARCHAR'`).join(', ')

  return `COPY (SELECT ${SELECT_LIST} FROM read_json(${sqlQuote(ndjsonPath)}, `
    + `format='newline_delimited', columns={${columns}}) ORDER BY "timestamp", "id") `
    + `TO ${sqlQuote(s3Url(bucket, key))} (FORMAT parquet, COMPRESSION zstd)`
}
