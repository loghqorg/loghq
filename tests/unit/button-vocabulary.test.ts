/**
 * settings.stx's button vocabulary: three paints, four sizes, one definition each.
 *
 * The page had 23 raw `<button>` elements carrying 14 distinct class strings,
 * and those 14 were the same three paints at four sizes with nothing left over.
 * They are `btn-quiet` / `btn-danger` / `btn-solid` plus `btn-xs` / `btn-sm` /
 * `btn-md` / `btn-cta` in config/crosswind.ts now, which is what lets
 * `<Button>` sit behind them without each call site re-stating its own paint.
 *
 * Two things this file pins, because neither fails loudly on its own.
 *
 * ## The paints must keep generating
 *
 * A shortcut that stops expanding emits nothing at all -- no error, no warning,
 * an unpainted button. So the declarations are read back out of the engine the
 * app actually renders with (stx's loadCssEngine + mergeCssConfig), not matched
 * against the config's source text. A rule present in the config proves nothing
 * about the sheet.
 *
 * ## The `!important` marks must stay
 *
 * `<Button variant="ghost">` brings its own `variantClasses.ghost` and
 * `sizeClasses.md`, which are single-class selectors exactly like a shortcut.
 * Specificity ties, and crosswind sorts its output by category rather than by
 * generation order, so an unmarked override lands PARTIALLY -- the padding
 * arrives and the colour does not, or the reverse. Half an override reads as
 * working, which is why it is asserted rather than left to review.
 *
 * The four controls that are NOT ordinary buttons keep their own shortcuts and
 * are listed here so the count below cannot quietly absorb them: the theme
 * toggle (`icon-btn theme-btn`), the alert-channel switch (`tgl`) and the two
 * webhook segment buttons (`seg seg-slack` / `seg seg-discord`). See the
 * comments at those call sites for why the shipped `<Switch>` was not adopted.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import theme from '../../config/crosswind'
// The installed STX package does not export these subpaths by bare specifier.
import { loadCssEngine } from '../../node_modules/@stacksjs/stx/dist/dev-server/ts-css.js'
import { mergeCssConfig } from '../../node_modules/@stacksjs/stx/dist/ts-css-config.js'

const ROOT = join(import.meta.dir, '../..')
const SETTINGS = readFileSync(join(ROOT, 'resources/views/settings.stx'), 'utf8')

/** The markup, with prose stripped: comments here discuss classes they do not use. */
const markup = SETTINGS
  .replace(/\{\{--[\s\S]*?--\}\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

/** The controls that are deliberately not part of the vocabulary. */
const NOT_BUTTONS = ['icon-btn', 'tgl', 'seg']

async function generate(classes: string): Promise<string> {
  const engine = await loadCssEngine()
  if (!engine)
    throw new Error('the installed STX CSS engine is required')
  const merged = mergeCssConfig(engine.defaultConfig || engine.config, theme)
  const generator = new engine.CSSGenerator(merged.config)
  for (const className of classes.split(/\s+/).filter(Boolean))
    generator.generate(className)
  return generator.toCSS(false, false)
}

/** Whitespace-insensitive: stx pins minify false, so spacing varies. */
const has = (css: string, needle: string): boolean =>
  css.replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''))

describe('settings button vocabulary', () => {
  test('every button in the page uses it, or is one of the four that do not', () => {
    const offenders: string[] = []
    for (const m of markup.matchAll(/<button\b([^>]*)>/g)) {
      const classes = /\bclass="([^"]*)"/.exec(m[1])?.[1] ?? ''
      if (NOT_BUTTONS.some(n => classes.split(/\s+/).includes(n)))
        continue
      // A paint and a size, and no re-stated padding or colour beside them.
      const paint = /\bbtn-(quiet|danger|solid|copy)\b/.test(classes)
      const inline = /\b(px-|py-|text-(xs|sm|base)\b|bg-panel|bg-accent\b|text-warn|text-muted)/.test(classes)
      if (!paint || inline)
        offenders.push(`line ${markup.slice(0, m.index).split('\n').length}: ${classes}`)
    }
    expect(offenders).toEqual([])
  })

  test('the three paints and the copy button generate their declarations', async () => {
    // `text-muted` resolves through the theme to --text-2, and `text-ink` to
    // --text: the token names in the markup are not the ones in the output, so
    // these are the generated values rather than the authored ones.
    const quiet = await generate('btn-quiet')
    expect(has(quiet, 'color:var(--text-2)!important')).toBe(true)
    expect(has(quiet, 'color:var(--text)!important')).toBe(true)
    expect(has(quiet, 'border-radius:9px!important')).toBe(true)
    expect(has(quiet, 'background-color:var(--panel)')).toBe(true)

    const danger = await generate('btn-danger')
    expect(has(danger, 'color:var(--warn)!important')).toBe(true)
    expect(has(danger, 'border-radius:9px!important')).toBe(true)

    const solid = await generate('btn-solid')
    expect(has(solid, 'background-color:var(--accent)')).toBe(true)
    expect(has(solid, 'color:var(--accent-ink)')).toBe(true)
    // The union of the transition lists. Without background-color the accent
    // fill this shortcut sets on :hover snaps instead of easing, which is what
    // settings.stx's own two solid buttons had declared and this had not.
    expect(has(solid, 'background-color0.15s')).toBe(true)

    const copy = await generate('btn-copy')
    expect(has(copy, 'border-radius:7px!important')).toBe(true)
    expect(has(copy, 'position:absolute')).toBe(true)
  })

  test('the four sizes are padding plus type size plus weight, all marked', async () => {
    const sizes: [string, string, string][] = [
      ['btn-xs', '0.625rem', '0.375rem'],
      ['btn-sm', '0.75rem', '0.5rem'],
      ['btn-md', '1rem', '0.625rem'],
      ['btn-cta', '1rem', '0.625rem'],
    ]
    for (const [name, px, py] of sizes) {
      const css = await generate(name)
      expect(`${name} px`).toBe(has(css, `padding-left:${px}!important`) ? `${name} px` : `${name} MISSING padding-left:${px}!important -> ${css}`)
      expect(`${name} py`).toBe(has(css, `padding-top:${py}!important`) ? `${name} py` : `${name} MISSING padding-top:${py}!important`)
      expect(`${name} weight`).toBe(/font-weight:\s*\d+\s*!important/.test(css) ? `${name} weight` : `${name} MISSING marked font-weight`)
    }
    // btn-md and btn-cta are the same box and differ ONLY in weight, which is
    // why the weight lives with the size rather than with the paint.
    const md = await generate('btn-md')
    const cta = await generate('btn-cta')
    expect(has(md, 'font-weight:500!important')).toBe(true)
    expect(has(cta, 'font-weight:600!important')).toBe(true)
  })
})
