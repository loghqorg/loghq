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
/*
 * Addressed by content, not by index. This was `appPreflights[0]` while the
 * picker was the config's only entry; TOKENS and APP_CHROME joined it when
 * public/tokens.css, public/app-chrome.css and public/marketing.css moved in,
 * and an index would have silently started asserting about the palette
 * instead.
 */
const picker = appPreflights.find(entry => entry.getCSS().includes('.drp-day'))!
const flat = sheet.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '').replace(/;\}/g, '}')

function contains(rule: string): boolean {
  // Same normalisation as `flat`, comments included: the splitter hands a
  // rule its preceding comment, and the sheet has none.
  const needle = rule.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '').replace(/;\}/g, '}')
  return needle.length > 0 && flat.includes(needle)
}

describe('date range picker CSS reaches the generated sheet', () => {
  test('preflights are merged and emitted at all', () => {
    // This app's config used to state the opposite, from a stx version where
    // the dev-server merge dropped preflights outright (stacksjs/stx#1867).
    // If that ever regresses, every rule in this file goes with it.
    expect(merged.includePreflight).toBe(true)
    // The picker, the design tokens, the app chrome, and the marketing sheet.
    expect(appPreflights.length).toBe(4)
    expect(picker).toBeDefined()
    // Plus the engine's own reset, which is a preflight too.
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

  test('no preflight entry quotes a font family with double quotes', () => {
    /*
     * The one real preflight hazard, and it is quoting rather than structure.
     * A double-quoted family name makes the engine substitute its own default
     * stack AND swallow what follows: on ts-css,
     * `font-family:...,"Segoe UI",sans-serif` came back as
     * `font-family: ui-sans-serif, system-ui, sans-serif` with everything up to
     * the next `transform` gone, which ate a whole h1-h3 rule and the opening
     * half of a @keyframes block. Single quotes are clean and mean the same
     * thing in CSS.
     *
     * This stylesheet quotes no families today, so the check is here to keep it
     * that way -- the failure is silent and looks like a font that never
     * applied.
     *
     * An earlier version of this file asserted one rule per entry instead.
     * That invariant came from measuring @cwcss/crosswind, which this app
     * imports types from and which does not render it; stx loads
     * @stacksjs/ts-css, and that engine keeps every rule in a multi-rule
     * getCSS().
     */
    for (const preflight of appPreflights) {
      const css = preflight.getCSS()
      const offenders = [...css.matchAll(/font-family\s*:[^;}]*"/g)].map(m => m[0])
      expect(offenders).toEqual([])
    }
  })

  test('every rule in the stylesheet survives the trip', () => {
    // The whole point: it is plain CSS in a config file now, reached through a
    // merge, and nothing else would notice if a rule stopped arriving.
    const rules: string[] = []
    let depth = 0
    let current = ''
    for (const ch of picker.getCSS()) {
      current += ch
      if (ch === '{') {
        depth++
      }
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          rules.push(current.trim())
          current = ''
        }
      }
    }
    const declared = rules.filter(rule => rule && !/^\/\*[\s\S]*\*\/$/.test(rule))
    expect(declared.length).toBeGreaterThan(30)
    for (const rule of declared)
      expect(`${rule.slice(0, 48)}: ${contains(rule)}`).toBe(`${rule.slice(0, 48)}: true`)
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
