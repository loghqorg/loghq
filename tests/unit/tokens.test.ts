/**
 * The token manifest: the app's roles as values, for a renderer that is not
 * Crosswind.
 *
 * `scripts/tokens.ts` resolves every colour role `@stacksjs/components` actually
 * uses down to a literal, per surface and per colour mode. These tests pin the
 * two things that are easy to get silently wrong, both of which the first two
 * drafts did get wrong:
 *
 *  1. SURFACES ARE NOT ONE THEME. loghq is emerald on marketing and indigo on
 *     the dashboard. A manifest that flattens them emits an accent no page
 *     renders.
 *  2. NESTING. `@media (prefers-color-scheme: dark)` contains rules, so a regex
 *     over `selector { body }` ends at the first inner `}` and loses every
 *     nested selector -- which attributed the dashboard's indigo to the base
 *     surface.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'config/tokens.json'), 'utf8')) as {
  roles: Record<string, Record<string, Record<string, string>>>
  lost: string[]
}
const config = readFileSync(join(ROOT, 'config/crosswind.ts'), 'utf8')

describe('token manifest', () => {
  test('covers both surfaces in both modes', () => {
    expect(Object.keys(manifest.roles).sort()).toEqual(['base', 'dashboard'])
    for (const surface of Object.keys(manifest.roles))
      expect(Object.keys(manifest.roles[surface]).sort(), surface).toEqual(['dark', 'light'])
  })

  test('every role resolves to a value, and none is left as a var() or a template hole', () => {
    for (const [surface, modes] of Object.entries(manifest.roles)) {
      for (const [mode, roles] of Object.entries(modes)) {
        expect(Object.keys(roles).length, `${surface}/${mode}`).toBe(19)
        for (const [role, value] of Object.entries(roles)) {
          expect(`${surface}/${mode}/${role}: ${value}`).not.toContain('var(')
          expect(`${surface}/${mode}/${role}: ${value}`).not.toContain('${')
        }
      }
    }
  })

  /*
   * The accent is the one role that differs per surface AND per mode, so it is
   * the case that catches a flattened or mis-nested parse. Read back out of the
   * config rather than hardcoded, so this keeps testing the resolution and not
   * a copy of its output.
   */
  test('the accent of each surface matches what the config declares for it', () => {
    const declared = [...config.matchAll(/(^|\n)\s*([^{\n][^{]*)\{([^}]*)\}/g)]
    expect(declared.length).toBeGreaterThan(0)

    // base: the two unscoped declarations; dashboard: the two .page-dashboard ones
    const accents = [...config.matchAll(/--accent:\s*(#[0-9a-f]{6})/gi)].map(m => m[1].toLowerCase())
    expect(accents).toContain(manifest.roles.base.light.accent)
    expect(accents).toContain(manifest.roles.base.dark.accent)
    expect(accents).toContain(manifest.roles.dashboard.light.accent)
    expect(accents).toContain(manifest.roles.dashboard.dark.accent)

    // and the surfaces must not have been flattened into each other
    expect(manifest.roles.base.light.accent).not.toBe(manifest.roles.dashboard.light.accent)
    expect(manifest.roles.base.dark.accent).not.toBe(manifest.roles.dashboard.dark.accent)
    // nor light into dark
    expect(manifest.roles.base.light.accent).not.toBe(manifest.roles.base.dark.accent)
    expect(manifest.roles.dashboard.light.accent).not.toBe(manifest.roles.dashboard.dark.accent)
  })

  /*
   * Recorded, not asserted away. This app has one text colour and one panel
   * colour, so a component asking for `fg-strong` or `bg-field` gets the same
   * value as `fg` and `bg-panel`. That is a real limit on what a shared
   * component can express here; the list exists so a NEW collapse is visible.
   */
  test('the known lost distinctions are exactly these two', () => {
    expect(manifest.lost.sort()).toEqual(['fg = fg-strong', 'panel = field'])
  })
})
