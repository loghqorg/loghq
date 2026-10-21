/**
 * The account you sign in with locally, and the production owner bootstrap.
 *
 *   ./buddy seed --only-seeders OwnerSeeder --skip-models
 *
 * ## Why this file has to exist
 *
 * Model-factory seeding will not produce a usable sign-in, in two separate
 * ways. `User` is on @stacksjs/database's ACCOUNT_MODELS list, so the factory
 * pass leaves foreign keys that point at a user null rather than inventing an
 * owner; the framework's note on that list says which account owns a seeded
 * row is "a decision for the app that seeded it (a `demo:account` command, a
 * fixture, a migration), not something a factory should guess". And the
 * `useSeeder` trait on `User` writes rows whose emails come from
 * `faker.internet.email()` -- accounts nobody can sign in to, because the
 * addresses are unknowable. This file is that decision for LogHQ.
 *
 * ## What this app needs that the others do not
 *
 * LogHQ has no teams. A `teams` table exists from the framework's own
 * migrations, but it is empty and nothing reads it: there is no Team model,
 * no `team_members` table to join through, and app/Actions/Auth/
 * RegisterAction.ts says so in as many words -- "no teams model, so there is
 * no personal-team creation here". Tenancy is a `project` with an `owner_id`.
 * So the seeder makes a user and one project owned by it, which is what the
 * dashboard needs to render something other than an empty state.
 *
 * `project_members` is deliberately NOT written. It keys members by `email`
 * rather than `user_id` and exists for invitations; an owner is established
 * by `projects.owner_id`, exactly as routes/projects.ts does it when a
 * project is created through the UI.
 *
 * `newProjectId` and `newIngestKey` are imported from app/Support/projects
 * rather than reimplemented, so a seeded project is indistinguishable from
 * one created through the app -- same id shape, same key shape. A key
 * invented here in a different format would be accepted by the seeder and
 * then rejected by ingest, which is the sort of difference that only shows
 * up once an SDK is pointed at it.
 *
 * ## Credentials
 *
 * `LOGHQ_OWNER_EMAIL` / `LOGHQ_OWNER_PASSWORD` when set. A local environment
 * falls back to the constants below so that a fresh clone can sign in after
 * one `./buddy seed` with nothing to configure; every other environment must
 * supply the password, and production refuses to run without both. The
 * fallback is keyed on an explicit allowlist of APP_ENV values rather than
 * "not production", so a staging deploy that forgets to set them gets the
 * skip and not a published default password.
 */
import { db, Seeder } from '@stacksjs/database'
import { env } from '@stacksjs/env'
import { log } from '@stacksjs/logging'
import { makeHash, verifyHash } from '@stacksjs/security'
import { newIngestKey, newProjectId } from '../../app/Support/projects'

/**
 * The local fallback. `.localhost` is reserved by RFC 6761 and resolves
 * nowhere but this machine, so the address cannot be mistaken for a real
 * mailbox or receive a stray notification.
 */
const DEV_EMAIL = 'owner@loghq.localhost'
const DEV_PASSWORD = 'stacks-dev-only'
const DEV_NAME = 'LogHQ Owner'
const PROJECT_NAME = 'LogHQ'

/**
 * APP_ENV values that may use the fallback credentials above.
 *
 * `dev` is in here deliberately: config/env.ts types APP_ENV as the enum
 * local|dev|stage|prod, so `dev` is a value this app really takes even though
 * the committed .env says `development`. Without it the seeder would silently
 * skip on a correctly-configured machine and report success while writing
 * nothing. `stage` is deliberately NOT here -- it falls through to the
 * "supply the password" branch, which is the point of listing the local
 * values explicitly instead of testing for "not production".
 */
const LOCAL_ENVS = new Set(['development', 'dev', 'local', 'test', 'testing'])
const PRODUCTION_ENVS = new Set(['prod', 'production'])

/**
 * The id of the one user with this address, or undefined.
 *
 * Number(): a Postgres bigint id arrives as a string, and a string flowing
 * into `projects.owner_id` is a foreign key the dialect then rejects. Note
 * this is only safe for `users` -- `projects.id` is TEXT in this app, so it
 * is looked up separately below rather than through here.
 */
async function findUserId(email: string): Promise<number | undefined> {
  const row = await db.selectFrom('users' as any)
    .select(['id'] as any)
    .where('email' as any, '=', email)
    .executeTakeFirst() as { id?: number | string } | undefined

  return row?.id === undefined ? undefined : Number(row.id)
}

/**
 * Whether `password` is the one behind `stored`.
 *
 * verifyHash THROWS rather than returning false when `stored` is not a hash
 * it can parse -- `Password verification failed with error "InvalidEncoding"`
 * -- and a row whose password column holds something unparseable is precisely
 * the case the caller is trying to repair.
 */
async function passwordMatches(password: string, stored: unknown): Promise<boolean> {
  if (typeof stored !== 'string' || stored.length === 0)
    return false

  try {
    return await verifyHash(password, stored)
  }
  catch {
    return false
  }
}

export default class OwnerSeeder extends Seeder {
  static override tags = ['owner'] as const

  async run(): Promise<void> {
    const appEnv = String(env.APP_ENV || '').toLowerCase()
    const isLocal = LOCAL_ENVS.has(appEnv)
    const isProduction = PRODUCTION_ENVS.has(appEnv)

    const envEmail = String(env.LOGHQ_OWNER_EMAIL || '').trim().toLowerCase()
    const envPassword = String(env.LOGHQ_OWNER_PASSWORD || '')

    if (isProduction && (!envEmail || !envPassword))
      throw new Error('LOGHQ_OWNER_EMAIL and LOGHQ_OWNER_PASSWORD are both required for the production owner bootstrap.')

    if (!envPassword && !isLocal) {
      log.info(`[OwnerSeeder] Skipped: LOGHQ_OWNER_PASSWORD is not set and APP_ENV="${appEnv}" is not a local environment.`)
      return
    }

    const email = envEmail || DEV_EMAIL
    const password = envPassword || DEV_PASSWORD
    const usedFallback = !envPassword
    const now = new Date().toISOString()

    let userId = await findUserId(email)
    if (!userId) {
      await db.insertInto('users' as any).values({
        name: DEV_NAME,
        email,
        password: await makeHash(password, { algorithm: 'bcrypt' }),
        uuid: crypto.randomUUID(),
        // NOT NULL on this app's users table. This schema has no
        // is_super_admin and no avatar column.
        two_factor_enabled: false,
        // Pre-verified: the local mailbox does not exist, so a seeded account
        // that had to click a link in an email could never finish signing in.
        email_verified_at: now,
        created_at: now,
        updated_at: now,
      } as any).execute()
      userId = await findUserId(email)
    }
    else if (isLocal) {
      /*
       * Keep the documented local password working. Re-running the seeder
       * after changing DEV_PASSWORD, or after an earlier experiment wrote
       * this row with a different hash, would otherwise leave a row that
       * exists and cannot be signed in to -- the exact failure this file is
       * here to end. Checked before writing so a run that changes nothing
       * issues no UPDATE, and confined to local environments so a deploy
       * never silently rotates a real account's password.
       */
      const row = await db.selectFrom('users' as any)
        .select(['password'] as any)
        .where('email' as any, '=', email)
        .executeTakeFirst() as { password?: string } | undefined

      if (!await passwordMatches(password, row?.password)) {
        await db.updateTable('users' as any)
          .set({ password: await makeHash(password, { algorithm: 'bcrypt' }), updated_at: now } as any)
          .where('email' as any, '=', email)
          .execute()
        log.info('[OwnerSeeder] Reset the local owner password to match this seeder.')
      }
    }

    if (!userId)
      throw new Error('The LogHQ owner account could not be resolved after creation.')

    /*
     * One project per owner per name, which is the rule routes/projects.ts
     * enforces on create (it answers 409 on a clash). Matched on owner_id as
     * well as name so the seeder cannot adopt another account's project of
     * the same name.
     */
    const project = await db.selectFrom('projects' as any)
      .select(['id'] as any)
      .where('owner_id' as any, '=', userId)
      .where('name' as any, '=', PROJECT_NAME)
      .executeTakeFirst() as { id?: string } | undefined

    if (!project) {
      await db.insertInto('projects' as any).values({
        // TEXT, not an autoincrement integer: this app mints its own.
        id: newProjectId(PROJECT_NAME),
        name: PROJECT_NAME,
        platform: 'javascript',
        ingest_key: newIngestKey(),
        owner_id: userId,
        is_active: true,
        created_at: now,
        updated_at: now,
      } as any).execute()
    }

    log.info(`[OwnerSeeder] Owner project is ready for ${email}.`)
    if (usedFallback)
      log.info(`[OwnerSeeder] Local fallback credentials in use: ${email} / ${DEV_PASSWORD}`)
  }
}

if (import.meta.main)
  await new OwnerSeeder().run()
