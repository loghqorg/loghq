/**
 * The marketing breadcrumb trail.
 *
 * `resources/partials/Breadcrumbs.stx` is one <Breadcrumb> call now, included
 * by 22 marketing pages. Two things make this worth pinning rather than
 * trusting:
 *
 * 1. An unresolved component renders an HTML COMMENT, not an error. So a
 *    partial that silently stops producing a trail passes every "no error"
 *    assertion while 22 pages ship no breadcrumbs at all. The harness resolves
 *    the component explicitly and fails on "could not be resolved".
 * 2. The trail is server-rendered. `:items` is visible to the server for this
 *    component, which is the whole point on pages whose job is to be crawled:
 *    the markup a crawler and a no-JS visitor get already has the trail, and
 *    the anchors carry data-stx-link so the SPA router still intercepts them.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { processDirectives } from '../../node_modules/@stacksjs/stx/dist/process.js'

const root = resolve(import.meta.dir, '../..')
const breadcrumbPath = resolve(root, 'node_modules/@stacksjs/components/src/ui/breadcrumb/Breadcrumb.stx')
const partialPath = resolve(root, 'resources/partials/Breadcrumbs.stx')

const crumbs = [
  { label: 'Home', href: '/', url: 'https://loghq.org/' },
  { label: 'Features', href: '/features', url: 'https://loghq.org/features' },
  { label: 'Capture' },
]

async function renderTrail() {
  const template = readFileSync(partialPath, 'utf8')
  const dependencies = new Set<string>()
  const rendered = await processDirectives(template, {
    crumbs,
    __importedComponents: new Map([['breadcrumb', breadcrumbPath]]),
  }, partialPath, {
    componentsDir: resolve(root, 'resources/components'),
    partialsDir: resolve(root, 'resources/partials'),
  }, dependencies)

  expect(rendered).not.toContain('[Component Error')
  expect(rendered).not.toContain('[Foreach Error')
  expect(rendered).not.toContain('<Breadcrumb')
  expect(rendered).not.toMatch(/could not be resolved/)
  return { html: rendered, dependencies }
}

describe('marketing breadcrumb trail', () => {
  test('renders the shared component, server side, with the whole trail', async () => {
    const { html, dependencies } = await renderTrail()
    expect([...dependencies]).toContain(breadcrumbPath)
    expect(html).toContain('aria-label="Breadcrumb"')
    expect((html.match(/<li\b/g) ?? []).length).toBe(3)
    for (const label of ['Home', 'Features', 'Capture'])
      expect(html).toContain(label)
    expect(html).toContain('href="/"')
    expect(html).toContain('href="/features"')
  })

  test('the deepest crumb is the current page and is not a link', async () => {
    const { html } = await renderTrail()
    expect(html).toMatch(/aria-current="page">\s*Capture\s*<\/span>/)
    // `url` is only for the page's own BreadcrumbList JSON-LD; the component
    // reads `href`, so an absolute URL must never become a crumb link.
    expect(html).not.toContain('https://loghq.org')
  })

  test('the container classes this app owns survive onto the nav', () => {
    /*
     * public/marketing.css owns the width (`shell`), the 28px of top padding
     * and the flex row (`subnav`), and all 22 pages that include this partial
     * extend the marketing layout, so that file is always linked. className is
     * the only way those reach the component's nav.
     */
    const source = readFileSync(partialPath, 'utf8')
    expect(source).toContain('className="shell subnav"')
  })

  test('separators are decorative and the anchors stay router-intercepted', async () => {
    const { html } = await renderTrail()
    expect((html.match(/aria-hidden="true"/g) ?? []).length).toBe(2)
    expect((html.match(/data-stx-link/g) ?? []).length).toBe(2)
  })
})
