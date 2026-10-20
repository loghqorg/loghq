/**
 * A control that is working has to SAY it is working.
 *
 * Every async button here gates itself on a busy signal through `:disabled`,
 * which stops a second click and greys the control. For a screen reader that is
 * not the same thing: `disabled` removes the button from the focus order, so
 * someone who just activated it loses their place and hears nothing about why.
 *
 * Two vehicles, and which one is right depends on the element:
 *
 * - A plain `<button>` takes `:aria-busy`. An ATTRIBUTE binding, deliberately,
 *   because a reactive mustache in a button's own text makes stx cloak the
 *   element until hydration. stx special-cases `aria-*` in dist/signals.js
 *   (`attrName.startsWith('aria-') && typeof v === 'boolean'` writes `String(v)`)
 *   so a boolean emits `aria-busy="true"` rather than the bare `aria-busy=""`
 *   the ordinary boolean path writes, and an empty value reads as FALSE.
 * - A `<Button>` takes `:loading`. The component writes `aria-busy` and shows a
 *   spinner from that prop and computes `isDisabled = disabled || loading`, so
 *   passing `:aria-busy` from here would fight its own binding.
 *
 * The pairing with the signal matters as much as the attribute. `aria-busy`
 * means "this element is being updated", so one signal cannot drive two buttons
 * that are on screen together: verifying a repository would otherwise announce
 * Disconnect as busy too. That is what `repoAction` is for.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const BUSY = /busy|loading|saving|sending|submitting|removing|deleting/i

function views(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    let directory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try { directory = statSync(path).isDirectory() }
      catch { continue }
    }
    if (directory) out.push(...views(path))
    else if (entry.name.endsWith('.stx')) out.push(path)
  }
  return out
}

/**
 * Comments, all three kinds, because prose about a shape matches a grep for it.
 * The block above `repoAction` says "repoBusy gates all three", and that
 * sentence is exactly what the mutation-count assertion would miscount.
 */
function code(source: string): string {
  return source
    .replace(/\{\{--[\s\S]*?--\}\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Open tags only, with quoted values kept whole so a `>` inside one cannot end the tag. */
const OPEN_TAG = /<(button|Button)\b((?:[^>"]|"[^"]*")*)>/g

function asyncButtons(source: string): { tag: string, attrs: string }[] {
  const found: { tag: string, attrs: string }[] = []
  for (const match of code(source).matchAll(OPEN_TAG)) {
    const attrs = match[2]
    const disabled = /:disabled="([^"]*)"/.exec(attrs)
    const gated = (disabled && BUSY.test(disabled[1])) || /:loading="/.test(attrs)
    if (gated)
      found.push({ tag: match[1], attrs })
  }
  return found
}

const files = views(join(ROOT, 'resources'))
const settings = () => readFileSync(join(ROOT, 'resources/views/settings.stx'), 'utf8')

describe('async buttons announce that they are working', () => {
  test('every button gated on a busy signal announces it', () => {
    const missing: string[] = []
    for (const file of files) {
      for (const button of asyncButtons(readFileSync(file, 'utf8'))) {
        const announced = button.tag === 'Button'
          ? /:loading="/.test(button.attrs)
          : /:aria-busy="/.test(button.attrs)
        if (!announced)
          missing.push(`${file.slice(ROOT.length + 1)}: <${button.tag}${button.attrs.trimEnd().slice(0, 80)}>`)
      }
    }
    expect(missing).toEqual([])
  })

  test('the count does not quietly fall to zero', () => {
    const total = files.reduce((n, f) => n + asyncButtons(readFileSync(f, 'utf8')).length, 0)
    // 16 at the time of writing. A regex that stops matching would pass the test
    // above by finding nothing at all, which is the failure mode of every gate in
    // this repo that greps for a shape.
    expect(total).toBeGreaterThanOrEqual(16)
  })

  test('the three repository buttons do not share one aria-busy source', () => {
    const found = asyncButtons(settings()).filter(b => /Repo"/.test(b.attrs) || /Repo'/.test(b.attrs) || /"(verify|disconnect|connect)Repo"/.test(b.attrs))
    expect(found).toHaveLength(3)
    const sources = found.map(b => /:aria-busy="([^"]*)"/.exec(b.attrs)?.[1])
    expect(new Set(sources).size).toBe(3)
    for (const source of sources)
      expect(source).toContain('repoAction()')
  })

  test('repoAction is cleared wherever repoBusy is', () => {
    // A discriminator left set after the work finishes announces a button as busy
    // forever, which is worse than not announcing it at all.
    const body = code(settings())
    expect((body.match(/repoBusy\.set\(/g) ?? []).length)
      .toBe((body.match(/repoAction\.set\(/g) ?? []).length)
  })

  test('the per-member buttons scope their busy state to one row', () => {
    // removingMember() holds an id, so each row already answers for itself and
    // needs no discriminator; the binding just has to use the same expression.
    const found = asyncButtons(settings()).filter(b => /removingMember\(\)/.test(b.attrs))
    expect(found).toHaveLength(2)
    for (const button of found) {
      const disabled = /:disabled="([^"]*)"/.exec(button.attrs)?.[1]
      const busy = /:aria-busy="([^"]*)"/.exec(button.attrs)?.[1]
      expect(busy).toBe(disabled)
    }
  })
})
