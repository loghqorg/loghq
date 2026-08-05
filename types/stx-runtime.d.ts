/**
 * Corrections for stx runtime globals whose shipped ambient declarations still
 * do not match the shipped implementation.
 *
 * Declared global (not exported) so store files can use them without an
 * `import` — the store loader deletes every single-line import before
 * transpiling (store-loader.js:52), so a store must be self-contained.
 *
 * This file used to carry five corrections. FOUR are gone because stx fixed
 * them (#1806, #1807, #1808, #1838) — the last of those gave store bundles the
 * runtime-globals preamble, so `useCookie` no longer has to be reached through
 * the `window.stx` registry and the augmentation for it is deleted: `useCookie` and `StxCookieOptions` are declared
 * upstream now, and `navigate`'s second argument is a real options object with
 * working `replace` and `reload`. Keeping a local copy of a fixed declaration is
 * not neutral — two same-named interfaces in global scope MERGE rather than
 * collide, so a stale copy silently widens the upstream shape and `tsc` says
 * nothing. Delete on fix; do not leave them for symmetry.
 */

declare global {
  /**
   * `useEventListener`'s real argument order.
   *
   * Two different functions ship under this name. `src/browser-composables.ts`
   * exports target-first overloads; the runtime global that a bare call in a
   * client script actually resolves to is `src/signals.ts:5032`, which is
   * `(event, handler, options)` with the target read from `options.target`,
   * defaulting to window. stx.d.ts:186-197 declares the target-first module
   * shape for the runtime one.
   *
   * The declared order happens to type-check a correct call, because parameter
   * one accepts a string and reads it as a selector — so getting this wrong
   * binds a listener to nothing rather than failing to compile. That is why the
   * correct order is declared here as an extra overload rather than trusted.
   *
   * Still unfixed upstream as of fork commit f539929dfe; unfiled.
   */
  function useEventListener(
    event: string,
    handler: (event: any) => void,
    options?: { target?: Window | Document | HTMLElement | string | null, capture?: boolean, passive?: boolean, once?: boolean },
  ): void
}

export {}
