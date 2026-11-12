import { db } from '@stacksjs/database'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { archiveConfig } from '../Archive/config'
import { FREE_RETENTION_DAYS } from '../Billing/plans'
import { planForPrune } from '../Billing/pro'
import { pruneFreeRetention, retentionMode, sqlRetentionStore } from '../Billing/retention'

/**
 * Nightly: remove Free projects' log lines that are past the retention window
 * (app/Billing/plans.ts). The rule and its safety limits are in
 * app/Billing/retention.ts; this is the scheduled shell around it.
 *
 * Does nothing unless `RETENTION_PRUNE_ENABLED` says otherwise:
 *
 *   unset / false   nothing runs, nothing is read
 *   dry-run         counts what would be removed, per project, and logs it
 *   true            removes it
 *
 * Off by default because the first run on an existing install is the first
 * time anything is ever deleted for its Free projects. Run `dry-run` for a
 * night, read the counts, then switch it on.
 *
 * Stands down when the archive is on. That run already prunes Free projects,
 * through a ledger and with a grace period for somebody who upgrades this
 * week (app/Archive/exporter.ts), and two jobs deleting the same rows would
 * leave the ledger describing partitions it never saw go.
 */
export default new Job({
  name: 'PruneFreeRetention',
  description: 'Delete Free projects\' log lines older than the retention window',
  queue: 'maintenance',
  tries: 1,
  backoff: 0,
  timeout: 1800,

  async handle() {
    const mode = retentionMode()
    if (mode === 'off')
      return

    if (archiveConfig().enabled) {
      log.info('[retention] archive is enabled and prunes Free projects itself, nothing to do')
      return
    }

    const dryRun = mode === 'dry-run'
    const summary = await pruneFreeRetention({ store: sqlRetentionStore(db), planOf: planForPrune, dryRun })
    const verb = dryRun ? 'would be removed' : 'removed'
    log.info(
      `[retention]${dryRun ? ' DRY RUN, nothing deleted.' : ''} ${FREE_RETENTION_DAYS}-day window, stored before ${summary.cutoff}: `
      + `${summary.rows} lines ${verb} from ${summary.pruned} Free projects, `
      + `${summary.keptPro} Pro projects kept, ${summary.skipped} skipped (plan unknown or no owner)`,
    )
    for (const project of summary.projects)
      log.info(`[retention]   ${project.projectId}: ${project.rows} lines ${verb}`)
    if (summary.capped)
      log.warn('[retention] stopped at the per-run row cap, the next run continues')
  },
})
