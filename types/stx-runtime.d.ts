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

  /** Options accepted by `useCookie` (signals.js:3568-3600). */
  interface StxCookieOptions {
    path?: string
    domain?: string
    /** Seconds. Emitted as max-age; setting the signal to '' emits max-age=0. */
    maxAge?: number
    sameSite?: 'Strict' | 'Lax' | 'None'
    /** Derived from location.protocol when omitted. */
    secure?: boolean
    defaultValue?: string
    encode?: (value: string) => string
    decode?: (value: string) => string
  }

  /**
   * `useCookie` is undeclared in the shipped stx.d.ts even though it exists and
   * is auto-imported. Declared here so client scripts can use it bare.
   *
   * IMPORTANT — this is only valid inside a <script client> block. Unlike
   * useColorMode, useLocalStorage and the other 24 composables, useCookie is
   * NOT assigned to `window` as a bare global; it lives only on `window.stx`
   * and reaches client scripts through auto-import destructuring. Store bundles
   * are injected raw, with no auto-import pass, so a store must reach it via
   * `window.stx.useCookie` — see resources/stores/session.ts. Calling it bare
   * from a store is a ReferenceError, which the type system will not catch.
   *
   * It returns a string signal with no JSON layer, which is why it is the right
   * home for a bearer token; useLocalStorage would JSON.parse it and throw.
   */
  function useCookie(name: string, options?: StxCookieOptions): StxSignal<string>

  /**
   * `navigate`'s real signature.
   *
   * The shipped declaration is `navigate(url, options?: { replace?: boolean })`.
   * The implementation is `navigate(url, forceReload)` and there is no replace
   * behaviour anywhere in it — the second argument is tested for truthiness and,
   * when truthy, assigns location.href. So the declared call
   * `navigate(url, { replace: true })` type-checks, does a FULL PAGE LOAD, and
   * pushes a history entry, which is the opposite of replace semantics. Cast
   * through this to pass the boolean the function actually reads.
   */
  type StxNavigate = (url: string, forceReload?: boolean) => void

  /** The subset of the `window.stx` runtime surface loghq reaches directly. */
  interface StxRuntime {
    useCookie: (name: string, options?: StxCookieOptions) => StxSignal<string>
  }

  interface Window {
    stx: StxRuntime
  }
}

export {}
