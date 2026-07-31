import type { StxOptions as UiOptions } from '@stacksjs/stx'

/**
 * stx configuration — the root of this application. There is no index.html.
 *
 * This file is loaded TWICE, by loaders with different semantics:
 *
 *   A. @stacksjs/stx loadStxConfig()            (dist/config.js:387)
 *      → applies resolveStxRoot (config.js:363-374) and prefixes
 *        componentsDir/layoutsDir/partialsDir with `root` (config.js:411-419).
 *      → used by `stx build`, the SSG, production-builder, store-loader,
 *        and Crosswind config discovery.
 *
 *   B. bun-plugin-stx serve()                   (dist/serve.js:8912-8919)
 *      → raw bunfig load, NO root prefixing, defaults ssr:true.
 *      → used by `bun scripts/dev.ts` and `buddy serve` on every request.
 *
 * A relative directory value cannot be correct in both unless `root` is '.'.
 * That is why `root: '.'` is pinned below and every directory is written from
 * the project root. Verify with `bun scripts/check-stx-topology.ts` — it fails
 * if the two loaders disagree or any resolved path is missing.
 *
 * Keys are only listed here if the serve path actually forwards them
 * (serve.js:9508-9528). Everything else — `defaultLayout`, `i18n`, `forms`,
 * `customDirectives`, `markdown`, `a11y`, `csp`, … — is silently dropped in
 * transit and would read as configured behaviour while doing nothing.
 */
export default {
  // --- Project shape -------------------------------------------------------
  // Pinned, not inferred. Without `root`, resolveStxRoot (config.js:363-374)
  // decides the whole topology from `fs.existsSync('resources/layouts')`. That
  // directory did not exist until the layouts moved into it, so `root` used to
  // resolve to '.' by accident; now that it exists, leaving `root` unset would
  // silently flip it to 'resources' and double-prefix the three directories
  // below into non-existent resources/resources/*. The pin and the move landed
  // in the same commit for exactly this reason.
  root: '.',

  // Every .stx under here is a public URL (stx-router file-router.js:41-58).
  // Nothing that is not a page may live in this tree: the SSG (ssg.d.ts:24-43)
  // and the route-type codegen (stx-router codegen.js:3-22) have no exclusion,
  // so a layout parked here is built to HTML and listed in the sitemap. This
  // was previously unset, so it defaulted to 'pages' — a directory that does
  // not exist — and only the dev/prod server overrides kept the app booting
  // while `stx build` and the SSG resolved nothing.
  pagesDir: 'resources/views',

  // --- Template directories ------------------------------------------------
  // Root-relative because `root` is '.', which makes the config.js:411-419
  // prefix a no-op and both loaders agree.
  //
  // Caveat, verified not assumed: all three are OVERRIDDEN on the served path.
  // Dev passes them at @stacksjs/actions/dist/dev/views.js:68-73, prod at
  // @stacksjs/buddy/dist/production-server.js:116-123, and options win at
  // bun-plugin-stx/dist/serve.js:8935-8937. They are still declared here
  // because `stx build`, the SSG and production-builder read them directly.
  componentsDir: 'resources/components',
  layoutsDir: 'resources/layouts',
  partialsDir: 'resources/partials',

  // Module-scope reactive state, inlined into every page as
  // <script data-stx-stores> (process.js:245-257). Resolved against `root` by
  // store-loader.js:11 — a different mechanism from the three keys above.
  // Contract: top-level *.ts only (non-recursive glob, store-loader.js:16),
  // index.ts/types.ts skipped, and all `import` lines stripped before
  // transpile (store-loader.js:36) — stores must be self-contained.
  storesDir: 'resources/stores',

  // Static root. Not passed by views.js, so this value actually reaches the
  // server (serve.js:8938). Declared so it stops being a hidden default.
  publicDir: 'public',

  // --- Rendering -----------------------------------------------------------
  // Explicit because the two loaders default it differently: stx's own
  // defaultConfig says false (config.js:18) while bun-plugin-stx says true
  // (serve.js:8833). The false side is what makes `stx build` pick SSG over
  // SSR (build.js:4-5). loghq is SSR; say so once, here.
  ssr: true,

  // Registers the shipped UI components by tag name — the ONLY code path that
  // fills _pluginComponentDirs (config.js:420-468), lifted into the serve path
  // at serve.js:8922-8930. Without it every <Badge>/<Button>/<Switch> renders
  // an absolute-filesystem-path error string into the page body.
  plugins: ['@stacksjs/components/stx-plugin'],

  // stx's own client-script DOM guard. process.js:704 calls validateClientScript
  // on every non-server <script> body; without this key it resolves to
  // { enabled: false } (script-validation.js:129) and reports nothing.
  //
  // Warn-only for now: failOnViolation throws from inside the render, which on
  // the SSR path is a 500 per request. Flip it once the burn-down is clean.
  //
  // allowPatterns stays EMPTY on purpose. The filter is rule-global, not
  // site-scoped (script-validation.js:130-132), and it substring-matches the
  // message — so allowing 'location' would silently kill four rules at once.
  strict: {
    enabled: true,
    failOnViolation: false,
    allowPatterns: [],
  },

  // The page and site.config own every SEO tag. Without this, seo.js:261-273
  // injects <title>stx Project</title> and "A website built with stx templating
  // engine" into any page that does not declare its own.
  skipDefaultSeoTags: true,

  // --- Router --------------------------------------------------------------
  // `container` names the element the router swaps. It must exist: getContainer
  // (stx-router client.js:193-195) returns the first match, and on null
  // shouldIntercept bails at client.js:796 and every link reverts to a full
  // document load. resources/layouts/default.stx owns the single <main>.
  //
  // interceptAllLinks stays true until every internal anchor is an <StxLink>
  // (guide ch.9.1) — stx-router's own default is false (client.js:9) while the
  // serve path hardcodes true (serve.js:9764), so pin it rather than inherit it.
  router: {
    container: 'main',
    interceptAllLinks: true,
  },

  // --- Document shell ------------------------------------------------------
  // The only <head> stx generates (process.js:205-233 → document-shell.js).
  // `title` here is the LAST-RESORT tier of the precedence chain, not a title:
  // its job is to make a page that forgot one read as "loghq". Pages set their
  // own with useSeoMeta({ title }) in <script server>.
  //
  // meta and link are concatenated, not replaced (process.js:216-218), and
  // injectConfigHeadTags dedupes links by exact href (document-shell.js:79-80)
  // and metas by name/property/charset (document-shell.js:73-75) — so these can
  // land here before the per-page copies are deleted, without doubling up.
  app: {
    head: {
      title: 'loghq',
      lang: 'en',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
      //
      // Only genuinely site-wide assets belong here. `/marketing.css` does NOT:
      // it styles the marketing shell only, and no app page has ever linked it.
      // Putting it here would load 16KB of `.btn`/`.panel`/`.hero` rules onto
      // /dashboard and /settings, which define their own conflicting versions of
      // the same class names. It lives in resources/layouts/marketing.stx
      // instead, so it arrives with the shell that needs it.
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap' },
      ],
    },
  },
} satisfies UiOptions
