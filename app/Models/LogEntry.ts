import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A single captured log entry - the unit of the loghq stream.
 *
 * Unlike an error tracker, loghq does NOT group entries: the stream is a flat,
 * time-ordered sequence you filter (by level/channel/environment) and search,
 * so there is no `issue_id`/`fingerprint` rollup here. `context`/`sdk`/
 * `user_context` hold the rich JSON blobs the SDK ships; the free-text
 * `message` is widened to the varchar cap so nothing truncates at storage.
 */
export default defineModel({
  name: 'LogEntry',
  table: 'log_entries',
  primaryKey: 'id',

  traits: {
    useTimestamps: true,
  },

  belongsTo: ['Project'],

  indexes: [
    // The stream query: newest-first within a project.
    { name: 'le_project_timestamp', columns: ['project_id', 'timestamp'] },
    // Level facet within a project (filter to warnings+, errors, …).
    { name: 'le_project_level', columns: ['project_id', 'level'] },
  ],

  attributes: {
    id: { fillable: true, validation: { rule: schema.string().required() } },
    project_id: { fillable: true, validation: { rule: schema.string().required() } },
    // One of the eight PSR-3 / RFC 5424 severities.
    level: { fillable: true, validation: { rule: schema.string().optional() }, factory: () => 'info' },
    // Widened to the Postgres varchar cap so long log lines persist untruncated.
    message: { fillable: true, validation: { rule: schema.string().required().max(10485760) } },
    // Source/logger name (e.g. `laravel`, `queue`, `billing`).
    channel: { fillable: true, validation: { rule: schema.string().optional() } },
    // Arbitrary structured context, JSON-encoded.
    context: { fillable: true, validation: { rule: schema.string().max(10485760).optional() } },
    environment: { fillable: true, validation: { rule: schema.string().optional() }, factory: () => 'production' },
    release: { fillable: true, validation: { rule: schema.string().optional() } },
    framework: { fillable: true, validation: { rule: schema.string().optional() } },
    // Reporting host/machine name.
    host: { fillable: true, validation: { rule: schema.string().optional() } },
    // `{ name, version }` of the SDK that sent this, JSON-encoded.
    sdk: { fillable: true, validation: { rule: schema.string().max(4096).optional() } },
    // Authenticated user `{ id, email }` if the SDK attached one, JSON-encoded.
    user_context: { fillable: true, validation: { rule: schema.string().max(10485760).optional() } },
    // Client-supplied ISO-8601 timestamp of the log event.
    timestamp: { fillable: true, validation: { rule: schema.string().required() } },
  },
})
