#!/usr/bin/env bun
/**
 * Enforce chapter 11 — styling.
 *
 * The conversion that emptied every `<style>` block out of resources/ took a
 * long time and broke things twice on the way. Nothing in the toolchain would
 * have caught either break, so the two failures are checks here.
 *
 * WHAT THIS EXISTS TO CATCH, both learned the hard way:
 *
 * 1. A Crosswind shortcut silently reshaping an existing component. `shortcuts`
 *    are global the moment they are defined, and the generated sheet is emitted
 *    AFTER public/*.css, so a shortcut named for a class that already exists in
 *    a stylesheet wins every specificity tie. Naming one `btn` painted every
 *    ghost button on /pricing and /account accent-red; naming one `panel`
 *    reshaped every marketing panel from a 14px radius to 12px. Neither raised
 *    an error, a warning, or a failing test — the second was visible only as a
 *    92-byte screenshot difference.
 *
 * 2. A `<style>` block creeping back into a .stx file. Beyond being invisible
 *    to the extractor, the SPA router destroys every <head> style that is not
 *    the Crosswind tag, so a page style block behaves differently on a fresh
 *    load than after a client-side navigation.
 *
 * WHAT IT DELIBERATELY DOES NOT FLAG
 *
 * Two kinds of inline `style=` are correct and are allowlisted by shape rather
 * than by file, so a new one still has to earn its place:
 *
 *   - a value interpolated per render (`style="width: {{ pct }}%"`), which is
 *     the case ch.11.5 exempts. It cannot become `:style`: that evaluates
 *     client-side against signals, and these read @foreach loop variables that
 *     exist only on the server.
 *   - `style="display:none"` on an element that also has `:show`. That is the
 *     server-rendered initial state the binding drives — when the expression
 *     turns true the runtime CLEARS the attribute rather than writing a
 *     display value, so a `hidden` class would outlive it and the element would
 *     never appear.
 *
 * resources/emails/ is exempt entirely: mail clients strip external CSS, so
 * inline styles are the only thing that renders.
 */
import { Glob } from 'bun'

const problems: string[] = []

// A template comment can legitimately contain the words `<style>` or a quoted
// style attribute while describing this very rule, so comments are stripped
// before anything is counted.
const STX_COMMENT = /\{\{--[\s\S]*?--\}\}/g

const stxFiles: string[] = []
for await (const f of new Glob('resources/**/*.stx').scan('.')) stxFiles.push(f)
stxFiles.sort()

for (const file of stxFiles) {
  const raw = await Bun.file(file).text()
  const src = raw.replace(STX_COMMENT, '')
  const isEmail = file.startsWith('resources/emails/')

  // ---- 1. no <style> blocks, anywhere ----------------------------------
  for (const m of src.matchAll(/<style[\s>]/g)) {
    const line = src.slice(0, m.index).split('\n').length
    problems.push(`${file}:${line}  <style> block — ch.11.1. Utilities, a shortcut in `
      + `config/crosswind.ts, or public/app-chrome.css if no utility can express it.`)
  }

  if (isEmail) continue

  // ---- 2. inline style= must be interpolated, or a :show initial state ---
  for (const m of src.matchAll(/(?<!:)\bstyle="([^"]*)"/g)) {
    const value = m[1]
    const line = src.slice(0, m.index).split('\n').length
    if (value.includes('{{')) continue // computed per render — ch.11.5 exemption

    // `display:none` is only legitimate as the initial state of a :show binding,
    // so look at the tag it sits on rather than trusting the value alone.
    if (/^display:\s*none;?$/.test(value.trim())) {
      const tagStart = src.lastIndexOf('<', m.index)
      const tagEnd = src.indexOf('>', m.index)
      const tag = src.slice(tagStart, tagEnd === -1 ? undefined : tagEnd)
      if (/:show\s*=/.test(tag)) continue
      problems.push(`${file}:${line}  style="display:none" without a :show on the same `
        + `element — use a \`hidden\` utility instead.`)
      continue
    }

    problems.push(`${file}:${line}  inline style="${value.slice(0, 48)}" — ch.11.5. `
      + `Only a per-render computed value may be inline.`)
  }
}

// ---- 3. no shortcut may collide with a class in public/*.css ------------
// This is the check that would have caught both regressions.
const config = await Bun.file('config/crosswind.ts').text()
const shortcutBlock = config.match(/shortcuts:\s*\{([\s\S]*?)\n\s{2}\},/)?.[1] ?? ''
const shortcutNames = [...shortcutBlock.matchAll(/^\s*'([a-z0-9-]+)':/gm)].map(m => m[1])

if (!shortcutNames.length)
  problems.push('config/crosswind.ts  could not parse any shortcut names — this check is blind.')

const sheets: string[] = []
for await (const f of new Glob('public/*.css').scan('.')) sheets.push(f)

for (const sheet of sheets.sort()) {
  const css = (await Bun.file(sheet).text()).replace(/\/\*[\s\S]*?\*\//g, '') // drop comments
  for (const name of shortcutNames) {
    // Only a STANDALONE `.name { … }` is a collision — that is the one that
    // ties with the shortcut on specificity and beats it on source order.
    //
    // Qualified and compound selectors are intentional extensions and must not
    // be flagged: `select.app-panel` (0,1,1) and `.tgl[data-on='1']` outrank
    // the shortcut on purpose, and `.theme-btn .ic-sun` styles a descendant
    // rather than redefining the class. So the class has to be the complete
    // selector — preceded by the start of a rule or a comma, and followed by
    // a comma or the opening brace.
    const re = new RegExp(`(^|[,}])\\s*\\.${name}\\s*(?=[,{])`, 'm')
    if (re.test(css)) {
      problems.push(`config/crosswind.ts  shortcut '${name}' collides with .${name} in ${sheet}. `
        + `The Crosswind sheet is emitted after public/*.css, so the shortcut wins every tie `
        + `and silently restyles that component. Rename the shortcut.`)
    }
  }
}

for (const p of problems) console.error(`  ✗ ${p}`)

if (!problems.length) {
  console.error(`styles ok — 0 <style> blocks, inline styles all interpolated or :show `
    + `initial state, ${shortcutNames.length} shortcuts with no stylesheet collision`)
}

process.exit(problems.length ? 1 : 0)
