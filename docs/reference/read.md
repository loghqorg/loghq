---
title: Read API
description: Read a project's log stream from a server or a desktop app - paging back, reading forward, and following it live.
---

# Read API

How a program reads logs: page back through history, read forward from a
cursor, or hold a live tail open. Implemented in
[`routes/logs.ts`](https://github.com/stacksjs/loghq/blob/main/routes/logs.ts),
[`app/Logs/query.ts`](https://github.com/stacksjs/loghq/blob/main/app/Logs/query.ts)
and [`app/Logs/tail.ts`](https://github.com/stacksjs/loghq/blob/main/app/Logs/tail.ts).

## Credentials

Every read endpoint takes one credential as `Authorization: Bearer <value>`.

| Credential | Shape | Reads | Issued from |
| --- | --- | --- | --- |
| Project read key | `lhq_read_` + 64 hex | One project | Project settings, or `POST /api/projects/{id}/read-key` |
| Read token | `lhq_user_` + 64 hex | Every project its owner can see | Account page, or `POST /api/read-tokens` |
| Session | cookie or account bearer | Every project the person can see | Signing in |

A **read key** belongs to a project and has no person behind it. Use it for a
server that reads one project.

A **read token** belongs to a person. Use it for an app that follows several
projects: it reads whatever its owner can read at the moment of each request,
so joining a project extends it and leaving one narrows it, with nothing to
reissue. It only reads. It cannot create, change or delete anything, and it
cannot list, mint or revoke read tokens.

Both are secrets. Each is shown once when it is issued; LogHQ keeps only a hash
of a read token. Keep them in the operating system's keychain or a server's
secret store, never in a URL or a client bundle. Neither is accepted by
`POST /logs`.

A project the credential cannot read answers `404`, the same as one that does
not exist. A missing or unknown credential answers `401`.

CORS is open on the read endpoints and `Authorization` and `Last-Event-ID` are
allowed request headers, so a desktop app's webview can call them directly.

### Managing read tokens

These three need a signed-in session. A read token cannot call them.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/read-tokens` | List your tokens: `id`, `name`, `token_hint` (last four characters), `last_used_at`, `expires_at`, `created_at` |
| `POST` | `/api/read-tokens` | Issue one. Body: `{ "name": "Work laptop", "expires_in_days": 90 }`, both optional. The response carries `token`, once |
| `DELETE` | `/api/read-tokens/{id}` | Revoke one. It stops working on the next request, and an open tail ends within 30 seconds |

A person can hold 20 at a time. A token with no `expires_in_days` lasts until it
is revoked.

### Finding project ids

```
GET /api/projects
Authorization: Bearer lhq_user_...
```

Answers `{ "projects": [{ "id", "name", "platform", "is_active", ... }] }` for a
session or a read token. A project read key is not accepted here: it already
names its project.

## Filters

All three ways of reading take the same filters, as query parameters.

| Parameter | Matches |
| --- | --- |
| `level` | One severity, or several separated by commas: `level=error,critical` |
| `channel` | Exact channel name |
| `environment` | Exact environment name |
| `q` | Case-insensitive substring of the message, up to 200 characters |
| `trace` | Exact `trace_id` |
| `request` | Exact `request_id` |

## Page back through history

```
GET /api/projects/{projectId}/logs?limit=100&before=<nextCursor>
```

Newest first, ordered by the time the entry reports (`timestamp`). `limit` is
1 to 200 and defaults to 100.

```json
{
  "logs": [{ "id": "...", "level": "error", "message": "...", "channel": "queue",
             "environment": "production", "release": null, "framework": null, "host": "web-1",
             "timestamp": "2026-11-11T09:30:07.045Z", "created_at": "2026-11-11 09:30:07.112",
             "trace_id": null, "request_id": null }],
  "nextCursor": "2026-11-11T09:12:44.000Z",
  "nextAfter": "MjAyNi0xMS0xMSAwOTozMDowNy4xMTIK..."
}
```

Pass `nextCursor` back as `before` for the next older page; it is `null` when
there are no more. `nextAfter` is a forward cursor at the present: hand it to
`after` or to the tail to pick up everything that arrives from here on.

`context`, `sdk` and `user_context` are not in the stream. Fetch one entry in
full with `GET /api/logs/{logId}`.

## Read forward

```
GET /api/projects/{projectId}/logs?after=<cursor>&limit=200
```

Entries that **arrived** after the cursor, oldest first.

```json
{ "logs": [ ... ], "nextAfter": "<cursor>", "hasMore": false }
```

Call again with `nextAfter`. It is always present, including on an empty page,
so a poller never has to keep its own position. `hasMore` is `true` when the
page was full and there is more waiting.

Three things to know:

- **Order is arrival, not `timestamp`.** A batch that sat in a client's buffer
  for a minute lands with old timestamps. Reading forward by arrival delivers it
  once; reading forward by reported time would have passed it already. Sort by
  `timestamp` for display if you need to.
- **A cursor is opaque.** Do not build or parse one. Take it from `nextAfter` or
  from a tail event's `id`. An invalid cursor answers `400`. `after` and `before`
  cannot be combined.
- **It runs about a second behind.** A forward read stops 750 ms short of the
  present so that an entry still being stored is not skipped. An entry appears
  between 0.75 and roughly 2 seconds after it is ingested.

`nextAfter` from a history page and the first forward read can overlap by that
same fraction of a second. Entries have stable ids: drop any you already hold.

## Live tail

```
GET /api/projects/{projectId}/logs/tail
Authorization: Bearer lhq_user_...
Accept: text/event-stream
```

A [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
stream of the same entries the forward read returns, in the same order, with the
same filters.

```
retry: 2000

: connected

event: log
id: MjAyNi0xMS0xMSAwOTozMDowNy4xMTIK...
data: {"id":"...","level":"error","message":"...","timestamp":"...", ...}

: ping

event: end
data: {"reason":"max-duration"}
```

| Event | Meaning |
| --- | --- |
| `log` | One entry. `data` is the entry as JSON on one line; `id` is the cursor to resume after it |
| `end` | The server is closing the stream. `reason` is `max-duration`, `unauthorized` or `error` |
| comment (`: ping`) | Nothing new. Sent every 5 seconds so the connection is not closed as idle |

**Where it starts.** With no cursor, at the present: only entries that arrive
after you connect. With `?after=<cursor>`, after that cursor. With a
`Last-Event-ID` header, after that event, and the header wins over `after`.

**Reconnecting.** Keep the `id` of the last `log` event and send it as
`Last-Event-ID` when you reconnect. Nothing is lost or repeated across the gap.
A stream ends itself after 15 minutes (`max-duration`); reconnect the same way.
On `unauthorized`, stop: the credential was revoked or lost access to the
project. A browser `EventSource` does all of this by itself but cannot send an
`Authorization` header, so it only works with a signed-in session; programs
should read the response body of a `fetch`.

**Limits.** 25 open tails per project. Past that the request answers `429` with
`Retry-After`.

### From Bun or Node

```ts
const base = process.env.LOGHQ_BASE_URL ?? 'https://loghq.org'
let lastId = ''

async function follow(projectId: string, token: string, onLog: (entry: any) => void) {
  for (;;) {
    const res = await fetch(`${base}/api/projects/${projectId}/logs/tail?level=warning,error,critical`, {
      headers: { Authorization: `Bearer ${token}`, ...(lastId ? { 'Last-Event-ID': lastId } : {}) },
    })
    if (res.status === 401 || res.status === 404)
      throw new Error('not allowed to read this project')
    if (res.ok && res.body) {
      let buffer = ''
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buffer += chunk
        let end
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const fields = Object.fromEntries(buffer.slice(0, end).split('\n')
            .filter(line => !line.startsWith(':'))
            .map(line => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]))
          buffer = buffer.slice(end + 2)
          if (fields.event === 'log') {
            lastId = fields.id
            onLog(JSON.parse(fields.data))
          }
          else if (fields.event === 'end' && JSON.parse(fields.data).reason === 'unauthorized') {
            throw new Error('credential revoked')
          }
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}
```

## Client configuration

| Name | Holds |
| --- | --- |
| `LOGHQ_BASE_URL` | The LogHQ origin, for example `https://loghq.org` |
| `LOGHQ_READ_TOKEN` | A read token (`lhq_user_...`), for an app that follows several projects |
| `LOGHQ_READ_KEY` | A project read key (`lhq_read_...`), for a server that reads one |
| `LOGHQ_PROJECT` | The project id, when a read key is used |

These are conventions for clients, not something the server reads.
