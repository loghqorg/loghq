import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isProjectToken, PROJECT_SCOPES, PROJECT_TOKEN_LIFETIME_DAYS, PROJECT_TOKEN_OWNER, projectTokenExpiry } from '../../app/Support/project-tokens'
import { connectReadKeyName, SETTINGS_READ_KEY_NAME } from '../../app/Support/read-key'
import { READ_SCOPE } from '../../app/Support/read-token'

const ROOT = join(import.meta.dir, '../..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

/** A token as the framework answers it, owned by a project's principal. */
const projectToken = (scopes: string[]) => ({ id: 7, subjectType: PROJECT_TOKEN_OWNER, subjectId: 3, scopes })

describe('isProjectToken', () => {
  test('a read key is a principal-owned token carrying the read scope', () => {
    expect(isProjectToken(projectToken([PROJECT_SCOPES.read]), PROJECT_SCOPES.read)).toBe(true)
  })

  test('a person\'s token is never a read key, whatever it carries', () => {
    // A sign-in, a person's read token, and a user token naming the project scope.
    expect(isProjectToken({ id: 1, subjectType: 'users', subjectId: 3, scopes: ['*'] }, PROJECT_SCOPES.read)).toBe(false)
    expect(isProjectToken({ id: 1, subjectType: 'users', subjectId: 3, scopes: [READ_SCOPE] }, PROJECT_SCOPES.read)).toBe(false)
    expect(isProjectToken({ id: 1, subjectType: 'users', subjectId: 3, scopes: [PROJECT_SCOPES.read] }, PROJECT_SCOPES.read)).toBe(false)
    expect(isProjectToken({ id: 1, subjectId: 3, scopes: [PROJECT_SCOPES.read] }, PROJECT_SCOPES.read)).toBe(false)
  })

  test('full access is not a project scope', () => {
    expect(isProjectToken(projectToken(['*']), PROJECT_SCOPES.read)).toBe(false)
    expect(isProjectToken(projectToken(['*', PROJECT_SCOPES.read]), PROJECT_SCOPES.read)).toBe(false)
  })

  test('nothing, another scope, and a token with no owner id are refused', () => {
    expect(isProjectToken(null, PROJECT_SCOPES.read)).toBe(false)
    expect(isProjectToken(undefined, PROJECT_SCOPES.read)).toBe(false)
    expect(isProjectToken(projectToken(['project:something-else']), PROJECT_SCOPES.read)).toBe(false)
    expect(isProjectToken({ id: 1, subjectType: PROJECT_TOKEN_OWNER, scopes: [PROJECT_SCOPES.read] }, PROJECT_SCOPES.read)).toBe(false)
  })
})

describe('a read key\'s life', () => {
  test('is the longest used here, because it runs unattended', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    expect(projectTokenExpiry(now).getTime() - now.getTime()).toBe(PROJECT_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000)
  })
})

describe('read key names', () => {
  test('a key given to a connected app is named after it', () => {
    expect(connectReadKeyName('cursio')).toBe('Connected: cursio')
    expect(connectReadKeyName('  my   app ')).toBe('Connected: my app')
    expect(connectReadKeyName('')).toBe('Connected app')
    expect(connectReadKeyName('x'.repeat(500)).length).toBeLessThanOrEqual('Connected: '.length + 100)
  })

  test('a key issued from settings has a fixed name', () => {
    expect(SETTINGS_READ_KEY_NAME).toBe('Read key')
  })
})

/*
 * A read key is the framework's token, owned by the project. The app mints,
 * lists, resolves and revokes it through @stacksjs/auth and keeps no
 * credential of its own.
 */
describe('a read key is the framework\'s token', () => {
  const support = read('app/Support/project-tokens.ts')

  test('minted, listed, resolved and revoked through @stacksjs/auth', () => {
    expect(support).toContain('import { createToken, findToken, revokeTokenById, tokens } from \'@stacksjs/auth\'')
    expect(support).toContain('tokenableType: PROJECT_TOKEN_OWNER')
    expect(support).not.toMatch(/getRandomValues|createHash|randomUUID/)
  })

  test('the app keeps no key column, generator or comparison', () => {
    for (const file of ['app/Support/read-key.ts', 'app/Hq/adapter.ts', 'app/Hq/service.ts', 'app/Support/request-auth.ts', 'routes/projects.ts']) {
      const source = read(file)
      expect({ file, clean: !/getRandomValues\(new Uint8Array\(32\)\)|createHash|sameKey\(|\bread_key\b(?!:)/.test(source) }).toEqual({ file, clean: true })
    }
    expect(read('app/Models/Project.ts')).not.toContain('read_key')
  })

  test('a read is authorised against the project in the path', () => {
    const auth = read('app/Support/request-auth.ts')
    const readAccess = auth.slice(auth.indexOf('export async function projectReadAccess'))
    expect(readAccess).toContain('projectForToken(presented, PROJECT_SCOPES.read)')
    // Another project's key answers 404, an archived project's 403.
    expect(readAccess).toContain('key.projectId !== String(projectId)')
    expect(readAccess).toContain('!key.isActive')
  })

  test('a read key is never resolved to a person', () => {
    const auth = read('app/Support/request-auth.ts')
    const holder = auth.slice(auth.indexOf('async function tokenHolder'), auth.indexOf('export async function sessionUser'))
    expect(holder).toContain('(access.subjectType ?? \'users\') !== \'users\'')
  })

  test('deleting a project revokes its read keys first', () => {
    const projects = read('routes/projects.ts')
    const handler = projects.slice(projects.indexOf('route.delete(\'/api/projects/{projectId}\', async'))
    expect(handler.indexOf('revokeProjectTokens(projectId, PROJECT_SCOPES.read)')).toBeLessThan(handler.indexOf('DELETE FROM projects WHERE id'))
  })
})
