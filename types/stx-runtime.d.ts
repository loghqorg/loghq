/**
 * Corrected shapes for stx runtime globals whose shipped ambient declarations
 * do not match the shipped implementation.
 *
 * These are declared global (not exported) so store files can use them without
 * an `import` — the store loader deletes every single-line import before
 * transpiling (store-loader.js:52), so a store must be self-contained.
 */

declare global {
  /**
   * Options accepted by `useColorMode` at runtime (signals.js:3429-3435).
   *
   * The shipped declaration at `@stacksjs/stx/dist/stx.d.ts:231` says
   * `useColorMode(): { mode: StxSignal<…>, setMode(…) }` — zero parameters, and
   * a return shape with no `subscribe`, no `toggle`, no `isDark`. None of that
   * exists in the implementation. Filed upstream; until it is fixed, call sites
   * cast through these interfaces.
   */
  interface StxColorModeOptions {
    /** localStorage key the preference persists under. Default 'stx-color-mode'. */
    storageKey?: string
    /** Starting preference before anything is persisted. Default 'auto'. */
    initialMode?: StxColorPreference
    /** Class toggled on <html> when `attribute` is not set. Default 'dark'. */
    darkClass?: string
    /**
     * Attribute written on <html> instead of toggling `darkClass`. Setting this
     * means the class is NOT written — see resources/stores/theme.ts, which
     * writes the class itself so Crosswind's class-strategy `dark:` variants
     * keep working alongside our [data-theme] tokens.
     */
    attribute?: string | null
    /** Suppress the repaint flash by killing transitions during the swap. Default true. */
    disableTransitions?: boolean
  }

  /** 'auto' follows prefers-color-scheme; the other two are explicit choices. */
  type StxColorPreference = 'light' | 'dark' | 'auto'

  /** Resolved mode — 'auto' has already been collapsed to a real value. */
  type StxColorResolved = 'light' | 'dark'

  /**
   * What `useColorMode` actually returns (signals.js:3494-3504).
   *
   * `mode`, `preference` and `isDark` are plain getters, NOT signals. Reading
   * one inside a directive registers no dependency and the binding will never
   * update — bridge through `subscribe` into a real `state()` instead.
   */
  interface StxColorMode {
    readonly mode: StxColorResolved
    readonly preference: StxColorPreference
    readonly isDark: boolean
    set: (mode: StxColorPreference) => void
    toggle: () => void
    /** Returns an unsubscribe function. Teardown is already registered via onDestroy. */
    subscribe: (fn: (resolved: StxColorResolved, preference: StxColorPreference) => void) => () => void
  }

  /** Correctly-typed view of the `useColorMode` global. */
  type StxUseColorMode = (options?: StxColorModeOptions) => StxColorMode
}

export {}
