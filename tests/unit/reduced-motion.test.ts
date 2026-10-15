/**
 * The reduced-motion guard on the account skeleton.
 *
 * account.stx used to carry `motion-reduce:[animation:none]` beside an
 * `[animation:loghq-pulse_...]` utility. The animation worked; the guard never
 * did. Crosswind's class EXTRACTOR did not recognise a variant applied to an
 * arbitrary property, so that class never reached the generator and produced
 * no rule at all -- no error, no warning, nothing in the sheet. Measured on
 * the served page: every other class on that element reached the stylesheet
 * and this one did not, while `active:` and `md:` rules from the same page
 * were present, so plain variants were fine.
 *
 * **That extractor bug is FIXED** (stacksjs/ts-css#37, in 0.3.16, which this
 * app now runs; the generator half was #36 in 0.3.14). Probed against this
 * app's own installed copy with the exact original spelling:
 * `motion-reduce:[animation:none]` extracts and emits
 * `@media (prefers-reduced-motion: reduce) { .motion-reduce\:\[animation\:none\]
 * { animation: none } }`. So the spelling is no longer a trap, and the test
 * that failed any view for using it has been removed.
 *
 * Both halves still travel together, in source order, and that is still the
 * better home: as utilities the two rules tie on specificity and the guard
 * wins only because the generator happens to emit the media query second.
 * Declaring them next to each other makes the order explicit.
 *
 * They moved with the rest of public/tokens.css into the TOKENS preflight in
 * config/crosswind.ts (stx-standards rule 3, §11.2), so this now reads them
 * out of the config rather than the deleted stylesheet. The order argument is
 * unchanged -- one block, same specificity, later wins -- but the second test
 * below matters MORE than it did. A preflight lands in @layer tc-base, so an
 * `[animation:loghq-pulse...]` utility on the same element would no longer
 * merely outrank the guard on source order; being unlayered it would beat it
 * outright, at any specificity.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import theme from '../../config/crosswind'

const ROOT = join(import.meta.dir, '../..')

/** The preflight entry that carries the palette and the skeleton. */
const tokens = ((theme as { preflights?: { getCSS: () => string }[] }).preflights ?? [])
  .map(entry => entry.getCSS())
  .find(css => css.includes('.skeleton-pulse')) ?? ''

describe('reduced motion', () => {
  test('the skeleton declares its animation and its guard, in that order', () => {
    expect(tokens).not.toBe('')
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
    // The animation must not also be applied as a utility. A utility is
    // unlayered and the guard is now in @layer tc-base, so it would not merely
    // outrank the guard on source order -- it would win at any specificity.
    expect(account).not.toMatch(/\[animation:loghq-pulse/)
  })
})
