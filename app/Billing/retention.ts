import type { SqlClient } from '@stacksjs/hq/meter'
import process from 'node:process'
import { cutoffDay } from '../Archive/partitions'
import { FREE_RETENTION_DAYS } from './plans'

/**
 * The Free plan's retention window, enforced.
 *
 * The pricing page sells Free as 30 days of logs. The only thing that ever
 * removed an old line was the archive run (app/Archive/exporter.ts), and that
 * run does nothing unless object storage is configured, so on an install with
 * the archive off a Free project's logs were kept forever. This prune is the
 * part of that promise that does not depend on a bucket.
 *
 * Pure of the app's database on purpose: it is handed a store and a plan
 * lookup, so the rule is tested against a real SQLite schema without booting
 * the framework (tests/unit/retention.test.ts).
 *
 * The rules, each of which exists because the alternative deletes something
 * it should not:
 *
 * - **Age is the time the SERVER stored the line (`created_at`), never the
 *   time the client reported (`timestamp`).** `timestamp` is a varchar holding
 *   whatever the SDK sent (app/Logs/normalize.ts keeps it verbatim, bounded
 *   only in length). Epoch milliseconds, a local date format or a wrong clock
 *   all compare as "older than the cutoff" as strings, and a prune keyed on
 *   them would remove lines stored a minute ago. `created_at` is written by
 *   the ingest route and by nothing else.
 * - **It is off unless switched on** (`RETENTION_PRUNE_ENABLED`, see
 *   `retentionMode`). The first run on an existing install has every Free
 *   project's backlog in front of it. That is a decision for a person, made
 *   after reading a dry run, not a side effect of a deploy.
 * - **Only a project whose owner is KNOWN to be Free is pruned.** A plan that
 *   is unknown or ambiguous is skipped (app/Billing/pro.ts `planForPrune`).
 *   Guessing wrong on the ingest costs a sampled line. Guessing wrong here
 *   deletes a paying customer's history.
 * - **A project with no owner is skipped.** Nobody is on a plan, so no plan's
 *   retention applies.
 * - **Deletes are batched and the run is capped**, so one statement never
 *   holds a write lock across a whole backlog. What a capped run leaves
 *   behind, the next run takes.
 */

export type RetentionMode = 'off' | 'dry-run' | 'on'

/**
 * `RETENTION_PRUNE_ENABLED`: `true` deletes, `dry-run` only counts, anything
 * else (including unset) does nothing at all.
 */
export function retentionMode(value: unknown = process.env.RETENTION_PRUNE_ENABLED): RetentionMode {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'true' || text === '1' || text === 'on' || text === 'yes')
    return 'on'
  if (text === 'dry-run' || text === 'dryrun' || text === 'dry_run')
    return 'dry-run'
  return 'off'
}

export interface RetentionProject {
  projectId: string
  ownerId: number | null
}

export interface RetentionStore {
  /** Projects holding at least one line stored before `cutoff`. */
  projectsWithLinesBefore: (cutoff: string) => Promise<RetentionProject[]>
  /** How many of a project's lines were stored before `cutoff`. Reads only. */
  countBefore: (projectId: string, cutoff: string) => Promise<number>
  /** Delete up to `limit` of a project's lines stored before `cutoff`, and answer how many went. */
  deleteBefore: (projectId: string, cutoff: string, limit: number) => Promise<number>
}

export interface PruneOptions {
  store: RetentionStore
  /** `true` Pro, `false` Free, `null` could not tell or ambiguous. */
  planOf: (ownerId: number) => Promise<boolean | null>
  /** Count what would go and delete nothing. */
  dryRun?: boolean
  now?: Date
  days?: number
  batchSize?: number
  /** Most rows one run removes across all projects. */
  maxRows?: number
}

export interface PruneSummary {
  dryRun: boolean
  /** The first UTC day kept, `YYYY-MM-DD`. Lines stored before it are out of the window. */
  cutoff: string
  /** Projects that had lines removed (or, in a dry run, would have). */
  pruned: number
  /** Rows removed (or, in a dry run, that would be). */
  rows: number
  /** Per project, for the log. Only projects with something to remove. */
  projects: Array<{ projectId: string, rows: number }>
  /** Projects left alone because their owner is Pro. */
  keptPro: number
  /** Projects left alone because the plan was unknown or there is no owner. */
  skipped: number
  /** True when the row cap stopped the run with work left. Never set by a dry run. */
  capped: boolean
}

export const PRUNE_BATCH = 2000
export const PRUNE_MAX_ROWS = 500_000

export async function pruneFreeRetention(options: PruneOptions): Promise<PruneSummary> {
  const { store, planOf } = options
  const dryRun = options.dryRun === true
  const days = options.days ?? FREE_RETENTION_DAYS
  const batchSize = Math.max(1, options.batchSize ?? PRUNE_BATCH)
  const maxRows = Math.max(1, options.maxRows ?? PRUNE_MAX_ROWS)
  // A UTC day. `created_at` is `YYYY-MM-DD HH:MM:SS[.mmm]` in UTC, written by
  // the server, so the bare day is a valid exclusive upper bound on SQLite
  // (string order) and on PostgreSQL (midnight of that day).
  const cutoff = cutoffDay(options.now ?? new Date(), days)
  const summary: PruneSummary = { dryRun, cutoff, pruned: 0, rows: 0, projects: [], keptPro: 0, skipped: 0, capped: false }

  const plans = new Map<number, boolean | null>()
  for (const project of await store.projectsWithLinesBefore(cutoff)) {
    if (project.ownerId == null) {
      summary.skipped++
      continue
    }
    if (!plans.has(project.ownerId))
      plans.set(project.ownerId, await planOf(project.ownerId).catch(() => null))
    const pro = plans.get(project.ownerId)
    if (pro === true) {
      summary.keptPro++
      continue
    }
    // Strictly `false`. `null`, `undefined` or anything else is "not known to
    // be Free", and that is never enough to delete on.
    if (pro !== false) {
      summary.skipped++
      continue
    }

    let removed = 0
    if (dryRun) {
      removed = await store.countBefore(project.projectId, cutoff)
      summary.rows += removed
    }
    else {
      while (summary.rows < maxRows) {
        const went = await store.deleteBefore(project.projectId, cutoff, Math.min(batchSize, maxRows - summary.rows))
        removed += went
        summary.rows += went
        if (went < batchSize)
          break
      }
    }
    if (removed > 0) {
      summary.pruned++
      summary.projects.push({ projectId: project.projectId, rows: removed })
    }
    if (!dryRun && summary.rows >= maxRows) {
      summary.capped = true
      break
    }
  }
  return summary
}

async function rows(client: SqlClient, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const result = await (client.unsafe(sql, params) as PromiseLike<unknown>)
  return Array.isArray(result) ? result as Record<string, unknown>[] : []
}

/**
 * The store over `log_entries` and `projects`. `$n` placeholders and no
 * dialect-specific functions, like every other statement in this app. Every
 * predicate is on `created_at`: see the note at the top of this file.
 */
export function sqlRetentionStore(client: SqlClient): RetentionStore {
  return {
    async projectsWithLinesBefore(cutoff) {
      const found = await rows(
        client,
        `SELECT p.id AS project_id, p.owner_id AS owner_id FROM projects p
          WHERE EXISTS (SELECT 1 FROM log_entries l WHERE l.project_id = p.id AND l.created_at < $1)
          ORDER BY p.id`,
        [cutoff],
      )
      return found.map(row => ({
        projectId: String(row.project_id),
        ownerId: row.owner_id == null ? null : Number(row.owner_id),
      }))
    },
    async countBefore(projectId, cutoff) {
      const found = await rows(client, 'SELECT COUNT(*) AS n FROM log_entries WHERE project_id = $1 AND created_at < $2', [projectId, cutoff])
      return Number(found[0]?.n ?? 0)
    },
    async deleteBefore(projectId, cutoff, limit) {
      const size = Math.max(1, Math.floor(limit))
      const params = [projectId, cutoff]
      // Counted first, then deleted by id: neither RETURNING nor an affected
      // row count is something every driver behind `db.unsafe` reports.
      const doomed = await rows(
        client,
        `SELECT id FROM log_entries WHERE project_id = $1 AND created_at < $2 ORDER BY created_at, id LIMIT ${size}`,
        params,
      )
      if (!doomed.length)
        return 0
      await client.unsafe(
        `DELETE FROM log_entries WHERE id IN (
           SELECT id FROM log_entries WHERE project_id = $1 AND created_at < $2 ORDER BY created_at, id LIMIT ${size}
         )`,
        params,
      )
      return doomed.length
    },
  }
}
