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
import { deferredStore, detectDialect, sqlDialect } from '../../app/Support/sql-dialect'

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
    for (const table of ['usage_counters', 'hq_connect_codes', 'log_alert_states'])
      expect(ddl(table)).not.toMatch(/AUTOINCREMENT|WITHOUT ROWID|DATETIME/i)
  })

  test('epoch milliseconds and line counts are 64-bit', () => {
    expect(ddl('hq_connect_codes')).toMatch(/"expires_at" BIGINT/i)
    expect(ddl('usage_counters')).toMatch(/"used" bigint/i)
    expect(ddl('log_alert_states')).toMatch(/"alerted_at" bigint/i)
  })

  test('no comment carries a semicolon, which the migration runner splits on', () => {
    for (const table of ['usage_counters', 'hq_connect_codes', 'log_alert_states'])
      expect(file(table).split('\n').filter(line => line.startsWith('--')).join('\n')).not.toContain(';')
  })

  test('the keys are the ones the stores write against', () => {
    expect(ddl('usage_counters')).toContain('PRIMARY KEY ("owner", "meter", "period")')
    expect(ddl('hq_connect_codes')).toContain('"code_hash" TEXT PRIMARY KEY')
  })
})

describe('which dialect the stores speak', () => {
  const answering = (row: Record<string, unknown> | Error): SqlClient => ({
    unsafe: async () => {
      if (row instanceof Error)
        throw row
      return [row]
    },
  })

  test('the database is asked, and a real SQLite says sqlite', async () => {
    const { client } = migrated('usage_counters')
    expect(await detectDialect(client, 'postgres')).toBe('sqlite')
  })

  test('PostgreSQL and MySQL are told apart by how they answer the same statement', async () => {
    // What each driver hands back for `SELECT (1 = '1') AS loose, ('a' = 'A') AS ci`.
    expect(await detectDialect(answering({ loose: true, ci: false }), 'sqlite')).toBe('postgres')
    expect(await detectDialect(answering({ loose: 't', ci: 'f' }), 'sqlite')).toBe('postgres')
    expect(await detectDialect(answering({ loose: 1, ci: 1 }), 'sqlite')).toBe('mysql')
    expect(await detectDialect(answering({ loose: 0, ci: 0 }), 'postgres')).toBe('sqlite')
  })

  test('what the database says wins over DB_CONNECTION', async () => {
    expect(await detectDialect(answering({ loose: true, ci: false }), sqlDialect('sqlite'))).toBe('postgres')
  })

  test('only when it cannot be asked does configuration decide', async () => {
    expect(await detectDialect(answering(new Error('connection refused')), 'postgres')).toBe('postgres')
    expect(await detectDialect({ unsafe: async () => [] }, 'postgres')).toBe('postgres')
    expect(await detectDialect({ unsafe: async () => [{ other: 1 }] }, 'mysql')).toBe('mysql')
  })

  test('DB_CONNECTION is read loosely, and defaults to sqlite', () => {
    for (const name of ['postgres', 'postgresql', 'Postgres', ' postgres ', 'pg', 'pgsql', 'postgres-pooled'])
      expect(sqlDialect(name)).toBe('postgres')
    for (const name of ['mysql', 'mariadb', 'singlestore', 'MySQL'])
      expect(sqlDialect(name)).toBe('mysql')
    for (const name of ['sqlite', undefined, '', 'something-else'])
      expect(sqlDialect(name)).toBe('sqlite')
  })

  test('a deferred store is built once, on first use, and retries a failed build', async () => {
    let builds = 0
    let fail = true
    const store = deferredStore(async () => {
      builds++
      if (fail)
        throw new Error('not ready')
      return { read: async (n: number) => n * 2 }
    })
    expect(builds).toBe(0)
    await expect(store.read(2)).rejects.toThrow('not ready')
    fail = false
    expect(await store.read(2)).toBe(4)
    expect(await store.read(3)).toBe(6)
    expect(builds).toBe(2)
  })

  test('the counter and the code store detect instead of trusting configuration', () => {
    const read = (path: string) => readFileSync(join(import.meta.dir, '..', '..', path), 'utf8')
    expect(read('app/Billing/meter.ts')).toContain('sqlCounterStore(db, { dialect: await detectDialect(db) })')
    expect(read('app/Hq/service.ts')).toContain('sqlConnectCodeStore(db, { dialect: await detectDialect(db) })')
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
