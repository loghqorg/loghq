import type { SqlDialect } from '@stacksjs/hq/meter'
import { env } from '@stacksjs/env'

/**
 * The dialect of the database this process is connected to, for the
 * `@stacksjs/hq` SQL stores. They spell placeholders and upserts per dialect,
 * so they have to be told; everything else in this app binds values and stays
 * dialect-free (app/Support/time.ts).
 *
 * Same default as config/database.ts: SQLite when nothing is set.
 */
export function sqlDialect(connection: unknown = env.DB_CONNECTION): SqlDialect {
  const name = String(connection ?? '').toLowerCase()
  if (name === 'postgres' || name === 'postgresql' || name === 'pgsql')
    return 'postgres'
  if (name === 'mysql' || name === 'mariadb')
    return 'mysql'
  return 'sqlite'
}
