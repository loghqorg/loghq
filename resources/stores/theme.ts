/**
 * Theme store — the single source of truth for light/dark.
 *
 * Store files are NOT modules. getStoreScript (store-loader.js:5-73) globs this
 * directory non-recursively, deletes every single-line `import`, strips the
 * `export` keyword, transpiles, and concatenates every file into one shared
 * IIFE. So: no value imports (they are silently deleted, leaving a
 * ReferenceError), no file named index.ts or types.ts (both are skipped), and
 * every top-level name here must be unique across the whole directory.
 *
 * `defineStore`, `state`, `derived` and `useColorMode` are runtime globals on
 * `window.stx` — never import them.
 *
 * Why a store rather than a per-page signal: window.stx._stores is the only
 * client state in stx that survives an SPA navigation. cleanupContainer
 * (signals.js:5099) disposes per-element effects on every fragment swap but
 * never touches _stores, and defineStore is idempotent, so re-running this
 * bundle after a swap is a no-op.
 */

/**
 * Registration is deferred when the runtime is not up yet.
 *
 * The store bundle is injected right after the page's FIRST
 * `<script data-stx-scoped>` (process.js:247-250). On the app pages that lands
 * late in the document, well after the signals runtime, and `defineStore` is
 * already a global. On the 24 pages that hand-write their own `<!DOCTYPE>` it
 * lands at roughly line 37 — BEFORE the runtime — and calling `defineStore`
 * there throws `ReferenceError: defineStore is not defined`, killing the whole
 * bundle on every marketing page.
 *
 * This is one more symptom of the DOCTYPE problem, not an independent bug:
 * a self-shelled page skips ensureDocumentShell, so the runtime is appended on
 * a different path and in a different order. When those pages become fragments
 * (@extends + @section) the ordering normalises and this guard can go —
 * `defineStore` will simply always be defined. Until then, deferring to
 * DOMContentLoaded is correct in both orders: at that point every inline script
 * in the document has run, so the runtime is guaranteed present.
 */
function registerThemeStore() {
  defineStore('theme', () => {
  // useColorMode owns persistence, the prefers-color-scheme listener, the
  // cross-tab storage listener, and transition suppression — all four of which
  // the hand-rolled `effectiveTheme()` copies scattered across the app lack.
  //
    // No cast here any more. stx used to declare this as a zero-arg function
    // returning { mode: StxSignal, setMode } — an API that did not exist — so
    // the call had to go through a locally corrected type. The shipped
    // declaration was fixed upstream and now matches the implementation, so the
    // local override is deleted and this is checked against stx's own types.
    const cm = useColorMode({
      storageKey: 'loghq_theme',
      attribute: 'data-theme',
    })

    // cm.mode / cm.isDark are plain getters, NOT signals (signals.js:3494-3504).
    // Reading one inside a directive registers no dependency, so the binding
    // would never update. Mirror it into a real signal via subscribe.
    const mode = state<'light' | 'dark'>(cm.mode)
    cm.subscribe((resolved) => {
      mode.set(resolved)
      // Crosswind's darkMode defaults to the *class* strategy, so every `dark:`
      // utility in the shipped component library compiles to `.dark .dark\:x`.
      // loghq themes via [data-theme], which those components cannot see.
      // Writing both keeps our own semantic tokens working AND makes the
      // library themable.
      document.documentElement.classList.toggle('dark', resolved === 'dark')
    })

    return {
      mode,
      isDark: derived(() => mode() === 'dark'),
      toggle: () => cm.toggle(),
    }
  })
}

if (typeof defineStore === 'function')
  registerThemeStore()
else
  document.addEventListener('DOMContentLoaded', registerThemeStore, { once: true })
