import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import theme from '../../config/crosswind'
import { processComponents } from '../../node_modules/@stacksjs/stx/dist/component-renderer.js'
import { loadCssEngine } from '../../node_modules/@stacksjs/stx/dist/dev-server/ts-css.js'
import { mergeCssConfig } from '../../node_modules/@stacksjs/stx/dist/ts-css-config.js'

const root = resolve(import.meta.dir, '../..')

describe('shared auth submit controls', () => {
  for (const [page, labels] of [
    ['login', ['Sign in', 'Verify and sign in']],
    ['register', ['Create account']],
  ] as const) {
    test(`${page} renders real submit buttons with initial names and live parent bindings`, async () => {
      const file = resolve(root, `resources/views/${page}.stx`)
      const source = readFileSync(file, 'utf8')
      const controls = source.match(/<Button\b[^]*?<\/Button>/g) || []
      expect(controls).toHaveLength(labels.length)
      expect(source).not.toMatch(/<button\b[^>]*type="submit"/)

      for (const [index, control] of controls.entries()) {
        const dependencies = new Set<string>()
        const html = await processComponents(control, {
          __stx_client_signal_names: ['loading'],
          __importedComponents: new Map([['button', resolve(root, 'node_modules/@stacksjs/components/src/ui/button/Button.stx')]]),
        }, file, {
          componentsDir: resolve(root, 'resources/components'),
        }, dependencies)
        expect([...dependencies].some(path => path.endsWith('/Button.stx'))).toBe(true)
        expect(html).not.toContain('<Button')
        expect(html).not.toContain('[Component Error')
        expect(html).toContain('type="submit"')
        expect(html).toContain(labels[index])
        expect(html).toContain('auth-submit')
        expect(html).toContain('w-full')
        expect(html).toContain('text-sm')
        expect(html).toContain('data-stx-parent-bindings')
        expect(html).toContain('loading()')
        // A label binding belongs to Button, not :text on its root, which
        // would destroy its accessible slot and internal state elements.
        expect(control).toContain(':label=')
        expect(control).toContain(':disabled="loading()"')
        expect(control).not.toContain(':text=')
      }
    })
  }

  test('the auth sizing and appearance overrides compile with explicit precedence', async () => {
    const engine = await loadCssEngine()
    if (!engine) throw new Error('The installed STX CSS engine is required')
    const generator = new engine.CSSGenerator(mergeCssConfig(engine.defaultConfig || engine.config, theme).config)
    generator.generate('auth-submit')
    const css = generator.toCSS(false, false)
    expect(css).toContain('.auth-submit')
    expect(css).toContain('!important')
    expect(css).toContain('0.625rem')
    expect(css).toContain('color-mix(in srgb,var(--accent) 88%,#000)')
    expect(css).toContain('opacity: 0.6 !important')
    expect(css).toContain('cursor: default !important')
  })
})
