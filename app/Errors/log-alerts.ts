import type { LogRow } from '../Logs/normalize'
import type { SeenStore } from './alert-state'
import type { AlertIssue } from './alerts'
import process from 'node:process'
import { db } from '@stacksjs/database'
import { fingerprintOf } from '../Fix/fingerprint'
import { appUrl } from '../Support/urls'
import { sqlSeenStore } from './alert-state'
import { dispatchAlerts } from './alerts'
import { allowAlert } from './limits'

/**
 * Which log lines are worth interrupting a person for, and when.
 *
 * loghq stores a flat stream and groups nothing, so there is no "issue" whose
 * first occurrence can trigger an alert the way an error tracker has. What
 * there is: a level on every line, and a fingerprint that makes the same
 * failure with different ids in it the same line (app/Fix/fingerprint.ts).
 * An alert fires the first time a fingerprint at `error` or above is stored
 * for a project, and then not again for that fingerprint for a day.
 *
 * **Off unless `LOG_ALERTS_ENABLED=true`.** Alert channels and owner emails
 * existed long before anything called them, so switching delivery on is the
 * moment every existing project owner starts receiving mail. That is a
 * decision for a person to make, not a side effect of a deploy.
 *
 * Which fingerprints have alerted is kept in `log_alert_states`
 * (app/Errors/alert-state.ts), so a restart or a deploy does not re-send.
 *
 * Bounded three ways, because the ingest key is public and anything on this
 * path can be driven by a script:
 * - at most `MAX_ALERTS_PER_BATCH` distinct fingerprints are considered per
 *   request;
 * - `allowAlert` caps deliveries per project per hour, whatever got this far;
 * - once a project hits that cap, it is not looked at again for a minute, so
 *   a flood of distinct errors cannot turn into a statement per request.
 */

/** `LOG_ALERTS_ENABLED`: only `true` (or `1`, `on`, `yes`) sends anything. */
export function alertsEnabled(value: unknown = process.env.LOG_ALERTS_ENABLED): boolean {
  return ['true', '1', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase())
}

export const ALERT_LEVELS: ReadonlySet<string> = new Set(['error', 'critical', 'alert', 'emergency'])
export const MAX_ALERTS_PER_BATCH = 3
/** How long a project is left alone after it hits the hourly cap. */
export const CAPPED_BACKOFF_MS = 60_000
const MAX_TITLE = 200

export interface AlertCandidate {
  fingerprint: string
  issue: AlertIssue
}

function titleOf(message: string): string {
  const firstLine = String(message ?? '').split('\n', 1)[0]!.trim()
  return firstLine.length > MAX_TITLE ? `${firstLine.slice(0, MAX_TITLE - 3)}...` : firstLine || '(no message)'
}

/**
 * The lines in a stored batch that could alert: error or above, one per
 * fingerprint, the first few only. Pure.
 */
export function alertCandidates(projectId: string, rows: LogRow[], base: string = appUrl()): AlertCandidate[] {
  const found = new Map<string, AlertCandidate>()
  for (const row of rows) {
    if (found.size >= MAX_ALERTS_PER_BATCH)
      break
    const level = String(row.level ?? '').toLowerCase()
    if (!ALERT_LEVELS.has(level))
      continue
    const fingerprint = fingerprintOf(row)
    if (found.has(fingerprint))
      continue
    found.set(fingerprint, {
      fingerprint,
      issue: {
        id: row.id,
        title: titleOf(row.message),
        culprit: row.channel,
        level,
        environment: row.environment,
        url: `${base}/dashboard?project=${encodeURIComponent(projectId)}`,
      },
    })
  }
  return [...found.values()]
}

export interface LogAlertDeps {
  enabled: () => boolean
  seen: SeenStore
  /** The per-project hourly cap. */
  allow: (projectId: string) => Promise<boolean>
  dispatch: (projectId: string, issue: AlertIssue, kind: 'new') => Promise<void>
  now?: () => number
}

const defaults: LogAlertDeps = {
  enabled: alertsEnabled,
  seen: sqlSeenStore(db),
  allow: allowAlert,
  dispatch: dispatchAlerts,
}

/** Projects over the hourly cap, and until when to leave them alone. */
const capped = new Map<string, number>()

/**
 * Alert on what is new in a batch that was just stored. Answers how many
 * alerts went out. Never throws: the ingest calls this without awaiting it,
 * and nothing about delivery may reach the response.
 */
export async function fireLogAlerts(projectId: string, rows: LogRow[], deps: LogAlertDeps = defaults): Promise<number> {
  let sent = 0
  try {
    if (!deps.enabled())
      return 0
    const at = (deps.now ?? Date.now)()
    const backoff = capped.get(projectId)
    if (backoff !== undefined) {
      if (at < backoff)
        return 0
      capped.delete(projectId)
    }

    for (const candidate of alertCandidates(projectId, rows)) {
      if (!(await deps.seen.claim(projectId, candidate.fingerprint, at)))
        continue
      // Over the hourly cap: nothing later in this batch will pass either.
      // The fingerprint is released so it can alert once the cap lifts,
      // instead of staying quiet for a day over an alert nobody received.
      if (!(await deps.allow(projectId))) {
        await deps.seen.release(projectId, candidate.fingerprint)
        capped.set(projectId, at + CAPPED_BACKOFF_MS)
        break
      }
      await deps.dispatch(projectId, candidate.issue, 'new')
      sent++
    }
  }
  catch (error) {
    console.error('[alerts] log alert failed:', error instanceof Error ? error.message : error)
  }
  return sent
}
