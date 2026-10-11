import { Database } from 'bun:sqlite'
import { realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute } from 'node:path'

interface E2EEnvironment {
  E2E_RUN?: string
  E2E_BASE_URL?: string
  E2E_SQLITE_PATH?: string
}

export interface E2ETarget {
  baseUrl: string
  sqlitePath: string
}

export function e2eUrl(target: E2ETarget | null, path: string): string {
  if (!target)
    throw new Error('Mutating E2E tests are disabled. See tests/e2e/README.md.')
  const resolved = new URL(path, target.baseUrl)
  if (resolved.origin !== target.baseUrl)
    throw new Error('E2E requests cannot leave the configured loopback origin.')
  return resolved.href
}

export function cleanupE2EAccounts(target: E2ETarget | null, emails: ReadonlySet<string>): void {
  if (!target || emails.size === 0)
    return
  const checked = validateE2ETarget({ E2E_RUN: '1', E2E_BASE_URL: target.baseUrl, E2E_SQLITE_PATH: target.sqlitePath })!
  const db = new Database(checked.sqlitePath, { readwrite: true, create: false })
  try {
    db.transaction(() => {
      for (const email of emails) {
        db.query('DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email = ?)').run(email)
        db.query('DELETE FROM oauth_access_tokens WHERE user_id IN (SELECT id FROM users WHERE email = ?)').run(email)
        db.query('DELETE FROM users WHERE email = ?').run(email)
      }
    })()
  }
  finally {
    db.close()
  }
}

/** Never infer permission to mutate from an unrelated server being reachable. */
export function validateE2ETarget(env: E2EEnvironment): E2ETarget | null {
  if (env.E2E_RUN !== '1')
    return null

  let base: URL
  try {
    base = new URL(env.E2E_BASE_URL || '')
  }
  catch {
    throw new Error('E2E_RUN requires an explicit numeric-loopback HTTP origin.')
  }
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(base.hostname)
    || !base.port || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Mutating E2E tests only accept a numeric-loopback HTTP origin with an explicit port.')
  }

  const path = env.E2E_SQLITE_PATH || ''
  if (!isAbsolute(path) || basename(path) !== 'database.sqlite')
    throw new Error('E2E_SQLITE_PATH must name an existing disposable database.sqlite file.')

  // Resolve symlinks before checking containment. /tmp is /private/tmp on macOS.
  const sqlitePath = realpathSync(path)
  const directory = realpathSync(dirname(path))
  const roots = new Set([realpathSync(tmpdir()), realpathSync('/tmp')])
  if (dirname(sqlitePath) !== directory || basename(sqlitePath) !== 'database.sqlite'
    || !basename(directory).startsWith('loghq-e2e-')
    || !roots.has(dirname(directory)) || !statSync(sqlitePath).isFile()) {
    throw new Error('E2E database must be a regular file inside a loghq-e2e-* directory directly under the system temp directory.')
  }
  return { baseUrl: base.origin, sqlitePath }
}
