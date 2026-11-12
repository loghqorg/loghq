import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashConnectCode } from '@stacksjs/hq/service'
import { confirmationCode, confirmationMatches } from '../../app/Hq/confirm'

const ROOT = join(import.meta.dir, '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const CODE = '6rKvL4SxrZnDT3j-VwO8wdaIPibVc9gtrHoujMoDHdc'
const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('the confirmation code', () => {
  test('is short, readable, and the same every time for one connect code', () => {
    const code = confirmationCode(CODE)
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{3}-[A-HJKMNP-Z2-9]{3}$/)
    expect(confirmationCode(CODE)).toBe(code)
  })

  test('differs between connect codes', () => {
    const codes = new Set(Array.from({ length: 200 }, (_, i) => confirmationCode(`${CODE}${i}`)))
    expect(codes.size).toBeGreaterThan(195)
    expect(confirmationCode(OTHER)).not.toBe(confirmationCode(CODE))
  })

  test('is not the hash the store keeps, nor a piece of the connect code', async () => {
    const confirm = confirmationCode(CODE).replace('-', '').toLowerCase()
    expect((await hashConnectCode(CODE)).startsWith(confirm)).toBe(false)
    expect(CODE.toLowerCase()).not.toContain(confirm)
  })

  test('matches what a person would type, however they type it', () => {
    const code = confirmationCode(CODE)
    for (const typed of [code, code.toLowerCase(), code.replace('-', ''), ` ${code} `, code.replace('-', ' ')])
      expect(confirmationMatches(CODE, typed)).toBe(true)
  })

  test('refuses anything else', () => {
    const code = confirmationCode(CODE)
    for (const typed of [undefined, null, '', 'ABC-DEF', code.slice(0, 5), `${code}X`, confirmationCode(OTHER), true, 123456])
      expect(confirmationMatches(CODE, typed)).toBe(false)
  })
})

describe('where the confirmation code travels', () => {
  const routes = read('routes/hq.ts')
  const page = read('resources/views/cli/connect.stx')

  test('the CLI is given it when it starts a connect', () => {
    expect(routes).toContain('confirmCode: confirmationCode(body.code)')
  })

  test('the approve action refuses without it, before anything is provisioned', () => {
    const approve = routes.slice(routes.indexOf('route.post(\'/api/cli/connect/{code}/approve\''))
    expect(approve).toContain('confirmationMatches(code, request.jsonBody?.confirm)')
    expect(approve.indexOf('confirmationMatches(')).toBeLessThan(approve.indexOf('hq.approveConnect('))
    // After the session and Origin checks, and behind a per-person attempt limit.
    expect(approve.indexOf('sameOrigin(request)')).toBeLessThan(approve.indexOf('confirmationMatches('))
    expect(approve.indexOf('hq-approve:')).toBeLessThan(approve.indexOf('confirmationMatches('))
  })

  test('the page asks for it and never renders it', () => {
    expect(page).toContain('name="confirm"')
    expect(page).toContain('body: JSON.stringify({ confirm: typed })')
    // If the page could compute or print the code, a person sent the link
    // could approve with no terminal at all.
    expect(page).not.toContain('confirmationCode')
    expect(page).not.toContain('confirmCode')
    // And it is not smuggled into the approve URL the CLI opens.
    expect(read('app/Hq/adapter.ts')).toContain('approveUrl: code => `${deps.origin()}/cli/connect?code=${encodeURIComponent(code)}`')
  })

  test('the page says in words when an existing app\'s keys will be shared', () => {
    expect(page).toContain('This shares the keys of an app you already have.')
    expect(page).toContain('Approving sends its existing ingest key and its read key to the terminal that asked.')
    expect(page).toContain('{{ existingName }}')
    expect(page).toContain('{{ existingId }}')
    expect(page).toContain('Approving creates a new app called')
  })

  test('the lookup behind that notice is scoped to the signed-in person', () => {
    const service = read('app/Hq/service.ts')
    expect(service).toContain('sqlProjectStore.findOwnedByName(userId, described.app)')
    expect(page).toContain('__describeApproval(code, Number(user.id))')
  })
})
