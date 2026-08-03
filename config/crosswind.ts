import type { CrosswindConfig, Theme } from '@cwcss/crosswind'

/**
 * Crosswind (utility CSS) config.
 *
 * The palette is registered here as semantic colour tokens backed by CSS custom
 * properties (`--bg`, `--panel`, `--border`, `--text*`, `--accent`). That gives
 * real utilities — `bg-panel`, `text-subtle`, `border-line`, `text-accent` —
 * instead of inline `style="color: var(--…)"`, while the variables still swap
 * under `[data-theme]` and `prefers-color-scheme`, so dark mode works without a
 * `dark:` on every class.
 *
 * WHAT ACTUALLY REACHES THE PAGE
 *
 * The stx serve path does not hand this file to Crosswind wholesale. It rebuilds
 * the generator config at @stacksjs/stx/dist/dev-server/crosswind.js — the
 * `crosswindConfig` literal — and only some of what is written here survives.
 * Verified against the installed build, not assumed:
 *
 *   theme.extend   merged explicitly, and it is the ONLY theme path that
 *                  survives; a top-level `theme.colors` is dropped.
 *   safelist       concatenated with the base safelist.
 *   shortcuts      read when expanding classes.
 *
 *   content        OVERRIDDEN to []. Class extraction runs over the RENDERED
 *                  HTML, not over globs, so a content list means nothing here.
 *   output         OVERRIDDEN to "". The CSS is injected as a <style> tag.
 *   minify         OVERRIDDEN to false.
 *   preflights     spread into the config and then NEVER EMITTED — toCSS()
 *                  writes the built-in reset only. Verified by putting a probe
 *                  token in a preflights entry and grepping the served page for
 *                  it: zero occurrences, on both a marketing and an app route.
 *                  This one matters: the obvious home for shared design tokens
 *                  does not work, so they have to reach the document another
 *                  way. See the token duplication noted in the styling work.
 *
 * Anything not on the surviving list is decoration. This file used to carry
 * `content`, `minify`, and `preflight: true` — and that last one is not even a
 * key of CrosswindConfig; the real name is `includePreflight`, so it was a
 * silent no-op that read as configuration. None of it was caught because the
 * file ended in a bare `}` with no `satisfies`, and `config/` sat outside
 * tsconfig's include.
 *
 * @see https://github.com/cwcss/crosswind
 */
export default {
  theme: {
    extend: {
      colors: {
        canvas: 'var(--bg)',
        panel: 'var(--panel)',
        line: 'var(--border)',
        ink: 'var(--text)',
        muted: 'var(--text-2)',
        subtle: 'var(--text-3)',
        accent: 'var(--accent)',
        // Status hues. These lived in settings.stx's <style> block until the
        // page needed `text-warn`; a utility backed by a token only one page
        // declares resolves to nothing everywhere else, silently, because an
        // undefined var() falls back to the property's initial value. Both are
        // in /tokens.css now, so the utilities are valid on every route.
        ok: 'var(--ok)',
        warn: 'var(--warn)',
        // The accent at low alpha — highlight fills, tinted cells. Registered
        // so the compare tables can mark their loghq column with a class
        // instead of a `:nth-child(3n+2)` rule in a per-page <style> block.
        'accent-soft': 'var(--accent-soft)',
      },
      fontFamily: {
        sans: ['Space Grotesk', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
// Partial<CrosswindConfig> alone is not enough: it makes the top-level keys
// optional but `theme` still demands every field of Theme (colors, spacing,
// fontSize, screens, borderRadius, boxShadow), when the only path that survives
// the serve merge is `theme.extend`. Narrowing to Pick<Theme, 'extend'> keeps
// the excess-property check that makes this assertion worth having — a key that
// is not part of CrosswindConfig, like the `preflight` that used to sit here,
// now fails the build.
} satisfies Partial<Omit<CrosswindConfig, 'theme'>> & { theme?: Pick<Theme, 'extend'> }
