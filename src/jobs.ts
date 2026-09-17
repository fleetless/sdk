// SPDX-License-Identifier: MIT
import type { Job, JobRunListResponse, JobState, RobotJobsResponse } from '@fleetless/contracts'
import { pathSegment, type HttpClient } from './http.js'

/**
 * The filters `jobs.history` reads. Every field is optional; the wire names
 * are snake_case and this SDK spells them the way its other options are
 * spelt. `fromMs`/`toMs` are unix milliseconds, a half-open window
 * `[from, to)` so adjacent windows never both contain the run on their
 * boundary. `limit` above the platform's page cap is refused with
 * `validation_error`, not quietly reduced.
 */
export interface JobHistoryOptions {
  slug?: string
  state?: JobState
  kind?: 'action' | 'service'
  limit?: number
  /** The previous page's `next_cursor`. Send it back rather than computing one. */
  beforeSeq?: number
  fromMs?: number
  toMs?: number
}

/** Options -> the wire query string, omitting whatever the caller did not set rather than sending it empty. */
function historyQueryString(options: JobHistoryOptions): string {
  const params = new URLSearchParams()
  if (options.slug !== undefined) params.set('slug', options.slug)
  if (options.state !== undefined) params.set('state', options.state)
  if (options.kind !== undefined) params.set('kind', options.kind)
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.beforeSeq !== undefined) params.set('before_seq', String(options.beforeSeq))
  if (options.fromMs !== undefined) params.set('from_ms', String(options.fromMs))
  if (options.toMs !== undefined) params.set('to_ms', String(options.toMs))
  return params.toString()
}

/**
 * Robot-wide job reads, reachable as `client.jobs` — addressed by robot,
 * not slug, which `actions` and `services` cannot do.
 */
export interface JobsApi {
  /**
   * Every job the platform currently believes this robot has.
   *
   * `actions.subscribe`/`services.call` and `GET /jobs/:slug` — the per-slug
   * route those build on — all require knowing the slug already. Two cases
   * don't: a reconnecting bridge naming a job the cloud only *adopted*, and
   * a config change leaving a job on a slug the published document no
   * longer contains. Neither has a slug to give — this method is the only
   * way an app developer reaches them.
   *
   * At most one entry per slug: the current job there, same as a per-slug
   * read would answer. Not a history endpoint — that is `history` below.
   * Grant-filtered same as `cameras.list`/`datapoints` — an end user or
   * server key sees only jobs on slugs their role grants, a developer
   * session sees every job on the robot. Never empty-vs-missing ambiguity:
   * a robot doing nothing resolves `[]`.
   *
   * **Ordered newest first by `started_at`, with `job.seq` as the
   * tiebreaker** (`started_at` alone is not a total order — two jobs minted
   * in the same millisecond used to sort arbitrarily, differently on each
   * query). But for an **adopted** job, `started_at` is adoption time, not
   * when it actually started on the robot — the cloud only learns of it at
   * `hello`, having never minted it, and has no other honest value to put
   * there. So this is newest-*known*-first: a job the robot has been
   * running for an hour can sit above one started a minute ago, if the
   * hour-long one was only just adopted.
   */
  list(robotId: string): Promise<Job[]>
  /**
   * What *has* run on this robot: one row per run, newest first by the
   * durable `seq`, with its actor, its outcome and its `duration_ms`, kept
   * for 90 days. The durable counterpart of `list`.
   *
   * **Needs the `action_history` capability** on the caller's role, or it
   * rejects `capability_required`. An app user sees only runs on the slugs
   * their role grants; a developer session sees the whole robot.
   *
   * **Page until `next_cursor` is `null`, never until a page looks short.**
   * The cloud applies the role's grants to the page it already read, so a
   * page can come back thin — or empty — with a perfectly good non-null
   * cursor behind it. `runs.length === 0` is not an end-of-data signal.
   *
   * It lags realtime by a moment, deliberately: a run watched to completion
   * over `actions.subscribe` can still read `running` here for an instant.
   * Render the outcome from the realtime job you already have; use this for
   * what you were not watching.
   */
  history(robotId: string, options?: JobHistoryOptions): Promise<JobRunListResponse>
}

export function createJobsApi(http: HttpClient): JobsApi {
  return {
    async list(robotId) {
      const response: RobotJobsResponse = await http.request(`/api/robots/${pathSegment(robotId)}/jobs`, {})
      return response.jobs
    },
    async history(robotId, options = {}) {
      const query = historyQueryString(options)
      const page: JobRunListResponse = await http.request(
        `/api/robots/${pathSegment(robotId)}/jobs/history${query ? `?${query}` : ''}`,
        {},
      )
      return page
    },
  }
}
