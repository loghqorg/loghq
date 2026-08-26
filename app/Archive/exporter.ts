/**
 * Moving aged log partitions out of the hot database.
 *
 * One (project, UTC day) at a time: page the rows out, stage them as NDJSON,
 * have DuckDB write them to Parquet on object storage, read the file back to
 * confirm the count, and only then delete the originals. Free-plan projects skip
 * the Parquet half and are pruned outright, which is the 30-day retention the
 * pricing page sells.
 *
 * Two constraints shape most of what follows.
 *
 * There are no transactions anywhere in this application, so nothing here can
 * rely on one. Coordination is done with the unique index on
 * (project_id, day) in archive_partitions: an INSERT is a lock acquisition, and
 * whoever loses throws. See claimPartition.
 *
 * And `log_entries.timestamp` is a varchar of ISO-8601 text rather than a
 * timestamp column, so every window comparison is a string comparison. That is
 * sound because ISO-8601 sorts lexicographically, and it is what lets these
 * queries ride the (project_id, timestamp) index. It also means the SQL here
 * never calls a date function, which keeps it valid on both SQLite (production)
 * and Postgres. See app/Support/time.ts for the history behind that rule.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '@stacksjs/database'
import { log } from '@stacksjs/logging'
import { utcNow } from '../Support/time'
import { type ArchiveConfig, archiveConfig, archiveReady } from './config'
import { runDuckDb, s3Preamble } from './duckdb'
import {
  type AgedPartition,
  cutoffDay,
  type Day,
  dayBounds,
  type ExistingPartition,
  freePruneCutoff,
  objectKeyFor,
  type PartitionPlan,
  partitionsToExport,
} from './partitions'
import { plansFor } from './plan'
import { ARCHIVE_COLUMNS, buildExportSql, buildVerifySql } from './sql'

/** Rows read from the hot database per page while staging. */
const PAGE_SIZE = 5000
/** Rows removed per DELETE. Small enough not to hold a SQLite write lock for long. */
const DELETE_BATCH = 2000
/** An `exporting` claim older than this belonged to a run that died. */
const STALE_CLAIM_HOURS = 6

const SELECT_COLS = ARCHIVE_COLUMNS.join(', ')

export interface ExportOutcome {
  projectId: string
  day: Day
  status: 'verified' | 'deleted' | 'pruned' | 'failed' | 'skipped'
  rows: number
  bytes: number | null
  error?: string
}

export interface RunSummary {
  partitions: number
  exported: number
  pruned: number
  failed: number
  skipped: number
  rows: number
  bytes: number
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** A SQL timestamp `hours` in the past, matching the shape archive_partitions.updated_at holds. */
function sqlHoursAgo(hours: number): string {
  const d = new Date(Date.now() - hours * 60 * 60 * 1000)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** Every (project, day) with entries that have aged out of the hot window. */
export async function listAgedPartitions(cutoff: Day): Promise<AgedPartition[]> {
  // substr rather than a date cast: valid on SQLite and Postgres alike, and the
  // bound cutoff on the raw column is what keeps the index in play.
  const rows = await db.unsafe(
    `SELECT project_id, substr(timestamp, 1, 10) AS day, COUNT(*) AS n
     FROM log_entries WHERE timestamp < $1
     GROUP BY project_id, substr(timestamp, 1, 10)
     ORDER BY project_id, day`,
    [cutoff],
  )
  return (rows ?? []).map((r: any) => ({ project_id: String(r.project_id), day: String(r.day), n: Number(r.n) }))
}

/** Ledger rows for the partitions we are considering. */
export async function listExistingPartitions(cutoff: Day): Promise<ExistingPartition[]> {
  const rows = await db.unsafe(
    'SELECT project_id, day, status, updated_at FROM archive_partitions WHERE day < $1',
    [cutoff],
  )
  return (rows ?? []).map((r: any) => ({
    project_id: String(r.project_id),
    day: String(r.day),
    status: String(r.status),
    updated_at: r.updated_at == null ? null : String(r.updated_at),
  }))
}

/**
 * Take ownership of a partition, or return false if someone else holds it.
 *
 * Without transactions this leans entirely on the unique index. The fresh case
 * is a plain INSERT: two runs racing produce one success and one constraint
 * violation, and the loser simply skips. The reclaim case cannot use INSERT, so
 * it writes its token and reads back to see whose survived. Both racers may
 * UPDATE, but only one token is in the row afterwards, and the one that reads
 * back a token other than its own backs off.
 */
export async function claimPartition(projectId: string, day: Day, token: string): Promise<boolean> {
  try {
    await db.unsafe(
      `INSERT INTO archive_partitions (id, project_id, day, status, attempts, claim_token, created_at, updated_at)
       VALUES ($1, $2, $3, 'exporting', 1, $4, $5, $6)`,
      [newId(), projectId, day, token, utcNow(), utcNow()],
    )
    return true
  }
  catch {
    // The row already exists. Either it is finished, someone is working on it,
    // or it is ours to reclaim.
  }

  const stale = sqlHoursAgo(STALE_CLAIM_HOURS)
  await db.unsafe(
    `UPDATE archive_partitions
     SET status = 'exporting', claim_token = $1, attempts = attempts + 1, error = NULL, updated_at = $2
     WHERE project_id = $3 AND day = $4
       AND (status = 'failed' OR (status = 'exporting' AND (updated_at IS NULL OR updated_at < $5)))`,
    [token, utcNow(), projectId, day, stale],
  )

  const row = (await db.unsafe(
    'SELECT claim_token, status FROM archive_partitions WHERE project_id = $1 AND day = $2 LIMIT 1',
    [projectId, day],
  ))?.[0]

  return row?.claim_token === token && row?.status === 'exporting'
}

async function markPartition(projectId: string, day: Day, fields: Record<string, any>): Promise<void> {
  const keys = Object.keys(fields)
  const sets = keys.map((k, i) => `"${k}" = $${i + 1}`)
  const params = keys.map(k => fields[k])
  params.push(utcNow(), projectId, day)

  await db.unsafe(
    `UPDATE archive_partitions SET ${sets.join(', ')}, updated_at = $${keys.length + 1}
     WHERE project_id = $${keys.length + 2} AND day = $${keys.length + 3}`,
    params,
  )
}

// ---------------------------------------------------------------------------
// Staging and deletion
// ---------------------------------------------------------------------------

/**
 * Write one day's rows to an NDJSON file, returning how many were written.
 *
 * Keyset paging on (timestamp, id) rather than OFFSET: the table is large, and
 * OFFSET makes the database walk every skipped row again on each page. The
 * comparison is spelled as an explicit OR rather than a row-value tuple because
 * row-value comparisons are not portable across the two engines this app runs
 * on, and a staging loop is the wrong place to discover that.
 *
 * JSON.stringify escapes embedded newlines, so one row is exactly one line by
 * construction, which is what read_json's newline_delimited format needs.
 */
async function stageDay(projectId: string, day: Day, filePath: string): Promise<number> {
  const { from, to } = dayBounds(day)
  const lines: string[] = []
  let cursorTs: string | null = null
  let cursorId: string | null = null

  for (;;) {
    const where = ['project_id = $1', 'timestamp >= $2', 'timestamp < $3']
    const params: any[] = [projectId, from, to]

    if (cursorTs != null) {
      params.push(cursorTs, cursorId)
      where.push(`(timestamp > $${params.length - 1} OR (timestamp = $${params.length - 1} AND id > $${params.length}))`)
    }

    const rows = await db.unsafe(
      `SELECT ${SELECT_COLS} FROM log_entries WHERE ${where.join(' AND ')}
       ORDER BY timestamp, id LIMIT ${PAGE_SIZE}`,
      params,
    )

    const page = rows ?? []
    if (!page.length)
      break

    for (const row of page) {
      // Normalize to the archive's own column list so a schema drift in the hot
      // table cannot silently change what a Parquet file contains.
      const record: Record<string, any> = {}
      for (const c of ARCHIVE_COLUMNS)
        record[c] = row[c] == null ? null : String(row[c])
      lines.push(JSON.stringify(record))
    }

    const last = page[page.length - 1]
    cursorTs = String(last.timestamp)
    cursorId = String(last.id)

    if (page.length < PAGE_SIZE)
      break
  }

  await writeFile(filePath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
  return lines.length
}

/**
 * Remove one day's rows, in batches, returning how many went.
 *
 * `DELETE ... LIMIT` is a MySQL/SQLite extension that Postgres rejects, so the
 * batch is expressed as a subselect instead, which both engines accept.
 * Batching at all is about lock duration: a single DELETE covering a busy day
 * would hold SQLite's write lock long enough for ingest to notice.
 */
async function deleteDay(projectId: string, day: Day): Promise<number> {
  const { from, to } = dayBounds(day)
  let removed = 0

  for (;;) {
    const before = (await db.unsafe(
      'SELECT COUNT(*) AS n FROM log_entries WHERE project_id = $1 AND timestamp >= $2 AND timestamp < $3',
      [projectId, from, to],
    ))?.[0]

    const remaining = Number(before?.n ?? 0)
    if (remaining === 0)
      break

    await db.unsafe(
      `DELETE FROM log_entries WHERE id IN (
         SELECT id FROM log_entries
         WHERE project_id = $1 AND timestamp >= $2 AND timestamp < $3
         LIMIT ${DELETE_BATCH}
       )`,
      [projectId, from, to],
    )

    removed += Math.min(remaining, DELETE_BATCH)

    if (remaining <= DELETE_BATCH)
      break
  }

  return removed
}

// ---------------------------------------------------------------------------
// The two paths
// ---------------------------------------------------------------------------

/**
 * Export one partition to Parquet, verify it, and trim the hot rows.
 *
 * The verification is the point of the whole function. Anything can go wrong
 * between staging and a finished object: a truncated upload, a credential that
 * expired mid-run, a bucket policy that silently rejects. Reading the file back
 * and comparing its row count against what was staged is cheap, and it is the
 * difference between deleting rows that are safely stored and deleting rows on
 * the strength of an exit code. A mismatch leaves the hot rows exactly where
 * they are and marks the partition failed for the next run to retry.
 */
export async function exportPartition(cfg: ArchiveConfig, projectId: string, day: Day): Promise<ExportOutcome> {
  const key = objectKeyFor(cfg.prefix, projectId, day)
  let dir: string | null = null

  try {
    dir = await mkdtemp(join(tmpdir(), 'loghq-archive-'))
    const ndjsonPath = join(dir, 'part.ndjson')

    const staged = await stageDay(projectId, day, ndjsonPath)

    if (staged === 0) {
      // The rows went away between planning and staging, most likely because the
      // project was deleted. Nothing to archive, and nothing to worry about.
      await markPartition(projectId, day, { status: 'deleted', row_count: 0, object_path: null, claim_token: null })
      return { projectId, day, status: 'deleted', rows: 0, bytes: null }
    }

    const preamble = s3Preamble(cfg)
    const copy = await runDuckDb(`${preamble}\n${buildExportSql(cfg.bucket, key, ndjsonPath)};`, {
      timeoutMs: cfg.exportTimeoutMs,
      cfg,
    })

    if (!copy.ok) {
      await markPartition(projectId, day, { status: 'failed', error: copy.stderr.slice(0, 2000), claim_token: null })
      return { projectId, day, status: 'failed', rows: staged, bytes: null, error: copy.stderr }
    }

    const verify = await runDuckDb(`${preamble}\n${buildVerifySql(cfg.bucket, key)};`, {
      timeoutMs: cfg.queryTimeoutMs,
      cfg,
    })

    if (!verify.ok) {
      await markPartition(projectId, day, { status: 'failed', error: `verify: ${verify.stderr}`.slice(0, 2000), claim_token: null })
      return { projectId, day, status: 'failed', rows: staged, bytes: null, error: verify.stderr }
    }

    const written = Number(verify.rows?.[0]?.n ?? -1)
    const bytes = Number(verify.rows?.[0]?.bytes ?? 0) || null

    if (written !== staged) {
      const error = `row count mismatch: staged ${staged}, parquet holds ${written}`
      await markPartition(projectId, day, { status: 'failed', error, claim_token: null })
      return { projectId, day, status: 'failed', rows: staged, bytes, error }
    }

    await markPartition(projectId, day, {
      status: 'verified',
      row_count: written,
      byte_size: bytes,
      object_path: key,
      error: null,
    })

    if (!cfg.deleteAfterVerify) {
      // Copy-only mode, used to prove a new bucket before trusting it with
      // deletion. The query layer keeps serving these days from the hot table.
      await markPartition(projectId, day, { claim_token: null })
      return { projectId, day, status: 'verified', rows: written, bytes }
    }

    await deleteDay(projectId, day)
    await markPartition(projectId, day, { status: 'deleted', claim_token: null })

    return { projectId, day, status: 'deleted', rows: written, bytes }
  }
  catch (error: any) {
    const message = String(error?.message ?? error).slice(0, 2000)
    await markPartition(projectId, day, { status: 'failed', error: message, claim_token: null })
    return { projectId, day, status: 'failed', rows: 0, bytes: null, error: message }
  }
  finally {
    if (dir)
      await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Drop one partition without archiving it: the free-plan path.
 *
 * Recorded in the ledger rather than deleted quietly. Once the entries are gone
 * this row is the only evidence the day existed, and a customer asking where
 * their logs went deserves an answer more precise than "retention".
 */
export async function prunePartition(projectId: string, day: Day): Promise<ExportOutcome> {
  try {
    const removed = await deleteDay(projectId, day)
    await markPartition(projectId, day, { status: 'pruned', row_count: removed, object_path: null, error: null, claim_token: null })
    return { projectId, day, status: 'pruned', rows: removed, bytes: null }
  }
  catch (error: any) {
    const message = String(error?.message ?? error).slice(0, 2000)
    await markPartition(projectId, day, { status: 'failed', error: message, claim_token: null })
    return { projectId, day, status: 'failed', rows: 0, bytes: null, error: message }
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunOptions {
  cfg?: ArchiveConfig
  now?: Date
  /** Plan only: report what would happen and change nothing. */
  dryRun?: boolean
  /** Restrict the run to one project. */
  projectId?: string
  /** Restrict the run to one day. */
  day?: Day
}

/** What a run would do, without doing any of it. */
export async function planRun(opts: RunOptions = {}): Promise<Array<PartitionPlan & { plan: string }>> {
  const cfg = opts.cfg ?? archiveConfig()
  const now = opts.now ?? new Date()
  const cutoff = cutoffDay(now, cfg.hotWindowDays)

  let aged = await listAgedPartitions(cutoff)
  if (opts.projectId)
    aged = aged.filter(a => a.project_id === opts.projectId)
  if (opts.day)
    aged = aged.filter(a => a.day === opts.day)

  const existing = await listExistingPartitions(cutoff)
  const plans = partitionsToExport(aged, existing, { staleClaimsBefore: sqlHoursAgo(STALE_CLAIM_HOURS) })
  const plansByProject = await plansFor(plans.map(p => p.projectId))

  return plans.map(p => ({ ...p, plan: plansByProject.get(p.projectId) ?? 'free' }))
}

/**
 * One pass over everything that has aged out.
 *
 * Partitions run one at a time rather than concurrently. The work is bounded by
 * object storage and by the hot database, both of which are shared with live
 * ingest, and a nightly job has all the time it needs. Sequential also means a
 * failure affects one partition instead of leaving several half-claimed.
 */
export async function runArchive(opts: RunOptions = {}): Promise<RunSummary> {
  const cfg = opts.cfg ?? archiveConfig()
  const now = opts.now ?? new Date()

  const summary: RunSummary = { partitions: 0, exported: 0, pruned: 0, failed: 0, skipped: 0, rows: 0, bytes: 0 }

  const plans = await planRun({ ...opts, cfg, now })
  summary.partitions = plans.length

  if (!plans.length)
    return summary

  const freeCutoff = freePruneCutoff(now, cfg.hotWindowDays, cfg.freePruneGraceDays)
  const token = newId()

  for (const partition of plans) {
    const { projectId, day } = partition

    if (partition.plan === 'free') {
      // Still inside the grace period: leave it, so an upgrade this week still
      // gets the day archived rather than finding it gone.
      if (day >= freeCutoff) {
        summary.skipped++
        continue
      }

      if (opts.dryRun) {
        summary.pruned++
        continue
      }

      if (!(await claimPartition(projectId, day, token))) {
        summary.skipped++
        continue
      }

      const outcome = await prunePartition(projectId, day)
      if (outcome.status === 'pruned') {
        summary.pruned++
        summary.rows += outcome.rows
      }
      else {
        summary.failed++
        log.warn(`[archive] prune failed for ${projectId} ${day}: ${outcome.error}`)
      }
      continue
    }

    if (opts.dryRun) {
      summary.exported++
      continue
    }

    if (!(await claimPartition(projectId, day, token))) {
      summary.skipped++
      continue
    }

    const outcome = await exportPartition(cfg, projectId, day)
    if (outcome.status === 'failed') {
      summary.failed++
      log.warn(`[archive] export failed for ${projectId} ${day}: ${outcome.error}`)
    }
    else {
      summary.exported++
      summary.rows += outcome.rows
      summary.bytes += outcome.bytes ?? 0
    }
  }

  return summary
}

/**
 * The entry point the nightly job and the CLI both call.
 *
 * Returns null when the archive is switched off or misconfigured, having said
 * why. A missing bucket is an operator problem, not a reason to throw inside the
 * scheduler process.
 */
export async function runArchiveIfEnabled(opts: RunOptions = {}): Promise<RunSummary | null> {
  const cfg = opts.cfg ?? archiveConfig()

  if (!cfg.enabled) {
    log.info('[archive] disabled, skipping run (set ARCHIVE_ENABLED=true to turn it on)')
    return null
  }

  const problem = archiveReady(cfg)
  if (problem) {
    log.warn(`[archive] ${problem}`)
    return null
  }

  return runArchive({ ...opts, cfg })
}
