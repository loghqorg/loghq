/**
 * Reading logs back once they span both tiers.
 *
 * A project's history now lives in two places: recent days in the primary
 * database, older days as Parquet on object storage. This module is what makes
 * that seam invisible to callers, and it is shared by the API routes and the
 * server blocks of the stx views so the two cannot answer the same question
 * differently.
 *
 * The rule that keeps totals honest:
 *
 *   the hot database owns every row it still holds
 *   the archive owns a day only once status reaches `deleted`
 *
 * Anything else double counts. A `verified` day has been written to Parquet but
 * its rows are still in log_entries, which is the normal state of affairs under
 * ARCHIVE_DELETE_AFTER_VERIFY=false, and counting both copies would silently
 * double a customer's volume chart.
 *
 * DuckDB is never pointed at the live database. It could be, through the sqlite
 * scanner, and it would be a tidier join. It would also take read locks on the
 * file that ingest is writing to, from a process the app does not supervise, and
 * it would tie the query layer to SQLite at exactly the moment this app is
 * meant to grow out of it. Two queries and a merge in JS cost a few
 * milliseconds and none of that.
 */

import { db } from '@stacksjs/database'
import { LEVELS } from '../Logs/normalize'
import { archiveConfig, type ArchiveConfig, archiveReady } from './config'
import { queryDuckDb, s3Preamble } from './duckdb'
import { type Day, cutoffDay } from './partitions'
import {
  type ArchiveFilters,
  buildLevelsByReleaseSql,
  buildSearchSql,
  buildVolumeSql,
  clampLimit,
} from './sql'

export interface PartitionRow {
  day: Day
  status: string
  row_count: number | null
  byte_size: number | null
  object_path: string | null
}

export interface VolumePoint {
  bucket: string
  hot: number
  archive: number
  total: number
}

export interface ReleaseLevels {
  release: string
  levels: Record<string, number>
  total: number
}

/** Statuses whose rows have left the hot database and must be read from Parquet. */
const ARCHIVED_ONLY = 'deleted'

/** The ledger rows for a project, newest day first. */
export async function archivePartitionsFor(
  projectId: string,
  opts: { fromDay?: Day, toDay?: Day, statuses?: string[], limit?: number } = {},
): Promise<PartitionRow[]> {
  const where = ['project_id = $1']
  const params: any[] = [projectId]

  if (opts.fromDay) {
    params.push(opts.fromDay)
    where.push(`day >= $${params.length}`)
  }
  if (opts.toDay) {
    params.push(opts.toDay)
    where.push(`day <= $${params.length}`)
  }
  if (opts.statuses?.length) {
    // Expanded placeholders: db.unsafe binds a JS array as a malformed literal,
    // so `= ANY($n)` does not work here. Same reason as routes/logs.ts.
    const start = params.length
    opts.statuses.forEach(s => params.push(s))
    where.push(`status IN (${opts.statuses.map((_, i) => `$${start + i + 1}`).join(', ')})`)
  }

  const limit = Math.min(1000, Math.max(1, Math.trunc(opts.limit ?? 400)))
  const rows = await db.unsafe(
    `SELECT day, status, row_count, byte_size, object_path FROM archive_partitions
     WHERE ${where.join(' AND ')} ORDER BY day DESC LIMIT ${limit}`,
    params,
  )

  return (rows ?? []).map((r: any) => ({
    day: String(r.day),
    status: String(r.status),
    row_count: r.row_count == null ? null : Number(r.row_count),
    byte_size: r.byte_size == null ? null : Number(r.byte_size),
    object_path: r.object_path == null ? null : String(r.object_path),
  }))
}

/**
 * Parquet keys to read for a day range, newest first.
 *
 * Capped at `maxFilesPerQuery`. DuckDB opens every listed file, and an
 * unbounded list on a project with two years of history would mean 700 range
 * requests behind one dashboard load. Callers that need more paginate by date.
 */
async function archiveKeysFor(
  projectId: string,
  cfg: ArchiveConfig,
  fromDay?: Day,
  toDay?: Day,
): Promise<string[]> {
  const partitions = await archivePartitionsFor(projectId, {
    fromDay,
    toDay,
    statuses: [ARCHIVED_ONLY],
    limit: cfg.maxFilesPerQuery,
  })

  return partitions
    .map(p => p.object_path)
    .filter((k): k is string => !!k)
}

/** Whether the archive can be queried at all right now. */
function archiveUsable(cfg: ArchiveConfig): boolean {
  return cfg.enabled && archiveReady(cfg) == null
}

/**
 * A page of archived entries.
 *
 * Returns an empty page rather than throwing when the archive is off or holds
 * nothing for the range: a dashboard asking for history it does not have should
 * render "nothing here", not an error.
 */
export async function searchArchive(
  projectId: string,
  filters: ArchiveFilters,
  cfg: ArchiveConfig = archiveConfig(),
): Promise<{ logs: any[], nextCursor: { ts: string, id: string } | null }> {
  if (!archiveUsable(cfg))
    return { logs: [], nextCursor: null }

  const keys = await archiveKeysFor(projectId, cfg, filters.fromDay, filters.toDay)
  if (!keys.length)
    return { logs: [], nextCursor: null }

  const limit = clampLimit(filters.limit)
  const sql = buildSearchSql(cfg.bucket, keys, { ...filters, limit })

  const rows = await queryDuckDb(`${s3Preamble(cfg)}\n${sql};`, {
    timeoutMs: cfg.queryTimeoutMs,
    cfg,
    context: `archive search for ${projectId}`,
  })

  const last = rows[rows.length - 1]
  const nextCursor = rows.length === limit && last
    ? { ts: String(last.timestamp), id: String(last.id) }
    : null

  return { logs: rows, nextCursor }
}

/**
 * Entry counts per day (or hour) across both tiers.
 *
 * Both sides bucket by a string prefix of the ISO timestamp, which is what lets
 * the results merge on a shared key without any date parsing in between.
 */
export async function volumeSeries(
  projectId: string,
  opts: { fromDay: Day, toDay: Day, unit?: 'day' | 'hour' },
  cfg: ArchiveConfig = archiveConfig(),
): Promise<VolumePoint[]> {
  const unit = opts.unit ?? 'day'
  const width = unit === 'hour' ? 13 : 10
  const buckets = new Map<string, { hot: number, archive: number }>()

  const bump = (bucket: string, side: 'hot' | 'archive', n: number) => {
    const entry = buckets.get(bucket) ?? { hot: 0, archive: 0 }
    entry[side] += n
    buckets.set(bucket, entry)
  }

  // Hot side. The upper bound is the day after toDay so the whole of toDay is
  // covered whatever time its entries carry.
  const hotRows = await db.unsafe(
    `SELECT substr(timestamp, 1, ${width}) AS bucket, COUNT(*) AS n
     FROM log_entries WHERE project_id = $1 AND timestamp >= $2 AND timestamp < $3
     GROUP BY substr(timestamp, 1, ${width}) ORDER BY 1`,
    [projectId, opts.fromDay, nextDayString(opts.toDay)],
  )

  for (const row of hotRows ?? [])
    bump(String(row.bucket), 'hot', Number(row.n))

  if (archiveUsable(cfg)) {
    const keys = await archiveKeysFor(projectId, cfg, opts.fromDay, opts.toDay)
    if (keys.length) {
      const sql = buildVolumeSql(cfg.bucket, keys, unit, { fromDay: opts.fromDay, toDay: opts.toDay })
      const rows = await queryDuckDb(`${s3Preamble(cfg)}\n${sql};`, {
        timeoutMs: cfg.queryTimeoutMs,
        cfg,
        context: `archive volume for ${projectId}`,
      })
      for (const row of rows)
        bump(String(row.bucket), 'archive', Number(row.n))
    }
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bucket, v]) => ({ bucket, hot: v.hot, archive: v.archive, total: v.hot + v.archive }))
}

/** Level counts grouped by release, across both tiers. */
export async function levelsByRelease(
  projectId: string,
  opts: { fromDay: Day, toDay: Day },
  cfg: ArchiveConfig = archiveConfig(),
): Promise<ReleaseLevels[]> {
  const releases = new Map<string, Record<string, number>>()

  const bump = (release: string, level: string, n: number) => {
    const key = release || '(none)'
    const levels = releases.get(key) ?? {}
    levels[level] = (levels[level] ?? 0) + n
    releases.set(key, levels)
  }

  const hotRows = await db.unsafe(
    `SELECT release, level, COUNT(*) AS n FROM log_entries
     WHERE project_id = $1 AND timestamp >= $2 AND timestamp < $3
     GROUP BY release, level`,
    [projectId, opts.fromDay, nextDayString(opts.toDay)],
  )

  for (const row of hotRows ?? [])
    bump(row.release == null ? '(none)' : String(row.release), String(row.level ?? 'info'), Number(row.n))

  if (archiveUsable(cfg)) {
    const keys = await archiveKeysFor(projectId, cfg, opts.fromDay, opts.toDay)
    if (keys.length) {
      const sql = buildLevelsByReleaseSql(cfg.bucket, keys, { fromDay: opts.fromDay, toDay: opts.toDay })
      const rows = await queryDuckDb(`${s3Preamble(cfg)}\n${sql};`, {
        timeoutMs: cfg.queryTimeoutMs,
        cfg,
        context: `archive levels for ${projectId}`,
      })
      for (const row of rows)
        bump(String(row.release ?? '(none)'), String(row.level ?? 'info'), Number(row.n))
    }
  }

  return [...releases.entries()]
    .map(([release, levels]) => ({
      release,
      levels,
      total: Object.values(levels).reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.total - a.total)
}

/** Totals for the retention panels: what is archived, what it costs, what was pruned. */
export async function archiveSummary(projectId: string): Promise<{
  partitions: number
  archivedRows: number
  archivedBytes: number
  prunedRows: number
  oldestDay: Day | null
  newestDay: Day | null
}> {
  const rows = await db.unsafe(
    `SELECT status, COUNT(*) AS parts, COALESCE(SUM(row_count), 0) AS rows_total,
            COALESCE(SUM(byte_size), 0) AS bytes_total, MIN(day) AS oldest, MAX(day) AS newest
     FROM archive_partitions WHERE project_id = $1 GROUP BY status`,
    [projectId],
  )

  let partitions = 0
  let archivedRows = 0
  let archivedBytes = 0
  let prunedRows = 0
  let oldestDay: Day | null = null
  let newestDay: Day | null = null

  for (const row of rows ?? []) {
    const status = String(row.status)
    partitions += Number(row.parts ?? 0)

    if (status === 'pruned') {
      prunedRows += Number(row.rows_total ?? 0)
    }
    else if (status === 'verified' || status === 'deleted') {
      archivedRows += Number(row.rows_total ?? 0)
      archivedBytes += Number(row.bytes_total ?? 0)
    }

    const oldest = row.oldest == null ? null : String(row.oldest)
    const newest = row.newest == null ? null : String(row.newest)
    if (oldest && (!oldestDay || oldest < oldestDay))
      oldestDay = oldest
    if (newest && (!newestDay || newest > newestDay))
      newestDay = newest
  }

  return { partitions, archivedRows, archivedBytes, prunedRows, oldestDay, newestDay }
}

/** The day the hot window currently starts on. */
export function hotWindowStart(cfg: ArchiveConfig = archiveConfig(), now = new Date()): Day {
  return cutoffDay(now, cfg.hotWindowDays)
}

/** Parse a comma-separated level filter, keeping only real severities. */
export function parseLevels(raw: unknown): string[] {
  if (!raw)
    return []
  return String(raw)
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(l => LEVELS.has(l))
}

function nextDayString(day: Day): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
