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
 *                  One constraint is real, and it is neither quoting nor
 *                  structure. The engine replaces a `font-family` written
 *                  literally in a preflight when the rule is in the SPACED
 *                  form (`sel { prop: value; }`) and the stack begins
 *                  `ui-sans-serif`; it substitutes the theme's own sans.
 *                  Quoting makes no difference and nothing after it is
 *                  swallowed -- this entry claimed both, from a reading rather
 *                  than a measurement. Behind a custom property, or read
 *                  through `var()`, nothing is rewritten, which is what both
 *                  font-family declarations below do. Several rules in one
 *                  getCSS() are fine.
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
 * The design tokens. Declared here and nowhere else (stx-standards rule 3,
 * §11.2).
 *
 * They were in public/tokens.css, linked into every route from config/ui.ts,
 * on the claim restated at the top of that file: that `preflights` "is spread
 * into the generator config and then never emitted", proven "with a probe
 * token that appears nowhere in the served CSS on any route". That probe was
 * real, and so was the result. It is also what the `preflights` entry above
 * already records as fixed: stacksjs/stx #1867 unified the two render paths
 * onto one merge, and this config has carried the correction for a while. Only
 * the two stylesheets still said it, which is why 83 declarations lived
 * outside this file.
 *
 * Re-probed on the installed stx 0.2.532 before moving anything, the same way
 * the original probe was run: mergeCssConfig() reports includePreflight true,
 * carries the entries into `config`, and a probe token placed in `preflights`
 * comes back out of toCSS(). DATE_RANGE_PICKER_CSS below had been reaching
 * /analytics the whole time, which is the same proof from the other direction.
 *
 * Still FIRST, which is what the old link order said: before APP_CHROME so
 * that can read the palette, and before /marketing.css, which the marketing
 * layout adds and which declares a richer overlapping set. Later still wins,
 * and marketing.css is unlayered while this is @layer tc-base, so it wins
 * harder than it did. That is the direction it already wanted.
 */
const TOKENS = `
:root {
  /* The one declaration that reaches the parts of the page we do not draw.
   *
   * Native UI — the select popup, scrollbars, the date and colour pickers, form
   * control backgrounds, the spellcheck underline, the caret — is painted by the
   * browser from \`color-scheme\`, not from our custom properties. Undeclared it
   * defaults to \`light\`, so on a dark loghq the project dropdown opened as a
   * white popup on a #090b11 page and the scrollbars stayed light. No amount of
   * token work reaches those pixels; this is the only thing that does.
   *
   * It is declared on all four blocks below and not once on \`:root\` with both
   * values, because \`color-scheme: light dark\` means "either is fine, follow the
   * OS" — which is wrong the moment someone picks a theme explicitly. The
   * attribute blocks have to be able to override the media query, exactly like
   * every colour here. */
  color-scheme: light;
  --bg: #fbfbfd;
  --panel: #ffffff;
  --border: rgba(15, 23, 42, 0.09);
  --text: #0b0f19;
  --text-2: #4b5565;
  /* --text-3 was #97a1b2, which measured 2.52:1 against --bg and 2.61:1
   * against --panel. WCAG AA wants 4.5:1 for body text, so every "subtle"
   * label in the app failed it — 73 elements in light and 82 in dark, measured
   * in a real browser across seven pages. It is the same token in both themes
   * and it failed in both (dark was #667085, 3.73:1 on --panel).
   *
   * #6b7280 gives 4.83:1 on --panel and 4.68:1 on --bg; the dark #79839a gives
   * 4.88:1 and 5.18:1. Both are the smallest step that clears AA on the worse
   * of the two surfaces, so "subtle" still reads as subtle. */
  --text-3: #6b7280;
  /* Emerald, not the rose this shipped with.
   *
   * The old --accent was #e11d48, which is byte-for-byte --sev-error below. In
   * a product whose whole surface is log severity, the brand colour WAS the
   * error colour: every button, link and focus ring carried the one hue the
   * severity scale reserves for something being wrong.
   *
   * Green collides with --ok instead, which is the milder trade. --ok is a UI
   * success state, not a severity: nothing in the sev-* scale is green, so the
   * severity reading stays unambiguous. Brand-as-healthy misleads nobody;
   * brand-as-error did.
   *
   * #047857 rather than the more obvious #059669: emerald-600 measures 3.65:1
   * on --bg, under the 4.5 floor this file holds everything else to. This one
   * measures 5.31:1 on --bg and 5.48:1 on --panel, which is also an improvement
   * on the rose it replaces (4.54:1, passing by 0.04). */
  --accent: #047857;
  --accent-soft: rgba(4, 120, 87, 0.08);
  /* Ink for text sitting ON a saturated fill — the accent, --warn, and the
   * Slack/Discord brand colours.
   *
   * It cannot be a hardcoded #fff, which is what the app markup and
   * app-chrome.css assumed. In dark mode the fills get LIGHTER, not darker:
   * --accent is #34d399 and the dashboard's indigo is #818cf8, where white
   * measures 1.92:1 and 2.98:1. The dark value here measures 9.83:1 and 6.34:1
   * on those same fills, and 6.83:1 on the dark --warn.
   *
   * marketing.css has had this token, correctly themed, since the marketing
   * pages were built; it just never reached the app surface, because that
   * sheet only loads on marketing routes. Declared here it covers both, and
   * marketing.css no longer declares its own copy — see the .reveal note there
   * for what two copies of one token cost. */
  --accent-ink: #ffffff;
  --ok: #16a34a;
  --warn: #b91c1c;
  --sans: 'Space Grotesk', ui-sans-serif, system-ui, sans-serif;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

  /* Log severity. These were six hex literals inside a levelColor() switch in
   * dashboard.stx, with two of them repeated in the stats array — so the same
   * "warning amber" was written twice and could drift.
   *
   * They were also a single set used on BOTH themes. The dark values below are
   * exactly what shipped before, so dark is unchanged; light gets darker,
   * higher-contrast variants, because #fb7185 on a #fbfbfd background is not a
   * readable label. */
  --sev-critical: #be123c;
  --sev-error: #e11d48;
  --sev-warning: #b45309;
  --sev-notice: #0369a1;
  --sev-info: #1d4ed8;
  --sev-debug: #64748b;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #090b11;
    --panel: #10131c;
    --border: rgba(148, 163, 184, 0.12);
    --text: #f3f5f9;
    --text-2: #b3bccb;
    --text-3: #79839a;
    --accent: #34d399;
    --accent-soft: rgba(52, 211, 153, 0.1);
    --accent-ink: #04140d;
    --ok: #4ade80;
    --warn: #f87171;
  --sev-critical: #f43f5e;
  --sev-error: #fb7185;
  --sev-warning: #f59e0b;
  --sev-notice: #38bdf8;
  --sev-info: #60a5fa;
  --sev-debug: #94a3b8;
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #090b11;
  --panel: #10131c;
  --border: rgba(148, 163, 184, 0.12);
  --text: #f3f5f9;
  --text-2: #b3bccb;
  --text-3: #79839a;
  --accent: #34d399;
  --accent-soft: rgba(52, 211, 153, 0.1);
  --accent-ink: #04140d;
  --ok: #4ade80;
  --warn: #f87171;
  --sev-critical: #f43f5e;
  --sev-error: #fb7185;
  --sev-warning: #f59e0b;
  --sev-notice: #38bdf8;
  --sev-info: #60a5fa;
  --sev-debug: #94a3b8;
}

:root[data-theme='light'] {
  color-scheme: light;
  --bg: #fbfbfd;
  --panel: #ffffff;
  --border: rgba(15, 23, 42, 0.09);
  --text: #0b0f19;
  --text-2: #4b5565;
  --text-3: #6b7280;
  --accent: #047857;
  --accent-soft: rgba(4, 120, 87, 0.08);
  --accent-ink: #ffffff;
  --ok: #16a34a;
  --warn: #b91c1c;
  --sev-critical: #be123c;
  --sev-error: #e11d48;
  --sev-warning: #b45309;
  --sev-notice: #0369a1;
  --sev-info: #1d4ed8;
  --sev-debug: #64748b;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  -webkit-font-smoothing: antialiased;
}

/* Skeleton shimmer, from account.stx's <style> block. Utilities cannot declare
 * a @keyframes, so this is a preflight, which is the documented home for one.
 *
 * Named loghq-pulse rather than pulse on purpose. Crosswind emits its own
 * \`@keyframes pulse\` (0%,100% opacity 1; 50% opacity .5) as soon as any page
 * uses \`animate-pulse\`, into a sheet that is linked AFTER this file. A
 * same-named keyframe there would silently replace this one and change the
 * animation rather than error.
 */
@keyframes loghq-pulse {
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 0.9;
  }
}

/* The one element that uses it, as a named class rather than an arbitrary
 * \`[animation:loghq-pulse_1.4s_ease-in-out_infinite]\` utility.
 *
 * That utility worked. What never worked was the guard beside it,
 * \`motion-reduce:[animation:none]\`: a variant on an arbitrary property is not
 * recognised by crosswind's class extractor, so it produced no rule at all and
 * the skeleton kept pulsing for people who asked their system not to animate.
 * Silent, as that whole class of miss is -- no error, no warning, nothing in
 * the sheet. Filed as stacksjs/ts-css#37; the generator side of it is fixed in
 * 0.3.14 (#36), the extractor is not.
 *
 * Both halves live here, in source order, so the reduced-motion case does not
 * depend on the extractor, on crosswind's output ordering, or on an
 * !important. It also cannot be separated from the keyframes it guards. Note
 * this file is linked BEFORE the generated sheet, which is why the animation
 * is declared here rather than left as a utility for this rule to fight.
 */
.skeleton-pulse {
  animation: loghq-pulse 1.4s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .skeleton-pulse {
    animation: none;
  }
}

/* Theme-toggle icon swap. Three identical copies of this lived in
 * dashboard.stx, settings.stx and projects/index.stx.
 *
 * It stays CSS because no utility can express it: the selector is an
 * attribute-state descendant, \`[data-t="light"] .ic-sun\`, driven by the
 * \`theme()\` signal through \`:data-t\` on the button. The alternative — a
 * \`:show\` binding on each icon — would need \`style="display:none"\` on both to
 * avoid showing both icons before hydration, trading a state rule for two
 * inline styles and a hydration dependency on something that is currently
 * pure CSS.
 */
.theme-btn .ic-sun,
.theme-btn .ic-moon {
  display: none;
}

/* Keyed off the ROOT element, not off the button.
 *
 * These used to read \`.theme-btn[data-t='light']\`, where data-t came from a
 * \`:data-t="theme()"\` binding — a client signal. So before hydration the button
 * carried no data-t at all, neither rule matched, and the pair above left BOTH
 * icons display:none: the theme control rendered as an empty box on every cold
 * load. There is no server-known theme to put in a static counterpart either,
 * so the fix is not a static attribute; it is keying off something that IS set
 * before first paint.
 *
 * stx's color-mode boot script sets data-theme on the root above every
 * stylesheet (config/ui.ts app.colorMode), and useColorMode keeps it current
 * afterwards, so the correct icon paints immediately and the mirror signal the
 * binding needed is gone from all three pages. */
:root[data-theme='light'] .theme-btn .ic-sun {
  display: block;
}

:root[data-theme='dark'] .theme-btn .ic-moon {
  display: block;
}
`

/*
 * App-surface CSS that utilities provably cannot express: pseudo-elements,
 * attribute-state selectors, bare element selectors, @keyframes, and the
 * dashboard's page-scoped accent.
 *
 * From public/app-chrome.css, which opened by naming this file as where
 * ch.11.2/11.7 says it belongs and then explaining why it could not be here.
 * See TOKENS above for why that reason no longer holds.
 *
 * Rules that WERE expressible are deliberately absent -- they live as
 * utilities in the markup. Do not move a rule back here because it is more
 * convenient.
 *
 * The cascade, measured rather than reasoned about, because this sheet used to
 * be linked between /tokens.css and /marketing.css and is now layered:
 *
 *   against a utility  A utility is unlayered and this is @layer tc-base, so a
 *     utility wins outright instead of winning ties on order. That is what the
 *     old header asked for ("before the Crosswind sheet so utilities still win
 *     a specificity tie"), now unconditional. Nothing here relied on beating
 *     one by specificity: every selector was checked against the app markup.
 *
 *   against marketing.css  Zero class names are shared between the two files.
 *     The only selectors both write are `:root`, `html` and two at-rules, and
 *     they do not collide: this declares `--slack`/`--discord` where marketing
 *     declares `--bg`/`--text`/`--surface`, both set `scroll-behavior: smooth`
 *     on `html` to the same value, and the three reduced-motion blocks across
 *     the two files target disjoint classes with no !important between them.
 *     So the layer change reverses nothing.
 *
 * Verified end to end by diffing the computed value of 58 properties on every
 * element of 11 served pages, before against after.
 */
const APP_CHROME = `
/* ---------------------------------------------------------------------------
 * Page-scoped tokens
 *
 * dashboard is the one surface with its own accent: indigo, so navigation
 * never reads as a severity colour (see 20f40ed). It used to be a \`:root\`
 * block inside dashboard.stx's <style>, scoped only by the accident of which
 * page carried the tag. Declared globally that would repaint the whole app, so
 * it hangs off a wrapper class on the dashboard's root element and cascades to
 * its descendants — including the fixed-position chrome, which is inside the
 * wrapper.
 * ------------------------------------------------------------------------ */
.page-dashboard {
  --accent: #4f46e5;
  --rail: rgba(79, 70, 229, 0.14);
}

@media (prefers-color-scheme: dark) {
  .page-dashboard {
    --accent: #818cf8;
    --rail: rgba(129, 140, 248, 0.16);
  }
}

:root[data-theme='dark'] .page-dashboard {
  --accent: #818cf8;
  --rail: rgba(129, 140, 248, 0.16);
}

:root[data-theme='light'] .page-dashboard {
  --accent: #4f46e5;
  --rail: rgba(79, 70, 229, 0.14);
}

/* Channel brand colours. Only settings uses them, but they are declared here
 * with everything else rather than in a page tag. */
:root {
  --slack: #611f69;
  --discord: #5865f2;
}

@media (prefers-color-scheme: dark) {
  :root {
    --discord: #818cf8;
  }
}

:root[data-theme='dark'] {
  --discord: #818cf8;
}

:root[data-theme='light'] {
  --discord: #5865f2;
}

/* Tabular numerals for the log stream's counts and timestamps, so digits do
 * not jitter as values change.
 *
 * This is a real rule rather than an arbitrary property because the value has
 * to be quoted — \`font-feature-settings: 'tnum' 1\` — and a quoted value cannot
 * survive Crosswind's class-name syntax. Written as
 * [font-feature-settings:'tnum'_1] it generates NOTHING; the three
 * font-feature-settings declarations in the served sheet are all preflight
 * resets, and the computed value on the element stayed \`normal\`.
 *
 * \`tabular-nums\` is not a substitute: it sets font-variant-numeric, a
 * different property, and would not reproduce the measured baseline.
 */
.tnum {
  font-feature-settings: 'tnum' 1;
}

/* ---------------------------------------------------------------------------
 * Bare element selectors — no utility targets an element type
 * ------------------------------------------------------------------------ */
html {
  scroll-behavior: smooth;
}

/* ---------------------------------------------------------------------------
 * settings: the alert-channel toggle
 *
 * The knob is a ::after pseudo-element and both states are attribute-driven.
 * Crosswind generates nothing for \`after:\` or for a \`[data-on]\` variant.
 * ------------------------------------------------------------------------ */
.tgl::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: #fff;
  transition: transform 0.15s ease;
}

/* The four rules below carry !important, and they are exactly the ones whose
 * element also carries a utility for the same property. While this was a
 * linked stylesheet they won on specificity -- an attribute-state or
 * tag-scoped selector outranks a single-class utility. As a preflight they are
 * in @layer tc-base and a utility is unlayered, which beats a layer at ANY
 * specificity, so without the marks they stop applying.
 *
 * Measured on a probe page carrying the real class lists from settings.stx and
 * dashboard.stx, with the before and after sheets swapped underneath it:
 *
 *   .tgl[data-on='1']          rgb(74,222,128) -> rgba(148,163,184,0.12), ie
 *                              the toggle stops turning green and reads as off
 *                              in both states (loses to \`bg-line\`)
 *   .seg-slack[data-sel='1']   rgb(97,31,105) -> rgb(16,19,28), the selected
 *                              channel loses its brand fill (\`bg-panel\`), and
 *                              .seg's own colour goes with it (\`text-muted\`)
 *   .dz-overlay[hidden]        display none -> flex, so the delete-zone modal
 *                              is permanently open over the settings page
 *                              (loses to \`flex\`)
 *   a.pill:hover               the hover paint stops arriving at all, because
 *                              the utilities it has to beat (\`bg-accent\`,
 *                              \`border-accent\`, \`text-accent-ink\`) carry no
 *                              hover variant and so apply in every state
 *
 * Marked per declaration rather than per rule: only the properties that
 * actually collide, so the override is exactly as wide as the utility it has
 * to beat. */
.tgl[data-on='1'] {
  background: var(--ok) !important;
}

.tgl[data-on='1']::after {
  transform: translateX(16px);
}

/* settings: the Slack/Discord channel picker. Selected state is attribute
 * driven, and each brand paints its own fill. */
.seg[data-sel='1'] {
  color: var(--accent-ink) !important;
  border-color: transparent !important;
}

.seg-slack[data-sel='1'] {
  background: var(--slack) !important;
}

.seg-discord[data-sel='1'] {
  background: var(--discord) !important;
}

/* settings: delete-zone modal. \`[hidden]\` has to beat the overlay's own
 * \`display: flex\`, which a utility cannot guarantee — the engine's own
 * preflight \`[hidden]{display:none}\` ties with \`.flex\` on specificity and
 * loses on order, and this rule, being layered, loses to it outright. Hence
 * the mark. */
.dz-overlay[hidden] {
  display: none !important;
}

@keyframes dz-fade {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

@keyframes dz-pop {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.98);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

/* ---------------------------------------------------------------------------
 * dashboard
 *
 * Moved verbatim from dashboard.stx's <style> block. Every family below is
 * entangled with a selector no utility reaches, so splitting them would have
 * meant half a component in each place:
 *
 *   .pill*        hover/active are tag-scoped (\`a.pill:hover, button.pill:hover\`)
 *                 on purpose — the disabled pager is a <span class="pill"> and
 *                 must NOT light up on hover.
 *   .log-row      \`details[open] > .log-row\` has to outrank the hover state.
 *   .search-input ::placeholder and :focus-visible.
 *   .chrome-*     \`.chrome-pro, .chrome-pro:hover\` cancels .chrome-upgrade's
 *                 hover: Pro is a status, not an action.
 *   summary       bare element selector plus ::-webkit-details-marker.
 *   :focus-visible a bare-element accessibility rule, not optional.
 *   .grain,       data-URI backgrounds with prefers-color-scheme variants.
 *   select.app-panel
 *   .reveal       @keyframes plus a reduced-motion variant.
 *
 * What IS expressible went the other way and is now utilities in the markup:
 * .mono, .wordmark, .wordmark-link, .panel, .lvl-chip, .ctx-pre and .icon-btn.
 * ------------------------------------------------------------------------ */
.pill { border-radius: 999px; transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease, transform 0.12s ease; }
a.pill:hover, button.pill:hover { color: var(--text) !important; border-color: color-mix(in srgb, var(--accent) 45%, var(--border)) !important; background: color-mix(in srgb, var(--accent) 6%, transparent) !important; }
a.pill:active, button.pill:active { transform: translateY(1px); }
/* Filter-tab state. These were inline style ternaries on every tab, which
  outrank the hover rules above and could not be themed. The two levels differ
  because the severity tabs are the primary control and the range tabs are
  secondary. */
.pill-on { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
a.pill-on:hover { color: var(--accent-ink); background: var(--accent); border-color: var(--accent); }
.pill-off { color: var(--text-2); border-color: var(--border); }
.pill-on-soft { color: var(--accent); border-color: var(--accent); }
.pill-off-soft { color: var(--text-3); border-color: var(--border); }
.log-row { transition: background-color 0.12s ease; }
.log-row:hover { background: color-mix(in srgb, var(--accent) 4%, transparent); }
details[open] > .log-row { background: color-mix(in srgb, var(--accent) 5%, transparent); }
summary { list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
.search-input { background: var(--panel); border: 1px solid var(--border); border-radius: 999px; color: var(--text); outline: none; transition: border-color 0.15s ease; }
.search-input:focus { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
.search-input::placeholder { color: var(--text-3); }
/* Position was an inline style string assembled in JS. It lives here now, so
  the chrome is styleable and themeable like everything else. */
.chrome-logout, .chrome-upgrade { position: fixed; top: 16px; z-index: 60; padding: 8px 13px; border-radius: 9px; font-size: 13px; line-height: 1; font-family: var(--sans, ui-sans-serif); }
.chrome-logout { right: 18px; font-weight: 500; cursor: pointer; border: 1px solid var(--border); background: var(--panel); color: var(--text-2); transition: color 0.15s ease, border-color 0.15s ease; }
.chrome-logout:hover { color: var(--text); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.chrome-upgrade { right: 112px; font-weight: 600; text-decoration: none; background: var(--accent); color: var(--accent-ink); transition: filter 0.15s ease, transform 0.12s ease; }
.chrome-upgrade:hover { filter: brightness(1.12); }
.chrome-upgrade:active { transform: translateY(1px); }
/* Pro is a status, not an action: no link, no hover lift. */
.chrome-pro, .chrome-pro:hover { background: transparent; color: var(--accent); border: 1px solid var(--accent); cursor: default; filter: none; }
/* The ONLY .reveal in the app. marketing.css carried a second copy with
  different values (0.6s/12px against this one's 0.5s/10px) and a second
  @keyframes of the same name; both sheets load on every marketing page, so the
  marketing copy won there and this one only ever reached the dashboard. These
  are the marketing values, kept because 23 pages used them and one did not. */
.reveal { opacity: 0; transform: translateY(12px); animation: reveal 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
@keyframes reveal { to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .reveal { animation: none; opacity: 1; transform: none; } }
/* Keyboard focus — a visible ring on every interactive control (accessibility,
  not optional). Search gets an inset ring so it doesn't clash with its pill.

  This rule used to also declare \`border-radius: 8px\`, which was not a property
  of the ring — it RESHAPED THE ELEMENT for as long as it held focus. Tabbing
  onto a filter tab squared off its 999px pill; the same happened to the pager
  and to every rounded control here, because \`a:focus-visible\` (0,1,1) outranks
  \`.pill\` (0,1,0). Nothing about a keyboard user's focus should change an
  element's geometry.

  Nothing replaces it: \`outline\` has followed the element's own border-radius
  since Chrome 94 / Firefox 88 / Safari 16.4, so the ring is correctly rounded
  on a pill and correctly square on a square control, which is what the 8px was
  reaching for in the first place. */
a:focus-visible, button:focus-visible, summary:focus-visible, select:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
summary:focus-visible { outline-offset: -2px; }
.search-input:focus-visible { outline: none; border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
/* Physical press feedback on a log row. */
.log-row:active { background: color-mix(in srgb, var(--accent) 9%, transparent); }
/* Log stream aligned as fixed columns: rail · time · level · channel · message. */
.log-row { display: grid; grid-template-columns: 3px 4.75rem 3.75rem 6rem minmax(0, 1fr); align-items: center; column-gap: 0.75rem; }
/* Subtle grain so the flat surfaces don't read as sterile. Fixed, non-blocking,
  barely-there; sits under the floating chrome (z-60). */
.grain { position: fixed; inset: 0; z-index: 5; pointer-events: none; opacity: 0.03;
  background-size: 170px 170px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='170' height='170'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
@media (prefers-reduced-motion: no-preference) { .grain { opacity: 0.032; } }
/* Project dropdown: the native select chevron hugged the rounded border. Reset
  the native appearance and draw our own with a comfortable inset + room for the
  value text. Chevron is themed to --text-3 in each mode. */
select.app-panel {
  -webkit-appearance: none; -moz-appearance: none; appearance: none;
  /* The one declaration here that a utility also sets: the element carries
   * \`px-3\`, and layered this rule loses to it outright where it used to win
   * on specificity. Measured: padding-right 32px -> 12px, which puts the
   * chevron on top of the project name. The appearance and background
   * properties have no utility on this element and stay unmarked. */
  padding-right: 2rem !important; background-repeat: no-repeat;
  background-position: right 0.7rem center; background-size: 13px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%2397a1b2' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
}
@media (prefers-color-scheme: dark) { select.app-panel { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23667085' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E"); } }

/* Log severity, driven by one data attribute rather than an inline style.
 *
 * The rail and the level badge on a log row both used
 * \`style="background: {{ levelColor(entry.level) }}"\`, and the stat dot and
 * value used \`style="color: {{ s.color }}"\` — four inline declarations carrying
 * hex literals computed in the view. \`data-level\` on the row sets \`--sev\` once
 * and both children read it, so the colour is named in exactly one place
 * (public/tokens.css) and follows the theme.
 *
 * The default covers a level the server does not recognise: it falls back to
 * the debug tone rather than to no colour, so the rail never disappears. */
[data-level] { --sev: var(--sev-debug); }
[data-level='emergency'], [data-level='alert'], [data-level='critical'] { --sev: var(--sev-critical); }
[data-level='error'] { --sev: var(--sev-error); }
[data-level='warning'] { --sev: var(--sev-warning); }
[data-level='notice'] { --sev: var(--sev-notice); }
[data-level='info'] { --sev: var(--sev-info); }
.log-rail { background: var(--sev); min-height: 20px; }
.log-level { color: var(--sev); background: color-mix(in srgb, var(--sev) 14%, transparent); }
/* One segment of the level-mix bars on /analytics. Reads the same --sev the
 * rail and the chip do, so a colour still means the same severity across the
 * whole app and the analytics page names no palette of its own. */
.level-seg { background: var(--sev); }

/* Stat cards. \`data-tone\` is set only when the count is non-zero, so an empty
 * warnings/errors card stays neutral — which is what \`s.on\` expressed inline. */
.stat-dot { background: var(--text-3); opacity: 0.35; }
.stat-value { color: var(--text); }
[data-tone='warning'] .stat-dot { background: var(--sev-warning); opacity: 1; }
[data-tone='warning'] .stat-value { color: var(--sev-warning); }
[data-tone='error'] .stat-dot { background: var(--sev-critical); opacity: 1; }
[data-tone='error'] .stat-value { color: var(--sev-critical); }

/* ---------------------------------------------------------------------------
 * Narrow viewports
 *
 * This sheet had NO width query at all, while marketing.css has four. The app
 * surface is the half that people actually work in, and it was the half with no
 * mobile behaviour — the two rules below are both fixed geometry that a phone
 * cannot satisfy.
 *
 * Everything here adjusts rules THIS FILE owns. It deliberately does not try to
 * override a utility (the page's own \`px-5 py-10\`, for instance): this sheet is
 * linked before the Crosswind sheet precisely so utilities win a specificity
 * tie, so a \`.page-dashboard { padding-top }\` here would be silently dead. Any
 * responsive change to a utility-styled element belongs in the markup as an
 * \`sm:\`/\`md:\` variant.
 *
 * 40rem rather than a round 375px: the breakpoint is where the content stops
 * fitting, and it is in rem so it also fires for someone at a large default
 * font size on a wider screen, who has the same problem for a different reason.
 * ------------------------------------------------------------------------ */
@media (max-width: 40rem) {
  /* The log stream was a single row of five fixed columns:
   *   3px rail + 4.75rem time + 3.75rem level + 6rem channel
   * plus four 0.75rem gaps and the row's own 20px side padding — 323px spoken
   * for before the message column starts. On a 375px phone that leaves the
   * message 52px, about four characters, on the one line that carries what
   * actually happened. The row was not narrow, it was empty.
   *
   * It becomes two rows: metadata above, message across the full width below.
   * Nothing is dropped — the channel is not repeated in the expanded panel, so
   * hiding it would have lost the only place it appears.
   *
   * Addressed by position because these are bare spans in the markup with no
   * hooks of their own, and the order is fixed by the template: rail, time,
   * level, channel, message. */
  .log-row {
    grid-template-columns: 3px auto auto minmax(0, 1fr);
    column-gap: 0.5rem;
    row-gap: 0.2rem;
  }

  /* The rail spans both rows so it stays one continuous severity stripe beside
   * the whole entry rather than a stub next to the timestamp. */
  .log-row > :nth-child(1) { grid-row: 1 / span 2; }
  .log-row > :nth-child(5) { grid-column: 2 / -1; }

  /* The floating chrome is positioned for a desktop margin: \`top: 16px\` with
   * 8px padding puts its lower edge at about 46px, and the page's own content
   * starts at 40px. On a wide screen the centred column leaves that gutter
   * empty so nothing shows; on a phone the column is the full width and the
   * header runs underneath the buttons.
   *
   * Smaller and tighter, so the chrome's lower edge lands near 32px and closes
   * the overlap window rather than merely making it less likely. */
  .chrome-logout, .chrome-upgrade {
    top: 10px;
    padding: 5px 10px;
    font-size: 12px;
    border-radius: 8px;
  }

  .chrome-logout { right: 12px; }
  .chrome-upgrade { right: 88px; }
}
`

/*
 * The date-range picker's stylesheet, lifted out of a <style> block in
 * resources/views/analytics.stx (stx-standards rule 3).
 *
 * This is a RELOCATION and not a conversion to utilities, which is a weaker
 * outcome than the rule wants, so here is why it is the honest one. Every
 * state in this widget is a compound selector the client script toggles --
 * .drp-day.is-range, .drp-preset.is-active, .drp-nav.is-hidden -- and an
 * ordinary utility cannot express "this class AND that class".
 *
 * The spelling that can, an arbitrary-variant utility like
 * [&.is-range]:bg-accent, used to emit nothing: the extractor rejected any
 * class whose variant is an arbitrary selector (stacksjs/ts-css#37). **Fixed
 * in 0.3.16**, which this app now resolves -- measured through this app's own
 * loader and merge, so against this config:
 *
 *   [&.is-range]:bg-accent          -> .….is-range { background-color: var(--accent) }
 *   [&.drp-day.is-range]:bg-accent  -> .….drp-day.is-range { … }
 *   [&.is-hidden]:hidden            -> .….is-hidden { display: none }
 *
 * So a conversion is possible now. Two reasons it still has not happened, and
 * neither is the defect. First, this stylesheet is shared with bughq byte for
 * byte, and converting it on one side forks it. Second, a PARTIAL conversion
 * is actively worse than either end state: the shortcuts are unlayered and a
 * preflight lands in @layer cw-base, so every unlayered base would outrank its
 * own layered active state and the selected range would stop painting.
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
  preflights: [
    // In the order the three stylesheets they came from were linked:
    // tokens, then the app chrome that reads them, then page CSS.
    { getCSS: () => TOKENS },
    { getCSS: () => APP_CHROME },
    { getCSS: () => DATE_RANGE_PICKER_CSS },
  ],
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

    /*
     * The union of the transition lists, not this app's first one.
     *
     * This entry animated transform and opacity only, so the accent fill it
     * sets on :hover SNAPPED. settings.stx's two solid buttons declared
     * `background 0.15s ease, opacity 0.15s ease` instead and eased it, which
     * is how the omission surfaced when they were folded in here. Each copy had
     * named the properties its own call site happened to animate; the union is
     * what all of them meant. bughq's btn-solid took the same union for the
     * same reason.
     */
    'btn-solid': 'btn-focus bg-accent !text-accent-ink !rounded-[10px] '
      + '![transition:transform_0.12s_ease,opacity_0.15s_ease,background-color_0.15s_ease] '
      + 'hover:!bg-[color-mix(in_srgb,var(--accent)_88%,#000)] '
      + 'active:translate-y-px disabled:!opacity-60 disabled:!cursor-default',

    /*
     * ## settings.stx's button vocabulary
     *
     * Three paints and four sizes, which is what its 23 raw `<button>`
     * elements actually were. Measured class string by class string: 14
     * distinct strings collapsed to these, with no string left over and no
     * paint invented. The four controls that are NOT ordinary buttons -- the
     * theme toggle (`icon-btn`), the channel switch (`tgl`) and the two
     * segment buttons (`seg`) -- keep their own shortcuts and are untouched.
     *
     * Marked `!important` throughout, and this is the reason rather than a
     * habit. The next step puts `<Button variant="ghost">` behind these, and
     * the component's own `variantClasses.ghost` and `sizeClasses.md` are
     * single-class selectors exactly like a shortcut: specificity ties, and
     * crosswind sorts its output by category rather than by generation order,
     * so an unmarked override lands PARTIALLY. Half an override is worse than
     * none, because it reads as working. bughq marked its family for the same
     * reason and the comment there has the measurement.
     *
     * Marked across the whole family, including the `:hover` steps: a marked
     * base outranks its own unmarked hover.
     *
     * The weight lives with the size, not the paint, because the two sizes
     * that exist in both weights differ ONLY in weight: `btn-md` is the
     * modal's Cancel and `btn-cta` is every primary action, and both are
     * px-4 py-2.5 text-sm.
     */
    'btn-quiet': 'btn-focus btn-disabled bg-panel border border-line !text-muted '
      + '!rounded-[9px] ![transition:color_0.15s_ease,border-color_0.15s_ease] '
      + 'hover:!bg-panel hover:!text-ink '
      + 'hover:!border-[color-mix(in_srgb,var(--accent)_45%,var(--border))]',

    'btn-danger': 'btn-focus btn-disabled bg-panel border !border-[color-mix(in_srgb,var(--warn)_45%,var(--border))] '
      + '!text-warn !rounded-[9px] ![transition:all_0.15s_ease] '
      + 'hover:!text-accent-ink hover:!bg-warn hover:!border-warn',

    // The copy button that sits over a code block. Its own entry rather than a
    // size of btn-quiet: it is positioned, uses the sans stack against the
    // mono block it overlays, and is the only control in the file at 11px.
    'btn-copy': 'btn-focus btn-disabled absolute right-2 top-2 bg-panel border border-line '
      + '!px-[9px] !py-[5px] !text-[11px] !font-medium font-sans !leading-none '
      + '!text-subtle cursor-pointer !rounded-[7px] '
      + '![transition:color_0.15s_ease,border-color_0.15s_ease] '
      + 'hover:!bg-panel hover:!text-ink '
      + 'hover:!border-[color-mix(in_srgb,var(--accent)_45%,var(--border))]',

    /*
     * The app's own focus treatment, restored over <Button>'s.
     *
     * The component declares `focus:outline-none focus:ring-2 ...`, and a
     * utility is unlayered while this app's `button:focus-visible { outline:
     * 2px solid var(--accent) }` is a preflight in @layer tc-base -- so the
     * component's ring wins at any specificity and the app's outline simply
     * stops arriving. The two look nearly identical, but the component's fires
     * on `:focus` and the app's on `:focus-visible`, so adopting <Button>
     * would have put a ring on nine buttons after a MOUSE click while every
     * other control in the app rings only for the keyboard.
     *
     * `focus:!ring-0` cancels the component's ring and the `:focus-visible`
     * pair restores the preflight's rule at utility level, where it outranks
     * the component.
     *
     * This spelling -- a variant on an arbitrary property -- emitted NOTHING
     * until ts-css 0.3.16 (stacksjs/ts-css#36 for the generator, #37 for the
     * extractor). It is the first place in this app that needed it, and it was
     * measured through this app's own loader before being relied on.
     */
    'btn-focus': 'focus:!ring-0 '
      + 'focus-visible:![outline:2px_solid_var(--accent)] '
      + 'focus-visible:![outline-offset:2px]',

    /*
     * One disabled appearance for every button.
     *
     * <Button> brings `disabled:opacity-50 disabled:cursor-not-allowed`, and
     * btn-solid already declared 60% with a default cursor. Rather than let
     * three paints disagree, all of them take the 60% that btn-solid's call
     * sites have used all along.
     *
     * This is also a gain on the quiet and danger paints, which previously had
     * no disabled styling at all: `:disabled="rotating()"` dimmed nothing, so a
     * disabled Rotate button looked exactly like an enabled one.
     */
    'btn-disabled': 'disabled:!opacity-60 disabled:!cursor-default',

    'btn-xs': '!px-2.5 !py-1.5 !text-xs !font-medium',
    'btn-sm': '!px-3 !py-2 !text-sm !font-medium',
    'btn-md': '!px-4 !py-2.5 !text-sm !font-medium',
    'btn-cta': '!px-4 !py-2.5 !text-sm !font-semibold',

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
     * one class, geometry is another, and `class="mb-4 py-2 * err-box notice-box"` says which is which. It also means the confirmation and the
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
