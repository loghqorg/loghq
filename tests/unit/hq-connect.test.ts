import type { ConnectGrant, UsageReport } from '@stacksjs/hq/service'
import type { HqProject, HqUser, ProjectStore } from '../../app/Hq/adapter'
import { describe, expect, test } from 'bun:test'
import { confirmationCode, createHqService, createMemoryConnectCodeStore } from '@stacksjs/hq/service'
import { hqServiceContract } from '@stacksjs/hq/testing'
import { FREE_LOG_LINES_PER_MONTH } from '../../app/Billing/plans'
import { ConnectRefusedError, createLoghqAdapter } from '../../app/Hq/adapter'

const ORIGIN = 'https://loghq.test'

/** A read key as the store keeps it: which project it reads, and whether it is still live. */
interface IssuedKey { projectId: string, key: string, name: string, revoked: boolean }

/**
 * The `projects` table and the project's read keys, as much of both as the
 * adapter touches. The real store mints a framework token and keeps a hash
 * (app/Support/project-tokens.ts); this one keeps the key so a test can
 * present it back.
 */
function memoryProjects(seed: HqProject[] = []): ProjectStore & { rows: HqProject[], keys: IssuedKey[] } {
  const rows = seed.map(project => ({ ...project }))
  const keys: IssuedKey[] = []
  const byId = (id: string) => rows.find(project => project.id === id)
  return {
    rows,
    keys,
    async findOwnedByName(ownerId, name) {
      const found = rows.find(project => project.ownerId === ownerId && project.name.toLowerCase() === name.toLowerCase())
      return found ? { ...found } : null
    },
    async create({ platform: _platform, ...project }) {
      rows.push({ ...project })
    },
    async setIngestKey(projectId, ingestKey) {
      byId(projectId)!.ingestKey = ingestKey
    },
    async issueReadKey(projectId, name) {
      const key = `read-key-${keys.length + 1}-${globalThis.crypto.randomUUID()}`
      keys.push({ projectId, key, name, revoked: false })
      return key
    },
    async findByReadKey(readKey) {
      const issued = keys.find(entry => entry.key === readKey && !entry.revoked)
      const found = issued ? byId(issued.projectId) : undefined
      return found ? { ...found } : null
    },
  }
}

function setup(options: { projects?: HqProject[], pro?: number[], used?: Record<number, number> } = {}) {
  const projects = memoryProjects(options.projects)
  const pro = new Set(options.pro ?? [])
  const used = options.used ?? {}
  const adapter = createLoghqAdapter({
    projects,
    codes: createMemoryConnectCodeStore(),
    origin: () => ORIGIN,
    isPro: async ownerId => pro.has(ownerId),
    linesUsed: async ownerId => used[ownerId] ?? 0,
  })
  const clock = { at: Date.parse('2026-03-10T12:00:00.000Z') }
  const service = createHqService(adapter, { now: () => new Date(clock.at) })

  const call = async (path: string, init: { method?: string, body?: unknown, headers?: Record<string, string> } = {}) => {
    const response = await service.handle(new Request(`${ORIGIN}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }))
    return { status: response!.status, body: await response!.json() as any }
  }
  const start = async (app: string) => (await call('/api/cli/connect', { method: 'POST', body: { app } })).body as { code: string, approveUrl: string }
  const connect = async (app: string, user: HqUser): Promise<ConnectGrant> => {
    const { code } = await start(app)
    await service.approveConnect(code, user, await confirmationCode(code))
    return (await call(`/api/cli/connect/${code}`)).body
  }
  const usage = (key?: string) => call('/api/v1/usage', { headers: key ? { Authorization: `Bearer ${key}` } : undefined })

  return { projects, adapter, service, clock, call, start, connect, usage }
}

const ALICE: HqUser = { id: 1 }
const BOB: HqUser = { id: 2 }

// The package's own suite, against LogHQ's adapter rather than the in-memory
// reference one: codes hashed at rest, single use under concurrent polls,
// expiry, project reuse, read-key refusal and the usage shape.
hqServiceContract('loghq', () => ({ adapter: setup().adapter, user: ALICE }))

describe('connect flow', () => {
  test('a new code is pending and points at this service\'s approve page', async () => {
    const { start, call, service } = setup()
    const { code, approveUrl } = await start('cursio')
    expect(approveUrl).toBe(`${ORIGIN}/cli/connect?code=${code}`)
    expect(await call(`/api/cli/connect/${code}`)).toEqual({ status: 200, body: { status: 'pending' } })
    expect(await service.describeConnect(code)).toMatchObject({ app: 'cursio' })
  })

  test('approving creates a project named after the app and hands over its keys once', async () => {
    const { start, call, service, projects } = setup()
    const { code } = await start('cursio')
    expect(await service.approveConnect(code, ALICE, await confirmationCode(code))).toEqual({ ok: true, project: { id: projects.rows[0]!.id, name: 'cursio' } })

    const first = await call(`/api/cli/connect/${code}`)
    expect(first.status).toBe(200)
    expect(first.body).toEqual({
      status: 'approved',
      project: { id: projects.rows[0]!.id, name: 'cursio' },
      ingestKey: projects.rows[0]!.ingestKey,
      readKey: projects.keys[0]!.key,
      dashboardUrl: `${ORIGIN}/dashboard?project=${projects.rows[0]!.id}`,
    })
    expect(first.body.ingestKey).toMatch(/^loghq_[0-9a-f]{64}$/)
    // Named after the app it was connected for, so it can be told apart in a list.
    expect(projects.keys[0]).toMatchObject({ projectId: projects.rows[0]!.id, name: 'Connected: cursio' })
    expect(projects.rows[0]).toMatchObject({ ownerId: 1, isActive: true })

    // Collected: the code is gone for everyone, including a second poll.
    expect(await call(`/api/cli/connect/${code}`)).toEqual({ status: 404, body: { status: 'expired' } })
  })

  test('an expired code is expired whether or not it was approved', async () => {
    const { start, call, service, clock, projects } = setup()
    const pending = await start('cursio')
    const approved = await start('other')
    await service.approveConnect(approved.code, ALICE, await confirmationCode(approved.code))
    clock.at += 10 * 60 * 1000 + 1
    expect(await call(`/api/cli/connect/${pending.code}`)).toEqual({ status: 404, body: { status: 'expired' } })
    expect(await call(`/api/cli/connect/${approved.code}`)).toEqual({ status: 404, body: { status: 'expired' } })
    expect(await service.approveConnect(pending.code, ALICE, await confirmationCode(pending.code))).toEqual({ ok: false, reason: 'expired' })
    expect(await service.describeConnect(pending.code)).toBeNull()
    // The unapproved one never created anything.
    expect(projects.rows.map(project => project.name)).toEqual(['other'])
  })

  test('an unknown or malformed code is expired, and creates nothing', async () => {
    const { call, service, projects } = setup()
    expect(await call(`/api/cli/connect/${'a'.repeat(43)}`)).toEqual({ status: 404, body: { status: 'expired' } })
    expect(await call('/api/cli/connect/nope')).toEqual({ status: 404, body: { status: 'expired' } })
    expect(await service.approveConnect('a'.repeat(43), ALICE, await confirmationCode('a'.repeat(43)))).toEqual({ ok: false, reason: 'expired' })
    expect(projects.rows).toEqual([])
  })

  test('connecting an app the account already has reuses the project and its ingest key', async () => {
    const existing: HqProject = { id: 'cursio-abc123', name: 'Cursio', ownerId: 1, ingestKey: 'loghq_existing', isActive: true }
    const { connect, projects } = setup({ projects: [existing] })
    const grant = await connect('cursio', ALICE)
    expect(grant).toMatchObject({ project: { id: 'cursio-abc123', name: 'Cursio' }, ingestKey: 'loghq_existing' })
    expect(projects.rows).toHaveLength(1)
  })

  test('each connect is given a read key of its own, and the earlier one keeps working', async () => {
    const { connect, usage, projects } = setup()
    const first = await connect('cursio', ALICE)
    // A second machine. A stored key is a hash and cannot be handed out twice,
    // so it gets its own, and the first machine's is not rotated.
    const second = await connect('cursio', ALICE)
    expect(second.readKey).not.toBe(first.readKey)
    expect(projects.keys.map(entry => entry.revoked)).toEqual([false, false])
    expect((await usage(first.readKey)).status).toBe(200)
    expect((await usage(second.readKey)).status).toBe(200)
  })

  test('two accounts connecting the same app name get separate projects', async () => {
    const { connect, projects } = setup()
    const a = await connect('cursio', ALICE)
    const b = await connect('cursio', BOB)
    expect(a.project.id).not.toBe(b.project.id)
    expect(a.readKey).not.toBe(b.readKey)
    expect(projects.rows.map(project => project.ownerId)).toEqual([1, 2])
  })

  test('an archived project is refused instead of handing over dead keys', async () => {
    const archived: HqProject = { id: 'cursio-abc123', name: 'cursio', ownerId: 1, ingestKey: 'loghq_existing', isActive: false }
    const { start, service } = setup({ projects: [archived] })
    const { code } = await start('cursio')
    await expect(service.approveConnect(code, ALICE, await confirmationCode(code))).rejects.toBeInstanceOf(ConnectRefusedError)
    // Refused, not consumed: restoring the project and approving again works.
    expect(await service.describeConnect(code)).toMatchObject({ app: 'cursio' })
  })
})

describe('GET /api/v1/usage', () => {
  test('answers the account\'s log line usage against the free allowance', async () => {
    const { connect, usage } = setup({ used: { 1: 412 } })
    const grant = await connect('cursio', ALICE)
    const { status, body } = await usage(grant.readKey)
    expect(status).toBe(200)
    expect(body as UsageReport[]).toEqual([{
      meter: 'log_lines',
      used: 412,
      limit: FREE_LOG_LINES_PER_MONTH,
      period: '2026-03',
      state: 'ok',
      upgradeUrl: `${ORIGIN}/pricing`,
    }])
  })

  test('reports warn, over and sampled as the account passes each threshold', async () => {
    const states: Record<number, string> = { 7999: 'ok', 8000: 'warn', 10_000: 'over', 12_000: 'over', 12_001: 'sampled' }
    for (const [used, state] of Object.entries(states)) {
      const { connect, usage } = setup({ used: { 1: Number(used) } })
      const grant = await connect('cursio', ALICE)
      expect((await usage(grant.readKey)).body[0]).toMatchObject({ used: Number(used), state })
    }
  })

  test('a paid account is unlimited', async () => {
    const { connect, usage } = setup({ pro: [1], used: { 1: 250_000 } })
    const grant = await connect('cursio', ALICE)
    expect((await usage(grant.readKey)).body).toEqual([{
      meter: 'log_lines',
      used: 250_000,
      limit: null,
      period: '2026-03',
      state: 'ok',
      upgradeUrl: `${ORIGIN}/pricing`,
    }])
  })

  test('usage is the account\'s: every project of one owner reports the same total', async () => {
    const { connect, usage } = setup({ used: { 1: 900 } })
    const first = await connect('cursio', ALICE)
    const second = await connect('other', ALICE)
    expect((await usage(first.readKey)).body[0].used).toBe(900)
    expect((await usage(second.readKey)).body[0].used).toBe(900)
  })

  test('refuses anything that is not this project\'s read key', async () => {
    const { connect, usage, projects } = setup()
    const grant = await connect('cursio', ALICE)
    for (const key of [undefined, 'nope', grant.ingestKey, `lhq_read_${'0'.repeat(64)}`, `lhqrt_${'0'.repeat(64)}`])
      expect((await usage(key)).status).toBe(401)
    // An archived project's key stops reading.
    projects.rows[0]!.isActive = false
    expect((await usage(grant.readKey)).status).toBe(401)
  })

  test('a revoked read key stops reading', async () => {
    const { connect, usage, projects } = setup()
    const grant = await connect('cursio', ALICE)
    expect((await usage(grant.readKey)).status).toBe(200)
    projects.keys[0]!.revoked = true
    expect((await usage(grant.readKey)).status).toBe(401)
  })
})

describe('the confirmation code a connect is approved with', () => {
  test('starting a connect answers it, and the approve URL does not carry it', async () => {
    const { call } = setup()
    const { body } = await call('/api/cli/connect', { method: 'POST', body: { app: 'cursio' } })
    expect(body.confirmCode).toBe(await confirmationCode(body.code))
    expect(body.approveUrl).not.toContain(body.confirmCode)
  })

  test('approving without it, or with another connect\'s, provisions nothing and leaves the code pending', async () => {
    const { start, call, service, projects } = setup()
    const { code } = await start('cursio')
    const other = await confirmationCode((await start('other')).code)
    for (const typed of [undefined, '', 'ABC-DEF', other])
      expect(await service.approveConnect(code, ALICE, typed)).toEqual({ ok: false, reason: 'confirmation_mismatch' })
    expect(projects.rows).toEqual([])
    expect(await call(`/api/cli/connect/${code}`)).toEqual({ status: 200, body: { status: 'pending' } })
    // The right one still works afterwards, typed in lower case and without the dash.
    const typed = (await confirmationCode(code)).toLowerCase().replace('-', '')
    expect((await service.approveConnect(code, ALICE, typed)).ok).toBe(true)
  })
})
