import { describe, expect, test } from 'bun:test'
import { validateWebhook } from '../../app/Errors/channels'

describe('alert channel URL policy', () => {
  test('accepts genuine Slack and Discord incoming webhooks', () => {
    expect(validateWebhook('slack', 'https://hooks.slack.com/services/T/B/token')).toEqual({ ok: true })
    expect(validateWebhook('discord', 'https://discord.com/api/webhooks/123/token')).toEqual({ ok: true })
    expect(validateWebhook('discord', 'https://discord.com/api/v10/webhooks/123/token')).toEqual({ ok: true })
  })

  test('rejects non-HTTPS and lookalike provider hosts', () => {
    expect(validateWebhook('slack', 'http://hooks.slack.com/services/T/B/token').ok).toBe(false)
    expect(validateWebhook('slack', 'https://hooks.slack.com.attacker.test/services/T/B/token').ok).toBe(false)
    expect(validateWebhook('discord', 'https://discord.com.attacker.test/api/webhooks/123/token').ok).toBe(false)
  })

  test('rejects provider pages that are not webhook endpoints', () => {
    expect(validateWebhook('slack', 'https://hooks.slack.com/').ok).toBe(false)
    expect(validateWebhook('discord', 'https://discord.com/channels/123').ok).toBe(false)
    expect(validateWebhook('email', 'https://hooks.slack.com/services/T/B/token').ok).toBe(false)
  })
})
