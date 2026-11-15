import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_EXPIRY_DAYS, MAX_TOKEN_NAME, READ_SCOPE, readTokenExpiry, readTokenName } from '../../app/Support/read-token'
import { isFullSession } from '../../app/Support/request-auth'

const ROOT = join(import.meta.dir, '..', '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

/** Every source file under a directory the app serves from. */
function sources(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(ROOT, dir))) {
    const path = join(dir, entry)
    if (statSync(join(ROOT, path)).isDirectory())
      found.push(...sources(path))
    else if (/\.(?:ts|stx)$/.test(entry))
      found.push(path)
  }
  return found
}

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

  test('no value means the longest lifetime, not forever', () => {
    const tenYears = new Date(now.getTime() + MAX_EXPIRY_DAYS * 86_400_000)
    expect(readTokenExpiry(undefined, now)).toEqual({ ok: true, expiresAt: tenYears })
    expect(readTokenExpiry('', now)).toEqual({ ok: true, expiresAt: tenYears })
  })

  test('a number of days becomes a deadline', () => {
    expect(readTokenExpiry(30, now)).toEqual({ ok: true, expiresAt: new Date('2026-12-11T12:00:00.000Z') })
  })

  test('refuses what is not a positive number of days, rather than reading it as the default', () => {
    for (const value of [0, -1, 'soon', Number.NaN, MAX_EXPIRY_DAYS + 1])
      expect(readTokenExpiry(value, now)).toEqual({ ok: false })
  })
})

describe('scopes', () => {
  test('a sign-in is a full session and a read token is not', () => {
    expect(isFullSession(['*'])).toBe(true)
    expect(isFullSession([READ_SCOPE])).toBe(false)
    expect(isFullSession([])).toBe(false)
  })
})

/*
 * A read token is a Stacks personal access token, and nothing in this app
 * generates, stores or compares one.
 */
describe('a read token is the framework\'s token', () => {
  const projects = read('routes/projects.ts')

  test('it is minted, listed and revoked through @stacksjs/auth', () => {
    expect(projects).toContain('import { createToken, revokeTokenById, tokens } from \'@stacksjs/auth\'')
    expect(projects).toContain('createToken(userId, name, [READ_SCOPE]')
    expect(projects).not.toContain('read_tokens')
  })

  test('the app keeps no token code or table of its own', () => {
    const support = read('app/Support/read-token.ts')
    expect(support).not.toMatch(/getRandomValues|createHash|randomUUID/)
    expect(sources('app').some(file => file.endsWith('Models/ReadToken.ts'))).toBe(false)
  })
})

/*
 * A read token must only ever read.
 *
 * `Auth.getUserFromToken` and `Auth.validateToken` answer for any live token
 * whatever its scopes, and a read token is a live token. So nothing asks the
 * framework directly who a token is: `sessionUser` and `userFromReadToken` in
 * app/Support/request-auth.ts are the only callers, the first refuses
 * anything that is not a full session, and the second is called from the read
 * paths and nowhere else.
 */
describe('a read token only reads', () => {
  const requestAuth = read('app/Support/request-auth.ts')

  test('nothing else resolves a token through the framework directly', () => {
    const allowed = new Set([
      'app/Support/request-auth.ts',
      // Reads back the user for the token it has just issued at sign-up.
      'app/Actions/Auth/RegisterAction.ts',
    ])
    const offenders: string[] = []
    for (const file of [...sources('app'), ...sources('routes'), ...sources('resources')]) {
      if (allowed.has(file))
        continue
      const code = read(file).split('\n').filter(line => !/^\s*(?:\/\/|\*|\/\*|\{\{--)/.test(line)).join('\n')
      if (/\bAuth\.(?:getUserFromToken|validateToken)\s*\(/.test(code))
        offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  test('the session resolver accepts a full session and nothing narrower', () => {
    const session = requestAuth.slice(requestAuth.indexOf('export async function sessionUser'), requestAuth.indexOf('export async function userFromRequest'))
    expect(session).toContain('isFullSession(holder.scopes)')
    const resolver = requestAuth.slice(requestAuth.indexOf('export async function userFromRequest'), requestAuth.indexOf('function bearerFrom'))
    expect(resolver).toContain('sessionUser(')
  })

  test('a read key is refused before any token lookup', () => {
    const holder = requestAuth.slice(requestAuth.indexOf('async function tokenHolder'), requestAuth.indexOf('export async function sessionUser'))
    expect(holder.indexOf('looksLikeReadKey(token)')).toBeGreaterThan(-1)
    expect(holder.indexOf('looksLikeReadKey(token)')).toBeLessThan(holder.indexOf('findToken(token)'))
  })

  test('the read-token resolver wants the read scope and refuses a session', () => {
    const reader = requestAuth.slice(requestAuth.indexOf('export async function userFromReadToken'), requestAuth.indexOf('export type ProjectReadAccess'))
    expect(reader).toContain('holder.scopes.includes(READ_SCOPE)')
    expect(reader).toContain('isFullSession(holder.scopes)')
  })

  test('the auth middleware asks for a session, not merely a valid token', () => {
    const middleware = read('app/Middleware/Auth.ts')
    expect(middleware).toContain('await sessionUser(bearerToken)')
    expect(middleware).toContain('await sessionUser(cookieToken)')
  })

  test('only the project list accepts one outside projectReadAccess', () => {
    const projects = read('routes/projects.ts')
    const uses = projects.split('\n').filter(line => line.includes('userFromReadToken(') && !line.trimStart().startsWith('//'))
    expect(uses).toHaveLength(1)
    const at = projects.indexOf(uses[0])
    const routeStart = projects.lastIndexOf('route.', at)
    expect(projects.slice(routeStart, at)).toContain(`route.get('/api/projects',`)

    for (const file of ['routes/logs.ts', 'routes/analytics.ts', 'routes/auth.ts', 'routes/api.ts'])
      expect(read(file)).not.toContain('userFromReadToken(')
  })

  test('the routes that manage tokens ask for a session', () => {
    const projects = read('routes/projects.ts')
    for (const signature of [`route.get('/api/read-tokens'`, `route.post('/api/read-tokens'`, `route.delete('/api/read-tokens/{tokenId}'`]) {
      const start = projects.indexOf(signature)
      expect(start).toBeGreaterThan(-1)
      const handler = projects.slice(start, start + 220)
      expect(handler).toContain('await currentUser(request)')
      expect(handler).not.toContain('userFromReadToken')
    }
  })

  test('revoking looks the id up in the caller\'s own read tokens', () => {
    const projects = read('routes/projects.ts')
    const revoke = projects.slice(projects.indexOf(`route.delete('/api/read-tokens/{tokenId}'`))
    expect(revoke.indexOf('readTokensOf(Number(user.id))')).toBeLessThan(revoke.indexOf('revokeTokenById('))
  })
})
