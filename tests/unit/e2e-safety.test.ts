import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupE2EAccounts, e2eUrl, validateE2ETarget } from '../e2e/safety'

const directory = mkdtempSync(join(tmpdir(), 'loghq-e2e-safety-'))
const sqlitePath = join(directory, 'database.sqlite')
const fixture = new Database(sqlitePath)
fixture.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT); CREATE TABLE projects (owner_id INTEGER); CREATE TABLE oauth_access_tokens (user_id INTEGER)')
fixture.close()
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('mutating E2E target safety', () => {
  test('is disabled by default, even when a server URL is present', () => {
    expect(validateE2ETarget({})).toBeNull()
    expect(validateE2ETarget({ E2E_BASE_URL: 'https://loghq.org' })).toBeNull()
  })

  test('requires an explicit local target and disposable database', () => {
    expect(() => validateE2ETarget({ E2E_RUN: '1' })).toThrow()
    expect(() => validateE2ETarget({ E2E_RUN: '1', E2E_BASE_URL: 'http://127.0.0.1:3100' })).toThrow()
  })

  test('rejects remote hosts, credentials, paths and non-HTTP targets', () => {
    for (const target of [
      'https://loghq.org',
      'http://localhost.example.com:3100',
      'http://localhost:3100',
      'http://user:password@127.0.0.1:3100',
      'http://127.0.0.1:3100/api',
      'http://127.0.0.1:3100/?redirect=production',
      'http://127.0.0.1:3100/#fragment',
      'ftp://127.0.0.1:3100',
    ]) {
      expect(() => validateE2ETarget({ E2E_RUN: '1', E2E_BASE_URL: target, E2E_SQLITE_PATH: '/tmp/loghq-e2e-example/test.sqlite' })).toThrow()
    }
  })

  test('accepts an explicit loopback origin with a real disposable file', () => {
    for (const baseUrl of ['http://127.0.0.1:3100', 'http://[::1]:3100']) {
      expect(validateE2ETarget({ E2E_RUN: '1', E2E_BASE_URL: baseUrl, E2E_SQLITE_PATH: sqlitePath }))
        .toEqual({ baseUrl, sqlitePath: realpathSync(sqlitePath) })
    }
  })

  test('rejects a symlink to a differently named file', () => {
    const linkDirectory = mkdtempSync(join(tmpdir(), 'loghq-e2e-link-'))
    const otherFile = join(directory, 'not-disposable.sqlite')
    new Database(otherFile).close()
    symlinkSync(otherFile, join(linkDirectory, 'database.sqlite'))
    try {
      expect(() => validateE2ETarget({ E2E_RUN: '1', E2E_BASE_URL: 'http://127.0.0.1:3100', E2E_SQLITE_PATH: join(linkDirectory, 'database.sqlite') })).toThrow()
    }
    finally {
      rmSync(linkDirectory, { recursive: true, force: true })
    }
  })

  test('cleans only this run in the disposable file and rejects cross-origin requests', () => {
    const target = validateE2ETarget({ E2E_RUN: '1', E2E_BASE_URL: 'http://127.0.0.1:3100', E2E_SQLITE_PATH: sqlitePath })!
    expect(() => e2eUrl(null, '/login')).toThrow()
    expect(() => e2eUrl(target, 'https://loghq.org/logout')).toThrow()
    expect(() => e2eUrl(target, '//example.com/logout')).toThrow()
    expect(e2eUrl(target, '/login')).toBe('http://127.0.0.1:3100/login')
    const email = 'e2e-current-run@loghq.test'
    const db = new Database(sqlitePath)
    try {
      db.query('INSERT INTO users (id, email) VALUES (?, ?)').run(1, email)
      db.query('INSERT INTO users (id, email) VALUES (?, ?)').run(2, 'e2e-previous-run@loghq.test')
      db.exec('INSERT INTO projects VALUES (1), (2); INSERT INTO oauth_access_tokens VALUES (1), (2)')
      cleanupE2EAccounts(target, new Set([email]))
      expect(db.query('SELECT email FROM users').all()).toEqual([{ email: 'e2e-previous-run@loghq.test' }])
      expect(db.query('SELECT owner_id FROM projects').all()).toEqual([{ owner_id: 2 }])
      expect(db.query('SELECT user_id FROM oauth_access_tokens').all()).toEqual([{ user_id: 2 }])
    }
    finally {
      db.close()
    }
  })
})
