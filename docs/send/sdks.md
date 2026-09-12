---
title: Stacks, PHP, and Laravel SDKs
description: Connect supported application runtimes to LogHQ.
---

# Stacks, PHP, and Laravel SDKs

## Stacks

```bash
bun add @loghq/stacks
```

```ts
import { loghqTransport } from '@loghq/stacks'
import { storagePath } from '@stacksjs/path'

export default {
  logsPath: storagePath('logs/stacks.log'),
  deploymentsPath: storagePath('logs/deployments.log'),
  transports: [loghqTransport({
    key: process.env.LOGHQ_KEY,
    environment: process.env.APP_ENV,
    release: process.env.APP_VERSION,
  })],
}
```

Existing `log.info()`, `log.warn()`, and `log.error()` calls retain local output and also enter LogHQ. Stacks request context supplies trace and request identifiers.

## PHP

```bash
composer require loghq/loghq
```

```php
use LogHQ\LogHQ;

LogHQ::init(['key' => getenv('LOGHQ_KEY')]);
LogHQ::info('order placed', ['order_id' => 42]);
LogHQ::error('payment failed', ['exception' => $exception]);
```

The PHP client requires PHP 8.4 or newer with cURL and JSON extensions.

## Laravel

Install `loghq/loghq-laravel` and configure its `loghq` channel. Existing `Log::info()` calls then use the shared PHP client without call-site changes.

## Reliability controls

SDKs buffer entries, cap their queues, retry temporary failures, honor `Retry-After`, and stop retrying permanent authentication failures. Set `host` only for a self-hosted LogHQ installation.
