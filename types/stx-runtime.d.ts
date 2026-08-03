/**
 * Corrected shapes for stx runtime globals whose shipped ambient declarations
 * do not match the shipped implementation.
 *
 * These are declared global (not exported) so store files can use them without
 * an `import` — the store loader deletes every single-line import before
 * transpiling (store-loader.js:52), so a store must be self-contained.
 */

declare global {
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

  /**
   * `useEventListener`'s real argument order.
   *
   * The shipped declaration is `(target, event, handler)`. The implementation
   * is `(event, handler, options)` and takes the target from `options.target`,
   * defaulting to window — verified in signals.js. The declared order happens
   * to type-check for a call like `useEventListener('keydown', fn, …)` because
   * the first parameter accepts a string (read as a selector), so getting this
   * wrong produces a listener bound to nothing rather than a compile error.
   *
   * Declared as an additional overload, so a correctly-ordered call resolves.
   */
  function useEventListener(
    event: string,
    handler: (event: any) => void,
    options?: { target?: Window | Document | HTMLElement | string | null, capture?: boolean, passive?: boolean, once?: boolean },
  ): void

  /** The subset of the `window.stx` runtime surface loghq reaches directly. */
  interface StxRuntime {
    useCookie: (name: string, options?: StxCookieOptions) => StxSignal<string>
  }

  interface Window {
    stx: StxRuntime
  }
}

export {}
