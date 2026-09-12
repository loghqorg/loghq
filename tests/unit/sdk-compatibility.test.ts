import { describe, expect, test } from 'bun:test'
import contracts from '../fixtures/sdk-ingest-contracts.json'
import { normalizeBatch } from '../../app/Logs/normalize'

describe('SDK ingest compatibility', () => {
  for (const client of contracts.clients) {
    test(`${client.name} emits an accepted v${contracts.version} batch`, () => {
      let id = 0
      const normalized = normalizeBatch(client.body, {
        projectId: 'resolved-from-ingest-key',
        receivedAt: '2026-09-12T00:00:01.000Z',
        newId: () => `row-${++id}`,
      })

      expect(client.path).toBe('/logs')
      expect(client.headerKey).toStartWith('loghq_')
      expect(normalized.skipped).toBe(0)
      expect(normalized.dropped).toBe(0)
      expect(normalized.rows).toHaveLength(client.body.logs.length)

      const row = normalized.rows[0]!
      expect(row.message).toBe(client.body.logs[0]!.message)
      expect(JSON.parse(row.sdk || '{}').name).toBe(client.body.logs[0]!.sdk.name)
      expect(row.project_id).toBe('resolved-from-ingest-key')
    })
  }
})
