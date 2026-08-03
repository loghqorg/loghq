#!/usr/bin/env bun
/**
 * Fail the build when a NEW file starts using a prohibited browser API.
 *
 * stx ships the rule set and the checker — PROHIBITED_DOM_PATTERNS and
 * validateClientScript — and config/ui.ts turns it on. What it does not ship is
 * a way to say "this one bootstrap file is allowed to touch the DOM directly".
 * `strict.failOnViolation` is all-or-nothing, and its escape hatch,
 * `allowPatterns`, matches on message substring and is RULE-global: allowing
 * the pre-paint guard's four rules would switch those rules off everywhere, so
 * the next accidental `location.replace` in a component would sail through.
 * That is the opposite of what turning the guard up is for.
 *
 * So the enforcement is per FILE rather than per rule. The allowlist below is
 * the complete set of files permitted to violate, each with the reason. Any
 * other file appearing in the report fails, and a file on the list that stops
 * violating fails too — a stale exemption is a lie about the code.
 */
import { Glob } from 'bun'

const { validateClientScript } = await import('@stacksjs/stx/script-validation') as {
  validateClientScript: (content: string, filePath: string, strict: unknown) => void
}

/**
 * Files allowed to use prohibited APIs, and why.
 *
 * Keep this at one entry. Guide ch.8.11: the point of collapsing the pre-paint
 * guards into a single partial is that the report names exactly one file, so a
 * second name is unambiguously a regression rather than one of five known
 * copies.
 */
const ALLOWED = new Map<string, string>([
  [
    'resources/partials/AuthGuard.stx',
    'Pre-paint auth bounce. Runs before the signals runtime exists, so no '
    + 'composable is reachable, and its whole job is to leave the page before '
    + 'it paints. Reads the session cookie and the server-rendered '
    + '#auth-pending marker directly.',
  ],
])

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
const violating = new Set<string>()

for await (const file of new Glob('resources/**/*.stx').scan('.')) {
  const src = await Bun.file(file).text()
  for (const m of src.matchAll(SCRIPT)) {
    if (/\bserver\b/i.test(m[1])) continue // server code has no DOM
    try {
      validateClientScript(m[2], file, { enabled: true, failOnViolation: true })
    }
    catch {
      violating.add(file)
    }
  }
}

const unexpected = [...violating].filter(f => !ALLOWED.has(f)).sort()
const stale = [...ALLOWED.keys()].filter(f => !violating.has(f)).sort()

for (const f of unexpected)
  console.error(`  ✗ ${f} uses a prohibited browser API and is not on the allowlist`)
for (const f of stale)
  console.error(`  ✗ ${f} is on the allowlist but no longer violates — remove the exemption`)

if (!unexpected.length && !stale.length)
  console.error(`dom guard ok — ${violating.size} allowed file(s), 0 unexpected`)

process.exit(unexpected.length || stale.length ? 1 : 0)
