/**
 * The token layer: what this app's UI means, as values rather than as classes.
 *
 * stx ships 77 role tokens and `@stacksjs/components` is written against them --
 * `text-fg` 95 times, `text-fg-strong` 51, `bg-field` 34, `bg-accent-solid` 22.
 * This app, like the other five, already maps those role names onto its own
 * custom properties in `theme.extend.colors`, so a shared component does pick up
 * this app's colours. That mapping is the token layer; it just was not written
 * down anywhere a non-Crosswind renderer could read it.
 *
 * This emits it. For each role a component actually uses, resolve the utility
 * through the real engine (authoritative for role -> var) and then resolve the
 * var chain through this config's own declarations (authoritative for var ->
 * value). The result is a plain role -> literal manifest, which is the form a
 * native shell needs: `fg-strong` means #0b0f19 here, whatever Crosswind spells
 * it as.
 *
 * It also reports LOST DISTINCTIONS: pairs the design system treats as different
 * that this app resolves to the same literal. Those are not failures. An app with
 * one muted grey genuinely cannot express `fg-muted` and `fg-soft` separately,
 * and the honest first step is to see it, not to invent a colour. So this script
 * reports and exits 0.
 *
 * SURFACES. This app does not have one theme, it has two. The base/marketing
 * surface is emerald (`--accent: #047857` light, `#34d399` dark) and the
 * dashboard overrides it to indigo under `:root[data-theme] .page-dashboard`
 * (`#4f46e5` / `#818cf8`). A manifest that ignores that silently mixes them --
 * the first version of this script emitted the marketing accent for light and
 * the dashboard accent for dark, which is a value no page ever renders. So the
 * manifest is per surface, and the mobile app that mirrors the dashboard wants
 * the `dashboard` one.
 *
 * KNOWN LIMIT: a value built by string interpolation rather than written
 * literally cannot be resolved here; it is emitted as-is and flagged.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import theme from '../config/crosswind'

const ROOT = resolve(import.meta.dir, '..')

/*
 * The roles `@stacksjs/components` actually reads, by measured usage in its
 * source: text-fg 95 times, text-fg-strong 51, text-fg-soft 48, text-fg-muted
 * 43, bg-panel 34, bg-field 34, border-line 33, text-danger 27, bg-accent-solid
 * 22, and so on.
 */
const ROLES = [
  'fg', 'fg-strong', 'fg-muted', 'fg-soft', 'fg-subtle',
  'page', 'panel', 'field', 'surface', 'surface-sunken',
  'line', 'line-strong',
  'accent', 'accent-solid', 'accent-ink',
  'danger', 'success', 'warning', 'info',
]

/** Pairs a component can render side by side and expects to tell apart. */
const MUST_DIFFER: [string, string][] = [
  ['fg', 'fg-strong'],
  ['fg-muted', 'fg-soft'],
  ['panel', 'field'],
  ['page', 'panel'],
  ['danger', 'warning'],
  ['success', 'warning'],
  ['accent', 'fg'],
  ['line', 'line-strong'],
]

const source = readFileSync(resolve(ROOT, 'config/crosswind.ts'), 'utf8')

/**
 * The custom properties in force for one surface and one colour mode.
 *
 * Source order with later winning, which is what the cascade does for equal
 * specificity, rather than "first wins" -- the earlier version mixed the two and
 * produced a light value from one surface and a dark value from another.
 */
const SURFACES: Record<string, RegExp | null> = {
  base: null,
  dashboard: /\.page-dashboard/,
}

/**
 * Walk the CSS with real brace matching, keeping the full selector stack.
 *
 * A regex over `selector { body }` cannot do this: an `@media` block contains
 * rules, so the match ends at the FIRST inner `}` and every nested selector is
 * swallowed into what looks like the media query's own body. This app has two
 * `@media (prefers-color-scheme: dark)` blocks, one of them holding the
 * `.page-dashboard` overrides -- so the naive version attributed the dashboard's
 * indigo to the base surface and reported an accent no base page renders.
 */
function* declarationsInContext(css: string): Generator<[string, string, string]> {
  const stack: string[] = []
  let i = 0
  let pending = ''
  while (i < css.length) {
    const ch = css[i]
    if (ch === '{') {
      stack.push(pending.trim().replace(/\s+/g, ' '))
      pending = ''
      i++
    }
    else if (ch === '}') {
      stack.pop()
      pending = ''
      i++
    }
    else if (ch === ';') {
      const decl = /(--[a-z0-9][a-z0-9-]*)\s*:\s*(.+)/s.exec(pending.trim())
      if (decl)
        yield [stack.join(' | '), decl[1], decl[2].trim()]
      pending = ''
      i++
    }
    else {
      pending += ch
      i++
    }
  }
}

function declarations(surface: string, dark: boolean): Map<string, string> {
  const qualifier = SURFACES[surface]
  const out = new Map<string, string>()
  for (const [context, name, value] of declarationsInContext(source)) {
    const scoped = /\.page-dashboard|stx-layout-group/.test(context)
    if (qualifier ? (scoped && !qualifier.test(context)) : scoped)
      continue
    const isDark = /data-theme\s*=\s*["']dark["']|prefers-color-scheme:\s*dark/.test(context)
    const isLight = /data-theme\s*=\s*["']light["']/.test(context)
    if (dark ? isLight : isDark)
      continue
    out.set(name, value)
  }
  return out
}

function resolveValue(value: string, vars: Map<string, string>, depth = 0): string {
  if (depth > 8)
    return value
  return value.replace(/var\((--[a-z0-9-]+)(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (whole, name, fallback) => {
    const found = vars.get(name)
    if (found) return resolveValue(found, vars, depth + 1)
    if (fallback) return resolveValue(fallback.trim(), vars, depth + 1)
    return whole
  })
}

/*
 * What each role is declared as, straight from `theme.extend.colors`.
 *
 * This is the same answer the CSS engine gives -- checked by generating the
 * utilities and comparing, e.g. `text-fg` emits `color: var(--text)` and
 * `colors.fg` is `var(--text)` -- but reading the theme needs no engine, no
 * `dist/` import, and no merge step.
 */
const colors = ((theme as { theme?: { extend?: { colors?: Record<string, string> } } })
  .theme?.extend?.colors) ?? {}

const manifest: Record<string, Record<string, Record<string, string>>> = {}
const unresolved: string[] = []
const missing: string[] = []

for (const surface of Object.keys(SURFACES)) {
  manifest[surface] = { light: {}, dark: {} }
  for (const mode of ['light', 'dark'] as const) {
    const vars = declarations(surface, mode === 'dark')
    for (const role of ROLES) {
      const expression = colors[role]
      if (!expression) {
        if (surface === 'base' && mode === 'light') missing.push(role)
        continue
      }
      const value = resolveValue(expression, vars)
      manifest[surface][mode][role] = value
      if (value.includes('var(') || value.includes('${'))
        unresolved.push(`${surface}/${mode} ${role}: ${value}`)
    }
  }
}

const lost = MUST_DIFFER
  .filter(([a, b]) => manifest.dashboard.light[a] && manifest.dashboard.light[a] === manifest.dashboard.light[b])
  .map(([a, b]) => `${a} = ${b}`)

const out = resolve(ROOT, 'config/tokens.json')
writeFileSync(out, `${JSON.stringify({ roles: manifest, lost }, null, 2)}\n`)

console.log(`Resolved ${Object.keys(manifest.base.light).length} of ${ROLES.length} roles, per surface (${Object.keys(SURFACES).join(', ')}), light and dark.`)
if (missing.length)
  console.log(`  no utility generated for: ${missing.join(', ')}`)
if (unresolved.length) {
  console.log(`  not reducible to a literal (${unresolved.length}):`)
  for (const entry of unresolved) console.log(`    ${entry}`)
}
console.log(lost.length
  ? `  lost distinctions (${lost.length}): ${lost.join(', ')}`
  : '  no lost distinctions')
console.log(`Wrote ${out.replace(`${ROOT}/`, '')}`)
