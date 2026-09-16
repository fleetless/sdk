// SPDX-License-Identifier: MIT
import type { Job, RobotJobsResponse } from '@fleetless/contracts'
import { pathSegment, type HttpClient } from './http.js'

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
   * read would answer. Not a history endpoint. Grant-filtered same as
   * `cameras.list`/`datapoints` — an end user or server key sees only jobs
   * on slugs their role grants, a developer session sees every job on the
   * robot. Never empty-vs-missing ambiguity: a robot doing nothing
   * resolves `[]`.
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
}

export function createJobsApi(http: HttpClient): JobsApi {
  return {
    async list(robotId) {
      const response: RobotJobsResponse = await http.request(`/api/robots/${pathSegment(robotId)}/jobs`, {})
      return response.jobs
    },
  }
}
