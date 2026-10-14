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
 *   preflights     merged and EMITTED. This entry used to say the opposite,
 *                  and it was true when it was written: the old dev-server
 *                  merge read only `theme.extend`, `safelist` and `shortcuts`
 *                  and dropped `preflights`, `darkMode`, `cssVariables`,
 *                  `rules`, `blocklist` and `variants` outright. stacksjs/stx
 *                  #1867 unified the two render paths onto one merge, and the
 *                  installed 0.2.520 carries the fix — its own ts-css-config
 *                  documents the old behaviour in the past tense.
 *
 *                  Re-verified here rather than taken from a changelog:
 *                  mergeCssConfig() reports includePreflight true, carries the
 *                  entries into `config`, and every rule below comes back out
 *                  of toCSS(). The stale note mattered, because it is why this
 *                  app's tokens went to public/app-chrome.css instead.
 *
 *                  One constraint is real, and it is quoting rather than
 *                  structure: a double-quoted font family in a preflight makes
 *                  the engine substitute its own stack and swallow the rules
 *                  after it. Several rules in one getCSS() are fine.
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
/*
 * The date-range picker's stylesheet, lifted out of a <style> block in
 * resources/views/analytics.stx (stx-standards rule 3).
 *
 * This is a RELOCATION and not a conversion to utilities, which is a weaker
 * outcome than the rule wants, so here is why it is the honest one. Every
 * state in this widget is a compound selector the client script toggles --
 * .drp-day.is-range, .drp-preset.is-active, .drp-nav.is-hidden -- and a
 * utility cannot express "this class AND that class". The spelling that could,
 * an arbitrary-variant utility like [&.is-range]:bg-accent, emits nothing in
 * this engine: the extractor rejects any class whose variant is an arbitrary
 * selector (same defect as stacksjs/ts-css#37, fixed in ts-css 0.3.16 and not
 * in @cwcss/crosswind). Splitting base rules into shortcuts and leaving the
 * state rules here would be worse than either: the shortcuts are unlayered and
 * a preflight lands in @layer cw-base, so every unlayered base would outrank
 * its own layered active state and the selected range would stop painting.
 *
 * One entry, not one per rule. An earlier version split it, on the strength of
 * a measurement taken against @cwcss/crosswind -- which this file imports its
 * TYPES from and which does not render this app. stx loads @stacksjs/ts-css on
 * every path, and that engine keeps every rule in a multi-rule getCSS(): all 35
 * here, and the 80 bughq passes through its own pageCss(). The split was
 * guarding against a bug in an engine that is not in the loop.
 *
 * There IS a real preflight hazard, and it is about quoting rather than
 * structure: a DOUBLE-quoted font family corrupts the sheet. On ts-css,
 * `font-family:...,"Segoe UI",sans-serif` came back as the engine's own default
 * stack with everything up to the next `transform` swallowed, taking a whole
 * h1-h3 rule and half a @keyframes block with it. This stylesheet quotes no
 * families, so it is unaffected; commshq's tokens use single quotes for it.
 *
 * Moving it into the layer was checked for cascade damage rather than assumed.
 * The picker's markup carries component classes only -- no utility co-occurs
 * with .range-tool, .drp-* or .date-popover -- so nothing of equal specificity
 * now wins where it used to lose. The one place a utility does meet these
 * rules is the shared :focus-visible list: settings.stx puts
 * focus:outline-none on seven inputs, and that already beat input:focus-visible
 * on specificity (0,2,0 against 0,1,1) before this move. Those fields trade
 * the ring for a border colour deliberately, and they behave the same either
 * way.
 */
const DATE_RANGE_PICKER_CSS = `
.range-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-height: 2.25rem;
  padding: 0 0.72rem;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel);
  color: var(--text-2);
  font: 600 0.8125rem/1 var(--sans, ui-sans-serif);
  text-decoration: none;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease, transform 0.15s ease;
}
.range-tool:hover { color: var(--text); border-color: var(--accent); }
.range-tool:active { transform: scale(0.98); }
.range-tool:focus-visible,
.range-link:focus-visible,
.chrome-btn:focus-visible,
.icon-btn:focus-visible,
select.panel:focus-visible,
input:focus-visible,
textarea:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.range-tool.is-active { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
.range-tool i { width: 1rem; height: 1rem; }
.date-menu { position: relative; }
.date-menu > summary { list-style: none; }
.date-menu > summary::-webkit-details-marker { display: none; }
.date-popover {
  position: absolute;
  right: 0;
  top: calc(100% + 0.5rem);
  z-index: 40;
  width: min(44rem, calc(100vw - 2.5rem));
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 18px 50px color-mix(in srgb, var(--text) 10%, transparent);
}
/* Period picker: presets down the left, two months on the right. The range is
   drawn flat with rounded ends, the way Fathom's is, on the --bar wash the KPI
   bars already use so it reads as the same accent at the same strength. */
.drp-backdrop { position: fixed; inset: 0; z-index: 39; background: transparent; cursor: default; }
.drp { display: grid; grid-template-columns: 10.5rem minmax(0, 1fr); gap: 0.75rem; }
.drp-presets { display: flex; flex-direction: column; gap: 0.15rem; padding-right: 0.75rem; border-right: 1px solid var(--border); }
.drp-preset {
  display: block;
  width: 100%;
  padding: 0.5rem 0.7rem;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  font: 500 0.8125rem/1.2 var(--sans, ui-sans-serif);
  text-align: left;
  cursor: pointer;
}
.drp-preset:hover { color: var(--text); background: color-mix(in srgb, var(--text) 6%, transparent); }
.drp-preset.is-active { color: var(--accent-ink); background: var(--accent); }
.drp-cals { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.drp-head { display: grid; grid-template-columns: 2rem minmax(0, 1fr) minmax(0, 1fr) 2rem; align-items: center; gap: 0.35rem; margin-bottom: 0.5rem; }
.drp-nav {
  display: inline-grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
.drp-nav:hover { color: var(--text); border-color: var(--border); }
.drp-nav svg { width: 1rem; height: 1rem; }
.drp-nav.is-hidden { visibility: hidden; }
.drp-sel {
  min-width: 0;
  height: 2rem;
  padding: 0 0.5rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font: 600 0.8125rem/1 var(--sans, ui-sans-serif);
}
.drp-dow, .drp-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.drp-dow span { padding: 0.25rem 0; color: var(--text-3); font: 600 0.7rem/1.2 var(--sans, ui-sans-serif); text-align: center; }
.drp-day {
  height: 2.25rem;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text);
  font: 500 0.8125rem/1 var(--mono, ui-monospace);
  cursor: pointer;
}
.drp-day:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
.drp-day.is-out { color: var(--text-3); }
.drp-day.is-today { font-weight: 700; text-decoration: underline; text-underline-offset: 3px; }
.drp-day.is-range { background: var(--accent-soft); }
.drp-day.is-edge { background: var(--accent); color: var(--accent-ink); border-radius: 8px; }
.drp-day.is-disabled { color: var(--text-3); opacity: 0.45; cursor: default; }
.drp-day.is-disabled:hover { background: transparent; }
.drp-day:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 8px; }
@media (max-width: 1023px) {
  .date-menu { position: static; }
  .date-popover { left: 0; right: auto; width: calc(100vw - 2rem); max-height: calc(100dvh - 6rem); overflow-y: auto; overscroll-behavior: contain; }
  .drp { grid-template-columns: minmax(0, 1fr); }
  .drp-presets { flex-direction: row; flex-wrap: wrap; gap: 0.35rem; padding: 0 0 0.6rem; border-right: 0; border-bottom: 1px solid var(--border); }
  .drp-preset { width: auto; padding: 0.45rem 0.65rem; border: 1px solid var(--border); border-radius: 999px; }
  .drp-cals { grid-template-columns: minmax(0, 1fr); }
  .drp-cal.is-right { display: none; }
  .drp-cal.is-left .drp-nav.is-hidden { visibility: visible; }
  .drp-day { height: 2.5rem; }
}
`

export default {
  preflights: [{ getCSS: () => DATE_RANGE_PICKER_CSS }],
  theme: {
    extend: {
      borderRadius: {
        control: '10px',
        pill: '999px',
        /*
         * `rounded-panel` is @stacksjs/components' radius role name:
         * <EmptyState variant="panel"> renders `bg-panel rounded-panel
         * ring-1 ring-line`. Without this it resolves to nothing and the
         * panel renders square. Pointed at this app's own panel radius:
         * the `app-panel` shortcut uses rounded-xl.
         */
        panel: '0.75rem',
      },
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

        // Complete component roles follow the app palette, not stock library
        // colors. Theme entries also avoid layered preflight precedence issues.
        // --ok alone is too bright for white small labels in light mode.
        'surface': 'var(--panel)',
        'surface-sunken': 'var(--bg)',
        'surface-raised': 'color-mix(in srgb, var(--accent) 8%, var(--panel))',
        'surface-hover': 'color-mix(in srgb, var(--text) 6%, var(--panel))',
        'surface-raised-hover': 'color-mix(in srgb, var(--accent) 14%, var(--panel))',
        'surface-sunken-hover': 'color-mix(in srgb, var(--text) 6%, var(--bg))',
        'page': 'var(--bg)',
        'content': 'var(--panel)',
        'field': 'var(--panel)',
        'field-hover': 'color-mix(in srgb, var(--text) 6%, var(--panel))',
        'fg': 'var(--text)',
        'fg-strong': 'var(--text)',
        'fg-muted': 'var(--text-2)',
        /*
         * The library's quiet text scale is four steps - fg, fg-muted, fg-soft,
         * fg-subtle - and this palette has three, so two roles share a value.
         * They used to share at the WRONG end: fg-soft was byte-identical to
         * fg-muted, which makes "quieter than muted" exactly as loud as muted.
         *
         * Nothing renders it today, which is why it was invisible: of the 53
         * <EmptyState> sites in the estate none passes an `icon` (the only
         * thing there that reads fg-soft) and there is no <Badge dot>. But
         * <Breadcrumb> paints separators with fg-soft and links with fg-muted,
         * so the two being equal is a divider as loud as the labels it divides.
         *
         * Doubling up at the quiet end keeps the scale monotonic, so a
         * component asking for a quieter grey gets one.
         */
        'fg-soft': 'var(--text-3)',
        'fg-subtle': 'var(--text-3)',
        'line-strong': 'color-mix(in srgb, var(--text-3) 55%, var(--border))',
        'line-hover': 'color-mix(in srgb, var(--text-2) 70%, var(--border))',
        'link': 'var(--accent)',
        'link-hover': 'color-mix(in srgb, var(--accent) 85%, var(--text))',
        'accent-solid': 'var(--accent)',
        'accent-solid-hover': 'color-mix(in srgb, var(--accent) 92%, var(--text))',
        'accent-soft-ink': 'color-mix(in srgb, var(--accent) 85%, var(--text))',
        'success': 'color-mix(in srgb, var(--ok) 75%, var(--text))',
        'success-solid': 'color-mix(in srgb, var(--ok) 75%, var(--text))',
        'success-solid-hover': 'color-mix(in srgb, color-mix(in srgb, var(--ok) 75%, var(--text)) 92%, var(--text))',
        'success-ink': 'var(--accent-ink)',
        'success-soft': 'color-mix(in srgb, color-mix(in srgb, var(--ok) 75%, var(--text)) 8%, var(--panel))',
        'success-soft-ink': 'color-mix(in srgb, color-mix(in srgb, var(--ok) 75%, var(--text)) 85%, var(--text))',
        'danger': 'var(--warn)',
        'danger-solid': 'var(--warn)',
        'danger-solid-hover': 'color-mix(in srgb, var(--warn) 92%, var(--text))',
        'danger-ink': 'var(--accent-ink)',
        'danger-soft': 'color-mix(in srgb, var(--warn) 8%, var(--panel))',
        'danger-soft-ink': 'color-mix(in srgb, var(--warn) 85%, var(--text))',
        'warning': 'var(--sev-warning)',
        'warning-solid': 'var(--sev-warning)',
        'warning-solid-hover': 'color-mix(in srgb, var(--sev-warning) 92%, var(--text))',
        'warning-ink': 'var(--accent-ink)',
        'warning-soft': 'color-mix(in srgb, var(--sev-warning) 8%, var(--panel))',
        'warning-soft-ink': 'color-mix(in srgb, var(--sev-warning) 85%, var(--text))',
        'info': 'var(--text-2)',
        'info-solid': 'var(--text-2)',
        'info-solid-hover': 'color-mix(in srgb, var(--text-2) 92%, var(--text))',
        'info-ink': 'var(--accent-ink)',
        'info-soft': 'color-mix(in srgb, var(--text-2) 8%, var(--panel))',
        'info-soft-ink': 'color-mix(in srgb, var(--text-2) 85%, var(--text))',
        'secondary': 'var(--text-2)',
        'secondary-solid': 'var(--text-2)',
        'secondary-solid-hover': 'color-mix(in srgb, var(--text-2) 92%, var(--text))',
        'secondary-ink': 'var(--accent-ink)',
        'secondary-soft': 'color-mix(in srgb, var(--text-2) 8%, var(--panel))',
        'secondary-soft-ink': 'color-mix(in srgb, var(--text-2) 85%, var(--text))',
        'danger-fg': 'var(--warn)',
        'danger-fg-subtle': 'var(--warn)',
        'danger-line': 'var(--warn)',
        'danger-focus': 'var(--warn)',
        'inverse': 'var(--text)',
        'inverse-ink': 'var(--bg)',
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

    // Shared Button owns semantics and reactive state. These explicit
    // overrides preserve the existing auth controls without depending on
    // utility order or copying the component into the app.
    'auth-submit': '!py-2.5 !shadow-none '
      + '![transition:transform_0.12s_ease,opacity_0.15s_ease] '
      + 'hover:!bg-[color-mix(in_srgb,var(--accent)_88%,#000)] '
      + 'active:translate-y-px disabled:!opacity-60 disabled:!cursor-default',

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

    /*
     * The box those two sit in. Ten sites across six views spelled
     * `px-3 text-sm rounded-lg` out as three separate utilities, identically in
     * every one, beside whichever of the pair gave it a colour.
     *
     * Kept apart from err-box and ok-box rather than folded into them, so the
     * composite reads the same way in all three apps that have it: colour is
     * one class, geometry is another, and `class="mb-4 py-2 err-box
     * notice-box"` says which is which. It also means the confirmation and the
     * error share a box instead of each carrying their own copy of it.
     *
     * The vertical padding stays at the call site: errors sit at py-2 and
     * confirmations at py-3 here, in bughq and in analyticshq alike, so it is a
     * real axis rather than an oversight.
     */
    'notice-box': 'px-3 text-sm rounded-lg',

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
