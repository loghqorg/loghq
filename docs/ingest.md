# Log ingest API

The wire contract for `POST /logs`. This is the spec an SDK implements — it is
deliberately independent of any particular client, so you can send logs from a
language loghq has no SDK for with nothing but an HTTP client.

Implemented in [`routes/logs.ts`](../routes/logs.ts); per-field shaping rules
live in [`app/Logs/normalize.ts`](../app/Logs/normalize.ts).

## Endpoint

```
POST /logs
Content-Type: application/json
X-LogHQ-Key: loghq_<64 hex>
```

The ingest key is **public by design** — it ships inside client bundles, DSN
style. It identifies a project and is revocable and rotatable; it is not a
secret and grants no read access. Rotate with
`POST /api/projects/{id}/rotate-key`.

CORS is open (`Access-Control-Allow-Origin: *`) and `OPTIONS /logs` is handled,
so browsers can post cross-origin. The route is CSRF-exempt.

### Alternatives to the header

The key may also be sent as `key` in the body. A body `project` (or `p`) field
selects the project by id instead — but the key is still validated against that
project, so this is only a convenience, never a way to skip authentication.

## Request body

Either a batch:

```json
{
  "logs": [
    { "message": "checkout started", "level": "info" },
    { "message": "gateway timeout", "level": "error" }
  ]
}
```

…or a single bare entry (any object carrying a `message`):

```json
{ "message": "checkout started", "level": "info" }
```

A body with neither `logs[]` nor a top-level `message` is a `400`.

### Entry fields

| Field | Type | Default | Stored as | Notes |
|---|---|---|---|---|
| `message` | string | — | `text` | **Required.** Non-strings are coerced. Clipped to 16 KiB with a `…[truncated]` marker |
| `level` | string | `info` | `varchar(255)` | One of the eight RFC 5424 severities below. Anything else silently becomes `info` |
| `channel` | string | `null` | `varchar(255)` | Source/logger name — `queue`, `billing`, `http` |
| `context` | object | `null` | JSON text | Arbitrary structured data. Capped at 96 KiB |
| `environment` | string | `production` | `varchar(255)` | |
| `release` | string | `null` | `varchar(255)` | Version/commit the entry came from |
| `framework` | string | `null` | `varchar(255)` | |
| `host` | string | `null` | `varchar(255)` | Reporting machine |
| `sdk` | object | `null` | JSON text | `{ name, version }`. Capped at 4 KiB |
| `user` | object | `null` | JSON text | Authenticated user, e.g. `{ id, email }`. Also read from `context.user` |
| `timestamp` | string | server receive time | `varchar(255)` | ISO-8601. Client-supplied values are kept as sent, including skewed ones |
| `trace_id` | string | `null` | `varchar(64)` | Distributed trace id. Also accepted as `traceId` |
| `request_id` | string | `null` | `varchar(64)` | Single inbound request. Also accepted as `requestId` |

Unknown fields are ignored. A per-entry `key` or `project` inside a batch is
ignored — the whole batch is attributed to the project the request authenticated
as.

### Levels

```
debug  info  notice  warning  error  critical  alert  emergency
```

Ordered least to most severe (RFC 5424 / PSR-3). There is no `trace` and no
`success`; both fall back to `info`. If you are bridging from a logger with a
different set, map before sending and keep the original in `context` so nothing
is lost.

### Correlation ids

`trace_id` and `request_id` are **join keys, not grouping keys** — loghq stores
a flat stream and never collapses entries. They exist so a single line can be
expanded into everything that happened around it:

```
GET /api/projects/{id}/logs?trace=<trace_id>
GET /api/projects/{id}/logs?request=<request_id>
```

Both are indexed per project. Use the 32-hex `trace-id` from a W3C
`traceparent` header when you have one, so traces line up with other
OpenTelemetry-aware tools.

Anything longer than 64 characters is truncated, not rejected — these arrive
over public ingest and are treated as untrusted display data.

## Limits

| Limit | Value | Behavior when exceeded |
|---|---|---|
| Request body | 512 KiB | `413 payload too large` |
| Entries per request | 500 | Extras counted in `dropped`, never stored |
| `message` | 16 KiB | Clipped with `…[truncated]` |
| `context` / `user` | 96 KiB | Replaced with `{"_truncated":"oversized context dropped"}` |
| `sdk` | 4 KiB | Same replacement |
| varchar fields | 255 (64 for correlation ids) | Truncated with a trailing `…` |
| Per project | 2000 entries / 10s | `429` + `Retry-After` |
| Per client IP | 4000 requests / 10s | `429` + `Retry-After` |

Quotas are fixed windows, shared across app instances when Redis is configured
and per-process otherwise (see [`app/Errors/limits.ts`](../app/Errors/limits.ts)).
The project quota is charged per *entry*, so one fat batch cannot dodge it.

## Responses

### `201` — accepted

```json
{ "ok": true, "stored": 498, "dropped": 0, "skipped": 2 }
```

| Field | Meaning |
|---|---|
| `stored` | Rows written |
| `dropped` | Entries past the 500 cap — **never examined**. Resend them |
| `skipped` | Entries examined and rejected as unusable (null, or no `message`). Resending will not help; fix the payload |

`stored + dropped + skipped` equals the number of entries you sent. **Check
these.** A `201` does not mean everything landed, and this is the only signal
that some of it did not.

### Errors

| Status | Body | Retry? |
|---|---|---|
| `400` | `{"error":"no log entries"}` | No — malformed payload |
| `401` | `{"error":"invalid ingest key"}` | **No — stop permanently.** Retrying a bad key is a self-inflicted flood |
| `403` | `{"error":"project inactive"}` / `{"error":"project has no ingest key"}` | No — the project is archived or has no key |
| `404` | `{"error":"unknown project"}` | No |
| `413` | `{"error":"payload too large"}` | Only after splitting the batch |
| `429` | `{"error":"rate limited"}` | Yes — **honor `Retry-After` (seconds)** |
| `5xx` | — | Yes, with exponential backoff |

## Client guidance

An SDK implementing this should:

- **Batch.** Flush on a size threshold well under 500, or a short interval.
- **Honor `Retry-After` on 429.** It is always sent.
- **Stop permanently on 401/403/404.** These never become success by retrying.
- **Split on 413**, and drop a single entry that still fails alone.
- **Clip client-side** to the limits above, so the server is not silently
  truncating data you could have summarized better.
- **Reconcile `stored`/`dropped`/`skipped`** and surface a warning locally.
- **Never let transport failures re-enter your own logger** — that recurses.
- **Send `sdk: { name, version }`.** It is the only version signal loghq gets,
  and the only way to attribute a bad payload shape to a client release.

## Example

```bash
curl -X POST https://loghq.org/logs \
  -H 'Content-Type: application/json' \
  -H 'X-LogHQ-Key: loghq_…' \
  -d '{
    "logs": [{
      "message": "payment gateway timeout",
      "level": "error",
      "channel": "billing",
      "environment": "production",
      "release": "a1b2c3d",
      "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
      "context": { "provider": "stripe", "attempt": 3 },
      "user": { "id": 8821 },
      "sdk": { "name": "curl", "version": "8.4.0" },
      "timestamp": "2026-07-30T01:15:00.000Z"
    }]
  }'
```

## Reading logs back

Dashboard endpoints, bearer-token authenticated (not the ingest key):

```
GET /api/projects/{projectId}/logs?level=&channel=&environment=&q=&trace=&request=&before=&limit=
GET /api/logs/{logId}
```

`level` accepts a comma-separated set. `before` is a keyset cursor — pass the
`nextCursor` from the previous page. `limit` is capped at 200, default 100.
Results are newest-first by `timestamp`.
