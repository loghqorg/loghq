/**
 * When "Fix with AI" is on offer.
 *
 * Split out of analyze.ts so the dashboard can ask these questions without
 * importing the analyzer - and with it `@stacksjs/ai` - into a page that
 * renders a hundred rows and calls no model. This module reads config and
 * nothing else.
 */
import aiConfig from '../../config/ai'

/**
 * Severities worth spending a model call on.
 *
 * `warning` is the floor. Below it the answer is almost always "nothing is
 * wrong", and offering the button there trains people to ignore it.
 */
const FIXABLE_LEVELS = new Set(['warning', 'error', 'critical', 'alert', 'emergency'])

export function fixableLevel(level?: string | null): boolean {
  return FIXABLE_LEVELS.has(String(level ?? '').toLowerCase())
}

/** The operator switch. Off means the button is never drawn. */
export function fixEnabled(): boolean {
  return aiConfig.fix.enabled
}

/**
 * Whether a provider is usable, as opposed to merely selected.
 *
 * Checked before the button is offered so an unconfigured install says so up
 * front, instead of failing on click after the user has committed to waiting.
 */
export function fixConfigured(): boolean {
  if (!aiConfig.fix.enabled)
    return false
  if (aiConfig.default === 'anthropic')
    return !!aiConfig.drivers.anthropic.apiKey
  if (aiConfig.default === 'openai')
    return !!aiConfig.drivers.openai.apiKey
  // Ollama is a local host rather than a key, so there is nothing to verify
  // short of calling it.
  return !!aiConfig.drivers.ollama.host
}
