import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A person's read token: reads every project they can see, changes nothing.
 *
 * Issued and revoked from the account page. What it is for and why only a hash
 * is kept are in app/Support/read-token.ts.
 */
export default defineModel({
  name: 'ReadToken',
  table: 'read_tokens',
  primaryKey: 'id',

  // No `useApi`: the generated CRUD is not scoped to the signed-in user. The
  // owner-scoped routes are in routes/projects.ts.
  traits: {
    useTimestamps: true,
  },

  belongsTo: ['User'],

  indexes: [
    { name: 'read_tokens_token_hash_unique', columns: ['token_hash'], unique: true },
    { name: 'read_tokens_user', columns: ['user_id'] },
  ],

  attributes: {
    id: { fillable: true, validation: { rule: schema.string().required() } },
    user_id: { fillable: true, validation: { rule: schema.number().required() } },
    name: { fillable: true, validation: { rule: schema.string().required().max(80) } },
    // SHA-256 of the token, hex. The token itself is shown once and never stored.
    token_hash: { fillable: false, validation: { rule: schema.string().required().max(64) } },
    // Last four characters of the token, so a list can tell two apart.
    token_hint: { fillable: false, validation: { rule: schema.string().optional().max(8) } },
    last_used_at: { fillable: false, validation: { rule: schema.string().optional() } },
    expires_at: { fillable: false, validation: { rule: schema.string().optional() } },
  },
})
