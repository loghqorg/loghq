/**
 * Route Registry
 *
 * The key selects the route file; `prefix: ''` mounts it at the root. loghq's
 * ingest + stream APIs (`routes/logs.ts`) and auth endpoints (`routes/auth.ts`)
 * use absolute paths, so they mount at the root. `api`/`v1` keep the framework
 * defaults.
 *
 * @see https://docs.stacksjs.org/routing
 */
import type { RouteRegistry } from '@stacksjs/router'

export type { RouteDefinition, RouteRegistry } from '@stacksjs/router'

export default {
  api: 'api',
  v1: { path: 'v1', prefix: 'v1' },
  logs: { path: 'logs', prefix: '' },
  auth: { path: 'auth', prefix: '' },
} satisfies RouteRegistry
