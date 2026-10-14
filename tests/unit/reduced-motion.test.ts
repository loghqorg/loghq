/**
 * The reduced-motion guard on the account skeleton, and the spelling that
 * silently cannot provide one.
 *
 * account.stx used to carry `motion-reduce:[animation:none]` beside an
 * `[animation:loghq-pulse_…]` utility. The animation worked; the guard never
 * did. Crosswind's class EXTRACTOR does not recognise a variant applied to an
 * arbitrary property, so that class never reached the generator and produced
 * no rule at all -- no error, no warning, nothing in the sheet. Measured on
 * the served page: every other class on that element reached the stylesheet
 * and this one did not, while `active:` and `md:` rules from the same page
 * were present, so plain variants are fine.
 *
 * Filed as stacksjs/ts-css#37. The generator half was fixed in 0.3.14
 * (ts-css#36); the extractor half is open, so the spelling is still a trap.
 *
 * Both halves now live in public/tokens.css instead, in source order, which
 * is what makes the guard independent of the extractor, of crosswind's output
 * ordering and of any !important. That file is also linked BEFORE the
 * generated sheet, which is why the animation itself moved there rather than
 * staying a utility for the guard to fight.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const tokens = readFileSync(join(ROOT, 'public/tokens.css'), 'utf8')

function stxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory())
      out.push(...stxFiles(full))
    else if (entry.endsWith('.stx'))
      out.push(full)
  }
  return out
}

describe('reduced motion', () => {
  test('the skeleton declares its animation and its guard, in that order', () => {
    const base = tokens.search(/\.skeleton-pulse\s*\{/)
    const guard = tokens.search(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.skeleton-pulse\s*\{/)
    expect(`base declared: ${base >= 0}`).toBe('base declared: true')
    expect(`guard declared: ${guard >= 0}`).toBe('guard declared: true')
    // Same file, same specificity, so the later one is what decides.
    expect(`guard after base: ${guard > base}`).toBe('guard after base: true')
    expect(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.skeleton-pulse\s*\{\s*animation:\s*none/.test(tokens)).toBe(true)
  })

  test('the element that pulses is the one the guard names', () => {
    const account = readFileSync(join(ROOT, 'resources/views/account.stx'), 'utf8')
    expect(account).toContain('skeleton-pulse')
    // The animation must not also be applied as a utility: that lands in the
    // generated sheet, which is linked after tokens.css, and would outrank the
    // guard on source order while tying on specificity.
    expect(account).not.toMatch(/\[animation:loghq-pulse/)
  })

  test('no view uses a variant on an arbitrary property', () => {
    /*
     * `motion-reduce:[animation:none]`, `hover:[border-color:red]` and friends.
     * They parse, they look right, and they emit nothing. Worth failing a test
     * over precisely because nothing else reports it -- and the cases people
     * reach for this spelling are the accessibility and edge-state ones, which
     * are the least likely to be noticed by eye.
     *
     * Drop this when ts-css#37 closes and the extractor can see them.
     */
    for (const file of stxFiles(join(ROOT, 'resources'))) {
      const source = readFileSync(file, 'utf8').replace(/\{\{--[\s\S]*?--\}\}/g, '')
      const hit = /[a-z-]+:\[[a-z-]+:[^\]]*\]/.exec(source)
      expect(`${file.slice(ROOT.length + 1)}: ${hit ? hit[0] : 'none'}`).toBe(`${file.slice(ROOT.length + 1)}: none`)
    }
  })
})
