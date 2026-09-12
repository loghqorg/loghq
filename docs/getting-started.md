---
title: Quick start
description: Create a LogHQ project, send a first entry, and verify it in the stream.
---

# Quick start

## 1. Create a project

Create an account at [loghq.org](https://loghq.org), add a project, and copy its `loghq_` ingest key. The key identifies a destination, can be revoked, and cannot read logs.

## 2. Send one entry

```bash
curl -X POST https://loghq.org/logs \
  -H 'Content-Type: application/json' \
  -H 'X-LogHQ-Key: loghq_your_project_key' \
  -d '{"message":"checkout started","level":"info","channel":"billing","environment":"production"}'
```

A successful request returns status `201` with `stored`, `dropped`, and `skipped` counts. Check all three.

## 3. Open the stream

Select the project in the dashboard. Filter by `channel=billing` or search for `checkout started`.

## 4. Add an SDK

Use [Stacks, PHP, or Laravel](/send/sdks) for batching, retries, context handling, and shutdown flushing. Any platform with HTTP can use the [wire contract](/reference/ingest).
