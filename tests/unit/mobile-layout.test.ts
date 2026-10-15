import { describe, expect, test } from 'bun:test'
import theme from '../../config/crosswind'

/*
 * The marketing sheet, read out of the MARKETING preflight. It was
 * public/marketing.css until it moved into config/crosswind.ts, scoped to the
 * marketing layout group (stx-standards rule 3, §11.2).
 *
 * Everything below still reads the same, because the move nested the rules
 * under one prefix rather than rewriting them: `body:has(.nav-menu[open])` is
 * still spelled exactly that way in the source, and the prefix is prepended at
 * the top of the block.
 */
const marketing = ((theme as { preflights?: { getCSS: () => string }[] }).preflights ?? [])
  .map(entry => entry.getCSS())
  .find(css => css.includes('content="marketing"')) ?? ''

// The phone menu lists every marketing destination in one column, which is
// taller than an 812px viewport. The panel has to scroll inside the viewport
// and the page behind it has to stay put, or the last links are unreachable.
describe('mobile layout contracts', () => {
  test('stacked subscription fields do not keep the desktop flex basis as height', () => {
    const mobile = marketing.slice(marketing.indexOf('@media (max-width: 30rem)'))
    expect(mobile).toMatch(/\.sub-field\s*\{\s*flex:\s*none;\s*\}/)
  })

  test('marketing menu is bounded by the visible mobile viewport', () => {
    const panel = marketing.match(/\.nav-menu-panel\s*\{[^}]*\}/)?.[0] ?? ''
    expect(panel).toContain('max-height: calc(100dvh - 92px)')
    expect(panel).toContain('overflow-y: auto')
    expect(panel).toContain('overscroll-behavior: contain')
  })

  test('opening the marketing menu locks the page behind it', () => {
    expect(marketing).toContain('body:has(.nav-menu[open]) { overflow: hidden; }')
  })
})
