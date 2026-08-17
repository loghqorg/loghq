import { response, route } from '@stacksjs/router'

/**
 * This file is the entry point for your application's API routes.
 * The routes defined here are automatically registered. Last but
 * not least, you may also create any other `routes/*.ts` files.
 *
 * Framework routes (auth, dashboard, commerce, CMS, etc.) are loaded
 * automatically from storage/framework/defaults/routes/dashboard.ts.
 * You do NOT need to define them here — only add your own custom routes.
 *
 * @see https://docs.stacksjs.com/routing
 */

// Your custom routes go here:
route.get('/', () => response.text('hello world'))

// `/coming-soon` is served as an STX view from
// `storage/framework/defaults/resources/views/coming-soon.stx`. The
// view auto-resolves through stx-serve, so no route registration is
// needed here. To activate the holding page across the whole app:
//
//   ./buddy coming-soon [--secret=my-magic-token]
//
// Launch the site with `./buddy launch`. Maintenance mode (503 page,
// distinct cookie + state file) is the separate `./buddy down` /
// `./buddy up` pair.


/**
 * Newsletter signup, re-registered here because the framework's own
 * registration does not take effect in this app.
 *
 * `storage/framework/defaults/routes/dashboard.ts:91` declares
 * `POST /api/email/subscribe -> Actions/SubscriberEmailAction`, but the route
 * is absent from `./buddy route:list` and answers 404, so the marketing form
 * had nowhere to post. Same shape as the auth routes above: user route files
 * load before the framework defaults, so this wins.
 *
 * Points at the framework ACTION rather than a hand-rolled handler. That action
 * owns the `Subscriber` model, its unique-email constraint, and the unsubscribe
 * token the footer link needs; a second writer to the same table would have
 * none of that, and my first attempt at one would have dropped the table's
 * `status` and `unsubscribed_at` columns.
 *
 * Path is `/email/subscribe`: every route in this file is auto-prefixed `/api`.
 */
route.post('/email/subscribe', 'Actions/SubscriberEmailAction').skipCsrf().rateLimit(5, 'minute')
