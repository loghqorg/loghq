/**
 * Who can see which project, and which log line.
 *
 * Extracted from routes/logs.ts so the API routes and the page actions that
 * render the same data cannot drift on the rule. A project is visible to its
 * owner and to anyone invited into `project_members` by email - the same
 * predicate in both branches of every query below, which is the point of
 * having one file own it.
 *
 * Follows app/Support/projects.ts: shared server-side helpers live here rather
 * than being copied between a route and a view.
 */
import { db } from '@stacksjs/database'

export function userEmail(user: any): string {
  return String(user?.email ?? '').trim().toLowerCase()
}

/** True when `user` can access the project (owner or invited member). */
export async function ownsProject(user: any, projectId: string): Promise<boolean> {
  const row = (await db.unsafe(
    `SELECT 1 FROM projects p
    WHERE p.id = $1 AND (
      p.owner_id = $2
      OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND lower(m.email) = $3)
    ) LIMIT 1`,
    [projectId, Number(user.id), userEmail(user)],
  ))?.[0]
  return !!row
}

/** True when `user` can access the project the log entry belongs to. */
export async function ownsLog(user: any, logId: string): Promise<boolean> {
  const row = (await db.unsafe(
    `SELECT 1 FROM log_entries l JOIN projects p ON p.id = l.project_id
    WHERE l.id = $1 AND (
      p.owner_id = $2
      OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND lower(m.email) = $3)
    ) LIMIT 1`,
    [logId, Number(user.id), userEmail(user)],
  ))?.[0]
  return !!row
}

/**
 * The entry itself, or null when it does not exist OR the user cannot see it.
 *
 * One query rather than an access check followed by a fetch: the two-step form
 * is a time-of-check/time-of-use gap, and it also answers "no such entry" and
 * "not yours" differently, which tells a stranger whether an id is real.
 */
export async function logEntryFor(user: any, logId: string): Promise<any | null> {
  const row = (await db.unsafe(
    `SELECT l.* FROM log_entries l JOIN projects p ON p.id = l.project_id
    WHERE l.id = $1 AND (
      p.owner_id = $2
      OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND lower(m.email) = $3)
    ) LIMIT 1`,
    [logId, Number(user.id), userEmail(user)],
  ))?.[0]
  return row ?? null
}
