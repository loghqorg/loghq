import type { CLI } from '@stacksjs/types'
// triggered via `buddy archive:run`
import process from 'node:process'
import { ExitCode } from '@stacksjs/types'
import { planRun, runArchiveIfEnabled } from '../Archive/exporter'
import { archiveConfig, archiveReady } from '../Archive/config'

/**
 * Run the log archive by hand.
 *
 * The nightly job (app/Jobs/ArchiveAgedLogs.ts) is the normal path. This command
 * exists for the two moments that one is awkward: proving a new bucket before
 * trusting the scheduler with it, and working out on the server why last night's
 * run did not do what was expected.
 *
 * `--dry-run` is the safe default habit: it reports the partitions a real run
 * would touch and which plan each project is on, and writes nothing.
 */
interface ArchiveRunOptions {
  dryRun?: boolean
  project?: string
  day?: string
}

export default function (cli: CLI) {
  cli
    .command('archive:run', 'Export aged log partitions to Parquet, then trim the hot database')
    .option('--dry-run', 'Report what would happen without changing anything', { default: false })
    .option('--project <id>', 'Restrict the run to one project')
    .option('--day <YYYY-MM-DD>', 'Restrict the run to one UTC day')
    .action(async (options: ArchiveRunOptions) => {
      const cfg = archiveConfig()

      if (options.dryRun) {
        // Deliberately does not gate on cfg.enabled: seeing what a run would do
        // is exactly what you want before switching it on.
        const problem = archiveReady(cfg)
        if (problem)
          console.log(`warning: ${problem}\n`)

        const plans = await planRun({ cfg, projectId: options.project, day: options.day })

        if (!plans.length) {
          console.log(`Nothing has aged out of the ${cfg.hotWindowDays} day hot window.`)
          process.exit(ExitCode.Success)
        }

        console.log(`${plans.length} partitions would be processed:\n`)
        for (const p of plans)
          console.log(`  ${p.plan === 'pro' ? 'archive' : 'prune  '}  ${p.projectId}  ${p.day}  ${p.rows} rows${p.reclaim ? '  (reclaim)' : ''}`)

        console.log(`\nDelete after verify: ${cfg.deleteAfterVerify ? 'yes' : 'no'}`)
        process.exit(ExitCode.Success)
      }

      const summary = await runArchiveIfEnabled({ cfg, projectId: options.project, day: options.day })

      if (!summary) {
        // runArchiveIfEnabled logs the reason (switched off, or missing config).
        process.exit(ExitCode.FatalError)
      }

      console.log(
        `${summary.partitions} partitions: ${summary.exported} exported, ${summary.pruned} pruned, `
        + `${summary.failed} failed, ${summary.skipped} skipped (${summary.rows} rows)`,
      )

      process.exit(summary.failed ? ExitCode.FatalError : ExitCode.Success)
    })
}
