/**
 * Project identifier and key generation.
 *
 * Extracted from routes/projects.ts because there are now two callers: the API
 * route and the page action behind `resources/views/projects/new.stx`. These
 * are the two functions that MUST NOT drift — two ways of minting an ingest key
 * is two formats to recognise, and a second project-id scheme would break the
 * assumption that an id is a readable slug.
 *
 * Kept here rather than exported from routes/: a route file is a registration
 * surface, and importing one from a view drags every `route.*` side effect in
 * with it.
 */

/** A short, readable, unique project id: slug of the name + a random suffix. */
export function newProjectId(name: string): string {
  const slug = (name || 'app')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'app'
  const rand = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 6)
  return `${slug}-${rand}`
}

/**
 * A public, revocable ingest key (not a secret; ships in client code). The
 * `loghq_` prefix makes it recognizable as a loghq key at a glance (Stripe/
 * GitHub style) and greppable in code and logs.
 */
export function newIngestKey(): string {
  return `loghq_${(globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID()).replace(/-/g, '')}`
}
