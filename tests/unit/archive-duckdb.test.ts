/**
 * The DuckDB runner's non-IO surface: credential handling and readiness.
 *
 * `redactScript` is the one that matters. Bucket credentials are written into
 * every script as a `CREATE SECRET` preamble, and the export path logs the
 * script when a partition fails. Without redaction the first failed nightly run
 * would put the object-store keys into the application log, where they would sit
 * for as long as logs are kept.
 */
import { describe, expect, test } from 'bun:test'
import { type ArchiveConfig, archiveReady } from '../../app/Archive/config'
import { duckdbBinary, parseResultSets, redactScript, s3Preamble } from '../../app/Archive/duckdb'

function cfg(overrides: Partial<ArchiveConfig> = {}): ArchiveConfig {
  return {
    enabled: true,
    endpoint: 'fsn1.your-objectstorage.com',
    region: 'auto',
    bucket: 'loghq-archive',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'sup3r-s3cret-value',
    useSsl: true,
    urlStyle: 'path',
    prefix: 'logs',
    hotWindowDays: 30,
    deleteAfterVerify: true,
    freePruneGraceDays: 7,
    duckdbPath: '',
    duckdbExtensionDir: '',
    exportTimeoutMs: 300000,
    queryTimeoutMs: 15000,
    maxFilesPerQuery: 62,
    ...overrides,
  }
}

describe('s3Preamble', () => {
  test('loads httpfs without trying to install it', () => {
    // The pantry recipe compiles httpfs in. An INSTALL would turn every query
    // into a download attempt against a box that may have no egress.
    const sql = s3Preamble(cfg())
    expect(sql).toContain('LOAD httpfs;')
    expect(sql).not.toContain('INSTALL')
  })

  test('carries endpoint, url style and TLS, which is what makes it provider-agnostic', () => {
    const sql = s3Preamble(cfg())
    expect(sql).toContain('ENDPOINT \'fsn1.your-objectstorage.com\'')
    expect(sql).toContain('URL_STYLE \'path\'')
    expect(sql).toContain('USE_SSL true')
  })

  test('renders a plaintext-http endpoint for a local MinIO', () => {
    expect(s3Preamble(cfg({ useSsl: false, urlStyle: 'path' }))).toContain('USE_SSL false')
  })

  test('quotes credentials rather than interpolating them raw', () => {
    const sql = s3Preamble(cfg({ secretAccessKey: 'has\'quote' }))
    expect(sql).toContain('\'has\'\'quote\'')
  })

  test('replaces the secret on each run rather than erroring on the second', () => {
    expect(s3Preamble(cfg())).toContain('CREATE OR REPLACE SECRET')
  })

  test('leaves the extension directory alone when unset, as in development', () => {
    // The pantry build has httpfs compiled in, so there is nothing to point at.
    expect(s3Preamble(cfg())).not.toContain('extension_directory')
  })

  test('pins the extension directory when set, as in production', () => {
    // The default is per-user, and the deploy step that caches httpfs does not
    // necessarily run as the user the scheduler runs as.
    const sql = s3Preamble(cfg({ duckdbExtensionDir: '/usr/local/share/duckdb-extensions' }))
    expect(sql).toContain('SET extension_directory=\'/usr/local/share/duckdb-extensions\';')
    // Ordering matters: LOAD consults the directory that is already set.
    expect(sql.indexOf('extension_directory')).toBeLessThan(sql.indexOf('LOAD httpfs'))
  })

  test('never emits INSTALL, which would need egress at query time', () => {
    expect(s3Preamble(cfg({ duckdbExtensionDir: '/tmp/ext' }))).not.toContain('INSTALL')
  })

  // Regression. The preamble originally loaded only httpfs, and every export
  // died on `Table Function with name "read_json" is not in the catalog`,
  // because buildExportSql stages through read_json. It was invisible to the
  // rest of the suite: the builders produce the same string either way, so
  // nothing but a real duckdb could catch it. These two assertions are what
  // stands in for that binary in CI.
  test('loads both extensions the archive actually uses', () => {
    const sql = s3Preamble(cfg())
    // httpfs reaches s3:// URLs.
    expect(sql).toContain('LOAD httpfs;')
    // json provides read_json, which the export reads its staged NDJSON with.
    expect(sql).toContain('LOAD json;')
  })

  test('loads json before any statement that could use read_json', () => {
    const script = `${s3Preamble(cfg())}\nCOPY (SELECT * FROM read_json('/tmp/x.ndjson')) TO 's3://b/k.parquet';`
    expect(script.indexOf('LOAD json')).toBeLessThan(script.indexOf('read_json('))
  })
})

describe('redactScript', () => {
  test('removes the secret access key', () => {
    const out = redactScript(s3Preamble(cfg()))
    expect(out).not.toContain('sup3r-s3cret-value')
    expect(out).toContain('SECRET \'[redacted]\'')
  })

  test('removes the access key id', () => {
    const out = redactScript(s3Preamble(cfg()))
    expect(out).not.toContain('AKIAEXAMPLE')
    expect(out).toContain('KEY_ID \'[redacted]\'')
  })

  test('survives a credential containing a doubled quote', () => {
    const out = redactScript(s3Preamble(cfg({ secretAccessKey: 'a\'b' })))
    expect(out).not.toContain('a\'\'b')
    expect(out).toContain('[redacted]')
  })

  test('leaves the rest of the script readable, which is the point of logging it', () => {
    const script = `${s3Preamble(cfg())}\nSELECT count(*) FROM read_parquet('s3://loghq-archive/logs/x.parquet');`
    const out = redactScript(script)
    expect(out).toContain('read_parquet')
    expect(out).toContain('loghq-archive')
    expect(out).toContain('ENDPOINT \'fsn1.your-objectstorage.com\'')
  })
})

describe('duckdbBinary', () => {
  test('falls back to PATH resolution when unset', () => {
    expect(duckdbBinary({ duckdbPath: '' })).toBe('duckdb')
  })

  test('honours an absolute path, which is what systemd needs', () => {
    expect(duckdbBinary({ duckdbPath: '/usr/local/bin/duckdb' })).toBe('/usr/local/bin/duckdb')
  })

  test('ignores surrounding whitespace from a sloppy env value', () => {
    expect(duckdbBinary({ duckdbPath: '  ' })).toBe('duckdb')
  })
})

describe('archiveReady', () => {
  test('passes a fully configured archive', () => {
    expect(archiveReady(cfg())).toBeNull()
  })

  test('names the missing variable rather than failing vaguely', () => {
    expect(archiveReady(cfg({ bucket: '' }))).toContain('ARCHIVE_S3_BUCKET')
  })

  test('lists every missing variable at once', () => {
    const problem = archiveReady(cfg({ bucket: '', accessKeyId: '', secretAccessKey: '' }))
    expect(problem).toContain('ARCHIVE_S3_BUCKET')
    expect(problem).toContain('ARCHIVE_S3_ACCESS_KEY_ID')
    expect(problem).toContain('ARCHIVE_S3_SECRET_ACCESS_KEY')
  })

  test('does not leak the secret it is complaining about', () => {
    expect(archiveReady(cfg({ endpoint: '' }))).not.toContain('sup3r-s3cret-value')
  })
})

describe('parseResultSets', () => {
  // Regression, found by running the export against a real MinIO. Every script
  // carries the s3Preamble, and CREATE SECRET answers with its own result set,
  // so stdout is two arrays back to back. JSON.parse rejected the pair, so every
  // query "failed" while the Parquet it had just written was perfectly fine.
  test('reads the query result when the preamble printed one first', () => {
    const stdout = '[{"Success":true}]\n[{"n":5,"bytes":"923"}]'
    const sets = parseResultSets(stdout)
    expect(sets).toHaveLength(2)
    // The caller's query is last; that is the one that matters.
    expect(sets[sets.length - 1]).toEqual([{ n: 5, bytes: '923' }])
  })

  test('a single result set still works', () => {
    expect(parseResultSets('[{"a":1}]')).toEqual([[{ a: 1 }]])
  })

  test('an empty result set is preserved, not dropped', () => {
    const sets = parseResultSets('[{"Success":true}]\n[]')
    expect(sets[sets.length - 1]).toEqual([])
  })

  // Log messages are arbitrary text and routinely contain brackets and quotes.
  // A delimiter split would tear the set apart here; depth scanning does not.
  test('brackets inside a message do not end a result set early', () => {
    const stdout = '[{"Success":true}]\n[{"message":"array [0] failed ] oops","id":"a1"}]'
    const last = parseResultSets(stdout).at(-1)!
    expect(last).toHaveLength(1)
    expect((last[0] as any).message).toBe('array [0] failed ] oops')
  })

  test('an escaped quote before a bracket does not confuse the scanner', () => {
    const stdout = String.raw`[{"message":"he said \"] done\" then [","id":"a2"}]`
    const last = parseResultSets(stdout).at(-1)!
    expect((last[0] as any).message).toBe('he said "] done" then [')
  })

  test('returns nothing for output that holds no array', () => {
    expect(parseResultSets('some error text')).toEqual([])
  })
})
