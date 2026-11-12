import type { SqlClient } from '@stacksjs/hq/meter'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FREE_RETENTION_DAYS } from '../../app/Billing/plans'
import { pruneVerdict } from '../../app/Billing/pro'
import { pruneFreeRetention, retentionMode, sqlRetentionStore } from '../../app/Billing/retention'

const ROOT = join(import.meta.dir, '..', '..')
const NOW = new Date('2026-03-31T09:00:00.000Z')
// 30 days before 2026-03-31. Everything STORED before this UTC day is out.
const CUTOFF = '2026-03-01'

/**
 * A real SQLite database with the two tables the prune reads, so the
 * statements are executed rather than trusted. `$n` is how the app binds and
 * `?n` is how bun:sqlite spells the same thing.
 */
function database(): { db: Database, client: SqlClient } {
  const db = new Database(':memory:')
  db.run('CREATE TABLE projects (id varchar(255) PRIMARY KEY, name varchar(255) NOT NULL, owner_id integer)')
  // `timestamp` is whatever the client sent. `created_at` is the server's.
  db.run('CREATE TABLE log_entries (id varchar(255) PRIMARY KEY, project_id varchar(255) NOT NULL, message text, timestamp varchar(255), created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP)')
  const client: SqlClient = {
    unsafe: async (sql, params = []) => {
      const statement = db.query(sql.replace(/\$(\d+)/g, '?$1'))
      return /^\s*select/i.test(sql) ? statement.all(...params as any[]) : (statement.run(...params as any[]), [])
    },
  }
  return { db, client }
}

let n = 0
/**
 * Lines stored at `storedAt` (the server's `created_at`, in the shape the
 * ingest writes). The client timestamp defaults to the same instant in
 * ISO-8601, which is what a well-behaved SDK sends.
 */
function seed(db: Database, projectId: string, ownerId: number | null, storedAt: string[], clientTimestamp?: (stored: string) => string): void {
  db.query('INSERT OR IGNORE INTO projects (id, name, owner_id) VALUES (?, ?, ?)').run(projectId, projectId, ownerId)
  for (const stored of storedAt) {
    const created = stored.replace('T', ' ').replace('Z', '')
    db.query('INSERT INTO log_entries (id, project_id, message, timestamp, created_at) VALUES (?, ?, ?, ?, ?)').run(`log_${++n}`, projectId, 'line', clientTimestamp ? clientTimestamp(stored) : stored, created)
  }
}

const remaining = (db: Database, projectId: string): string[] =>
  (db.query('SELECT created_at FROM log_entries WHERE project_id = ? ORDER BY created_at').all(projectId) as { created_at: string }[]).map(row => `${row.created_at.replace(' ', 'T')}Z`)

const clientTimestamps = (db: Database, projectId: string): string[] =>
  (db.query('SELECT timestamp FROM log_entries WHERE project_id = ? ORDER BY id').all(projectId) as { timestamp: string }[]).map(row => row.timestamp)

const plans = (table: Record<number, boolean | null>) => async (ownerId: number) => table[ownerId] ?? null

describe('free retention prune', () => {
  test('the window is the one the limits file sells', () => {
    expect(FREE_RETENTION_DAYS).toBe(30)
  })

  test('removes a free project\'s lines older than 30 days and keeps the rest', async () => {
    const { db, client } = database()
    seed(db, 'free-app', 1, ['2026-01-05T10:00:00.000Z', '2026-02-28T23:59:59.999Z', '2026-03-01T00:00:00.000Z', '2026-03-30T08:00:00.000Z'])

    const summary = await pruneFreeRetention({ store: sqlRetentionStore(client), planOf: plans({ 1: false }), now: NOW })

    expect(summary).toEqual({ dryRun: false, cutoff: CUTOFF, pruned: 1, rows: 2, projects: [{ projectId: 'free-app', rows: 2 }], keptPro: 0, skipped: 0, capped: false })
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

describe('age is the time the server stored the line, not the time the client claimed', () => {
  const RECENT = ['2026-03-30T08:00:00.000Z', '2026-03-30T08:00:01.000Z']

  test('a line stored yesterday with an epoch-millisecond timestamp survives', async () => {
    const { db, client } = database()
    // As strings, '1774857600000' sorts before '2026-03-01'. A prune on the
    // client column would delete these although they are a day old.
    seed(db, 'free-app', 1, RECENT, stored => String(Date.parse(stored)))
    expect(clientTimestamps(db, 'free-app').every(value => value < CUTOFF)).toBe(true)

    const summary = await pruneFreeRetention({ store: sqlRetentionStore(client), planOf: plans({ 1: false }), now: NOW })

    expect(summary).toMatchObject({ pruned: 0, rows: 0 })
    expect(remaining(db, 'free-app')).toEqual(RECENT)
  })

  test('so does every other shape a client can send', async () => {
    const shapes = ['03/30/2026 08:00:00', '1774857600', 'yesterday', '', '0001-01-01T00:00:00Z', '1970-01-01T00:00:00.000Z', '30 Mar 2026']
    const { db, client } = database()
    for (const shape of shapes)
      seed(db, 'free-app', 1, ['2026-03-30T08:00:00.000Z'], () => shape)

    const summary = await pruneFreeRetention({ store: sqlRetentionStore(client), planOf: plans({ 1: false }), now: NOW })

    expect(summary.rows).toBe(0)
    expect(clientTimestamps(db, 'free-app')).toEqual(shapes)
  })

  test('a client timestamp from the future does not keep an old line alive', async () => {
    const { db, client } = database()
    seed(db, 'free-app', 1, ['2026-01-05T10:00:00.000Z'], () => '2099-01-01T00:00:00.000Z')
    const summary = await pruneFreeRetention({ store: sqlRetentionStore(client), planOf: plans({ 1: false }), now: NOW })
    expect(summary.rows).toBe(1)
    expect(remaining(db, 'free-app')).toEqual([])
  })

  test('no statement in the store filters on the client column', () => {
    const source = readFileSync(join(ROOT, 'app/Billing/retention.ts'), 'utf8')
    const sql = [...source.matchAll(/`[^`]*(?:SELECT|DELETE)[^`]*`|'(?:SELECT|DELETE)[^']*'/g)].map(match => match[0])
    expect(sql.length).toBeGreaterThanOrEqual(4)
    for (const statement of sql) {
      expect(statement).not.toMatch(/\btimestamp\b/)
      if (/log_entries/.test(statement))
        expect(statement).toContain('created_at <')
    }
  })
})

describe('dry run', () => {
  test('counts what would go, per project, and deletes nothing', async () => {
    const { db, client } = database()
    seed(db, 'a-app', 1, ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-03-30T00:00:00.000Z'])
    seed(db, 'b-app', 1, ['2026-02-01T00:00:00.000Z'])
    seed(db, 'pro-app', 2, ['2025-06-01T00:00:00.000Z'])

    const summary = await pruneFreeRetention({ store: sqlRetentionStore(client), planOf: plans({ 1: false, 2: true }), now: NOW, dryRun: true })

    expect(summary).toEqual({
      dryRun: true,
      cutoff: CUTOFF,
      pruned: 2,
      rows: 3,
      projects: [{ projectId: 'a-app', rows: 2 }, { projectId: 'b-app', rows: 1 }],
      keptPro: 1,
      skipped: 0,
      capped: false,
    })
    expect(db.query('SELECT COUNT(*) AS n FROM log_entries').get()).toEqual({ n: 5 })
  })

  test('is not stopped by the row cap, so the count is the whole backlog', async () => {
    const { db, client } = database()
    seed(db, 'a-app', 1, Array.from({ length: 30 }, () => '2026-01-01T00:00:00.000Z'))
    const summary = await pruneFreeRetention({ store: sqlRetentionStore(client), planOf: plans({ 1: false }), now: NOW, dryRun: true, maxRows: 10, batchSize: 5 })
    expect(summary).toMatchObject({ rows: 30, capped: false })
    expect(db.query('SELECT COUNT(*) AS n FROM log_entries').get()).toEqual({ n: 30 })
  })

  test('never calls the deleting half of the store', async () => {
    const { db, client } = database()
    seed(db, 'a-app', 1, ['2026-01-01T00:00:00.000Z'])
    const store = sqlRetentionStore(client)
    let deletes = 0
    await pruneFreeRetention({
      store: { ...store, deleteBefore: async () => { deletes++; return 0 } },
      planOf: plans({ 1: false }),
      now: NOW,
      dryRun: true,
    })
    expect(deletes).toBe(0)
  })
})

describe('RETENTION_PRUNE_ENABLED', () => {
  test('is off unless explicitly switched on', () => {
    for (const value of [undefined, null, '', 'false', '0', 'no', 'off', 'maybe', 'enabled'])
      expect(retentionMode(value)).toBe('off')
  })

  test('dry-run counts and true deletes', () => {
    expect(retentionMode('dry-run')).toBe('dry-run')
    expect(retentionMode('DRY-RUN')).toBe('dry-run')
    expect(retentionMode('true')).toBe('on')
    expect(retentionMode(' True ')).toBe('on')
    expect(retentionMode('1')).toBe('on')
  })
})

describe('which accounts the prune treats as Free', () => {
  const now = new Date('2026-03-31T09:00:00Z')

  test('no subscription at all is Free', () => {
    expect(pruneVerdict([], now)).toBe(false)
  })

  test('an active or trialing subscription is Pro, whatever ends_at says', () => {
    expect(pruneVerdict([{ type: 'default', provider_status: 'active', ends_at: null }], now)).toBe(true)
    expect(pruneVerdict([{ type: 'default', provider_status: 'trialing', ends_at: null }], now)).toBe(true)
    // The case the review named: active with an ends_at in the past.
    expect(pruneVerdict([{ type: 'default', provider_status: 'active', ends_at: '2026-01-01 00:00:00' }], now)).toBe(true)
  })

  test('a cancelled subscription whose time has run out is Free', () => {
    expect(pruneVerdict([{ type: 'default', provider_status: 'canceled', ends_at: null }], now)).toBe(false)
    expect(pruneVerdict([{ type: 'default', provider_status: 'canceled', ends_at: '2026-03-01 00:00:00' }], now)).toBe(false)
  })

  test('anything a different reading could call paying is ambiguous, and skipped', () => {
    const ambiguous = [
      [{ type: 'default', provider_status: 'past_due', ends_at: null }],
      [{ type: 'default', provider_status: 'unpaid', ends_at: null }],
      [{ type: 'default', provider_status: 'paused', ends_at: null }],
      [{ type: 'default', provider_status: 'incomplete', ends_at: null }],
      [{ type: 'default', provider_status: 'something-new', ends_at: null }],
      [{ type: 'default', provider_status: '', ends_at: null }],
      // Cancelled, but the paid period has not run out.
      [{ type: 'default', provider_status: 'canceled', ends_at: '2026-04-15 00:00:00' }],
      [{ type: 'default', provider_status: 'canceled', ends_at: 'not a date' }],
      // Paying for something, just not under the name the rule looks for.
      [{ type: 'team', provider_status: 'active', ends_at: null }],
    ]
    for (const rows of ambiguous)
      expect(pruneVerdict(rows, now)).toBeNull()
  })

  test('one live subscription among dead ones is Pro', () => {
    expect(pruneVerdict([
      { type: 'default', provider_status: 'canceled', ends_at: '2025-01-01 00:00:00' },
      { type: 'default', provider_status: 'active', ends_at: null },
    ], now)).toBe(true)
  })

  test('ends_at is read as a Date or as either string shape', () => {
    expect(pruneVerdict([{ provider_status: 'canceled', ends_at: new Date('2026-04-15T00:00:00Z') }], now)).toBeNull()
    expect(pruneVerdict([{ provider_status: 'canceled', ends_at: '2026-04-15T00:00:00.000Z' }], now)).toBeNull()
    expect(pruneVerdict([{ provider_status: 'canceled', ends_at: new Date('2026-03-01T00:00:00Z') }], now)).toBe(false)
  })
})

describe('one plan rule', () => {
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

  test('the entitlement query looks at status only', () => {
    const pro = read('app/Billing/pro.ts')
    const query = pro.slice(pro.indexOf('export async function hasLiveSubscription'), pro.indexOf('export interface SubscriptionRow'))
    expect(query).toContain('provider_status IN (\'active\', \'trialing\')')
    expect(query).not.toContain('ends_at')
  })

  test('/api/me and the archive ask the same function the ingest does', () => {
    for (const file of ['app/Actions/MeAction.ts', 'app/Archive/plan.ts']) {
      expect(read(file)).toContain('hasLiveSubscription(')
      expect(read(file)).not.toContain('Payment.hasActiveSubscription')
    }
  })
})

describe('scheduling', () => {
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

  test('the prune is on the schedule', () => {
    expect(read('app/Scheduler.ts')).toContain('.job(\'PruneFreeRetention\')')
  })

  test('the job does nothing when off, asks the strict plan, and stands down for the archive', () => {
    const job = read('app/Jobs/PruneFreeRetention.ts')
    expect(job).toContain('if (mode === \'off\')\n      return')
    expect(job).toContain('planOf: planForPrune')
    expect(job).toContain('archiveConfig().enabled')
    // Off is checked before anything is read.
    expect(job.indexOf('mode === \'off\'')).toBeLessThan(job.indexOf('pruneFreeRetention({'))
  })
})
