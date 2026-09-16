// SPDX-License-Identifier: MIT
import type { Job, JobState } from '@fleetless/contracts'
import { resolveLocalWaitMs, type CommandTransport, type InvokeOptions } from './commands.js'
import { FleetlessError } from './errors.js'
import type { JobSubscriptions } from './job-subscriptions.js'

/**
 * Request/response calls to a robot, reachable as `client.services`. A
 * service answers once and is done — one method, nothing to subscribe to.
 */
export interface ServicesApi {
  /**
   * Calls a service and resolves with its result. A service call is a job
   * underneath — the same `job_id` exchange and disconnect survival as an
   * action — but that is deliberately invisible here: the caller gets a
   * plain `Promise<result>`, matching the REST `serviceCallResponse` shape.
   * There is nothing to subscribe to for a service —
   * no feedback, no progress, no cancel — so this call already waits for
   * the terminal state internally.
   *
   * `options.patienceMs` bounds the **whole wait** for a service call —
   * unlike an action, where it bounds acceptance only — because a service
   * has no further state to observe once it settles; the platform gives up
   * on the ROS call itself after this long.
   *
   * `options.timeoutMs` bounds this SDK's own local wait for the WHOLE
   * call — the ack that a job was created, plus however much of the
   * budget is left for it to then reach a terminal state — not two
   * separate `timeoutMs`-length windows back to back. A caller who sets
   * `timeoutMs: 5000` bounds total latency at ~5s, not ~10s.
   *
   * It is also **not independent** of `patienceMs`: left unset, it
   * is derived from `patienceMs` so this SDK's local clock cannot fire
   * before the platform's own deadline has even been reached. Setting
   * both, with `timeoutMs` shorter than `patienceMs`, rejects with
   * `invalid_option` before any request is sent rather than letting the two
   * race — see `InvokeOptions.patienceMs` for the full reasoning.
   */
  call(robotId: string, slug: string, params: Record<string, unknown>, options?: InvokeOptions): Promise<unknown>
}

const DEFAULT_RESULT_TIMEOUT_MS = 30_000

function isTerminal(state: JobState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'lost'
}

/**
 * Unwraps a terminal job into its result, or throws the typed error it
 * ended with.
 *
 * `error.details` is passed through. `job.error` carries an optional
 * `details` field because a `job_queue_full` refusal discovered *after* a job
 * was already minted (the bridge's queue was full when it got around to this
 * one) has nowhere else to carry its
 * `{limit, queued}` payload: the cloud already answered with a job, so this
 * cannot be the call's own refusal, only the job's terminal error. Drop
 * `details` here and `services.call` silently throws away exactly what a
 * caller needs to decide whether to retry.
 */
function unwrap(job: Job): unknown {
  if (job.state === 'succeeded') return job.result
  const error = job.error
  throw new FleetlessError(
    error?.code ?? job.state,
    error?.message ?? `The service call ended in state '${job.state}'.`,
    error?.details !== undefined ? { details: error.details } : undefined,
  )
}

export function createServicesApi(transport: CommandTransport, jobSubscriptions: JobSubscriptions): ServicesApi {
  return {
    async call(robotId, slug, params, options = {}) {
      // May throw invalid_option synchronously — before anything is
      // sent, same discipline as sendCommand's own "never partially sent".
      const timeoutMs = resolveLocalWaitMs(options, DEFAULT_RESULT_TIMEOUT_MS)
      // One deadline for the whole call, computed once, BEFORE the
      // ack-wait — not `timeoutMs` handed to the ack-wait and then handed
      // again, in full, to the terminal-wait below. Two independent
      // `timeoutMs`-length windows back to back let a caller who set
      // `timeoutMs: 5000` to bound the call at 5s wait close to 10s in the
      // worst case (ack arrives just before ITS deadline, terminal state
      // takes the rest). Nothing exercised "ack arrives late, then the
      // terminal wait needs its own clock" until the test added for this
      // fix.
      const deadline = Date.now() + timeoutMs
      // transport.invoke() only resolves on ok:true — a busy/robot_offline/
      // parameter_invalid refusal rejects here directly, before any job-wait.
      // `patienceMs` passes through unchanged — it is the platform's own
      // wait for the ROS call, not this SDK's local `timeoutMs`. The
      // ack-wait itself still gets the full `timeoutMs` (nothing to share it
      // with yet — it's the first wait), so no elapsed time is unaccounted
      // for: `deadline` was computed before this call, so any time spent
      // here is automatically subtracted from what's left below.
      const initial = await transport.invoke(robotId, slug, params, { timeoutMs, patienceMs: options.patienceMs })
      const initialJob = initial.job
      if (!initialJob) {
        throw new FleetlessError('unexpected_response', `The server accepted the call to '${slug}' but returned no job to track.`)
      }
      if (isTerminal(initialJob.state)) return unwrap(initialJob)

      // Whatever's left of the ONE deadline, not a fresh timeoutMs. If the
      // ack itself consumed the whole budget, there is nothing left to wait
      // with — give up now rather than schedule a timer for 0ms and still
      // pay an extra event-loop tick pretending to wait.
      const remainingMs = Math.max(0, deadline - Date.now())
      if (remainingMs === 0) {
        throw new FleetlessError('command_timeout', `Service '${slug}' did not reach a terminal state within ${timeoutMs}ms.`)
      }

      return new Promise<unknown>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          settle(() =>
            reject(new FleetlessError('command_timeout', `Service '${slug}' did not reach a terminal state within ${timeoutMs}ms.`)),
          )
        }, remainingMs)

        const subscription = jobSubscriptions.subscribe(robotId, slug, {
          onJob(event) {
            if (event.job.id !== initialJob.id || !isTerminal(event.job.state)) return
            settle(() => {
              try {
                resolve(unwrap(event.job))
              } catch (error) {
                reject(error)
              }
            })
          },
          onError(error) {
            settle(() => reject(error))
          },
        })

        function settle(fn: () => void): void {
          if (settled) return
          settled = true
          clearTimeout(timer)
          subscription.unsubscribe()
          fn()
        }
      })
    },
  }
}
