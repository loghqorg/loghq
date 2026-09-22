---
title: HTTP from any language
description: Send structured LogHQ entries without an SDK.
---

# HTTP from any language

Send one object or a `logs` array to `POST /logs`.

```json
{
  "logs": [{
    "message": "payment gateway timeout",
    "level": "error",
    "channel": "billing",
    "environment": "production",
    "release": "checkout@2.14.0",
    "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    "context": { "provider": "stripe", "attempt": 3 }
  }]
}
```

## Client responsibilities

- Batch below the 500-entry cap.
- Reconcile `stored`, `dropped`, and `skipped` after every `201`.
- Honor `Retry-After` on `429` and retry `5xx` with backoff.
- Split a batch after `413`.
- Stop permanently on `401`, `403`, or `404`.
- Never feed transport diagnostics back into the logger being transported.
- Send `sdk: { name, version }`.

The complete definition is the [ingest API contract](/reference/ingest).
