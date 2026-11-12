import { db } from '@stacksjs/database'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { archiveConfig } from '../Archive/config'
import { FREE_RETENTION_DAYS } from '../Billing/plans'
import { knownPlan } from '../Billing/pro'
import { pruneFreeRetention, sqlRetentionStore } from '../Billing/retention'

/**
 * Nightly: remove Free projects' log lines that are past the retention window
 * (app/Billing/plans.ts). The rule and its safety limits are in
 * app/Billing/retention.ts; this is the scheduled shell around it.
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
    if (archiveConfig().enabled) {
      log.info('[retention] archive is enabled and prunes Free projects itself, nothing to do')
      return
    }

    const summary = await pruneFreeRetention({ store: sqlRetentionStore(db), planOf: knownPlan })
    log.info(
      `[retention] ${FREE_RETENTION_DAYS}-day window, cutoff ${summary.cutoff}: `
      + `${summary.rows} lines removed from ${summary.pruned} Free projects, `
      + `${summary.keptPro} Pro projects kept, ${summary.skipped} skipped`,
    )
    if (summary.capped)
      log.warn('[retention] stopped at the per-run row cap, the next run continues')
  },
})
