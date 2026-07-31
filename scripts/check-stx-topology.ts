#!/usr/bin/env bun
/**
 * stx topology gate.
 *
 * config/ui.ts is read by two loaders with different semantics, and a relative
 * directory value cannot satisfy both unless `root` is '.':
 *
 *   A. @stacksjs/stx loadStxConfig()  — applies resolveStxRoot (config.js:363-374)
 *      and prefixes partialsDir/componentsDir/layoutsDir with `root`
 *      (config.js:411-419). Used by `stx build`, the SSG, production-builder,
 *      store-loader and Crosswind config discovery.
 *   B. raw bunfig load in bun-plugin-stx serve() (serve.js:8912-8919) — no root
 *      prefixing at all. Used by the dev server and `buddy serve`.
 *
 * When the two disagree, the failure is silent: @include resolves against a
 * path that does not exist and the *error string*, including an absolute
 * filesystem path, is rendered into the page body as content.
 *
 * This script fails if the loaders disagree, if any resolved path is missing,
 * or if a non-page directory has been parked inside pagesDir — where the SSG
 * (ssg.d.ts:24-43) and the route-type codegen (stx-router codegen.js:3-22)
 * would build it to HTML and list it in the sitemap.
 */
import fs from 'node:fs'
import path from 'node:path'

const KEYS = ['componentsDir', 'layoutsDir', 'partialsDir'] as const

// Read loader B first and COPY the values out. loadStxConfig mutates the object
// bunfig caches, so reading raw[k] afterwards silently reports loader A's
// already-prefixed value and the comparison below always passes.
const { loadConfig } = await import('bunfig')
const raw: any = await loadConfig({
  name: 'stx',
  alias: ['ui'],
  cwd: process.cwd(),
  defaultConfig: {},
  checkEnv: false,
  verbose: false,
})
const served = Object.fromEntries(KEYS.map(k => [k, raw[k]])) as Record<string, string>

const { loadStxConfig } = await import('@stacksjs/stx')
const built: any = await loadStxConfig()

let bad = 0
const fail = (msg: string) => { console.error(`  ✗ ${msg}`); bad++ }

for (const k of KEYS) {
  if (served[k] !== built[k]) {
    fail(`${k}: serve sees ${JSON.stringify(served[k])}, build sees ${JSON.stringify(built[k])}`)
    continue
  }
  if (fs.existsSync(built[k]))
    continue

  // componentsDir is the one directory whose local absence is not fatal: the
  // serve path force-overrides it to the framework defaults tree
  // (@stacksjs/actions dev/views.js:71, @stacksjs/buddy production-server.js:121)
  // and options win at bun-plugin-stx serve.js:8935-8937, so nothing at runtime
  // reads the configured value. Only `stx build` and the SSG do. loghq currently
  // has no local components — the eleven that were here were unreferenced
  // template scaffolding — and git does not track empty directories, so
  // requiring it would fail on a fresh clone for no behavioural reason.
  if (k === 'componentsDir') {
    console.error(`  ! ${k} -> ${built[k]} does not exist (ok: always overridden on the serve path; only stx build reads it)`)
    continue
  }

  fail(`${k} -> ${built[k]} does not exist`)
}

const pages = path.resolve(built.root === '.' ? '.' : built.root, built.pagesDir)
if (!fs.existsSync(pages))
  fail(`pagesDir -> ${pages} does not exist`)

for (const d of ['layouts', 'components', 'partials', 'stores']) {
  if (fs.existsSync(path.join(pages, d)))
    fail(`${d}/ is inside pagesDir and is therefore routed, built and sitemapped`)
}

// storesDir is resolved against `root` by store-loader.js:11 — a different
// mechanism from the three keys above, and not part of the serve allow-list.
if (built.storesDir) {
  const stores = path.resolve(built.root || process.cwd(), built.storesDir)
  if (!fs.existsSync(stores))
    fail(`storesDir -> ${stores} does not exist`)
}

if (bad === 0)
  console.error(`stx topology ok — root=${JSON.stringify(built.root)} pagesDir=${JSON.stringify(built.pagesDir)}`)

process.exit(bad ? 1 : 0)
