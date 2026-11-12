import type { AlertIssue } from '../../app/Errors/alerts'
import type { LogRow } from '../../app/Logs/normalize'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { alertCandidates, createSeenStore, fireLogAlerts, MAX_ALERTS_PER_BATCH, QUIET_MS } from '../../app/Errors/log-alerts'

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

function deps(options: { allow?: boolean[] } = {}) {
  const sent: Array<{ projectId: string, issue: AlertIssue }> = []
  const allow = [...(options.allow ?? [])]
  const clock = { at: 1_000_000 }
  return {
    sent,
    clock,
    deps: {
      seen: createSeenStore(),
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
    const { deps: d, sent } = deps({ allow: [false, true] })
    expect(await fireLogAlerts('p1', [row('error', 'gateway timeout')], d)).toBe(0)
    expect(await fireLogAlerts('p1', [row('error', 'gateway timeout')], d)).toBe(1)
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

describe('wiring', () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, '..', '..', path), 'utf8')

  test('the ingest calls it, after storing, without awaiting', () => {
    expect(read('routes/logs.ts')).toContain('void fireLogAlerts(projectId, kept)')
  })

  test('the settings page no longer says delivery is not live', () => {
    expect(read('resources/views/settings.stx')).not.toContain('Automatic delivery isn\'t live yet')
  })

  test('alert links do not point at an issue page this app does not have', () => {
    expect(read('app/Errors/alerts.ts')).not.toContain('/issue/')
    expect(read('app/Errors/channels.ts')).not.toContain('/issue/')
  })
})
