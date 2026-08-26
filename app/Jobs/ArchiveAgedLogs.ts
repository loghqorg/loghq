import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { runArchiveIfEnabled } from '../Archive/exporter'

/**
 * Nightly: move aged log partitions out of the hot database.
 *
 * Pro projects get their aged days written to Parquet on object storage and
 * verified before the originals are removed. Free projects get theirs pruned,
 * which is the 30-day retention the pricing page sells. All the work lives in
 * app/Archive/exporter.ts; this is the scheduled shell around it.
 *
 * `tries: 1` deliberately. This job is a coordinator over many partitions, and
 * retrying the whole pass would redo finished work to reach the one that broke.
 * Retry granularity is per partition instead: a failure is recorded in
 * archive_partitions and reclaimed by tomorrow's run. See claimPartition.
 */
export default new Job({
  name: 'ArchiveAgedLogs',
  description: 'Export aged log partitions to Parquet, verify them, then trim the hot database',
  queue: 'maintenance',
  tries: 1,
  backoff: 0,
  timeout: 3600,

  async handle() {
    const started = Date.now()
    const outcome = await runArchiveIfEnabled()

    // Switched off or misconfigured. runArchiveIfEnabled has already logged
    // which, so there is nothing to add.
    if (!outcome.ran)
      return

    const { summary } = outcome

    if (!summary.partitions) {
      log.info('[archive] nothing has aged out of the hot window')
      return
    }

    const seconds = Math.round((Date.now() - started) / 1000)
    const megabytes = (summary.bytes / 1024 / 1024).toFixed(1)

    log.info(
      `[archive] ${summary.partitions} partitions in ${seconds}s: `
      + `${summary.exported} exported, ${summary.pruned} pruned, `
      + `${summary.failed} failed, ${summary.skipped} skipped `
      + `(${summary.rows} rows, ${megabytes} MB)`,
    )

    if (summary.failed)
      log.warn(`[archive] ${summary.failed} partitions failed and will be retried on the next run`)
  },
})
