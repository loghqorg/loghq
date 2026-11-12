import type { SqlClient } from '@stacksjs/hq/meter'
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
 * Three rules worth knowing before changing it:
 *
 * - **Only a project whose owner is KNOWN to be Free is pruned.** A plan that
 *   could not be determined is skipped, never treated as Free. Guessing wrong
 *   on the ingest costs a sampled line; guessing wrong here deletes a paying
 *   customer's history.
 * - **A project with no owner is skipped.** Nobody is on a plan, so no plan's
 *   retention applies.
 * - **Deletes are batched and the run is capped.** The first run on an old
 *   install has every Free project's backlog to remove, and one statement
 *   over all of it would hold SQLite's write lock against live ingest. What a
 *   capped run leaves behind, tomorrow's run takes.
 */

export interface RetentionProject {
  projectId: string
  ownerId: number | null
}

export interface RetentionStore {
  /** Projects holding at least one line older than `cutoff`. */
  projectsWithLinesBefore: (cutoff: string) => Promise<RetentionProject[]>
  /** Delete up to `limit` of a project's lines older than `cutoff`; answer how many went. */
  deleteBefore: (projectId: string, cutoff: string, limit: number) => Promise<number>
}

export interface PruneOptions {
  store: RetentionStore
  /** `true` Pro, `false` Free, `null` could not tell. */
  planOf: (ownerId: number) => Promise<boolean | null>
  now?: Date
  days?: number
  batchSize?: number
  /** Most rows one run removes across all projects. */
  maxRows?: number
}

export interface PruneSummary {
  /** The first day kept, `YYYY-MM-DD`. Everything before it is out of the window. */
  cutoff: string
  /** Projects that had lines removed. */
  pruned: number
  rows: number
  /** Projects left alone because their owner is Pro. */
  keptPro: number
  /** Projects left alone because the plan was unknown or there is no owner. */
  skipped: number
  /** True when the row cap stopped the run with work left. */
  capped: boolean
}

export const PRUNE_BATCH = 2000
export const PRUNE_MAX_ROWS = 500_000

export async function pruneFreeRetention(options: PruneOptions): Promise<PruneSummary> {
  const { store, planOf } = options
  const days = options.days ?? FREE_RETENTION_DAYS
  const batchSize = Math.max(1, options.batchSize ?? PRUNE_BATCH)
  const maxRows = Math.max(1, options.maxRows ?? PRUNE_MAX_ROWS)
  // A UTC day, compared as a string against the ISO-8601 `timestamp` column:
  // the same boundary the archive uses (app/Archive/partitions.ts).
  const cutoff = cutoffDay(options.now ?? new Date(), days)
  const summary: PruneSummary = { cutoff, pruned: 0, rows: 0, keptPro: 0, skipped: 0, capped: false }

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
    if (pro !== false) {
      summary.skipped++
      continue
    }

    let removed = 0
    while (summary.rows < maxRows) {
      const went = await store.deleteBefore(project.projectId, cutoff, Math.min(batchSize, maxRows - summary.rows))
      removed += went
      summary.rows += went
      if (went < batchSize)
        break
    }
    if (removed > 0)
      summary.pruned++
    if (summary.rows >= maxRows) {
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
 * dialect-specific functions, like every other statement in this app.
 */
export function sqlRetentionStore(client: SqlClient): RetentionStore {
  return {
    async projectsWithLinesBefore(cutoff) {
      const found = await rows(
        client,
        `SELECT p.id AS project_id, p.owner_id AS owner_id FROM projects p
          WHERE EXISTS (SELECT 1 FROM log_entries l WHERE l.project_id = p.id AND l.timestamp < $1)
          ORDER BY p.id`,
        [cutoff],
      )
      return found.map(row => ({
        projectId: String(row.project_id),
        ownerId: row.owner_id == null ? null : Number(row.owner_id),
      }))
    },
    async deleteBefore(projectId, cutoff, limit) {
      const size = Math.max(1, Math.floor(limit))
      const params = [projectId, cutoff]
      // Counted first, then deleted by id: neither RETURNING nor an affected
      // row count is something every driver behind `db.unsafe` reports.
      const doomed = await rows(
        client,
        `SELECT id FROM log_entries WHERE project_id = $1 AND timestamp < $2 LIMIT ${size}`,
        params,
      )
      if (!doomed.length)
        return 0
      await client.unsafe(
        `DELETE FROM log_entries WHERE id IN (
           SELECT id FROM log_entries WHERE project_id = $1 AND timestamp < $2 LIMIT ${size}
         )`,
        params,
      )
      return doomed.length
    },
  }
}
