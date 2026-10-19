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
import { join, resolve } from 'node:path'
import theme from '../../config/crosswind'
// The installed STX package does not export these subpaths by bare specifier.
import { processComponents } from '../../node_modules/@stacksjs/stx/dist/component-renderer.js'
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

/**
 * The five call sites that took <Button>, and what each one gained.
 *
 * All five hand-rolled `:disabled="someBusy()"` and announced nothing: the
 * served markup carried no aria-busy, and three of them also swapped their own
 * label through `:text`, which is the spelling Button's `:label` prop exists to
 * replace (stacksjs/stx#1997 -- `:text` writes textContent and would erase the
 * spinner).
 *
 * Rendered through stx's own component renderer rather than asserted from the
 * source, because the failure mode is not a thrown error. A component that
 * cannot resolve ships its RAW TEMPLATE to the browser while every source-level
 * check stays green (see [[stx-build-vs-serve-divergence]]), so the only honest
 * assertion is on the HTML.
 */
describe('settings Button adoption', () => {
  const SITES = [
    { paint: 'btn-danger btn-sm', name: 'Rotate', bindings: ['loading'] },
    // The read key's pair (#14). Issue doubles as Replace once a key exists, so
    // its label is reactive — through `:label`, never `:text`, which writes
    // textContent and would erase the spinner this file exists to protect.
    { paint: 'btn-quiet btn-sm', name: 'Issue key', bindings: ['loading', 'label'] },
    { paint: 'btn-danger btn-sm', name: 'Revoke', bindings: ['loading'] },
    { paint: 'btn-cta btn-solid', name: 'Invite', bindings: ['loading'] },
    { paint: 'btn-cta btn-solid', name: 'Add channel', bindings: ['loading'] },
    { paint: 'flex-none whitespace-nowrap btn-cta btn-danger', name: '', bindings: ['loading'] },
    // The type-to-confirm gate is independent of busy state, so this one is the
    // documented three-prop combination: a reactive label, a reactive loading
    // flag, and a `disabled` that the gate owns.
    { paint: 'btn-cta btn-danger', name: 'Confirm', bindings: ['disabled', 'loading', 'label'] },
  ]

  const FILE = join(ROOT, 'resources/views/settings.stx')
  // `markup`, not the raw source: the comment above the members-list Remove
  // button explains why that button is NOT a <Button>, and writing the tag in
  // prose made this match start inside the comment and run to the first real
  // </Button>, swallowing half the file. Strip comments before matching markup.
  const calls = markup.match(/<Button\b[\s\S]*?<\/Button>/g) ?? []

  test('there are exactly as many as are registered, and none re-states a paint', () => {
    expect(calls).toHaveLength(SITES.length)
    for (const [i, call] of calls.entries()) {
      expect(/className="([^"]*)"/.exec(call)?.[1]).toBe(SITES[i].paint)
      // The paint comes from the vocabulary, so a call site has no utilities of
      // its own beyond the layout ones the modal row needs.
      expect(call).not.toMatch(/className="[^"]*\b(px-|py-|bg-panel|text-warn)/)
      // `:text` on the root would destroy the spinner and the label span.
      expect(call).not.toContain(':text=')
    }
  })

  test('each renders a real button that announces its busy state', async () => {
    for (const [i, call] of calls.entries()) {
      const dependencies = new Set<string>()
      const html = await processComponents(call, {
        __stx_client_signal_names: ['rotating', 'inviting', 'adding', 'archiving', 'modalBusy', 'modalReady', 'modalConfirmLabel', 'readKeyBusy', 'hasReadKey'],
        __importedComponents: new Map([['button', resolve(ROOT, 'node_modules/@stacksjs/components/src/ui/button/Button.stx')]]),
      }, FILE, { componentsDir: resolve(ROOT, 'resources/components') }, dependencies)

      const where = `${SITES[i].paint}:`
      expect(`${where} resolved`).toBe(html.includes('<Button') || html.includes('[Component Error') ? `${where} RAW TEMPLATE SHIPPED` : `${where} resolved`)
      expect(`${where} aria-busy`).toBe(/aria-busy="(?:true|false)"/.test(html) ? `${where} aria-busy` : `${where} MISSING aria-busy`)
      expect(`${where} spinner`).toBe(html.includes('animate-spin') ? `${where} spinner` : `${where} MISSING spinner`)
      // The paint must reach the concrete root, not sit in data-stx-props.
      const rootClass = /<button[^>]*class="([^"]*)"/.exec(html)?.[1] ?? ''
      for (const token of SITES[i].paint.split(' '))
        expect(`${where} ${token} on root`).toBe(rootClass.includes(token) ? `${where} ${token} on root` : `${where} ${token} NOT on root`)
      // And the live bindings must be recorded, or the prop is a server snapshot.
      const bindings = (/data-stx-parent-bindings="([^"]*)"/.exec(html)?.[1] ?? '').split(/\s+/).filter(Boolean)
      expect(bindings.sort()).toEqual([...SITES[i].bindings].sort())
      if (SITES[i].name)
        expect(html).toContain(SITES[i].name)
    }
  })

  test('<Button> is not used where it would silently drop an x-tooltip', () => {
    /*
     * Four more sites hand-roll busy state and are deliberately still plain
     * buttons: the two Remove buttons in the members list, the channel Test
     * button and the channel Remove button. Each carries `x-tooltip`, and an
     * `x-tooltip` on a COMPONENT never reaches the DOM.
     *
     * Measured on the installed 0.2.532 rather than read: `x-tooltip` IS in
     * COMPONENT_PASSTHROUGH_X_ATTRS now, so it is no longer rewritten into a
     * `:tooltip` signal binding (the old crash dashboard.stx documents). But
     * processComponents still emits it only inside `data-stx-props`, and the
     * tooltip runtime reads `el.getAttribute('x-tooltip')`, so the tooltip just
     * disappears. `title` and `aria-label` forward correctly; `x-tooltip` sits
     * in the gap.
     *
     * This test exists so the four are not "finished" by someone who does not
     * hit the silence. Filed upstream.
     */
    const tooltipped = [...markup.matchAll(/<Button\b[^>]*>/g)].filter(m => m[0].includes('x-tooltip'))
    expect(tooltipped.map(m => m[0])).toEqual([])
  })
})
