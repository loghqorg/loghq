import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The code itself (its shape, how it is derived and compared) is the
// package's, and tested there: `@stacksjs/hq` confirm. What is LogHQ's own is
// where the code travels, which is what this covers.
const ROOT = join(import.meta.dir, '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

describe('where the confirmation code travels', () => {
  const routes = read('routes/hq.ts')
  const page = read('resources/views/cli/connect.stx')

  test('the code is the package\'s, with no copy of its own here', () => {
    expect(routes).toContain('import { confirmationCode, confirmationMatches } from \'@stacksjs/hq/service\'')
    expect(existsSync(join(ROOT, 'app/Hq/confirm.ts'))).toBe(false)
  })

  test('the CLI is given it when it starts a connect', () => {
    expect(routes).toContain('confirmCode: body.confirmCode ?? await confirmationCode(body.code)')
  })

  test('the approve action refuses without it, before anything is provisioned', () => {
    const approve = routes.slice(routes.indexOf('route.post(\'/api/cli/connect/{code}/approve\''))
    expect(approve).toContain('await confirmationMatches(code, request.jsonBody?.confirm)')
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
