/**
 * Names a render context carries into a template, as AMBIENT declarations for
 * `stx typecheck` (passed with --lib; the checker does not read tsconfig's
 * include).
 *
 * An include's data becomes a render-context key, so inside a partial it
 * arrives as a bare name with nothing in the partial itself to declare it.
 * Mirrors analyticshq's types/render-context.d.ts.
 */

/**
 * The trail partials/Breadcrumbs.stx renders, declared by each including page
 * (it drives the page's BreadcrumbList JSON-LD from the same array). The last
 * crumb has no `href` because it is the current page; `url` is the absolute
 * form the JSON-LD needs.
 *
 * Not optional: the partial is only ever reached through a page that supplies
 * it. Restated rather than imported, because a --lib file with an import stops
 * being ambient.
 */
declare const crumbs: { label: string, href?: string, url?: string }[]
