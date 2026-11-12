import type { SqlClient } from '@stacksjs/hq/meter'

/**
 * Which errors have already alerted, kept where a restart cannot lose it.
 *
 * `claim` answers "is this the first time this fingerprint is seen on this
 * project inside the quiet window?" and records that it was, in one step. The
 * record is the `log_alert_states` table (0000000030), so a deploy, a crash
 * or a second instance does not send the alert again.
 *
 * In front of the table sits a small per-process memory. It only ever says
 * "quiet", never "new": a fingerprint this process has already asked about is
 * answered without a query, which is what keeps an error storm from turning
 * into a statement per line. Anything it does not know goes to the table.
 *
 * No transactions and no affected-row counts are relied on, because not every
 * driver behind `db.unsafe` reports them. The upsert only overwrites a row
 * whose quiet window has passed, and writes a random token as it does. The
 * caller whose token is in the row afterwards is the one that alerts. Two
 * instances racing on the same new error therefore send one alert, not two.
 */

export interface SeenStore {
  /** True for exactly one caller per (project, fingerprint) per quiet window. */
  claim: (projectId: string, fingerprint: string, at: number) => Promise<boolean>
  /** Undo a claim whose alert was never delivered, so it can alert later. */
  release: (projectId: string, fingerprint: string) => Promise<void>
}

/** How long a fingerprint stays quiet after it alerts. */
export const QUIET_MS = 24 * 60 * 60 * 1000
const MAX_REMEMBERED = 20_000
const SWEEP_EVERY_MS = 60 * 60 * 1000
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

const keyOf = (projectId: string, fingerprint: string): string => `${projectId}\u0000${fingerprint}`

/** The per-process memory on its own: tests, and the fallback when the table cannot be reached. */
export function createMemorySeenStore(quietMs: number = QUIET_MS, max: number = MAX_REMEMBERED): SeenStore & { quietUntil: (projectId: string, fingerprint: string) => number | undefined, remember: (projectId: string, fingerprint: string, until: number) => void } {
  const until = new Map<string, number>()
  const remember = (projectId: string, fingerprint: string, expiry: number): void => {
    const key = keyOf(projectId, fingerprint)
    // Re-inserting moves the key to the end, so eviction is oldest first.
    until.delete(key)
    until.set(key, expiry)
    if (until.size > max) {
      const oldest = until.keys().next().value
      if (oldest !== undefined)
        until.delete(oldest)
    }
  }
  return {
    quietUntil: (projectId, fingerprint) => until.get(keyOf(projectId, fingerprint)),
    remember,
    async claim(projectId, fingerprint, at) {
      const expiry = until.get(keyOf(projectId, fingerprint))
      if (expiry !== undefined && at < expiry)
        return false
      remember(projectId, fingerprint, at + quietMs)
      return true
    },
    async release(projectId, fingerprint) {
      until.delete(keyOf(projectId, fingerprint))
    },
  }
}

async function rows(client: SqlClient, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const result = await (client.unsafe(sql, params) as PromiseLike<unknown>)
  return Array.isArray(result) ? result as Record<string, unknown>[] : []
}

export interface SqlSeenStoreOptions {
  quietMs?: number
  onError?: (error: unknown) => void
}

/** The durable store over `log_alert_states`, with the memory in front of it. */
export function sqlSeenStore(client: SqlClient, options: SqlSeenStoreOptions = {}): SeenStore {
  const quietMs = options.quietMs ?? QUIET_MS
  const onError = options.onError ?? ((error) => {
    console.error('[alerts] alert state could not be stored:', error instanceof Error ? error.message : error)
  })
  const memory = createMemorySeenStore(quietMs)
  let sweptAt = 0

  async function sweep(at: number): Promise<void> {
    if (at - sweptAt < SWEEP_EVERY_MS)
      return
    sweptAt = at
    await client.unsafe('DELETE FROM log_alert_states WHERE alerted_at < $1', [at - KEEP_MS])
  }

  return {
    async claim(projectId, fingerprint, at) {
      const known = memory.quietUntil(projectId, fingerprint)
      if (known !== undefined && at < known)
        return false

      try {
        const token = globalThis.crypto.randomUUID()
        // Insert, or take over a row whose quiet window has passed. A row
        // still inside its window is left exactly as it is.
        await client.unsafe(
          `INSERT INTO log_alert_states (project_id, fingerprint, alerted_at, claim) VALUES ($1, $2, $3, $4)
            ON CONFLICT (project_id, fingerprint) DO UPDATE SET alerted_at = $5, claim = $6
            WHERE log_alert_states.alerted_at <= $7`,
          [projectId, fingerprint, at, token, at, token, at - quietMs],
        )
        const row = (await rows(client, 'SELECT alerted_at, claim FROM log_alert_states WHERE project_id = $1 AND fingerprint = $2', [projectId, fingerprint]))[0]
        const alertedAt = Number(row?.alerted_at ?? at)
        // Whoever holds the row, this process now knows when it goes quiet.
        memory.remember(projectId, fingerprint, alertedAt + quietMs)
        await sweep(at).catch(onError)
        return row?.claim === token
      }
      catch (error) {
        // The table is unreachable. Fall back to what this process remembers
        // rather than going silent: the hourly cap still bounds what is sent.
        onError(error)
        return memory.claim(projectId, fingerprint, at)
      }
    },
    async release(projectId, fingerprint) {
      await memory.release(projectId, fingerprint)
      try {
        // Zero is always outside the window, so the next sighting claims it.
        await client.unsafe('UPDATE log_alert_states SET alerted_at = 0, claim = NULL WHERE project_id = $1 AND fingerprint = $2', [projectId, fingerprint])
      }
      catch (error) {
        onError(error)
      }
    },
  }
}
