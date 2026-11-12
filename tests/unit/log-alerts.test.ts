import type { SqlClient } from '@stacksjs/hq/meter'
import type { AlertIssue } from '../../app/Errors/alerts'
import type { LogRow } from '../../app/Logs/normalize'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMemorySeenStore, QUIET_MS, sqlSeenStore } from '../../app/Errors/alert-state'
import { alertCandidates, alertsEnabled, CAPPED_BACKOFF_MS, fireLogAlerts, MAX_ALERTS_PER_BATCH } from '../../app/Errors/log-alerts'

let n = 0
function row(level: string, message: string, extra: Partial<LogRow> = {}): LogRow {
  return {
    id: `log_${++n}`,
    project_id: 'shop-abc123',
    level,
    message,
    channel: 'billing',
    context: null,
    environment: 'production',
    release: null,
    framework: null,
    host: null,
    sdk: null,
    user_context: null,
    timestamp: '2026-03-10T12:00:00.000Z',
    trace_id: null,
    request_id: null,
    ...extra,
  }
}

let project = 0
/** A fresh project id: the cap backoff is remembered per project, across tests. */
const pid = () => `p${++project}`

function deps(options: { allow?: boolean[], enabled?: boolean } = {}) {
  const sent: Array<{ projectId: string, issue: AlertIssue }> = []
  const allow = [...(options.allow ?? [])]
  const clock = { at: 1_000_000 }
  return {
    sent,
    clock,
    deps: {
      enabled: () => options.enabled ?? true,
      seen: createMemorySeenStore(),
      allow: async () => allow.length ? allow.shift()! : true,
      dispatch: async (projectId: string, issue: AlertIssue) => {
        sent.push({ projectId, issue })
      },
      now: () => clock.at,
    },
  }
}

describe('which lines can alert', () => {
  test('error and above, never info or warning', () => {
    const rows = [row('info', 'started'), row('warning', 'slow'), row('error', 'gateway timeout'), row('emergency', 'disk full')]
    expect(alertCandidates('shop-abc123', rows, 'https://loghq.test').map(c => c.issue.level)).toEqual(['error', 'emergency'])
  })

  test('the same failure with different ids in it is one alert', () => {
    const rows = [row('error', 'order 10422 failed for cus_AAAA1111'), row('error', 'order 10987 failed for cus_BBBB2222')]
    expect(alertCandidates('shop-abc123', rows, 'https://loghq.test')).toHaveLength(1)
  })

  test('one request can raise only a few', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row('error', `distinct failure ${'x'.repeat(i + 1)}`))
    expect(alertCandidates('shop-abc123', rows, 'https://loghq.test')).toHaveLength(MAX_ALERTS_PER_BATCH)
  })

  test('the alert links to the project stream and carries the first line', () => {
    const [candidate] = alertCandidates('shop abc', [row('critical', 'boom\n  at stack frame')], 'https://loghq.test')
    expect(candidate!.issue).toMatchObject({
      title: 'boom',
      culprit: 'billing',
      environment: 'production',
      url: 'https://loghq.test/dashboard?project=shop%20abc',
    })
  })
})

describe('firing', () => {
  test('a new error alerts once, and a storm of it stays quiet', async () => {
    const { deps: d, sent } = deps()
    expect(await fireLogAlerts('p1', [row('error', 'gateway timeout')], d)).toBe(1)
    for (let i = 0; i < 20; i++)
      expect(await fireLogAlerts('p1', [row('error', 'gateway timeout')], d)).toBe(0)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ projectId: 'p1', issue: { title: 'gateway timeout' } })
  })

  test('the same error alerts again after the quiet window', async () => {
    const { deps: d, sent, clock } = deps()
    await fireLogAlerts('p1', [row('error', 'gateway timeout')], d)
    clock.at += QUIET_MS + 1
    await fireLogAlerts('p1', [row('error', 'gateway timeout')], d)
    expect(sent).toHaveLength(2)
  })

  test('projects do not silence each other', async () => {
    const { deps: d, sent } = deps()
    await fireLogAlerts('p1', [row('error', 'gateway timeout')], d)
    await fireLogAlerts('p2', [row('error', 'gateway timeout')], d)
    expect(sent.map(s => s.projectId)).toEqual(['p1', 'p2'])
  })

  test('an alert stopped by the hourly cap is not remembered as sent', async () => {
    const { deps: d, sent, clock } = deps({ allow: [false, true] })
    const p = pid()
    expect(await fireLogAlerts(p, [row('error', 'gateway timeout')], d)).toBe(0)
    // The project is left alone for a minute after hitting the cap.
    expect(await fireLogAlerts(p, [row('error', 'gateway timeout')], d)).toBe(0)
    clock.at += CAPPED_BACKOFF_MS + 1
    expect(await fireLogAlerts(p, [row('error', 'gateway timeout')], d)).toBe(1)
    expect(sent).toHaveLength(1)
  })

  test('nothing but errors means nothing is sent', async () => {
    const { deps: d, sent } = deps()
    expect(await fireLogAlerts('p1', [row('info', 'ok'), row('debug', 'tick')], d)).toBe(0)
    expect(sent).toEqual([])
  })

  test('a failing transport never throws into the ingest', async () => {
    const { deps: d } = deps()
    const broken = { ...d, dispatch: async () => { throw new Error('smtp down') } }
    expect(await fireLogAlerts('p1', [row('error', 'gateway timeout')], broken)).toBe(0)
  })
})

describe('LOG_ALERTS_ENABLED', () => {
  test('is off unless explicitly true', () => {
    for (const value of [undefined, null, '', 'false', '0', 'off', 'no', 'maybe'])
      expect(alertsEnabled(value)).toBe(false)
    for (const value of ['true', 'TRUE', ' true ', '1', 'on', 'yes'])
      expect(alertsEnabled(value)).toBe(true)
  })

  test('when off nothing is sent and nothing is even recorded as seen', async () => {
    const { deps: d, sent } = deps({ enabled: false })
    let claims = 0
    const watched = { ...d, seen: { claim: async () => { claims++; return true }, release: async () => {} } }
    expect(await fireLogAlerts(pid(), [row('error', 'gateway timeout'), row('critical', 'disk full')], watched)).toBe(0)
    expect(sent).toEqual([])
    expect(claims).toBe(0)
  })

  test('the settings page says alerts are off when they are', () => {
    const settings = readFileSync(join(import.meta.dir, '..', '..', 'resources/views/settings.stx'), 'utf8')
    expect(settings).toContain('const alertsLive = alertsEnabled()')
    expect(settings).toContain('@if (alertsLive)')
    expect(settings).toContain('Automatic alerts are switched off on this')
  })
})

describe('what has alerted survives a restart', () => {
  const MIGRATIONS = join(import.meta.dir, '..', '..', 'database', 'migrations')

  /** The real migration file, in a real database, behind the `$n` binding the app uses. */
  function database(): { db: Database, client: SqlClient, failing: { on: boolean } } {
    const db = new Database(':memory:')
    db.exec(readFileSync(join(MIGRATIONS, readdirSync(MIGRATIONS).find(name => name.endsWith('-create-log_alert_states-table.sql'))!), 'utf8'))
    const failing = { on: false }
    const client: SqlClient = {
      unsafe: async (sql, params = []) => {
        if (failing.on)
          throw new Error('database is locked')
        const statement = db.query(sql.replace(/\$(\d+)/g, '?$1'))
        return /^\s*select/i.test(sql) ? statement.all(...params as any[]) : (statement.run(...params as any[]), [])
      },
    }
    return { db, client, failing }
  }

  const AT = Date.parse('2026-03-10T12:00:00Z')
  const quiet = { onError: () => {} }

  test('a new process does not alert again for an error it already alerted on', async () => {
    const { client } = database()
    const beforeRestart = sqlSeenStore(client, quiet)
    expect(await beforeRestart.claim('p1', 'fp-a', AT)).toBe(true)

    // Nothing in memory: this is what a deploy or a crash leaves.
    const afterRestart = sqlSeenStore(client, quiet)
    expect(await afterRestart.claim('p1', 'fp-a', AT + 60_000)).toBe(false)
    expect(await afterRestart.claim('p1', 'fp-a', AT + QUIET_MS - 1)).toBe(false)
  })

  test('end to end: restart in the middle of an error storm sends nothing more', async () => {
    const { client } = database()
    const sent: string[] = []
    const process = () => ({
      enabled: () => true,
      seen: sqlSeenStore(client, quiet),
      allow: async () => true,
      dispatch: async (_projectId: string, issue: AlertIssue) => {
        sent.push(issue.title)
      },
      now: () => AT,
    })
    const p = pid()
    const first = process()
    await fireLogAlerts(p, [row('error', 'gateway timeout for order 10421')], first)
    await fireLogAlerts(p, [row('error', 'gateway timeout for order 10422')], first)
    const second = process()
    for (let i = 0; i < 5; i++)
      await fireLogAlerts(p, [row('error', `gateway timeout for order 2000${i}`)], second)
    expect(sent).toEqual(['gateway timeout for order 10421'])
  })

  test('it alerts again once the quiet window has passed', async () => {
    const { client } = database()
    expect(await sqlSeenStore(client, quiet).claim('p1', 'fp-a', AT)).toBe(true)
    expect(await sqlSeenStore(client, quiet).claim('p1', 'fp-a', AT + QUIET_MS + 1)).toBe(true)
    expect(await sqlSeenStore(client, quiet).claim('p1', 'fp-a', AT + QUIET_MS + 2)).toBe(false)
  })

  test('two instances seeing the same new error send one alert between them', async () => {
    const { client } = database()
    const a = sqlSeenStore(client, quiet)
    const b = sqlSeenStore(client, quiet)
    const outcomes = await Promise.all([a.claim('p1', 'fp-a', AT), b.claim('p1', 'fp-a', AT), a.claim('p1', 'fp-b', AT), b.claim('p1', 'fp-b', AT)])
    expect(outcomes.slice(0, 2).filter(Boolean)).toHaveLength(1)
    expect(outcomes.slice(2).filter(Boolean)).toHaveLength(1)
  })

  test('projects and fingerprints are independent', async () => {
    const { client, db } = database()
    const store = sqlSeenStore(client, quiet)
    expect(await store.claim('p1', 'fp-a', AT)).toBe(true)
    expect(await store.claim('p2', 'fp-a', AT)).toBe(true)
    expect(await store.claim('p1', 'fp-b', AT)).toBe(true)
    expect(db.query('SELECT COUNT(*) AS n FROM log_alert_states').get()).toEqual({ n: 3 })
  })

  test('a released claim can alert later, in this process or the next', async () => {
    const { client } = database()
    const store = sqlSeenStore(client, quiet)
    expect(await store.claim('p1', 'fp-a', AT)).toBe(true)
    await store.release('p1', 'fp-a')
    expect(await sqlSeenStore(client, quiet).claim('p1', 'fp-a', AT + 1000)).toBe(true)
  })

  test('a storm of one error costs one round of statements, not one per line', async () => {
    const { client } = database()
    let statements = 0
    const counting: SqlClient = { unsafe: (sql, params) => { statements++; return client.unsafe(sql, params) } }
    const store = sqlSeenStore(counting, quiet)
    await store.claim('p1', 'fp-a', AT)
    const afterFirst = statements
    for (let i = 0; i < 200; i++)
      await store.claim('p1', 'fp-a', AT + i)
    expect(statements).toBe(afterFirst)
  })

  test('with the table unreachable it falls back to memory instead of going silent or spamming', async () => {
    const { client, failing } = database()
    failing.on = true
    const store = sqlSeenStore(client, quiet)
    expect(await store.claim('p1', 'fp-a', AT)).toBe(true)
    expect(await store.claim('p1', 'fp-a', AT + 1)).toBe(false)
  })

  test('old rows are swept', async () => {
    const { client, db } = database()
    db.query('INSERT INTO log_alert_states (project_id, fingerprint, alerted_at) VALUES (?, ?, ?)').run('old', 'fp', AT - 30 * 24 * 60 * 60 * 1000)
    await sqlSeenStore(client, quiet).claim('p1', 'fp-a', AT)
    expect(db.query('SELECT project_id FROM log_alert_states').all()).toEqual([{ project_id: 'p1' }])
  })
})

describe('wiring', () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, '..', '..', path), 'utf8')

  test('the ingest calls it, after storing, without awaiting', () => {
    expect(read('routes/logs.ts')).toContain('void fireLogAlerts(projectId, kept)')
  })

  test('the default path is gated by the flag and backed by the table', () => {
    const source = read('app/Errors/log-alerts.ts')
    expect(source).toContain('enabled: alertsEnabled')
    expect(source).toContain('seen: sqlSeenStore(db)')
  })

  test('alert links do not point at an issue page this app does not have', () => {
    expect(read('app/Errors/alerts.ts')).not.toContain('/issue/')
    expect(read('app/Errors/channels.ts')).not.toContain('/issue/')
  })
})
