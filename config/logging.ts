import type { LoggingConfig } from '@stacksjs/types'
import { bughqTransport } from '@bughq/stacks'
import { env } from '@stacksjs/env'
import { storagePath } from '@stacksjs/path'

/**
 * **Logging Configuration**
 *
 * This configuration defines all of your logging options. Because Stacks is fully-typed, you
 * may hover any of the options below and the definitions will be provided. In case you
 * have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  /**
   * **Log File Path**
   *
   * The path to the log file. This will be used to write logs to a file. If you do not want to
   * write logs to a file, you may set this to `null`.
   *
   * @default 'storage/logs/stacks.log'
   */
  logsPath: storagePath('logs/stacks.log'),

  /**
   * **Deployments Path**
   *
   * The path to the deployments folder. This will be used to write deployment logs to a file.
   * If you do not want to write deployment logs to a file, you may set this to `null`.
   *
   * @default 'storage/logs/deployments.log'
   */
  deploymentsPath: storagePath('logs/deployments.log'),

  /**
   * **Transports**
   *
   * Destinations for log records, alongside the console and the log file. The
   * framework calls each one for every `log.*` call, so nothing here changes a
   * single call site.
   *
   * bughq is declared unconditionally. With no `BUGHQ_KEY` the client marks
   * itself disabled on construction and drops everything, silently - the
   * missing-key warning is behind its `debug` flag - so this is safe in local
   * dev and in CI with no env setup at all.
   *
   * What it does, which is not what a log transport usually does: records at
   * `error` and above become bughq ISSUES, and everything below is retained as
   * a breadcrumb, 30 per trace, attached to the next issue. So the lines
   * leading up to a failure travel with the failure. The transport deliberately
   * attaches with no `level` of its own, because the breadcrumbs depend on
   * seeing records the console would filter out.
   *
   * `capture.unhandled` is left at its default of false on purpose: the built
   * server entry installs its own process handlers, and a second set would
   * double-report. Queue workers install none, so a worker entry that wants
   * crash coverage has to opt in.
   *
   * Note this is loghq reporting to bughq, not to itself. Self-ingest is a
   * separate question with a loop hazard, and is deliberately not what this is.
   */
  transports: [
    bughqTransport({
      key: env.BUGHQ_KEY,
      host: env.BUGHQ_HOST || undefined,
      environment: env.APP_ENV,
    }),
  ],
} satisfies LoggingConfig
