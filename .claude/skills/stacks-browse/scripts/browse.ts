#!/usr/bin/env bun
/**
 * Dependency-free headless browser driver for the /stacks-browse QA skill.
 *
 * No Playwright, no Puppeteer, no npm packages. It launches a Chromium-family
 * browser already on the machine and drives it over the Chrome DevTools
 * Protocol using only Bun's native `Bun.spawn`, `fetch`, and `WebSocket`.
 *
 * Commands:
 *   bun browse.ts navigate   <url>
 *   bun browse.ts screenshot <url> [--viewport WxH] [--full] [--element SEL] [--scale N] [--out PATH]
 *   bun browse.ts responsive <url> [--out-dir DIR]
 *   bun browse.ts monitor    <url> [--ms 5000]
 *   bun browse.ts snapshot   <url>
 *
 * Auth (any command, repeatable) — seeded before the document exists, so a page
 * that reads them during hydration sees them:
 *   --localstorage token=abc   --cookie loghq_token=abc
 *
 * Interaction (screenshot, repeatable, applied in order before capture) — proves
 * a directive-bound handler actually runs, not merely that it is in the markup:
 *   --fill "#dz-input=My Project"   --click ".dz-card .btn-danger"  [--settle 400]
 * Actions run in the order given on the command line, interleaved.
 *
 * Browser discovery order: $BROWSE_BROWSER → PATH (chromium, google-chrome, …)
 * → common macOS app bundles → a Playwright-cached chromium as last resort.
 */

import { spawn } from 'bun'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── Browser discovery ──────────────────────────────────────────────────────

function which(bin: string): string | null {
  try {
    const r = Bun.spawnSync(['which', bin])
    const out = r.stdout.toString().trim()
    return out && existsSync(out) ? out : null
  }
  catch {
    return null
  }
}

/** Ordered list of candidate browser binaries — validated lazily at launch. */
function collectCandidates(): string[] {
  const out: string[] = []
  const add = (p: string | null) => { if (p && existsSync(p) && !out.includes(p)) out.push(p) }

  if (process.env.BROWSE_BROWSER)
    add(process.env.BROWSE_BROWSER)

  for (const bin of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'brave-browser', 'microsoft-edge', 'chrome'])
    add(which(bin))

  for (const p of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ]) add(p)

  // Last resort: a Chromium that Playwright may have cached. We only borrow the
  // binary — we never import or require Playwright itself.
  const cacheRoot = join(process.env.HOME || '', 'Library/Caches/ms-playwright')
  if (existsSync(cacheRoot)) {
    try {
      const hit = Bun.spawnSync(['find', cacheRoot, '-maxdepth', '3', '-name', 'chrome-headless-shell', '-o', '-maxdepth', '3', '-name', 'Chromium'])
      for (const p of hit.stdout.toString().trim().split('\n').filter(Boolean)) add(p)
    }
    catch { /* ignore */ }
  }

  if (!out.length)
    throw new Error('No Chromium-family browser found. Install one (e.g. `brew install --cask chromium`) or set BROWSE_BROWSER=/path/to/chrome.')
  return out
}

/** A candidate is usable only if it actually runs — `--version` weeds out dead
 *  wrappers (e.g. a Homebrew shim pointing at an uninstalled .app). */
function runs(bin: string): boolean {
  try {
    const r = Bun.spawnSync([bin, '--version'], { stdout: 'pipe', stderr: 'pipe' })
    return r.exitCode === 0 && r.stdout.toString().trim().length > 0
  }
  catch {
    return false
  }
}

// ── Minimal CDP client over Bun's native WebSocket ──────────────────────────

interface CdpEvent { method: string, params: any }

export class Cdp {
  private ws: WebSocket
  private id = 0
  private pending = new Map<number, { resolve: (v: any) => void, reject: (e: any) => void }>()
  private listeners: ((e: CdpEvent) => void)[] = []

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev: any) => {
      const msg = JSON.parse(ev.data)
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      }
      else if (msg.method) {
        for (const l of this.listeners) l({ method: msg.method, params: msg.params })
      }
    })
  }

  static connect(wsUrl: string, timeoutMs = 10_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const t = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(t); resolve(new Cdp(ws)) })
      ws.addEventListener('error', e => { clearTimeout(t); reject(e) })
    })
  }

  send(method: string, params: Record<string, any> = {}): Promise<any> {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(fn: (e: CdpEvent) => void): void {
    this.listeners.push(fn)
  }

  waitFor(method: string, predicate: (p: any) => boolean = () => true, timeoutMs = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs)
      this.on(e => {
        if (e.method === method && predicate(e.params)) {
          clearTimeout(t)
          resolve(e.params)
        }
      })
    })
  }

  close(): void {
    try { this.ws.close() }
    catch { /* ignore */ }
  }
}

// ── Browser lifecycle ───────────────────────────────────────────────────────

interface Session { proc: ReturnType<typeof spawn>, port: number, userDataDir: string, browser: string }

async function tryLaunch(browser: string): Promise<Session | null> {
  const userDataDir = join(tmpdir(), `stacks-browse-${process.pid}-${Math.floor(Number(process.hrtime.bigint() % 1000000n))}`)
  mkdirSync(userDataDir, { recursive: true })

  const isHeadlessShell = /chrome-headless-shell|headless_shell/.test(browser)
  const proc = spawn([
    browser,
    ...(isHeadlessShell ? [] : ['--headless=new']),
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-color-profile=srgb',
    'about:blank',
  ], { stdout: 'ignore', stderr: 'ignore' })

  // Chromium writes the chosen port to <user-data-dir>/DevToolsActivePort.
  const portFile = join(userDataDir, 'DevToolsActivePort')
  for (let i = 0; i < 80; i++) {
    if (existsSync(portFile)) {
      const line = readFileSync(portFile, 'utf8').split('\n')[0]?.trim()
      if (line)
        return { proc, port: Number(line), userDataDir, browser }
    }
    await Bun.sleep(50)
  }
  try { proc.kill() }
  catch { /* ignore */ }
  return null
}

export async function launch(): Promise<Session> {
  const tried: string[] = []
  for (const browser of collectCandidates()) {
    if (!runs(browser)) { tried.push(`${browser} (won't run)`); continue }
    const s = await tryLaunch(browser)
    if (s)
      return s
    tried.push(`${browser} (no DevTools port)`)
  }
  throw new Error(`Could not launch any browser. Tried:\n  ${tried.join('\n  ')}\nSet BROWSE_BROWSER=/path/to/chrome to override.`)
}

export async function openPage(port: number): Promise<Cdp> {
  // The initial about:blank tab already exists; grab its page-level WS URL.
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[]
      const page = list.find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl)
        return Cdp.connect(page.webSocketDebuggerUrl)
    }
    catch { /* not ready yet */ }
    await Bun.sleep(50)
  }
  throw new Error('Could not find a page target to attach to.')
}

export function kill(s: Session): void {
  try { s.proc.kill() }
  catch { /* ignore */ }
}

// ── Page helpers ────────────────────────────────────────────────────────────

interface PageState { consoleErrors: string[], console: string[], responses: { url: string, status: number, ms: number, type: string }[], mainStatus: number | null }

/** `k=v` pairs from a repeatable flag, e.g. --localstorage token=abc --localstorage user={...} */
function parsePairs(value: unknown): [string, string][] {
  const list = value == null ? [] : Array.isArray(value) ? value : [value]
  return list.flatMap((raw) => {
    const s = String(raw)
    const i = s.indexOf('=')
    return i === -1 ? [] : [[s.slice(0, i), s.slice(i + 1)] as [string, string]]
  })
}

async function gotoAndInstrument(cdp: Cdp, url: string, opts: { viewport?: { w: number, h: number }, scale?: number, timeoutMs?: number, localStorage?: [string, string][], cookies?: [string, string][] } = {}): Promise<PageState> {
  const state: PageState = { consoleErrors: [], console: [], responses: [], mainStatus: null }
  const startById = new Map<string, number>()

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Network.enable')

  // Seed auth BEFORE the document exists. An app that reads localStorage during
  // hydration has already read it by the time Runtime.evaluate could run, so
  // setting it after navigation is too late — the page renders logged-out and
  // the check silently measures the wrong state.
  //
  // Cookies and localStorage are seeded together on purpose: this app writes the
  // token to both (localStorage for client fetches, a mirrored cookie so
  // server-rendered pages authenticate). Seeding only one yields a page that
  // looks logged-out for reasons that read like a missing link rather than a
  // missing credential.
  if (opts.localStorage?.length) {
    const script = opts.localStorage
      .map(([k, v]) => `try{localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)})}catch(e){}`)
      .join('')
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script })
  }
  if (opts.cookies?.length) {
    const { host, protocol } = new URL(url)
    await cdp.send('Network.setCookies', {
      cookies: opts.cookies.map(([name, value]) => ({
        name,
        value,
        domain: host.split(':')[0],
        path: '/',
        secure: protocol === 'https:',
      })),
    })
  }

  if (opts.viewport) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: opts.viewport.w,
      height: opts.viewport.h,
      deviceScaleFactor: opts.scale ?? 1,
      mobile: opts.viewport.w < 600,
    })
  }

  cdp.on((e) => {
    if (e.method === 'Runtime.consoleAPICalled') {
      const text = (e.params.args || []).map((a: any) => a.value ?? a.description ?? a.type).join(' ')
      state.console.push(`[${e.params.type}] ${text}`)
      if (e.params.type === 'error') state.consoleErrors.push(text)
    }
    else if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails
      state.consoleErrors.push(d?.exception?.description || d?.text || 'Uncaught exception')
    }
    else if (e.method === 'Log.entryAdded' && e.params.entry?.level === 'error') {
      state.consoleErrors.push(e.params.entry.text)
    }
    else if (e.method === 'Network.requestWillBeSent') {
      startById.set(e.params.requestId, e.params.timestamp * 1000)
    }
    else if (e.method === 'Network.responseReceived') {
      const r = e.params.response
      const started = startById.get(e.params.requestId) ?? r.timing?.requestTime * 1000 ?? 0
      const ms = started ? Math.max(0, Math.round(e.params.timestamp * 1000 - started)) : 0
      state.responses.push({ url: r.url, status: r.status, ms, type: e.params.type })
      if (e.params.type === 'Document' && state.mainStatus == null)
        state.mainStatus = r.status
    }
  })

  await cdp.send('Page.navigate', { url })
  try { await cdp.waitFor('Page.loadEventFired', () => true, opts.timeoutMs ?? 15_000) }
  catch { /* SSE/long-poll pages may never fire load; proceed after a settle */ }
  await Bun.sleep(700)
  return state
}

async function title(cdp: Cdp): Promise<string> {
  const r = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
  return r.result?.value ?? ''
}

async function captureScreenshot(cdp: Cdp, opts: { full?: boolean, element?: string } = {}): Promise<Buffer> {
  let clip: any
  let captureBeyondViewport = false

  if (opts.element) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(opts.element)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height }; })()`,
      returnByValue: true,
    })
    if (!r.result?.value)
      throw new Error(`Element not found: ${opts.element}`)
    clip = { ...r.result.value, scale: 1 }
    captureBeyondViewport = true
  }
  else if (opts.full) {
    const m = await cdp.send('Page.getLayoutMetrics')
    const size = m.cssContentSize || m.contentSize
    clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
    captureBeyondViewport = true
  }

  const r = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport } : {}) })
  return Buffer.from(r.data, 'base64')
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseFlags(args: string[]): { positional: string[], flags: Record<string, string | boolean | string[]> } {
  const positional: string[] = []
  const flags: Record<string, string | boolean | string[]> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('--')) {
        // Repeats accumulate rather than overwrite, so `--localstorage a=1
        // --localstorage b=2` keeps both. Silently dropping the first would
        // seed half the credentials and render a page that looks logged-out.
        const prev = flags[key]
        if (prev === undefined) flags[key] = next
        else if (Array.isArray(prev)) prev.push(next)
        else flags[key] = [String(prev), next]
        i++
      }
      else { flags[key] = true }
    }
    else { positional.push(a) }
  }
  return { positional, flags }
}

const BREAKPOINTS = [
  { device: 'Mobile S', w: 320, h: 568 },
  { device: 'Mobile L', w: 428, h: 926 },
  { device: 'Tablet', w: 768, h: 1024 },
  { device: 'Desktop', w: 1280, h: 720 },
  { device: 'Wide', w: 1920, h: 1080 },
]

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { positional, flags } = parseFlags(rest)
  const url = positional[0]

  if (!command || command === 'help' || !url) {
    console.log('Usage: bun browse.ts <navigate|screenshot|responsive|monitor|snapshot> <url> [flags]')
    process.exit(url ? 0 : 1)
  }

  // Auth seeding is available to every command — a logged-out screenshot of an
  // auth-gated page is not a smaller result, it is a different page.
  const auth = { localStorage: parsePairs(flags.localstorage), cookies: parsePairs(flags.cookie) }

  const session = await launch()
  try {
    if (command === 'navigate' || command === 'go') {
      const cdp = await openPage(session.port)
      const t0 = performance.now()
      const state = await gotoAndInstrument(cdp, url, auth)
      const loadMs = Math.round(performance.now() - t0)
      console.log(JSON.stringify({
        browser: session.browser,
        url,
        title: await title(cdp),
        status: state.mainStatus,
        loadMs,
        consoleErrors: state.consoleErrors,
        requests: state.responses.length,
      }, null, 2))
      cdp.close()
    }

    else if (command === 'screenshot') {
      const cdp = await openPage(session.port)
      const vp = typeof flags.viewport === 'string' ? flags.viewport.split('x').map(Number) : [1280, 900]
      const scale = flags.scale ? Number(flags.scale) : 1
      const out = (flags.out as string) || `.stacks/shots/${new URL(url).pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}.png`
      mkdirSync(out.split('/').slice(0, -1).join('/') || '.', { recursive: true })
      await gotoAndInstrument(cdp, url, { viewport: { w: vp[0], h: vp[1] }, scale, ...auth })
      // --click fires real DOM clicks before capturing, so a handler bound by a
      // directive can be shown to RUN, not merely to be present in the markup.
      // Repeatable, applied in order. Missing selectors are reported rather than
      // ignored: a silent no-op would look identical to a handler that did
      // nothing, which is the failure this flag exists to catch.
      // Actions run in the ORDER GIVEN on the command line, interleaved. Grouping
      // all fills before all clicks looks equivalent but is not: opening a modal
      // often resets its own inputs, so a fill staged before that click is wiped
      // and the run silently exercises the empty-input path instead.
      const actions: { kind: 'click' | 'fill', sel: string, val?: string }[] = []
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]
        if (a !== '--click' && a !== '--fill') continue
        const raw = rest[i + 1]
        if (!raw || raw.startsWith('--')) continue
        if (a === '--click') { actions.push({ kind: 'click', sel: raw }) }
        else {
          const eq = raw.indexOf('=')
          if (eq !== -1) actions.push({ kind: 'fill', sel: raw.slice(0, eq), val: raw.slice(eq + 1) })
        }
      }
      const actionResults: { kind: string, selector: string, found: boolean }[] = []
      for (const act of actions) {
        const expr = act.kind === 'click'
          ? `(() => { const el = document.querySelector(${JSON.stringify(act.sel)}); if (!el) return false; el.click(); return true })()`
          : `(() => {
              const el = document.querySelector(${JSON.stringify(act.sel)}); if (!el) return false
              const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
              const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
              setter ? setter.call(el, ${JSON.stringify(act.val ?? '')}) : (el.value = ${JSON.stringify(act.val ?? '')})
              el.dispatchEvent(new Event('input', { bubbles: true }))
              el.dispatchEvent(new Event('change', { bubbles: true }))
              return true
            })()`
        const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
        actionResults.push({ kind: act.kind, selector: act.sel, found: r.result?.value === true })
        await Bun.sleep(Number(flags.settle) || 400)
      }
      const png = await captureScreenshot(cdp, { full: !!flags.full, element: flags.element as string | undefined })
      await Bun.write(out, png)
      console.log(JSON.stringify({ url, out, viewport: `${vp[0]}x${vp[1]}`, scale, full: !!flags.full, element: flags.element ?? null, ...(actionResults.length ? { actions: actionResults } : {}), bytes: png.length }, null, 2))
      cdp.close()
    }

    else if (command === 'responsive') {
      const outDir = (flags['out-dir'] as string) || '.stacks/shots/responsive'
      mkdirSync(outDir, { recursive: true })
      const results: any[] = []
      for (const bp of BREAKPOINTS) {
        const cdp = await openPage(session.port)
        await gotoAndInstrument(cdp, url, { viewport: { w: bp.w, h: bp.h } })
        const overflow = await cdp.send('Runtime.evaluate', {
          expression: 'document.documentElement.scrollWidth > window.innerWidth ? document.documentElement.scrollWidth - window.innerWidth : 0',
          returnByValue: true,
        })
        const out = join(outDir, `${bp.device.toLowerCase().replace(/\s+/g, '-')}.png`)
        await Bun.write(out, await captureScreenshot(cdp, { full: true }))
        results.push({ device: bp.device, viewport: `${bp.w}x${bp.h}`, out, horizontalOverflowPx: overflow.result?.value ?? 0 })
        cdp.close()
      }
      console.log(JSON.stringify({ url, results }, null, 2))
    }

    else if (command === 'monitor') {
      const cdp = await openPage(session.port)
      const ms = flags.ms ? Number(flags.ms) : 5000
      const state = await gotoAndInstrument(cdp, url)
      await Bun.sleep(ms)
      const failed = state.responses.filter(r => r.status >= 400)
      const slow = state.responses.filter(r => r.ms > 3000)
      console.log(JSON.stringify({
        url,
        consoleErrors: state.consoleErrors,
        consoleMessages: state.console,
        failedRequests: failed,
        slowRequests: slow,
        totalRequests: state.responses.length,
      }, null, 2))
      cdp.close()
    }

    else if (command === 'snapshot') {
      const cdp = await openPage(session.port)
      await gotoAndInstrument(cdp, url)
      const expr = `(() => {
        const sel = (q) => Array.from(document.querySelectorAll(q));
        const txt = (e) => (e.innerText || e.textContent || '').trim().slice(0, 80);
        return {
          title: document.title,
          headings: sel('h1,h2,h3').map(h => h.tagName + ': ' + txt(h)).slice(0, 40),
          links: sel('a[href]').map(a => txt(a) + ' -> ' + a.getAttribute('href')).slice(0, 60),
          buttons: sel('button, [role=button]').map(txt).filter(Boolean).slice(0, 40),
          forms: sel('form').map(f => ({ action: f.getAttribute('action'), fields: sel.call(null, 'input,select,textarea').length })).slice(0, 10),
          landmarks: sel('[role], nav, main, header, footer, aside').map(e => e.getAttribute('role') || e.tagName.toLowerCase()).slice(0, 20),
        };
      })()`
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
      console.log(JSON.stringify({ url, ...r.result?.value }, null, 2))
      cdp.close()
    }

    else {
      console.error(`Unknown command: ${command}`)
      process.exit(1)
    }
  }
  finally {
    kill(session)
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('browse error:', e?.message || e)
    process.exit(1)
  })
}
