import type { ConnectGrant, UsageReport } from '@stacksjs/hq/service'
import type { HqProject, HqUser, ProjectStore } from '../../app/Hq/adapter'
import { describe, expect, test } from 'bun:test'
import { createHqService, createMemoryConnectCodeStore } from '@stacksjs/hq/service'
import { hqServiceContract } from '@stacksjs/hq/testing'
import { FREE_LOG_LINES_PER_MONTH } from '../../app/Billing/plans'
import { ConnectRefusedError, createLoghqAdapter } from '../../app/Hq/adapter'
import { looksLikeReadKey } from '../../app/Support/read-key'

const ORIGIN = 'https://loghq.test'

/** The `projects` table, as much of it as the adapter touches. */
function memoryProjects(seed: HqProject[] = []): ProjectStore & { rows: HqProject[], touched: string[] } {
  const rows = seed.map(project => ({ ...project }))
  const touched: string[] = []
  const byId = (id: string) => rows.find(project => project.id === id)
  return {
    rows,
    touched,
    async findOwnedByName(ownerId, name) {
      const found = rows.find(project => project.ownerId === ownerId && project.name.toLowerCase() === name.toLowerCase())
      return found ? { ...found } : null
    },
    async create({ platform: _platform, ...project }) {
      rows.push({ ...project })
    },
    async setReadKey(projectId, readKey) {
      byId(projectId)!.readKey = readKey
    },
    async setIngestKey(projectId, ingestKey) {
      byId(projectId)!.ingestKey = ingestKey
    },
    async findByReadKey(readKey) {
      const found = rows.find(project => project.readKey === readKey)
      return found ? { ...found } : null
    },
    async touchReadKey(projectId) {
      touched.push(projectId)
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
    await service.approveConnect(code, user)
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
    expect(await service.approveConnect(code, ALICE)).toEqual({ ok: true, project: { id: projects.rows[0]!.id, name: 'cursio' } })

    const first = await call(`/api/cli/connect/${code}`)
    expect(first.status).toBe(200)
    expect(first.body).toEqual({
      status: 'approved',
      project: { id: projects.rows[0]!.id, name: 'cursio' },
      ingestKey: projects.rows[0]!.ingestKey,
      readKey: projects.rows[0]!.readKey,
      dashboardUrl: `${ORIGIN}/dashboard?project=${projects.rows[0]!.id}`,
    })
    expect(first.body.ingestKey).toMatch(/^loghq_[0-9a-f]{64}$/)
    expect(looksLikeReadKey(first.body.readKey)).toBe(true)
    expect(projects.rows[0]).toMatchObject({ ownerId: 1, isActive: true })

    // Collected: the code is gone for everyone, including a second poll.
    expect(await call(`/api/cli/connect/${code}`)).toEqual({ status: 404, body: { status: 'expired' } })
  })

  test('an expired code is expired whether or not it was approved', async () => {
    const { start, call, service, clock, projects } = setup()
    const pending = await start('cursio')
    const approved = await start('other')
    await service.approveConnect(approved.code, ALICE)
    clock.at += 10 * 60 * 1000 + 1
    expect(await call(`/api/cli/connect/${pending.code}`)).toEqual({ status: 404, body: { status: 'expired' } })
    expect(await call(`/api/cli/connect/${approved.code}`)).toEqual({ status: 404, body: { status: 'expired' } })
    expect(await service.approveConnect(pending.code, ALICE)).toEqual({ ok: false, reason: 'expired' })
    expect(await service.describeConnect(pending.code)).toBeNull()
    // The unapproved one never created anything.
    expect(projects.rows.map(project => project.name)).toEqual(['other'])
  })

  test('an unknown or malformed code is expired, and creates nothing', async () => {
    const { call, service, projects } = setup()
    expect(await call(`/api/cli/connect/${'a'.repeat(43)}`)).toEqual({ status: 404, body: { status: 'expired' } })
    expect(await call('/api/cli/connect/nope')).toEqual({ status: 404, body: { status: 'expired' } })
    expect(await service.approveConnect('a'.repeat(43), ALICE)).toEqual({ ok: false, reason: 'expired' })
    expect(projects.rows).toEqual([])
  })

  test('connecting an app the account already has reuses the project and its keys', async () => {
    const existing: HqProject = { id: 'cursio-abc123', name: 'Cursio', ownerId: 1, ingestKey: 'loghq_existing', readKey: `lhq_read_${'a'.repeat(64)}`, isActive: true }
    const { connect, projects } = setup({ projects: [existing] })
    const grant = await connect('cursio', ALICE)
    expect(grant).toMatchObject({ project: { id: 'cursio-abc123', name: 'Cursio' }, ingestKey: 'loghq_existing', readKey: existing.readKey })
    expect(projects.rows).toHaveLength(1)
  })

  test('a reused project with no read key is issued one, and keeps its ingest key', async () => {
    const existing: HqProject = { id: 'cursio-abc123', name: 'cursio', ownerId: 1, ingestKey: 'loghq_existing', readKey: null, isActive: true }
    const { connect, projects } = setup({ projects: [existing] })
    const grant = await connect('cursio', ALICE)
    expect(grant.ingestKey).toBe('loghq_existing')
    expect(looksLikeReadKey(grant.readKey)).toBe(true)
    expect(projects.rows[0]!.readKey).toBe(grant.readKey)
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
    const archived: HqProject = { id: 'cursio-abc123', name: 'cursio', ownerId: 1, ingestKey: 'loghq_existing', readKey: null, isActive: false }
    const { start, service } = setup({ projects: [archived] })
    const { code } = await start('cursio')
    await expect(service.approveConnect(code, ALICE)).rejects.toBeInstanceOf(ConnectRefusedError)
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

  test('stamps the read key as used', async () => {
    const { connect, usage, projects } = setup()
    const grant = await connect('cursio', ALICE)
    await usage(grant.readKey)
    expect(projects.touched).toEqual([grant.project.id])
  })
})
