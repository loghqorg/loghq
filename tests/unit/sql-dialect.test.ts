/**
 * The SQL this app issues has to run on the database this app actually uses.
 *
 * loghq runs SQLite in production (DB_CONNECTION=sqlite), and seven statements
 * were written in Postgres dialect: `NOW()`, `AT TIME ZONE 'UTC'`, and
 * `($n || ' hours')::interval`. None of those exist in SQLite. `NOW()` raises
 * `no such function: NOW` and `AT TIME ZONE` is a parse error, so the statements
 * did not degrade, they threw.
 *
 * That is why `log_fix_runs` held zero rows on production: "Fix with AI" could
 * not insert the run it had just started, so the feature could never complete a
 * single analysis. Rotate-key, archive and channel-enable had the same defect.
 *
 * Nothing caught it because the dialect only matters at execution: it type-checks,
 * it lints, it passes review, and it is correct against the Postgres the code was
 * presumably written on. So this file pins the two things that keep it fixed.
 */
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { utcHoursAgo, utcNow } from '../../app/Support/time'

const ROOT = join(import.meta.dir, '..', '..')

/** The columns these statements touch, enough to execute them for real. */
function schema(): Database {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE log_fix_runs (
    id varchar(255) PRIMARY KEY,
    project_id varchar(255) NOT NULL,
    log_entry_id varchar(255) NOT NULL,
    fingerprint varchar(64) NOT NULL,
    created_by integer,
    status varchar(32) NOT NULL DEFAULT 'queued',
    provider varchar(32),
    started_at timestamp,
    completed_at timestamp,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp
  )`)
  return db
}

describe('timestamps are written in a dialect SQLite accepts', () => {
  test('the format matches what CURRENT_TIMESTAMP itself produces', () => {
    const db = new Database(':memory:')
    const native = db.query('SELECT CURRENT_TIMESTAMP AS t').get() as { t: string }
    // Same shape, or a string comparison between a stored default and a bound
    // value is comparing two different formats and silently ordering wrong.
    expect(utcNow()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(native.t).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  test('the Postgres form really does fail, which is the whole bug', () => {
    const db = new Database(':memory:')
    expect(() => db.query('SELECT NOW() AS t').get()).toThrow(/no such function: NOW/i)
    expect(() => db.query("SELECT (NOW() AT TIME ZONE 'UTC') AS t").get()).toThrow()
  })

  test('the insert "Fix with AI" starts a run with executes', () => {
    const db = schema()
    const now = utcNow()
    db.run(
      `INSERT INTO log_fix_runs (id, project_id, log_entry_id, fingerprint, created_by, status, provider, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      ['run_1', 'proj_1', 'entry_1', 'fp_1', 1, 'anthropic', now, now],
    )
    const row = db.query('SELECT * FROM log_fix_runs WHERE id = ?').get('run_1') as any
    expect(row.status).toBe('running')
    expect(row.started_at).toBe(now)
  })

  test('the cache window compares as a bound value, not an interval cast', () => {
    const db = schema()
    const fresh = utcNow()
    const stale = utcHoursAgo(72)
    for (const [id, created] of [['fresh', fresh], ['stale', stale]] as const) {
      db.run(
        `INSERT INTO log_fix_runs (id, project_id, log_entry_id, fingerprint, status, created_at)
         VALUES (?, 'proj_1', 'entry_1', 'fp_1', 'completed', ?)`,
        [id, created],
      )
    }
    // The real query shape, with a 48 hour window: the fresh run is served from
    // cache and the 72-hour-old one is not.
    const rows = db.query(
      `SELECT id FROM log_fix_runs
       WHERE project_id = ? AND fingerprint = ?
         AND (status IN ('queued', 'running') OR created_at > ?)
       ORDER BY created_at DESC`,
    ).all('proj_1', 'fp_1', utcHoursAgo(48)) as Array<{ id: string }>
    expect(rows.map(r => r.id)).toEqual(['fresh'])
  })
})

describe('no statement reintroduces the Postgres-only forms', () => {
  test('app/ and routes/ issue no NOW() or AT TIME ZONE in SQL', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(path)
          continue
        }
        if (!entry.name.endsWith('.ts'))
          continue
        readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
          // Comments describe the bug on purpose; only executable SQL counts.
          const code = line.trim()
          if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*'))
            return
          if (/NOW\(\)|AT TIME ZONE|::interval/.test(line))
            offenders.push(`${path.replace(`${ROOT}/`, '')}:${i + 1}`)
        })
      }
    }
    walk(join(ROOT, 'app'))
    walk(join(ROOT, 'routes'))
    expect(offenders).toEqual([])
  })
})
