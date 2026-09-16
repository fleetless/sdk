// SPDX-License-Identifier: MIT
import type { Job } from '@fleetless/contracts'
import type { CommandTransport, InvokeOptions, SendCommandOptions } from './commands.js'
import { FleetlessError } from './errors.js'
import type { JobSubscription, JobSubscriptionHandlers, JobSubscriptions } from './job-subscriptions.js'

/**
 * Long-running work on a robot, reachable as `client.actions`. An action is
 * a ROS action the developer exposed under a slug: it is invoked, runs as
 * long as it runs, and reports back while it does.
 */
export interface ActionsApi {
  /**
   * Invokes an action. Resolves as soon as the job is created
   * — the job id is informative, not the result. Feedback, progress and the
   * eventual result arrive separately over `subscribe`. A second invoke of
   * the same slug while one is already running is refused `busy`, with
   * `error.details.running` naming the running job.
   *
   * `options.patienceMs` bounds goal *acceptance* only — once a goal
   * is accepted this call has already resolved; the job then runs as long
   * as it runs, observed via `subscribe`, never awaited. `options.timeoutMs`
   * (this SDK's own local wait for the acceptance reply) is derived from
   * `patienceMs` when left unset, and the combination `timeoutMs <
   * patienceMs` is refused with `invalid_option` rather than raced.
   */
  invoke(robotId: string, slug: string, params: Record<string, unknown>, options?: InvokeOptions): Promise<Job>
  /**
   * Cancels a job — a real ROS goal cancel on the robot, not a local forget.
   * Resolves with the `Job` the cancel was actually sent to, or `null` if
   * nothing matched.
   *
   * **Two different requests, both legitimate:**
   * - `cancel(robotId, slug)` — no `jobId` — is the operator's stop button:
   *   whatever is running on this slug, stop it.
   * - `cancel(robotId, slug, jobId)` cancels **that** job specifically. If
   *   it is not the one running, the platform answers `not_found` — this
   *   never silently falls back to stopping whatever *is* running, because
   *   a caller who named an id has already ruled that out. The failure this
   *   closes: a cancel arriving just after its own job ended used to stop
   *   the *next* caller's job on the same slug.
   *
   * Read the returned job either way: "I stopped the one I meant", "there
   * was nothing there", and "I stopped a job that started after I last
   * looked" are three different outcomes a discarded result cannot tell
   * apart.
   */
  cancel(robotId: string, slug: string, jobId?: string | null, options?: SendCommandOptions): Promise<Job | null>
  /**
   * Subscribes to the slug's job: state, feedback, progress and result, as
   * they happen. State is observed **by slug**, not by job id — this
   * is what makes late delivery after a reconnect and a second observer
   * watching the same job both work without special-casing either. Naming a
   * job to `cancel` does not change this: a slug is still a *place a job may
   * be running*, not the job itself, and it is still what `subscribe` watches.
   */
  subscribe(robotId: string, slug: string, handlers: JobSubscriptionHandlers): JobSubscription
}

export function createActionsApi(transport: CommandTransport, jobSubscriptions: JobSubscriptions): ActionsApi {
  return {
    async invoke(robotId, slug, params, options) {
      const result = await transport.invoke(robotId, slug, params, options)
      // transport.invoke() only resolves on ok:true (ok:false rejects) — a
      // missing job at that point is the server not honouring its own
      // contract, not a refusal the caller can branch on.
      if (!result.job) {
        throw new FleetlessError('unexpected_response', `The server accepted the invoke for '${slug}' but returned no job to track.`)
      }
      return result.job
    },

    async cancel(robotId, slug, jobId, options) {
      const result = await transport.cancel(robotId, slug, jobId, options)
      return result.job
    },

    subscribe(robotId, slug, handlers) {
      return jobSubscriptions.subscribe(robotId, slug, handlers)
    },
  }
}
