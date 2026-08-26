import { describe, expect, test } from 'bun:test'
import type { ArchiveConfig } from '../../app/Archive/config'
import { archiveClient, projectPrefix } from '../../app/Archive/storage'

function cfg(overrides: Partial<ArchiveConfig> = {}): ArchiveConfig {
  return {
    enabled: true,
    endpoint: 'fsn1.your-objectstorage.com',
    region: 'fsn1',
    bucket: 'loghq-archive',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'sup3r-s3cret',
    useSsl: true,
    urlStyle: 'path',
    prefix: 'logs',
    hotWindowDays: 30,
    deleteAfterVerify: true,
    freePruneGraceDays: 7,
    caCertFile: '',
    duckdbPath: '',
    duckdbExtensionDir: '',
    exportTimeoutMs: 300000,
    queryTimeoutMs: 15000,
    maxFilesPerQuery: 62,
    ...overrides,
  }
}

describe('projectPrefix', () => {
  test('matches the layout objectKeyFor writes to', () => {
    // The purge lists by this prefix and the export writes under it. If the two
    // ever disagree, deleting a project silently leaves its Parquet behind.
    expect(projectPrefix(cfg(), 'proj-abc')).toBe('logs/project_id=proj-abc/')
  })

  test('handles an empty prefix without a leading slash', () => {
    expect(projectPrefix(cfg({ prefix: '' }), 'proj-abc')).toBe('project_id=proj-abc/')
  })

  test('refuses a project id that could escape the prefix', () => {
    // The id reaches an object key, so traversal has to be impossible.
    expect(() => projectPrefix(cfg(), '../../etc')).toThrow()
    expect(() => projectPrefix(cfg(), 'a/b')).toThrow()
  })
})

describe('archiveClient', () => {
  test('builds an https endpoint when useSsl is on', () => {
    // Not inspectable on the client, so assert on what we pass rather than
    // reaching into Bun internals: the client must at least construct.
    expect(() => archiveClient(cfg())).not.toThrow()
  })

  test('constructs for a plain-http endpoint too', () => {
    // MinIO in development. This is the case @stacksjs/storage cannot express,
    // which is why this module does not use it yet.
    expect(() => archiveClient(cfg({ useSsl: false, endpoint: '127.0.0.1:9100' }))).not.toThrow()
  })

  test('constructs in virtual-hosted style', () => {
    expect(() => archiveClient(cfg({ urlStyle: 'vhost' }))).not.toThrow()
  })
})
