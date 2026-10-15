/**
 * The design tokens and the app chrome, now that both are declared in the
 * typed config rather than a stylesheet (stx-standards rule 3, §11.2).
 *
 * public/tokens.css and public/app-chrome.css were linked into every route
 * from config/ui.ts, and each opened by saying why it could not be a
 * `preflights` entry. app-chrome.css put it most directly:
 *
 *   "`config/crosswind.ts` `preflights` is where ch.11.2/11.7 says this
 *    belongs. It does not work on the stx serve path: the entry is spread into
 *    the generator config and then never emitted, verified with a probe token
 *    that appears nowhere in the served CSS on any route."
 *
 * The probe was real and so was its result -- on the stx of the day. It is
 * also what config/crosswind.ts's own `preflights` note already recorded as
 * fixed by stacksjs/stx #1867, which unified the two render paths onto one
 * merge. The config had carried that correction for a while; only the two
 * stylesheets still said otherwise, and they were the reason 83 declarations
 * lived outside the config.
 *
 * So the first test here is the original probe, re-run against the installed
 * engine and kept, because a claim about the engine is worth exactly as much
 * as its last measurement.
 *
 * The second half is about the cascade. A linked stylesheet is unlayered; a
 * preflight lands in @layer tc-base, and an unlayered rule beats a layered one
 * at ANY specificity. Six declarations in the app chrome relied on outranking
 * a utility that sits on the same element, and they stopped applying when the
 * file moved -- measured on a probe page, not reasoned about:
 *
 *   .tgl[data-on='1']         rgb(74,222,128) -> rgba(148,163,184,0.12)
 *   .seg-slack[data-sel='1']  rgb(97,31,105)  -> rgb(16,19,28)
 *   .dz-overlay[hidden]       display: none   -> display: flex
 *
 * They carry !important now, per declaration rather than per rule.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import theme from '../../config/crosswind'
// The installed stx package does not export these subpaths by bare specifier.
import { loadCssEngine } from '../../node_modules/@stacksjs/stx/dist/dev-server/ts-css.js'
import { mergeCssConfig } from '../../node_modules/@stacksjs/stx/dist/ts-css-config.js'

const ROOT = join(import.meta.dir, '../..')
const PUBLIC = join(ROOT, 'public')

const ENTRIES = ((theme as { preflights?: { getCSS: () => string }[] }).preflights ?? [])
  .map(entry => entry.getCSS())
const TOKENS = ENTRIES.find(css => css.includes('--accent-soft:')) ?? ''
const CHROME = ENTRIES.find(css => css.includes('.dz-overlay')) ?? ''

async function generate(): Promise<string> {
  const engine = await loadCssEngine()
  if (!engine)
    throw new Error('The installed STX CSS engine is required')
  const merged = mergeCssConfig(engine.defaultConfig || engine.config, theme)
  return new engine.CSSGenerator(merged.config).toCSS(merged.includePreflight, false)
}

describe('the claim that kept them out of the config', () => {
  test('the original probe, re-run: a preflight IS emitted', async () => {
    const engine = await loadCssEngine()
    if (!engine)
      throw new Error('The installed STX CSS engine is required')
    const probe = {
      ...theme,
      preflights: [...ENTRIES.map(css => ({ getCSS: () => css })), { getCSS: () => ':root { --probe-token: #abcdef; }' }],
    }
    const merged = mergeCssConfig(engine.defaultConfig || engine.config, probe)
    expect(merged.includePreflight).toBe(true)
    expect(merged.config.preflights.length).toBeGreaterThan(ENTRIES.length)
    const css = new engine.CSSGenerator(merged.config).toCSS(merged.includePreflight, false)
    expect(css).toContain('--probe-token: #abcdef')
  })

  test('both entries are found, and by content rather than index', () => {
    // Addressing a preflight by index is how the date-range-picker test
    // started asserting about the palette when these two joined it.
    expect(TOKENS).not.toBe('')
    expect(CHROME).not.toBe('')
    expect(ENTRIES).toHaveLength(3)
  })
})

describe('one declaration site', () => {
  test('§11.2: tokens.css and app-chrome.css are gone, and nothing links them', () => {
    const stylesheets = readdirSync(PUBLIC).filter(name => name.endsWith('.css'))
    expect(stylesheets).not.toContain('tokens.css')
    expect(stylesheets).not.toContain('app-chrome.css')

    /*
     * A link entry, not the substring: config/ui.ts still NAMES both files, in
     * the comment saying where they went, and that note is the point of the
     * removal rather than a leftover.
     */
    const ui = readFileSync(join(ROOT, 'config/ui.ts'), 'utf8')
    const linked = [...ui.matchAll(/rel: 'stylesheet', href: '([^']+)'/g)].map(match => match[1])
    for (const href of ['/tokens.css', '/app-chrome.css'])
      expect({ href, stillLinked: linked.includes(href) }).toEqual({ href, stillLinked: false })

    // Every local stylesheet it does still link has to exist on disk.
    for (const href of linked.filter(h => h.startsWith('/')))
      expect({ href, onDisk: stylesheets.includes(href.slice(1)) }).toEqual({ href, onDisk: true })
  })

  test('public/marketing.css is the one stylesheet left, and it is not site-wide', () => {
    /*
     * Not part of this move and not the same problem. It is linked from
     * resources/layouts/marketing.stx rather than config/ui.ts, because app
     * pages define their own conflicting `.btn` and `.panel`, so it cannot
     * become an unscoped preflight the way these two could. Its 32 token
     * declarations are the remaining §11.2 debt in this app, recorded here so
     * the number is explicit rather than implied by the absence of a check.
     */
    const marketing = readFileSync(join(PUBLIC, 'marketing.css'), 'utf8')
    const declarations = [...marketing.matchAll(/^\s*(--[a-z][\w-]*)\s*:/gm)].length
    expect({ declarations }).toEqual({ declarations: 35 })
    expect(readFileSync(join(ROOT, 'resources/layouts/marketing.stx'), 'utf8')).toContain('href="/marketing.css"')
    expect(readFileSync(join(ROOT, 'config/ui.ts'), 'utf8')).not.toContain('href: \'/marketing.css\'')
  })

  test('all four theme blocks, and the chrome, reach the generated sheet', async () => {
    const css = await generate()
    for (const selector of [':root {', '@media (prefers-color-scheme: dark)', ':root[data-theme=\'dark\']', ':root[data-theme=\'light\']'])
      expect({ selector, emitted: css.includes(selector) }).toEqual({ selector, emitted: true })
    // One value per block, so an empty block would not pass.
    expect(css).toContain('--bg: #fbfbfd')
    expect(css).toContain('--bg: #090b11')
    // And the chrome that reads them.
    for (const rule of ['@keyframes loghq-pulse', '.skeleton-pulse', '--slack: #611f69', '.chrome-logout', '.dz-overlay'])
      expect({ rule, emitted: css.includes(rule) }).toEqual({ rule, emitted: true })
    // An explicit choice still has to beat the OS preference.
    expect(css.indexOf(':root[data-theme=\'dark\']')).toBeGreaterThan(css.indexOf('prefers-color-scheme'))
  })

  test('the font stacks are not rewritten on the way through', async () => {
    /*
     * This engine replaces a `font-family` written literally in a preflight
     * when the rule is in the spaced form and the stack begins
     * `ui-sans-serif`. Both declarations that moved read a custom property
     * instead, so neither is a candidate -- asserted because it is a property
     * of the engine rather than of this file.
     */
    const css = await generate()
    expect(css).toContain('--sans: \'Space Grotesk\', ui-sans-serif, system-ui, sans-serif')
    expect(css).toContain('--mono: \'JetBrains Mono\', ui-monospace, SFMono-Regular, Menlo, monospace')
    for (const entry of [TOKENS, CHROME]) {
      for (const match of entry.matchAll(/(?<!-)font-family\s*:\s*([^;}\n]+)/g))
        expect({ value: match[1].trim(), readsAToken: match[1].includes('var(--') }).toEqual({ value: match[1].trim(), readsAToken: true })
    }
  })
})

describe('the declarations that have to beat a utility', () => {
  /*
   * These six are the whole cost of the move. Each sits on an element that
   * also carries a utility setting the same property; while this was a linked
   * stylesheet they won on specificity, and layered they lose outright.
   *
   * Measured on a probe page built from the real class lists in settings.stx
   * and dashboard.stx, with the pre-move and post-move sheets swapped under
   * it. Without the marks the toggle stops turning green, the selected
   * Slack/Discord segment loses its brand fill and its ink, and the delete
   * -zone modal is permanently open over the settings page. With them, every
   * computed value matches the pre-move sheet exactly.
   */
  const MARKED: Array<[string, string[]]> = [
    ['.tgl[data-on=\'1\']', ['background: var(--ok) !important']],
    ['.seg[data-sel=\'1\']', ['color: var(--accent-ink) !important', 'border-color: transparent !important']],
    ['.seg-slack[data-sel=\'1\']', ['background: var(--slack) !important']],
    ['.seg-discord[data-sel=\'1\']', ['background: var(--discord) !important']],
    ['.dz-overlay[hidden]', ['display: none !important']],
    ['a.pill:hover, button.pill:hover', ['color: var(--text) !important']],
    ['select.app-panel', ['padding-right: 2rem !important']],
  ]

  test('each one keeps its mark, in the config and in the sheet', async () => {
    const css = await generate()
    for (const [selector, declarations] of MARKED) {
      expect({ selector, inChrome: CHROME.includes(selector) }).toEqual({ selector, inChrome: true })
      for (const declaration of declarations)
        expect({ selector, declaration, emitted: css.includes(declaration) }).toEqual({ selector, declaration, emitted: true })
    }
  })

  test('the utilities they have to beat are still on those elements', () => {
    /*
     * The marks are only correct while the collision exists. If a utility is
     * dropped from the markup the mark becomes noise, and if a new one is
     * added to one of these elements it needs a mark of its own -- which is
     * the failure this names rather than leaves to be rediscovered.
     */
    const settings = readFileSync(join(ROOT, 'resources/views/settings.stx'), 'utf8')
    const dashboard = readFileSync(join(ROOT, 'resources/views/dashboard.stx'), 'utf8')
    const collisions: Array<[string, string, string, string]> = [
      ['settings.stx', settings, 'tgl', 'bg-line'],
      ['settings.stx', settings, 'seg-slack', 'bg-panel'],
      ['settings.stx', settings, 'seg', 'border-line'],
      ['settings.stx', settings, 'dz-overlay', 'flex'],
      ['dashboard.stx', dashboard, 'pill', 'bg-accent'],
      ['dashboard.stx', dashboard, 'app-panel', 'px-3'],
    ]
    for (const [name, source, own, utility] of collisions) {
      const carries = [...source.matchAll(/class="([^"{}]*)"/g)]
        .map(match => match[1].split(/\s+/))
        .some(classes => classes.includes(own) && classes.includes(utility))
      expect({ file: name, class: own, alsoCarries: utility, found: carries })
        .toEqual({ file: name, class: own, alsoCarries: utility, found: true })
    }
  })

  test('nothing else in the chrome outranks a single-class utility unmarked', () => {
    /*
     * The marked declarations were found by walking every selector in the file
     * and keeping the ones above single-class specificity whose element also
     * carries another class. This re-derives that list so an eighth cannot be
     * added quietly: anything with two or more classes, or a class plus a tag,
     * has to either carry a mark or set only properties no utility on that
     * element sets.
     *
     * Per DECLARATION, not per rule. A rule-level check would let an unmarked
     * property hide behind a marked sibling, which select.app-panel has: its
     * padding-right is marked and its six background and appearance
     * properties are not, correctly.
     */
    const rules = [...CHROME.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?<=^|\})\s*([^{}@][^{}]*?)\s*\{([^{}]*)\}/g)]
    /*
     * Lookbehind, not a consuming `(?:^|\})`. With the brace inside the match
     * the previous rule ate it, the next could not match its own opener, and
     * the walk read every OTHER rule -- which is how select.app-panel's
     * padding-right nearly shipped unmarked.
     */
    expect(rules.length).toBeGreaterThan(60)

    const unmarked: string[] = []
    for (const [, selectorList, body] of rules) {
      const loose = body.split(';')
        .map(d => d.trim())
        .filter(d => /^[a-z-]+\s*:/.test(d) && !d.startsWith('--') && !d.includes('!important'))
        .map(d => d.slice(0, d.indexOf(':')))
      if (loose.length === 0)
        continue
      for (const selector of selectorList.split(',').map(s => s.trim()).filter(Boolean)) {
        const bare = selector.replace(/::?[a-z-]+(\([^)]*\))?/g, '')
        const weight = (bare.match(/\.[\w-]+/g)?.length ?? 0) + (bare.match(/\[[^\]]+\]/g)?.length ?? 0)
        if (weight < 2 && !/^[a-z]+\./.test(bare))
          continue
        // A ::after or ::before cannot be reached by a utility on the element.
        if (/::(after|before)/.test(selector))
          continue
        unmarked.push(`${selector} { ${loose.join(', ')} }`)
      }
    }

    // Each survivor checked against the markup: no utility on that element
    // sets the property named.
    expect(unmarked.sort()).toEqual([
      // .stat-dot carries h-1.5/w-1.5/rounded-full/shrink-0/inline-block.
      '[data-tone=\'error\'] .stat-dot { background, opacity }',
      // .stat-value carries font-mono/font-semibold/text-3xl/tnum: no colour.
      '[data-tone=\'error\'] .stat-value { color }',
      '[data-tone=\'warning\'] .stat-dot { background, opacity }',
      '[data-tone=\'warning\'] .stat-value { color }',
      // `border` on a .pill-on sets width and style, never a colour.
      'a.pill-on:hover { color, background, border-color }',
      // No transform utility on a pill.
      'a.pill:active { transform }',
      'button.pill:active { transform }',
      // .log-row carries px-5/py-2.5 only.
      'details[open] > .log-row { background }',
      // What is left on the select once padding-right took its mark.
      'select.app-panel { -webkit-appearance, -moz-appearance, appearance, background-repeat, background-position, background-size, background-image }',
    ])
  })
})
