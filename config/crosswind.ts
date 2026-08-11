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
        // Ink for text sitting ON a saturated fill. `text-white` was hardcoded
        // at 19 sites, which is only correct in light mode — dark makes the
        // fills lighter (--accent #fb7185, the dashboard's indigo #818cf8),
        // where white measures 2.69:1 and 2.98:1 against a 4.5:1 requirement.
        // This token is #fff in light and near-black in dark, so one class is
        // right in both. See public/tokens.css.
        'accent-ink': 'var(--accent-ink)',
      },
      // The site's own two breakpoints, as min-widths. public/marketing.css
      // states them as `max-width: 560px` and `max-width: 900px`; Crosswind
      // generates NOTHING for a `max-[900px]:` variant or a bare
      // `[@media(max-width:900px)]:` — verified against the served sheet, no
      // rule and no media query — so a max-width rule has to be inverted to
      // mobile-first and the boundary moves by one pixel.
      screens: {
        'bp-sm': '561px',
        'bp-md': '901px',
      },
      fontFamily: {
        sans: ['Space Grotesk', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  /**
   * Repeated compositions, per ch.11.1. Each of these was a rule duplicated
   * byte-for-byte in five or more per-page <style> blocks; the shortcut is the
   * one definition those blocks collapse into.
   *
   * The markup does not change when a rule becomes a shortcut. Crosswind
   * expands a shortcut when the shortcut NAME appears in a class attribute
   * (dev-server/crosswind.js), so `class="field"` keeps working and only the
   * <style> block goes away. That is what makes this conversion low-risk.
   *
   * Underscores are the escape for spaces inside an arbitrary value, and
   * commas survive — `bg-[color-mix(in_srgb,var(--accent)_88%,#000)]` emits
   * `background-color: color-mix(in srgb,var(--accent) 88%,#000)`. Verified
   * against the served sheet, along with the hover/focus/active/disabled
   * variants used below.
   *
   * NOT AVAILABLE: `before:` and `after:`. Both are silently dropped — the
   * generator emits no rule at all, so a `before:h-px` reads as styling and
   * does nothing. `.divider`'s two pseudo-element rules became real <span>
   * elements in the markup instead. Check the sheet before assuming a variant
   * exists; the failure mode is silence, not an error.
   */
  shortcuts: {
    'wordmark': 'font-bold tracking-[-0.03em]',

    'field': 'bg-canvas border border-line rounded-[10px] text-ink '
      + 'focus:outline-none focus:border-accent '
      + 'focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_16%,transparent)]',

    'btn-solid': 'bg-accent text-accent-ink rounded-[10px] '
      + '[transition:transform_0.12s_ease,opacity_0.15s_ease] '
      + 'hover:bg-[color-mix(in_srgb,var(--accent)_88%,#000)] '
      + 'active:translate-y-px disabled:opacity-60 disabled:cursor-default',

    'oauth-btn': 'bg-panel border border-line rounded-[10px] text-ink '
      + '[transition:border-color_0.15s_ease,transform_0.12s_ease] '
      + 'hover:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] '
      + 'active:translate-y-px',

    // Status notes. The literal hexes are deliberate: these are fixed
    // semantic colours that do not follow the accent, and #ef4444/#16a34a are
    // what the five blocks all carried.
    //
    // Named -box, and the filled button named -solid, because the bare names
    // are already taken and mean something DIFFERENT elsewhere in the app:
    // pricing.stx and account.stx use `.btn` as a neutral base that carries
    // only radius, transition and weight, with `.btn-primary` / `.btn-ghost`
    // supplying the fill, and pricing's `.err` sets a colour and no
    // background. A shortcut named `btn` therefore painted every ghost button
    // on those two pages accent-coloured — a shortcut is global the moment it
    // is defined, and it collides with any same-named rule still living in a
    // page <style> block. Unify the vocabulary when those blocks are
    // converted; until then, distinct names.
    'err-box': 'bg-[color-mix(in_srgb,#ef4444_12%,transparent)] text-[#ef4444]',
    'ok-box': 'bg-[color-mix(in_srgb,#22c55e_12%,transparent)] text-[#16a34a]',

    // SiteFooter's repeated link and column heading. Four columns and ~28
    // links, so these earn a name rather than being repeated on each element.
    'footer-head': 'm-0 mb-[0.35rem] font-mono text-[0.7rem] font-semibold '
      + 'tracking-[0.12em] uppercase text-subtle',
    'footer-link': 'text-muted text-[0.9rem] leading-[1.4] '
      + '[transition:color_0.16s_ease] hover:text-ink',

    // Shared app-surface vocabulary. `panel`, `icon-btn` and `wordmark-link`
    // were byte-identical in dashboard.stx and settings.stx; defining them
    // once is the whole point of ch.11.1. Checked that no OTHER remaining
    // <style> block defines these names differently before adding them —
    // the mistake 469068c had to undo.
    // NOT named `panel`: public/marketing.css already defines .panel with a
    // 14px radius and its own surface, and the Crosswind sheet is emitted
    // after it, so a `panel` shortcut silently reshaped every marketing panel
    // to 12px. Checking the remaining <style> blocks for a name is not
    // enough — the stylesheets in public/ own names too.
    'app-panel': 'bg-panel border border-line rounded-xl',
    'wordmark-link': 'text-inherit no-underline [transition:opacity_0.15s_ease] hover:opacity-75',
    'icon-btn': 'inline-flex items-center justify-center h-[34px] w-[34px] border border-line '
      + 'rounded-[9px] text-muted bg-panel cursor-pointer '
      + '[transition:color_0.15s_ease,border-color_0.15s_ease] hover:text-ink '
      + 'hover:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))]',

    'invite-hint': 'px-3 py-[9px] text-[13px] rounded-[9px] text-accent '
      + 'bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] '
      + 'border border-[color-mix(in_srgb,var(--accent)_35%,var(--border))]',
  },
// Partial<CrosswindConfig> alone is not enough: it makes the top-level keys
// optional but `theme` still demands every field of Theme (colors, spacing,
// fontSize, screens, borderRadius, boxShadow), when the only path that survives
// the serve merge is `theme.extend`. Narrowing to Pick<Theme, 'extend'> keeps
// the excess-property check that makes this assertion worth having — a key that
// is not part of CrosswindConfig, like the `preflight` that used to sit here,
// now fails the build.
} satisfies Partial<Omit<CrosswindConfig, 'theme'>> & { theme?: Pick<Theme, 'extend'> }
