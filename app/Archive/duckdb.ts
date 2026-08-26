/**
 * Driving the DuckDB CLI.
 *
 * DuckDB is a system binary here, installed through pantry (see config/deps.ts),
 * not an npm package. There is no native module to load and no server to
 * connect to: each query spawns `duckdb`, writes a script to its stdin, and
 * reads a JSON result back. That is slower per call than an embedded driver and
 * entirely fine for this workload, which is a nightly export plus the occasional
 * dashboard query, never the ingest path.
 *
 * Two conventions the rest of app/Archive/ relies on:
 *
 *   1. One result-producing statement per invocation. `-json` prints an array
 *      per result set, and concatenated arrays are not valid JSON, so anything
 *      that needs two result sets makes two calls (or, as in buildVerifySql,
 *      folds both into one row).
 *
 *   2. Credentials arrive in the script, never in argv or the child's
 *      environment. See s3Preamble.
 */

import { log } from '@stacksjs/logging'
import { type ArchiveConfig, archiveConfig } from './config'
import { sqlQuote } from './sql'

export interface DuckDbResult {
  ok: boolean
  rows: any[]
  stderr: string
  code: number
}

/** Where the duckdb binary lives. */
export function duckdbBinary(cfg?: Pick<ArchiveConfig, 'duckdbPath'>): string {
  const configured = (cfg ?? archiveConfig()).duckdbPath.trim()
  // PATH resolution is right for local development, where the buddy wrapper
  // prepends pantry/.bin. Under systemd the unit's PATH is not the operator's,
  // so production sets ARCHIVE_DUCKDB_PATH to an absolute path instead.
  return configured || 'duckdb'
}

/**
 * The `CREATE SECRET` preamble that teaches DuckDB how to reach the bucket.
 *
 * Credentials go here rather than into `S3_ACCESS_KEY_ID`-style environment
 * variables on the child process for three reasons. A secret carries the
 * endpoint, URL style, and TLS flag alongside the keys, which is what makes one
 * code path work against Hetzner Object Storage, R2, MinIO, and AWS. The env-var
 * route is a compatibility shim that covers those knobs inconsistently. And a
 * script on stdin never appears in `ps` output, where an argv would.
 *
 * Two extensions are loaded, and both are needed. httpfs reaches s3:// URLs.
 * json provides `read_json`, which the export reads its staged NDJSON with:
 * without it every export dies on `Table Function with name "read_json" is not
 * in the catalog`, which is exactly how this was found.
 *
 * Neither `LOAD` has a matching `INSTALL`. The extensions are cached once, into
 * the directory named by ARCHIVE_DUCKDB_EXTENSION_DIR: on the box by the deploy
 * step, in development by the setup in ARCHIVE-PLAN.md. An INSTALL here would
 * turn every query into a download attempt from a host that may have no egress,
 * and would fail closed on a slow or blocked network rather than working.
 *
 * The directory is set explicitly rather than left to default, because the
 * default is per-user (`~/.duckdb`) and the deploy step that populates it does
 * not run as the user the scheduler runs as.
 */
export function s3Preamble(cfg: ArchiveConfig): string {
  return [
    ...(cfg.duckdbExtensionDir ? [`SET extension_directory=${sqlQuote(cfg.duckdbExtensionDir)};`] : []),
    'LOAD httpfs;',
    'LOAD json;',
    'CREATE OR REPLACE SECRET loghq_archive (',
    '  TYPE s3,',
    `  KEY_ID ${sqlQuote(cfg.accessKeyId)},`,
    `  SECRET ${sqlQuote(cfg.secretAccessKey)},`,
    `  ENDPOINT ${sqlQuote(cfg.endpoint)},`,
    `  REGION ${sqlQuote(cfg.region)},`,
    `  URL_STYLE ${sqlQuote(cfg.urlStyle)},`,
    `  USE_SSL ${cfg.useSsl ? 'true' : 'false'}`,
    ');',
  ].join('\n')
}

/**
 * Strip secret material from a script so it can be logged.
 *
 * Every path that reports a DuckDB failure runs the script through this first.
 * Export errors are logged with context to be debuggable, and without this the
 * bucket credentials would land in the application log on the first failed
 * nightly run.
 */
export function redactScript(script: string): string {
  return script.replace(
    /(\b(?:KEY_ID|SECRET)\s+)'(?:[^']|'')*'/gi,
    (_match, keyword) => `${keyword}'[redacted]'`,
  )
}

/**
 * Run a script and return its rows.
 *
 * Never throws for a query failure: the caller decides whether an unreadable
 * partition is fatal (an export marks it failed and keeps the hot rows) or
 * merely empty (a dashboard falls back to hot-only numbers). It does throw if
 * the binary itself cannot be spawned, because that is a deployment fault
 * rather than a data one.
 */
export async function runDuckDb(script: string, opts: { timeoutMs: number, cfg?: ArchiveConfig }): Promise<DuckDbResult> {
  const bin = duckdbBinary(opts.cfg)

  const proc = Bun.spawn([bin, '-batch', '-json'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    // A minimal environment: nothing in the parent's env is meaningful to
    // duckdb, and passing it wholesale would hand the child every secret the
    // app holds for no reason.
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
  })

  proc.stdin.write(script)
  await proc.stdin.end()

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
    // SIGKILL if it ignores the polite request. A duckdb stuck on a slow S3
    // read would otherwise hold the scheduler for the whole job timeout.
    setTimeout(() => { try { proc.kill(9) } catch {} }, 5000)
  }, opts.timeoutMs)

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (timedOut)
      return { ok: false, rows: [], stderr: `timed out after ${opts.timeoutMs}ms`, code: code ?? -1 }

    if (code !== 0)
      return { ok: false, rows: [], stderr: stderr.trim(), code: code ?? -1 }

    const text = stdout.trim()
    if (!text)
      return { ok: true, rows: [], stderr: stderr.trim(), code: 0 }

    try {
      const parsed = JSON.parse(text)
      return { ok: true, rows: Array.isArray(parsed) ? parsed : [parsed], stderr: stderr.trim(), code: 0 }
    }
    catch {
      // Valid exit, unreadable output. Almost always the one-result-set
      // convention having been broken by a caller.
      return { ok: false, rows: [], stderr: `unparseable duckdb output: ${text.slice(0, 200)}`, code: 0 }
    }
  }
  finally {
    clearTimeout(timer)
  }
}

/** Run a script, logging and swallowing failure. Returns rows, empty when it did not work. */
export async function queryDuckDb(script: string, opts: { timeoutMs: number, cfg?: ArchiveConfig, context: string }): Promise<any[]> {
  const result = await runDuckDb(script, opts)
  if (!result.ok) {
    log.warn(`[archive] ${opts.context} failed: ${result.stderr}`)
    return []
  }
  return result.rows
}
