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

  test('the code is the service\'s, with no copy or check of its own here', () => {
    // `@stacksjs/hq` issues the code and checks it, so the route neither
    // derives nor compares it: there is one place it can be got wrong.
    expect(routes).not.toContain('confirmationCode')
    expect(routes).not.toContain('confirmationMatches')
    expect(existsSync(join(ROOT, 'app/Hq/confirm.ts'))).toBe(false)
  })

  test('the CLI is given it when it starts a connect', () => {
    // The service's own answer, `{ code, approveUrl, confirmCode }`, unchanged.
    const start = routes.slice(routes.indexOf('route.post(\'/api/cli/connect\','), routes.indexOf('route.get(\'/api/cli/connect/{code}\''))
    expect(start).toContain('return hq.startConnect(hqRequest(request))')
  })

  test('the approve action hands the service what was typed, and answers a mismatch as one', () => {
    const approve = routes.slice(routes.indexOf('route.post(\'/api/cli/connect/{code}/approve\''))
    expect(approve).toContain('hq.approveConnect(code, { id: Number(user.id) }, request.jsonBody?.confirm)')
    expect(approve).toContain('result.reason === \'confirmation_mismatch\'')
    expect(approve).toContain('}, 422)')
    // After the session and Origin checks, and behind a per-person attempt limit.
    expect(approve.indexOf('sameOrigin(request)')).toBeLessThan(approve.indexOf('hq.approveConnect('))
    expect(approve.indexOf('hq-approve:')).toBeLessThan(approve.indexOf('hq.approveConnect('))
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
