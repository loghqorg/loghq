import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { looksLikeReadKey, newReadKey } from '../../app/Support/read-key'
import {
  hashReadToken,
  looksLikeReadToken,
  MAX_EXPIRY_DAYS,
  MAX_TOKEN_NAME,
  newReadToken,
  newReadTokenId,
  readTokenExpiry,
  readTokenHint,
  readTokenName,
  readTokenUsable,
} from '../../app/Support/read-token'

const ROOT = join(import.meta.dir, '..', '..')
const TOKEN = newReadToken()

describe('newReadToken', () => {
  test('is prefixed and carries 256 bits of hex', () => {
    expect(TOKEN.startsWith('lhq_user_')).toBe(true)
    expect(TOKEN.slice('lhq_user_'.length)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('does not repeat', () => {
    expect(new Set(Array.from({ length: 200 }, () => newReadToken())).size).toBe(200)
    expect(new Set(Array.from({ length: 200 }, () => newReadTokenId())).size).toBe(200)
  })
})

describe('looksLikeReadToken', () => {
  test('accepts a token it minted', () => {
    expect(looksLikeReadToken(TOKEN)).toBe(true)
  })

  test('rejects anything else a bearer header might carry', () => {
    for (const value of [
      '',
      null,
      undefined,
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      `lhq_user_${'z'.repeat(64)}`,
      `lhq_user_${'a'.repeat(63)}`,
      `lhq_user_${'a'.repeat(65)}`,
      TOKEN.toUpperCase(),
    ])
      expect(looksLikeReadToken(value)).toBe(false)
  })

  test('a read key and a read token are never mistaken for each other', () => {
    // The two arrive in the same header and are told apart by shape alone, so
    // each must fail the other's test or a project key would be looked up as
    // a person.
    expect(looksLikeReadToken(newReadKey())).toBe(false)
    expect(looksLikeReadKey(TOKEN)).toBe(false)
  })
})

describe('hashReadToken', () => {
  test('is a stable SHA-256 and never the token', () => {
    const hash = hashReadToken(TOKEN)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(hashReadToken(TOKEN))
    expect(hash).not.toBe(hashReadToken(newReadToken()))
    expect(TOKEN).not.toContain(hash)
  })

  test('the hint is four characters and cannot rebuild the token', () => {
    expect(readTokenHint(TOKEN)).toBe(TOKEN.slice(-4))
    expect(readTokenHint(TOKEN)).toHaveLength(4)
  })
})

describe('readTokenName', () => {
  test('trims, collapses and caps a label', () => {
    expect(readTokenName('  Work   laptop\n')).toBe('Work laptop')
    expect(readTokenName('x'.repeat(500))).toHaveLength(MAX_TOKEN_NAME)
  })

  test('is never empty', () => {
    for (const value of ['', '   ', null, undefined, '\n\t'])
      expect(readTokenName(value)).toBe('Read token')
  })
})

describe('readTokenExpiry', () => {
  const now = new Date('2026-11-11T12:00:00.000Z')

  test('no value means no expiry', () => {
    expect(readTokenExpiry(undefined, now)).toEqual({ ok: true, expiresAt: null })
    expect(readTokenExpiry('', now)).toEqual({ ok: true, expiresAt: null })
  })

  test('a number of days becomes a stored timestamp', () => {
    expect(readTokenExpiry(30, now)).toEqual({ ok: true, expiresAt: '2026-12-11 12:00:00' })
  })

  test('refuses what is not a positive number of days, rather than reading it as forever', () => {
    for (const value of [0, -1, 'soon', Number.NaN, MAX_EXPIRY_DAYS + 1])
      expect(readTokenExpiry(value, now)).toEqual({ ok: false })
  })
})

describe('readTokenUsable', () => {
  const now = new Date('2026-11-11T12:00:00.000Z')

  test('an unknown token is not usable', () => {
    expect(readTokenUsable(null, now)).toBe(false)
    expect(readTokenUsable(undefined, now)).toBe(false)
  })

  test('a token with no expiry lasts until revoked', () => {
    expect(readTokenUsable({ id: 'rtk_1', user_id: 1, expires_at: null }, now)).toBe(true)
  })

  test('an expiry is honoured, read as UTC', () => {
    expect(readTokenUsable({ id: 'rtk_1', user_id: 1, expires_at: '2026-11-11 12:00:01' }, now)).toBe(true)
    expect(readTokenUsable({ id: 'rtk_1', user_id: 1, expires_at: '2026-11-11 12:00:00' }, now)).toBe(false)
    expect(readTokenUsable({ id: 'rtk_1', user_id: 1, expires_at: '2026-11-11 11:59:59' }, now)).toBe(false)
  })

  test('an expiry that cannot be read closes the token', () => {
    expect(readTokenUsable({ id: 'rtk_1', user_id: 1, expires_at: 'whenever' }, now)).toBe(false)
  })
})

/**
 * A read token must only ever read.
 *
 * That holds because of two lines of code rather than a permission table, so
 * they are pinned here: the session resolver refuses the token's shape, and
 * the helper that does accept it is called from the read paths and nowhere else.
 */
describe('a read token only reads', () => {
  const requestAuth = readFileSync(join(ROOT, 'app/Support/request-auth.ts'), 'utf8')

  test('the session resolver refuses a read key and a read token before any lookup', () => {
    const body = requestAuth.slice(requestAuth.indexOf('export async function userFromRequest'), requestAuth.indexOf('function bearerFrom'))
    const guard = body.indexOf('looksLikeReadToken(token)')
    expect(guard).toBeGreaterThan(-1)
    expect(body.indexOf('looksLikeReadKey(token)')).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(body.indexOf('Auth.getUserFromToken'))
  })

  test('only the project list accepts one outside projectReadAccess', () => {
    const projects = readFileSync(join(ROOT, 'routes/projects.ts'), 'utf8')
    const uses = projects.split('\n').filter(line => line.includes('userFromReadToken(') && !line.trimStart().startsWith('//'))
    expect(uses).toHaveLength(1)
    const at = projects.indexOf(uses[0])
    const routeStart = projects.lastIndexOf('route.', at)
    expect(projects.slice(routeStart, at)).toContain(`route.get('/api/projects',`)

    for (const file of ['routes/logs.ts', 'routes/analytics.ts', 'routes/auth.ts', 'routes/api.ts'])
      expect(readFileSync(join(ROOT, file), 'utf8')).not.toContain('userFromReadToken(')
  })

  test('the routes that manage tokens ask for a session', () => {
    const projects = readFileSync(join(ROOT, 'routes/projects.ts'), 'utf8')
    for (const signature of [`route.get('/api/read-tokens'`, `route.post('/api/read-tokens'`, `route.delete('/api/read-tokens/{tokenId}'`]) {
      const start = projects.indexOf(signature)
      expect(start).toBeGreaterThan(-1)
      const handler = projects.slice(start, start + 220)
      expect(handler).toContain('await currentUser(request)')
      expect(handler).not.toContain('userFromReadToken')
    }
  })
})
