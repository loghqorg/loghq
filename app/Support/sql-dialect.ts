import type { SqlClient, SqlDialect } from '@stacksjs/hq/meter'
import { env } from '@stacksjs/env'

/**
 * Which SQL dialect the `@stacksjs/hq` stores should speak.
 *
 * They spell placeholders and upserts per dialect, so they have to be told.
 * Everything else in this app binds `$n` values and stays dialect-free
 * (app/Support/time.ts).
 *
 * This app runs SQLite in local development and has run both SQLite and
 * PostgreSQL in production, and the repository's own documents disagree about
 * which it is now. So the answer is not taken from configuration on trust: it
 * is asked of the database the process is actually connected to
 * (`detectDialect`), and `DB_CONNECTION` is only the fallback for when that
 * question cannot be answered.
 */

/** The dialect a `DB_CONNECTION` value names. SQLite when nothing recognisable is set, as in config/database.ts. */
export function sqlDialect(connection: unknown = env.DB_CONNECTION): SqlDialect {
  const name = String(connection ?? '').trim().toLowerCase()
  if (name.startsWith('postgres') || name === 'pg' || name === 'pgsql' || name === 'psql' || name === 'cockroachdb' || name === 'neon' || name === 'supabase')
    return 'postgres'
  if (name.startsWith('mysql') || name === 'mariadb' || name === 'singlestore' || name === 'planetscale' || name === 'tidb')
    return 'mysql'
  return 'sqlite'
}

/**
 * Ask the database what it is.
 *
 * One statement that is valid on all three and answers differently on each,
 * so nothing is raised and nothing is logged as a failed query at boot:
 *
 *   loose = (1 = '1')    SQLite compares an integer with text and says no.
 *                        PostgreSQL and MySQL coerce the literal and say yes.
 *   ci    = ('a' = 'A')  MySQL's default collation ignores case. The other
 *                        two do not.
 */
export async function detectDialect(client: SqlClient, fallback: SqlDialect = sqlDialect()): Promise<SqlDialect> {
  try {
    const result = await (client.unsafe('SELECT (1 = \'1\') AS loose, (\'a\' = \'A\') AS ci') as PromiseLike<unknown>)
    const row = Array.isArray(result) ? result[0] as Record<string, unknown> | undefined : undefined
    if (!row || !('loose' in row))
      return fallback
    const truthy = (value: unknown): boolean => value === true || value === 1 || value === 1n || value === '1' || value === 't' || value === 'true'
    if (!truthy(row.loose))
      return 'sqlite'
    return truthy(row.ci) ? 'mysql' : 'postgres'
  }
  catch {
    return fallback
  }
}

/**
 * A store that is built on first use, once the dialect is known.
 *
 * The package's stores take their dialect at construction, which happens at
 * module load, before anything may be awaited. Every method of those stores
 * is async, so each call can wait for the one build and then pass through.
 */
export function deferredStore<T extends object>(build: () => Promise<T>): T {
  let built: Promise<T> | undefined
  const ready = (): Promise<T> => (built ??= build().catch((error) => {
    // Do not cache a failure: the next call tries again.
    built = undefined
    throw error
  }))
  return new Proxy({} as T, {
    get(_target, property) {
      return async (...args: unknown[]) => {
        const store = await ready() as Record<PropertyKey, (...a: unknown[]) => unknown>
        return store[property]!(...args)
      }
    },
  })
}
