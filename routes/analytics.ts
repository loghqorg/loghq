/**
 * loghq - archive and analytics API.
 *
 * The stream API in routes/logs.ts answers "what is happening now" from the hot
 * database. These routes answer the two questions that need the cold tier:
 * "what happened months ago" (archive search over Parquet) and "what does the
 * shape of my logging look like over time" (volume and level aggregations
 * spanning both tiers).
 *
 * Authorization copies routes/logs.ts exactly, including returning 404 rather
 * than 403 for a project the caller cannot see, so an outsider cannot tell a
 * project id apart from one that does not exist.
 */

import { db } from '@stacksjs/database'
import { route } from '@stacksjs/router'
import {
  archivePartitionsFor,
  archiveSummary,
  hotWindowStart,
  levelsByRelease,
  parseLevels,
  searchArchive,
  volumeSeries,
} from '../app/Archive/query'
import { archiveConfig } from '../app/Archive/config'
import { projectPlan } from '../app/Archive/plan'
import { dayOf } from '../app/Archive/partitions'
import { ownsProject } from '../app/Support/access'
import { userFromRequest } from '../app/Support/request-auth'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Ranges the analytics endpoints accept, in days. */
const RANGES: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '180d': 180 }

/**
 * Resolve `?range=` to a day window.
 *
 * Whitelisted rather than parsed: these values reach a bucket width and a day
 * arithmetic, and an unbounded range is a way to ask the archive to open every
 * Parquet file a project has.
 */
function rangeDays(raw: unknown): number {
  return RANGES[String(raw ?? '30d')] ?? 30
}

function dayRange(days: number, now = new Date()): { fromDay: string, toDay: string } {
  const from = new Date(now.getTime())
  from.setUTCDate(from.getUTCDate() - days)
  return { fromDay: dayOf(from), toDay: dayOf(now) }
}

/** 401 when signed out, 404 when the project is not theirs, else the user. */
async function authorize(request: any, projectId: string): Promise<Response | null> {
  const user = await userFromRequest(request)
  if (!user)
    return json({ error: 'unauthorized' }, 401)
  if (!(await ownsProject(user, projectId)))
    return json({ error: 'not found' }, 404)
  return null
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

/**
 * What the archive holds for this project, and what the plan entitles it to.
 *
 * Available on both plans deliberately. A free project's rows are pruned rather
 * than archived, and this endpoint is how the settings page can say so plainly,
 * including how many rows have already gone.
 */
route.get('/api/projects/{projectId}/archive/status', async (request: any) => {
  const projectId = request.params.projectId
  const denied = await authorize(request, projectId)
  if (denied)
    return denied

  const cfg = archiveConfig()
  const [plan, summary, partitions] = await Promise.all([
    projectPlan(projectId),
    archiveSummary(projectId),
    archivePartitionsFor(projectId, { limit: 400 }),
  ])

  return json({
    plan,
    archiveEnabled: cfg.enabled,
    hotWindowDays: cfg.hotWindowDays,
    hotWindowStart: hotWindowStart(cfg),
    freePruneGraceDays: cfg.freePruneGraceDays,
    summary,
    partitions,
  })
})

/**
 * Search the Parquet archive.
 *
 * Pro only. Free projects have no archive to search, because their aged logs
 * were pruned rather than exported, so this answers 403 with a code the UI can
 * turn into an upgrade prompt rather than an error.
 */
route.get('/api/projects/{projectId}/archive/search', async (request: any) => {
  const projectId = request.params.projectId
  const denied = await authorize(request, projectId)
  if (denied)
    return denied

  if ((await projectPlan(projectId)) !== 'pro')
    return json({ error: 'archive search requires the pro plan', code: 'plan' }, 403)

  const q = request.query ?? {}

  // The cursor is carried as `timestamp~id` so one query parameter holds the
  // whole keyset position. Split rather than parsed: both halves are validated
  // by the SQL builder, which rejects anything that is not the expected shape.
  const [beforeTs, beforeId] = String(q.before ?? '').split('~')

  try {
    const { logs, nextCursor } = await searchArchive(projectId, {
      levels: parseLevels(q.level),
      channel: q.channel ? String(q.channel) : undefined,
      environment: q.environment ? String(q.environment) : undefined,
      release: q.release ? String(q.release) : undefined,
      q: q.q ? String(q.q) : undefined,
      fromDay: q.from ? String(q.from) : undefined,
      toDay: q.to ? String(q.to) : undefined,
      beforeTs: beforeTs || undefined,
      beforeId: beforeId || undefined,
      limit: Number(q.limit) || 100,
    })

    return json({
      logs,
      nextCursor: nextCursor ? `${nextCursor.ts}~${nextCursor.id}` : null,
    })
  }
  catch (error: any) {
    // The SQL builder throws on a filter it will not vouch for. That is a bad
    // request, not a server fault.
    return json({ error: String(error?.message ?? 'invalid filter') }, 400)
  }
})

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/**
 * Entry volume over time, hot and archived reported separately.
 *
 * Kept separate rather than summed so the chart can show where the boundary of
 * the hot window falls, which is the difference between "logging stopped" and
 * "those days moved to the archive".
 */
route.get('/api/projects/{projectId}/analytics/volume', async (request: any) => {
  const projectId = request.params.projectId
  const denied = await authorize(request, projectId)
  if (denied)
    return denied

  const q = request.query ?? {}
  const days = rangeDays(q.range)
  // Hourly buckets only for short ranges: 180 days by hour is 4320 points, which
  // is neither renderable nor useful.
  const unit = String(q.interval ?? 'day') === 'hour' && days <= 7 ? 'hour' : 'day'
  const { fromDay, toDay } = dayRange(days)

  const [plan, series] = await Promise.all([
    projectPlan(projectId),
    volumeSeries(projectId, { fromDay, toDay, unit }),
  ])

  return json({ plan, unit, fromDay, toDay, series })
})

/** Level distribution per release, for spotting a release that changed the error mix. */
route.get('/api/projects/{projectId}/analytics/levels', async (request: any) => {
  const projectId = request.params.projectId
  const denied = await authorize(request, projectId)
  if (denied)
    return denied

  const { fromDay, toDay } = dayRange(rangeDays((request.query ?? {}).range))

  const [plan, releases] = await Promise.all([
    projectPlan(projectId),
    levelsByRelease(projectId, { fromDay, toDay }),
  ])

  return json({ plan, fromDay, toDay, releases })
})

/**
 * Distinct releases and channels seen recently, to populate filter menus.
 *
 * Hot side only: a filter menu wants what is current, and scanning Parquet to
 * offer a two-year-old channel name is not worth the round trips.
 */
route.get('/api/projects/{projectId}/analytics/facets', async (request: any) => {
  const projectId = request.params.projectId
  const denied = await authorize(request, projectId)
  if (denied)
    return denied

  const [releases, channels, environments] = await Promise.all([
    db.unsafe('SELECT DISTINCT release AS v FROM log_entries WHERE project_id = $1 AND release IS NOT NULL LIMIT 100', [projectId]),
    db.unsafe('SELECT DISTINCT channel AS v FROM log_entries WHERE project_id = $1 AND channel IS NOT NULL LIMIT 100', [projectId]),
    db.unsafe('SELECT DISTINCT environment AS v FROM log_entries WHERE project_id = $1 AND environment IS NOT NULL LIMIT 50', [projectId]),
  ])

  const values = (rows: any) => (rows ?? []).map((r: any) => String(r.v)).sort()

  return json({
    releases: values(releases),
    channels: values(channels),
    environments: values(environments),
  })
})
