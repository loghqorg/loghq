import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Someone who asked to hear when loghq is ready.
 *
 * The marketing site is reachable before the product is announced, so a visitor
 * who finds it early has somewhere to leave an address instead of bouncing.
 * That is the whole scope: an address, where it came from, and when.
 *
 * No `useApi`: the only writer is the rate-limited `/api/subscribe` route, and
 * a public CRUD surface over a list of email addresses is a harvesting target.
 * Reads happen through the console.
 *
 * `email` is unique so a double submit is idempotent rather than a duplicate
 * row, which also lets the route answer the same way whether or not the address
 * was already known. Telling a stranger "you are already on this list" reveals
 * whether an address exists, the same enumeration leak `/password/forgot`
 * avoids.
 */
export default defineModel({
  name: 'Subscriber',
  table: 'subscribers',
  primaryKey: 'id',

  traits: {
    useTimestamps: true,
  },

  indexes: [
    { name: 'subscribers_email', columns: ['email'], unique: true },
  ],

  attributes: {
    id: { fillable: true, validation: { rule: schema.string().required() } },
    email: { fillable: true, validation: { rule: schema.string().email().required() } },
    /** Where on the site the address came from, so a later form is attributable. */
    source: { fillable: true, validation: { rule: schema.string() } },
  },
})
