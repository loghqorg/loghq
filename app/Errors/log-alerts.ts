import type { LogRow } from '../Logs/normalize'
import type { AlertIssue } from './alerts'
import { fingerprintOf } from '../Fix/fingerprint'
import { appUrl } from '../Support/urls'
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
 * Bounded three ways, because the ingest key is public and anything on this
 * path can be driven by a script:
 * - at most `MAX_ALERTS_PER_BATCH` distinct fingerprints are considered per
 *   request;
 * - the memory of what has been seen is capped, oldest dropped first;
 * - `allowAlert` caps deliveries per project per hour, whatever got this far.
 *
 * The memory is per process. After a restart, or on a second instance, an
 * error that is still happening alerts once more. That is the price of
 * storing no grouping state, and the hourly cap bounds it.
 */

export const ALERT_LEVELS: ReadonlySet<string> = new Set(['error', 'critical', 'alert', 'emergency'])
export const MAX_ALERTS_PER_BATCH = 3
/** How long a fingerprint stays quiet after it alerts. */
export const QUIET_MS = 24 * 60 * 60 * 1000
const MAX_REMEMBERED = 20_000
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

export interface SeenStore {
  /** True the first time a key is offered inside the quiet window, false after. */
  firstSeen: (key: string, at: number) => boolean
  /** Undo a `firstSeen` whose alert was never delivered. */
  forget: (key: string) => void
}

/** A capped, per-process memory of which fingerprints alerted recently. */
export function createSeenStore(quietMs: number = QUIET_MS, max: number = MAX_REMEMBERED): SeenStore {
  const until = new Map<string, number>()
  return {
    firstSeen(key, at) {
      const expiry = until.get(key)
      if (expiry !== undefined && at < expiry)
        return false
      // Re-inserting moves the key to the end, so eviction is oldest first.
      until.delete(key)
      until.set(key, at + quietMs)
      if (until.size > max) {
        const oldest = until.keys().next().value
        if (oldest !== undefined)
          until.delete(oldest)
      }
      return true
    },
    forget(key) {
      until.delete(key)
    },
  }
}

export interface LogAlertDeps {
  seen: SeenStore
  /** The per-project hourly cap. */
  allow: (projectId: string) => Promise<boolean>
  dispatch: (projectId: string, issue: AlertIssue, kind: 'new') => Promise<void>
  now?: () => number
}

const defaults: LogAlertDeps = {
  seen: createSeenStore(),
  allow: allowAlert,
  dispatch: dispatchAlerts,
}

/**
 * Alert on what is new in a batch that was just stored. Answers how many
 * alerts went out. Never throws: the ingest calls this without awaiting it,
 * and nothing about delivery may reach the response.
 */
export async function fireLogAlerts(projectId: string, rows: LogRow[], deps: LogAlertDeps = defaults): Promise<number> {
  let sent = 0
  try {
    const at = (deps.now ?? Date.now)()
    for (const candidate of alertCandidates(projectId, rows)) {
      const key = `${projectId}\u0000${candidate.fingerprint}`
      if (!deps.seen.firstSeen(key, at))
        continue
      // Over the hourly cap: nothing later in this batch will pass either.
      // The fingerprint is released so it can alert once the cap lifts,
      // instead of staying quiet for a day over an alert nobody received.
      if (!(await deps.allow(projectId))) {
        deps.seen.forget(key)
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
