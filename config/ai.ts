import type { AiConfig } from '@stacksjs/types'
import { env } from '@stacksjs/env'

interface LogHqAiConfig extends AiConfig {
  default: 'anthropic' | 'openai' | 'ollama'
  drivers: {
    anthropic: { apiKey: string, model: string, maxTokens: number }
    openai: { apiKey: string, model: string, maxTokens: number, baseUrl: string }
    ollama: { host: string, model: string }
  }
  fix: {
    enabled: boolean
    maxContextBytes: number
    correlatedEntries: number
    cacheHours: number
    timeoutMs: number
  }
}

/**
 * **AI Configuration**
 *
 * Drives "Fix with AI" (app/Fix/, resources/views/fix.stx): given one log
 * entry and the lines around it, explain the root cause and propose a fix.
 *
 * Nothing here reads the repository or writes to GitHub. The reserved columns
 * in `log_fix_runs` are for that later phase; until it exists, the only
 * outbound call this feature makes is to the configured model provider.
 */
export default {
  // Anthropic by default. The analysis is one structured-output call over
  // untrusted log text, which is exactly the shape Claude's tool/JSON mode
  // handles best, and Sonnet is the right rung: the run is per-log-line, so
  // per-call cost matters more here than peak reasoning.
  default: String(env.AI_DRIVER || 'anthropic') as 'anthropic' | 'openai' | 'ollama',

  drivers: {
    anthropic: {
      apiKey: String(env.ANTHROPIC_API_KEY || ''),
      model: String(env.ANTHROPIC_MODEL || 'claude-sonnet-5'),
      maxTokens: Number(env.ANTHROPIC_MAX_TOKENS || 8192),
    },
    openai: {
      apiKey: String(env.OPENAI_API_KEY || ''),
      model: String(env.OPENAI_MODEL || 'gpt-4o'),
      maxTokens: Number(env.OPENAI_MAX_TOKENS || 8192),
      baseUrl: String(env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
    },
    ollama: {
      host: String(env.OLLAMA_HOST || 'http://localhost:11434'),
      model: String(env.OLLAMA_MODEL || 'llama3.2'),
    },
  },

  fix: {
    // The button disappears entirely when this is off, rather than failing on
    // click.
    enabled: String(env.AI_FIX_ENABLED ?? 'true') !== 'false',
    // Ceiling on the log payload sent to the provider. `context` alone is
    // allowed 96 KiB at ingest, so an unbounded prompt is a real possibility.
    maxContextBytes: Math.min(256 * 1024, Math.max(8 * 1024, Number(env.AI_FIX_MAX_CONTEXT_BYTES || 48 * 1024))),
    // How many surrounding entries travel with the one being analyzed. This is
    // loghq's edge over an error tracker: the lines either side of a failure
    // usually say more than the failure does.
    correlatedEntries: Math.min(40, Math.max(0, Number(env.AI_FIX_CORRELATED_ENTRIES || 12))),
    // How long a completed answer keeps serving repeats of the same error
    // shape. Long, because the answer only goes stale when the code changes,
    // and "Re-analyze" is always available.
    cacheHours: Math.max(1, Number(env.AI_FIX_CACHE_HOURS || 168)),
    // The analysis runs inside the request that starts it, so this bound is
    // also the worst case a user waits on the button.
    timeoutMs: Math.min(180_000, Math.max(10_000, Number(env.AI_FIX_TIMEOUT_MS || 90_000))),
  },

  models: [
    'amazon.titan-text-express-v1',
    'amazon.titan-text-lite-v1',
    'meta.llama2-70b-chat-v1',
  ],

  deploy: false,
} satisfies LogHqAiConfig
