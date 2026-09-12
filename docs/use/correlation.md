---
title: Correlation
description: Connect LogHQ entries across a request or distributed trace.
---

# Correlation

Use `request_id` for lines produced while handling one inbound request. Use `trace_id` across service boundaries. When available, send the 32-character identifier from the W3C `traceparent` header.

```text
GET /api/projects/{projectId}/logs?request=REQUEST_ID
GET /api/projects/{projectId}/logs?trace=TRACE_ID
```

Both queries return ordinary entries in time order. Correlation does not merge or deduplicate records.

Keep order, job, and tenant identifiers in structured context. Do not put credentials or entire request bodies there. SDK redaction is a safety net, not a substitute for safe fields.

## Request identifiers

Generate one `request_id` at the first trusted application boundary and include it in every line produced while handling that request. Return it in an error response or support header when appropriate so a report from a user can be connected to the exact server activity.

```json
{
  "message": "Payment authorization started",
  "request_id": "req_01k4g7p8v2q3",
  "channel": "checkout"
}
```

Do not reuse one request id for scheduled jobs, retries, or later asynchronous work unless they are intentionally part of the same operation. Give each job execution its own request id and carry the originating id in structured context.

## Trace identifiers

Use `trace_id` when work crosses process or service boundaries. With W3C Trace Context, extract the 32-hex trace identifier from `traceparent` and propagate the complete header to the next service. LogHQ stores the identifier but does not create spans or calculate trace timing.

```json
{
  "message": "Inventory reservation failed",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "request_id": "req_01k4g7p8v2q3",
  "service": "inventory"
}
```

Both correlation columns accept at most 64 characters. Choose one canonical representation per application so equivalent ids do not differ by casing, prefixes, or punctuation.

## Investigation workflow

1. Find the first failing or user-reported line.
2. Filter by `request_id` to reconstruct the local request.
3. Filter by `trace_id` to follow the operation across services.
4. Sort by event timestamp and compare environment, release, host, channel, and structured context.
5. Confirm clock synchronization before interpreting very small ordering differences across machines.

Correlation fields remain ordinary stored columns when logs move to archive storage, so the same identifiers can be used for hot and archived searches.
