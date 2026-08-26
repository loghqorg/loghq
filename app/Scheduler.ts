import process from 'node:process'
import { schedule } from '@stacksjs/scheduler'

/**
 * **Scheduler**
 *
 * Define your scheduled tasks here. Jobs, actions, and shell commands
 * can all be scheduled with a fluent, expressive API.
 *
 * @see https://docs.stacksjs.com/scheduling
 */
export default function () {
  // Run the Inspire job every hour
  schedule
    .job('Inspire')
    .hourly()
    .setTimeZone('America/Los_Angeles')

  // Move aged log partitions out of the hot database: Pro projects to Parquet
  // on object storage, free projects pruned. See app/Archive/.
  //
  // UTC rather than a local zone because the partitions themselves are UTC days,
  // so a run at 03:10 UTC is always working on days that closed hours ago
  // whatever the season. 03:10 is quiet, and off the hour to avoid piling onto
  // whatever else the box starts at :00.
  //
  // withoutOverlapping because a first run against a long backlog can take far
  // longer than a day's worth of exports, and two passes claiming the same
  // partitions would just contend on the ledger.
  schedule
    .job('ArchiveAgedLogs')
    .daily()
    .at('03:10')
    .setTimeZone('UTC')
    .withoutOverlapping(120)

  // Run a custom action every five minutes
  // schedule.action('CleanupTempFiles').everyFiveMinutes()

  // Run a shell command daily at midnight
  // schedule.command('echo "Daily maintenance complete"').daily()
}

process.on('SIGINT', () => {
  schedule.gracefulShutdown().then(() => process.exit(0))
})
