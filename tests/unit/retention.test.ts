import type { SqlClient } from '@stacksjs/hq/meter'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FREE_RETENTION_DAYS } from '../../app/Billing/plans'
import { pruneFreeRetention, sqlRetentionStore } from '../../app/Billing/retention'

const ROOT = join(import.meta.dir, '..', '..')
const NOW = new Date('2026-03-31T09:00:00.000Z')
// 30 days before 2026-03-31. Everything before this UTC day is out.
const CUTOFF = '2026-03-01'

/**
 * A real SQLite database with the two tables the prune reads, so the
 * statements are executed rather than trusted. `$n` is how the app binds and
 * `?n` is how bun:sqlite spells the same thing.
 */
function database(): { db: Database, client: SqlClient } {
  const db = new Database(':memory:')
  db.run('CREATE TABLE projects (id varchar(255) PRIMARY KEY, name varchar(255) NOT NULL, owner_id integer)')
  db.run('CREATE TABLE log_entries (id varchar(255) PRIMARY KEY, project_id varchar(255) NOT NULL, message text, timestamp varchar(255))')
  const client: SqlClient = {
    unsafe: async (sql, params = []) => {
      const statement = db.query(sql.replace(/\$(\d+)/g, '?$1'))
      return /^\s*select/i.test(sql) ? statement.all(...params as any[]) : (statement.run(...params as any[]), [])
    },
  }
  return { db, client }
}

let n = 0
function seed(db: Database, projectId: string, ownerId: number | null, timestamps: string[]): void {
  db.query('INSERT OR IGNORE INTO projects (id, name, owner_id) VALUES (?, ?, ?)').run(projectId, projectId, ownerId)
  for (const timestamp of timestamps)
    db.query('INSERT INTO log_entries (id, project_id, message, timestamp) VALUES (?, ?, ?, ?)').run(`log_${++n}`, projectId, 'line', timestamp)
}

const remaining = (db: Database, projectId: string): string[] =>
  (db.query('SELECT timestamp FROM log_entries WHERE project_id = ? ORDER BY timestamp').all(projectId) as { timestamp: string }[]).map(row => row.timestamp)

const plans = (table: Record<number, boolean | null>) => async (ownerId: number) => table[ownerId] ?? null

describe('free retention prune', () => {
  test('the window is the one the limits file sells', () => {
    expect(FREE_RETENTION_DAYS).toBe(30)
  })

  test('removes a free project\'s lines older than 30 days and keeps the rest', async () => {
    const { db, client } = database()
    seed(db, 'free-app', 1, ['2026-01-05T10:00:00.000Z', '2026-02-28T23:59:59.999Z', '2026-03-01T00:00:00.000Z', '2026-03-30T08:00:00.000Z'])

    const summary = await pruneFreeRetention({ store: sqlRetentionStore(client), planOf: plans({ 1: false }), now: NOW })

    expect(summary).toEqual({ cutoff: CUTOFF, pruned: 1, rows: 2, keptPro: 0, skipped: 0, capped: false })
    expect(remaining(db, 'free-app')).toEqual(['2026-03-01T00:00:00.000Z', '2026-03-30T08:00:00.000Z'])
  })

  test('never touches a paid project', async () => {
    const { db, client } = database()
    seed(db, 'pro-app', 2, ['2025-06-01T00:00:00.000Z', '2026-03-30T08:00:00.000Z'])
    seed(db, 'free-app', 1, ['2025-06-01T00:00:00.000Z'])

    const summary = await pruneFreeRetention({ store: sqlRetentionStore(client), planOf: plans({ 1: false, 2: true }), now: NOW })

    expect(summary).toMatchObject({ pruned: 1, rows: 1, keptPro: 1 })
    expect(remaining(db, 'pro-app')).toHaveLength(2)
    expect(remaining(db, 'free-app')).toEqual([])
  })

  test('a plan that could not be determined is skipped, never treated as free', async () => {
    const { db, client } = database()
    seed(db, 'unknown-app', 3, ['2025-06-01T00:00:00.000Z'])
    seed(db, 'throwing-app', 4, ['2025-06-01T00:00:00.000Z'])

    const summary = await pruneFreeRetention({
      store: sqlRetentionStore(client),
      planOf: async (ownerId) => {
        if (ownerId === 4)
          throw new Error('database is locked')
        return null
      },
      now: NOW,
    })

    expect(summary).toMatchObject({ pruned: 0, rows: 0, skipped: 2 })
    expect(remaining(db, 'unknown-app')).toHaveLength(1)
    expect(remaining(db, 'throwing-app')).toHaveLength(1)
  })

  test('a project with no owner is left alone', async () => {
    const { db, client } = database()
    seed(db, 'orphan', null, ['2025-06-01T00:00:00.000Z'])
    const summary = await pruneFreeRetention({ store: sqlRetentionStore(client), planOf: plans({}), now: NOW })
    expect(summary).toMatchObject({ rows: 0, skipped: 1 })
    expect(remaining(db, 'orphan')).toHaveLength(1)
  })

  test('deletes in batches until the project is clear', async () => {
    const { db, client } = database()
    seed(db, 'free-app', 1, Array.from({ length: 25 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`))
    seed(db, 'free-app', 1, ['2026-03-20T00:00:00.000Z'])

    const summary = await pruneFreeRetention({ store: sqlRetentionStore(client), planOf: plans({ 1: false }), now: NOW, batchSize: 10 })

    expect(summary).toMatchObject({ pruned: 1, rows: 25, capped: false })
    expect(remaining(db, 'free-app')).toEqual(['2026-03-20T00:00:00.000Z'])
  })

  test('a capped run stops early and the next one finishes', async () => {
    const { db, client } = database()
    seed(db, 'a-app', 1, Array.from({ length: 12 }, () => '2026-01-01T00:00:00.000Z'))
    seed(db, 'b-app', 1, Array.from({ length: 12 }, () => '2026-01-01T00:00:00.000Z'))
    const run = () => pruneFreeRetention({ store: sqlRetentionStore(client), planOf: plans({ 1: false }), now: NOW, batchSize: 5, maxRows: 15 })

    expect(await run()).toMatchObject({ rows: 15, capped: true })
    expect(await run()).toMatchObject({ rows: 9, capped: false })
    expect(remaining(db, 'a-app').length + remaining(db, 'b-app').length).toBe(0)
  })

  test('with nothing aged out it does nothing and asks about no plan', async () => {
    const { db, client } = database()
    seed(db, 'free-app', 1, ['2026-03-30T08:00:00.000Z'])
    let asked = 0
    const summary = await pruneFreeRetention({
      store: sqlRetentionStore(client),
      planOf: async () => {
        asked++
        return false
      },
      now: NOW,
    })
    expect(summary).toMatchObject({ pruned: 0, rows: 0 })
    expect(asked).toBe(0)
  })
})

describe('scheduling', () => {
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

  test('the prune is on the schedule', () => {
    expect(read('app/Scheduler.ts')).toContain('.job(\'PruneFreeRetention\')')
  })

  test('the job asks for a KNOWN plan and stands down when the archive prunes instead', () => {
    const job = read('app/Jobs/PruneFreeRetention.ts')
    expect(job).toContain('planOf: knownPlan')
    expect(job).toContain('archiveConfig().enabled')
  })
})
