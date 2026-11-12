import type { SqlClient } from '@stacksjs/hq/meter'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCounter, sqlCounterStore } from '@stacksjs/hq/meter'
import { createHqService, sqlConnectCodeStore } from '@stacksjs/hq/service'
import { hqServiceContract } from '@stacksjs/hq/testing'
import { admitLines } from '../../app/Billing/meter'
import { LOG_LINES_METER } from '../../app/Billing/plans'
import { createLoghqAdapter } from '../../app/Hq/adapter'
import { sqlDialect } from '../../app/Support/sql-dialect'

/**
 * The `@stacksjs/hq` SQL stores against the tables this repository's own
 * migrations create.
 *
 * The migrations are this repository's files, not the package's
 * `*MigrationSql()` called at runtime, so nothing but this proves the two
 * still agree: the counter's upsert names a conflict target that must be the
 * table's key, and the code store inserts no id. This runs the real migration
 * files and then the real stores, so an edit that breaks the pairing fails
 * here rather than on the first flush in production.
 *
 * It also holds the files to what PostgreSQL needs, since production runs it
 * and this suite runs SQLite: no SQLite-only keyword, and 64-bit columns for
 * the values that do not fit 32.
 */

const MIGRATIONS = join(import.meta.dir, '..', '..', 'database', 'migrations')

function migrated(...tables: string[]): { db: Database, client: SqlClient } {
  const db = new Database(':memory:')
  for (const table of tables) {
    const file = readdirSync(MIGRATIONS).find(name => name.endsWith(`-create-${table}-table.sql`))
    if (!file)
      throw new Error(`no migration creates ${table}`)
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
  }
  const client: SqlClient = {
    unsafe: async (sql, params = []) => {
      const statement = db.query(sql)
      return /^\s*select|returning/i.test(sql) ? statement.all(...params as any[]) : (statement.run(...params as any[]), [])
    },
  }
  return { db, client }
}

describe('the migration files are valid on PostgreSQL too', () => {
  const file = (table: string) => readFileSync(join(MIGRATIONS, readdirSync(MIGRATIONS).find(name => name.endsWith(`-create-${table}-table.sql`))!), 'utf8')
  const ddl = (table: string) => file(table).split('\n').filter(line => !line.startsWith('--')).join('\n')

  test('no SQLite-only keyword, which would make `buddy migrate` refuse the corpus', () => {
    for (const table of ['usage_counters', 'hq_connect_codes'])
      expect(ddl(table)).not.toMatch(/AUTOINCREMENT|WITHOUT ROWID|DATETIME/i)
  })

  test('epoch milliseconds and line counts are 64-bit', () => {
    expect(ddl('hq_connect_codes')).toMatch(/"expires_at" BIGINT/i)
    expect(ddl('usage_counters')).toMatch(/"used" bigint/i)
  })

  test('no comment carries a semicolon, which the migration runner splits on', () => {
    for (const table of ['usage_counters', 'hq_connect_codes'])
      expect(file(table).split('\n').filter(line => line.startsWith('--')).join('\n')).not.toContain(';')
  })

  test('the keys are the ones the stores write against', () => {
    expect(ddl('usage_counters')).toContain('PRIMARY KEY ("owner", "meter", "period")')
    expect(ddl('hq_connect_codes')).toContain('"code_hash" TEXT PRIMARY KEY')
  })
})

describe('sqlDialect', () => {
  test('follows DB_CONNECTION and defaults to sqlite', () => {
    expect(sqlDialect('postgres')).toBe('postgres')
    expect(sqlDialect('mysql')).toBe('mysql')
    expect(sqlDialect('sqlite')).toBe('sqlite')
    expect(sqlDialect(undefined)).toBe('sqlite')
    expect(sqlDialect('')).toBe('sqlite')
  })
})

describe('usage_counters, as migrated', () => {
  test('the additive upsert lands on the table\'s key', async () => {
    const { db, client } = migrated('usage_counters')
    const store = sqlCounterStore(client, { dialect: 'sqlite' })
    const key = { owner: '1', meter: LOG_LINES_METER, period: '2026-03' }

    expect(await store.read(key)).toBe(0)
    expect(await store.add({ ...key, delta: 50 })).toBe(50)
    expect(await store.add({ ...key, delta: 7 })).toBe(57)
    expect(await store.add({ ...key, period: '2026-04', delta: 1 })).toBe(1)
    expect(await store.read(key)).toBe(57)
    // One row per (owner, meter, period), not one per flush.
    expect(db.query('SELECT COUNT(*) AS n FROM usage_counters').get()).toEqual({ n: 2 })
  })

  test('ingest counts survive a flush and a restart', async () => {
    const { client } = migrated('usage_counters')
    const now = () => new Date('2026-03-10T12:00:00Z')
    const first = createCounter({ store: sqlCounterStore(client, { dialect: 'sqlite' }), flushMs: 0, now })
    admitLines(first, 1, false, 50, 'https://loghq.test/pricing')
    admitLines(first, 1, false, 25, 'https://loghq.test/pricing')
    await first.flush()

    // A new process: nothing in memory, the durable total is what it reads.
    const second = createCounter({ store: sqlCounterStore(client, { dialect: 'sqlite' }), flushMs: 0, now })
    expect(await second.read(1, LOG_LINES_METER)).toBe(75)
    await second.prime(1, LOG_LINES_METER)
    expect(admitLines(second, 1, false, 5, 'https://loghq.test/pricing').usage.used).toBe(80)
  })
})

describe('hq_connect_codes, as migrated', () => {
  const projects = new Map<string, any>()
  const adapter = () => {
    const { client } = migrated('hq_connect_codes')
    return createLoghqAdapter({
      codes: sqlConnectCodeStore(client, { dialect: 'sqlite' }),
      origin: () => 'https://loghq.test',
      isPro: async () => false,
      linesUsed: async () => 0,
      projects: {
        async findOwnedByName(ownerId, name) {
          return projects.get(`${ownerId}/${name.toLowerCase()}`) ?? null
        },
        async create({ platform: _platform, ...project }) {
          projects.set(`${project.ownerId}/${project.name.toLowerCase()}`, project)
        },
        async setReadKey() {},
        async setIngestKey() {},
        async findByReadKey(readKey) {
          return [...projects.values()].find(project => project.readKey === readKey) ?? null
        },
      },
    })
  }

  // The whole contract again, this time with the codes in the migrated table:
  // hashing at rest, single use under concurrent polls, expiry.
  hqServiceContract('loghq over sqlite', () => ({ adapter: adapter(), user: { id: 1 } }))

  test('only the hash of a code and a sealed grant are ever written', async () => {
    const { db, client } = migrated('hq_connect_codes')
    const service = createHqService(createLoghqAdapter({
      codes: sqlConnectCodeStore(client, { dialect: 'sqlite' }),
      origin: () => 'https://loghq.test',
      isPro: async () => false,
      linesUsed: async () => 0,
      projects: {
        findOwnedByName: async () => null,
        create: async () => {},
        setReadKey: async () => {},
        setIngestKey: async () => {},
        findByReadKey: async () => null,
      },
    }))
    const started = await service.handle(new Request('https://loghq.test/api/cli/connect', { method: 'POST', body: JSON.stringify({ app: 'cursio' }), headers: { 'Content-Type': 'application/json' } }))
    const { code } = await started!.json() as { code: string }
    await service.approveConnect(code, { id: 1 })

    const row = db.query('SELECT * FROM hq_connect_codes').get() as Record<string, string>
    expect(row.status).toBe('approved')
    expect(row.app).toBe('cursio')
    const stored = JSON.stringify(row)
    expect(stored).not.toContain(code)
    expect(stored).not.toContain('lhq_read_')
    expect(stored).not.toContain('loghq_')

    const collected = await (await service.handle(new Request(`https://loghq.test/api/cli/connect/${code}`)))!.json() as any
    expect(collected.status).toBe('approved')
    expect(db.query('SELECT COUNT(*) AS n FROM hq_connect_codes').get()).toEqual({ n: 0 })
  })
})
