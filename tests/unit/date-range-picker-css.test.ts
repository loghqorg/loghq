import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CSSGenerator, defaultConfig } from '@cwcss/crosswind'
// The installed stx package does not export this subpath by bare specifier.
import { mergeCssConfig } from '../../node_modules/@stacksjs/stx/dist/ts-css-config.js'
import theme from '../../config/crosswind'

const ROOT = join(import.meta.dir, '../..')

/*
 * The picker's stylesheet moved out of a <style> block in analytics.stx and
 * into config/crosswind.ts preflights (stx-standards rule 3). It is a
 * relocation rather than a utility rewrite because every state in this widget
 * is a compound selector the client script toggles, and no utility can say
 * "this class AND that class" -- the arbitrary-variant spelling that could,
 * [&.is-range]:…, emits nothing in this engine.
 *
 * That makes the rules below the fragile part: they are plain CSS in a config
 * file now, reached through a merge, and nothing else would notice if they
 * stopped arriving. The selected range would simply stop painting.
 */
const merged: any = mergeCssConfig(defaultConfig as any, theme as any)
const generator = new CSSGenerator(merged.config)
const sheet: string = generator.toCSS(merged.includePreflight, merged.minify)
// stx pins minify false, so compare without whitespace or trailing semicolons.
const appPreflights = (theme as any).preflights as { getCSS: () => string }[]
const flat = sheet.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '').replace(/;\}/g, '}')

function contains(rule: string): boolean {
  return flat.includes(rule.replace(/\s+/g, '').replace(/;\}/g, '}'))
}

describe('date range picker CSS reaches the generated sheet', () => {
  test('preflights are merged and emitted at all', () => {
    // This app's config used to state the opposite, from a stx version where
    // the dev-server merge dropped preflights outright (stacksjs/stx#1867).
    // If that ever regresses, every rule in this file goes with it.
    expect(merged.includePreflight).toBe(true)
    // The app's own entries, one per rule, plus the engine's built-in reset.
    expect(appPreflights.length).toBeGreaterThan(30)
    expect(merged.config.preflights.length).toBeGreaterThan(appPreflights.length)
  })

  test('the JS-toggled state rules are present', () => {
    expect(contains('.range-tool.is-active { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }')).toBe(true)
    expect(contains('.drp-preset.is-active { color: var(--accent-ink); background: var(--accent); }')).toBe(true)
    expect(contains('.drp-day.is-range { background: var(--accent-soft); }')).toBe(true)
    expect(contains('.drp-day.is-edge { background: var(--accent); color: var(--accent-ink); border-radius: 8px; }')).toBe(true)
    expect(contains('.drp-nav.is-hidden { visibility: hidden; }')).toBe(true)
    expect(contains('.drp-day.is-disabled:hover { background: transparent; }')).toBe(true)
  })

  test('the selectors no utility could express are present', () => {
    expect(contains('.date-menu > summary::-webkit-details-marker { display: none; }')).toBe(true)
    expect(contains('summary:focus-visible {')).toBe(true)
    expect(flat).toContain('@media(max-width:1023px)')
  })

  test('the phone layout collapses to one calendar', () => {
    // Inside the media block, so it also proves an @media rule survived whole.
    expect(contains('.drp-cal.is-right { display: none; }')).toBe(true)
    expect(contains('.drp-cal.is-left .drp-nav.is-hidden { visibility: visible; }')).toBe(true)
  })

  test('each preflight entry holds exactly one top-level rule', () => {
    /*
     * The invariant that keeps the rest of this file true. A getCSS() returning
     * several rules silently loses some of them -- measured on commshq, where
     * ten in one string came back with two rules gone and a @keyframes body
     * spliced into the rule before it. Adding a rule to an existing entry is
     * the easy mistake, so it fails here rather than on the page.
     *
     * This app's entries only: the engine contributes its own preflight, and
     * the Tailwind reset is one entry holding 38 rules.
     */
    for (const preflight of appPreflights) {
      const css = preflight.getCSS()
      let depth = 0
      let closes = 0
      for (const ch of css) {
        if (ch === '{')
          depth++
        else if (ch === '}') {
          depth--
          if (depth === 0)
            closes++
        }
      }
      expect(`${css.slice(0, 60)} -> ${closes}`).toBe(`${css.slice(0, 60)} -> 1`)
    }
  })
})

describe('stx-standards rule 3', () => {
  test('no view or component carries a style block', () => {
    const stx = (dir: string): string[] => {
      const out: string[] = []
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory())
          out.push(...stx(full))
        else if (entry.endsWith('.stx'))
          out.push(full)
      }
      return out
    }
    for (const file of stx(join(ROOT, 'resources'))) {
      const source = readFileSync(file, 'utf8')
      // An opening tag at the start of a line. Prose about a <style> block that
      // USED to be here is not a violation, and this app's comments have
      // several -- matching '<style' anywhere counts those.
      expect(`${file}: ${/^[ \t]*<style[ >]/m.test(source)}`).toBe(`${file}: false`)
    }
  })
})
