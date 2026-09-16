// SPDX-License-Identifier: MIT
import type { BusyDetails, ClientCancel, ClientInvoke, ClientPublish, CommandResult } from '@fleetless/contracts'
import { FleetlessError } from './errors.js'
import type { RealtimeChannel } from './realtime.js'

/**
 * Generates a `request_id`: unique per command, opaque to the
 * wire — the server only ever echoes it back.
 */
function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // Fallback for the rare environment without `crypto.randomUUID` (older
  // Node/browsers) — still unique enough, just not a real UUID.
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * The options every realtime command accepts — `actions.cancel` and
 * `publishers.publish` take exactly these; `InvokeOptions` extends them for
 * `actions.invoke` and `services.call`.
 */
export interface SendCommandOptions {
  /** How long to wait for a `command_result` before rejecting `command_timeout`. Default 10s. */
  timeoutMs?: number
}

/**
 * What `actions.invoke` and `services.call` accept on top of
 * `SendCommandOptions`: the two clocks a command runs under, one local to
 * this SDK and one on the platform.
 */
export interface InvokeOptions extends SendCommandOptions {
  /**
   * How long **the platform itself** should wait for this one call before
   * giving up on the robot — the whole wait for a service call, goal
   * *acceptance* only for an action (once accepted, a job runs as long as it
   * runs and is observed, not awaited).
   *
   * Optional; absent means the platform's own `DEFAULT_PATIENCE_MS`, 15s —
   * exactly the behaviour of a caller who names no preference. Outside
   * `MIN_PATIENCE_MS` to `MAX_PATIENCE_MS` (1s to 120s, both exported by
   * `@fleetless/contracts`) the platform refuses with `validation_error`
   * rather than clamping, and this SDK does not clamp locally or retry:
   * surfacing the refusal is the whole of what it does with this field.
   * The floor exists because
   * impatience reaches the robot, not just the platform — a patience too
   * short to survive a goal-acceptance round trip made the bridge report
   * `goal_timeout` and then issue a *corrective cancel* against a goal an
   * action server accepted a moment later, so a caller who names an
   * unreachable deadline was causing a real cancellation on the machine,
   * repeatably, not just receiving an error.
   *
   * `timeoutMs` bounds how long *this SDK* waits locally for a reply on the
   * wire it already sent on; `patienceMs` travels to the platform and bounds
   * what *it* is willing to wait for from the robot. **They are not set
   * independently of each other.** `timeoutMs` left unset is *derived* from
   * `patienceMs`, not defaulted to a fixed number that might be shorter —
   * the SDK giving up locally before the platform's own deadline would
   * report `command_timeout` for a call the platform never actually refused.
   * Setting both explicitly with `timeoutMs < patienceMs` is refused with
   * `invalid_option` before any request is sent, for the same reason.
   */
  patienceMs?: number
}

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000

/**
 * How much longer than `patienceMs` the SDK waits locally for the reply to
 * travel back over the wire once the platform has already given up. Not
 * zero: a `patienceMs`-equal local timeout would race the platform's own
 * deadline and could fire first on nothing more than ordinary network
 * latency, misreporting `command_timeout` for a call the platform was about
 * to answer honestly.
 */
const LOCAL_WAIT_MARGIN_MS = 5_000

/**
 * Resolves the local wait `sendCommand` actually uses from a caller's
 * `InvokeOptions` — the one place `timeoutMs` and `patienceMs`
 * are reconciled, shared by `actions.invoke` (via `createRealtimeCommandTransport`)
 * and `services.call` (which reuses it again for its own post-ack
 * terminal-state wait, so both of a service call's clocks agree with the
 * platform's).
 *
 * The two clocks used to agree only by accident: an invoke's local wait
 * (`DEFAULT_COMMAND_TIMEOUT_MS`, 10s) and the platform's own patience
 * (`DEFAULT_PATIENCE_MS`, 15s) were both small round numbers nobody had
 * reconciled. Timeouts that agree by coincidence stop agreeing the moment
 * either one moves, and the caller is who finds out: raising `patienceMs`
 * without also raising `timeoutMs` got you cut off by the SDK before the
 * platform had given up, and told `command_timeout` — which reads as "nobody
 * answered" when the true story is "the SDK stopped listening first".
 *
 * - Neither set: `defaultMs`, unchanged from before this field existed.
 * - Only `patienceMs` set: derived from it, `patienceMs + LOCAL_WAIT_MARGIN_MS`
 *   — stating one number does not also require reasoning about a second,
 *   unrelated one.
 * - Only `timeoutMs` set: unchanged, exactly as given — `patienceMs` is
 *   absent, so the platform applies its own default and this SDK's local
 *   wait is the caller's sole concern.
 * - Both set, `timeoutMs < patienceMs`: refused outright, client-side,
 *   before any request is sent — that combination cannot mean what it
 *   looks like it means, only "give up before the platform could ever
 *   have answered honestly".
 */
export function resolveLocalWaitMs(options: InvokeOptions, defaultMs: number): number {
  const { timeoutMs, patienceMs } = options
  if (timeoutMs !== undefined && patienceMs !== undefined && timeoutMs < patienceMs) {
    throw new FleetlessError(
      'invalid_option',
      `timeoutMs (${timeoutMs}ms) is shorter than patienceMs (${patienceMs}ms) — the SDK would give up locally before the platform's own patience runs out, and report command_timeout for a call the platform never actually refused. Raise timeoutMs above patienceMs, or omit timeoutMs to have it derived automatically.`,
    )
  }
  if (timeoutMs !== undefined) return timeoutMs
  if (patienceMs !== undefined) return patienceMs + LOCAL_WAIT_MARGIN_MS
  return defaultMs
}

interface CommandFrame {
  type: string
  request_id: string
  [key: string]: unknown
}

/**
 * Sends one command frame and resolves on its matching `command_result`
 * — the primitive every verb (`invoke`/`cancel`/`publish`) is built on.
 * Three non-negotiables:
 *
 * 1. **Never silently dropped.** If the channel is not yet authenticated,
 *    the frame is *held* until it is (`RealtimeChannel.onReady`) rather than
 *    sent into a closed socket or quietly discarded — but sent exactly
 *    once, never re-sent, so a slow connect can never cause a double
 *    invoke.
 * 2. **Bounded.** No reply within `timeoutMs` rejects with `command_timeout`
 *    — a caller never awaits forever.
 * 3. **Honest about a reconnect.** A command sent on one physical socket can
 *    only ever be answered on *that* socket. If it drops and a new one
 *    authenticates before the reply arrives, the reply is never coming —
 *    waiting out the rest of the timeout would misreport "still working on
 *    it" as the reason, when the true reason is "we can no longer hear the
 *    answer". That case rejects immediately with the distinct
 *    `command_outcome_unknown`, so a caller does not confuse "nothing
 *    happened yet" with "we lost the ability to find out and must check by
 *    other means" — reading the job by slug (`actions.subscribe`) is the
 *    recovery, not a blind retry.
 */
export function sendCommand(channel: RealtimeChannel, frame: CommandFrame, options: SendCommandOptions = {}): Promise<CommandResult> {
  channel.connect()
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS

  return new Promise<CommandResult>((resolve, reject) => {
    let settled = false
    const cleanups: Array<() => void> = []
    const cleanup = () => {
      for (const fn of cleanups) fn()
    }
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new FleetlessError(
            'command_timeout',
            `Command '${frame.type}' (request_id=${frame.request_id}) timed out after ${timeoutMs}ms without a reply.`,
          ),
        ),
      )
    }, timeoutMs)
    cleanups.push(() => clearTimeout(timer))

    cleanups.push(
      channel.on('command_result', (raw) => {
        const result = raw as unknown as CommandResult
        if (result.request_id !== frame.request_id) return
        settle(() => {
          if (result.ok) {
            resolve(result)
            return
          }
          const code = result.code ?? 'command_failed'
          // `busy` is special-cased because its detail comes from the
          // frame's dedicated `job` field, not from `details` — "present
          // when a command started or addressed a job": on a busy refusal
          // that job is the one already running, exactly what a caller
          // needs to branch on instead of guessing whether to wait or give
          // up. Every other refusal passes `details` through verbatim —
          // same as `HttpClient`'s REST path (see http.ts) — e.g.
          // `parameter_invalid` carries a `ParameterInvalidDetails`; parse
          // it with the schema of the same name (re-exported from
          // index.ts) rather than reading fields off it.
          const details: unknown = code === 'busy' && result.job ? ({ running: result.job } satisfies BusyDetails) : result.details
          reject(new FleetlessError(code, result.message ?? 'The command was refused.', details !== undefined ? { details } : undefined))
        })
      }),
    )

    cleanups.push(
      channel.onAuthFailed((error) => {
        settle(() => reject(error))
      }),
    )

    const watchForDeadConnection = (epochAtSend: number) => {
      cleanups.push(
        channel.onReady(() => {
          // Fires immediately (microtask) if the channel is already ready —
          // that is the very connection we just sent on, not a new one.
          if (channel.connectionEpoch === epochAtSend) return
          settle(() =>
            reject(
              new FleetlessError(
                'command_outcome_unknown',
                `The realtime connection was re-established before a reply to '${frame.type}' (request_id=${frame.request_id}) arrived. The command may or may not have run — read the job by slug (e.g. actions.subscribe) rather than retrying blindly.`,
              ),
            ),
          )
        }),
      )
    }

    if (channel.isReady) {
      const epoch = channel.connectionEpoch
      channel.send(frame)
      watchForDeadConnection(epoch)
    } else {
      const unlistenReady = channel.onReady(() => {
        unlistenReady()
        const epoch = channel.connectionEpoch
        channel.send(frame)
        watchForDeadConnection(epoch)
      })
      cleanups.push(unlistenReady)
    }
  })
}

/**
 * Verb-shaped, not frame-shaped, on purpose: `actions`/`services`/
 * `publishers` depend on this interface, not on `RealtimeChannel` directly,
 * so a future non-realtime transport (a server-key caller that wants to
 * publish once a minute without holding a socket open, say) is an
 * additional implementation of this interface, not a redesign of the
 * callers built on it.
 */
export interface CommandTransport {
  invoke(robotId: string, slug: string, params: Record<string, unknown>, options?: InvokeOptions): Promise<CommandResult>
  /**
   * `jobId` addresses a specific job; `null`/omitted keeps the operator
   * meaning — "stop whatever is running on this slug" (see
   * `ActionsApi.cancel`'s doc comment for the full reasoning). Never falls
   * back from a named id to the slug-only form: `sendCommand` already
   * rejects on `ok:false` (e.g. `not_found`) without retrying, so that
   * guarantee falls out of not adding a retry here — an absence, not an
   * explicit check. Do not "fix" a `not_found` on a stale id by resending
   * without it.
   *
   * **Rejects `invalid_option` if `jobId` is neither a string, `null`, nor
   * omitted.** This used to be `cancel(robotId, slug, options?)`;
   * a plain-JavaScript caller who upgrades without reading the changelog and
   * keeps passing an options object third — `cancel(robotId, slug,
   * {timeoutMs: 5000})` — now has that object land in the `jobId`
   * position. Sent as-is, `job_id` on the wire would be an object where the
   * contract requires a uuid, and the platform would refuse it — correctly,
   * but with a `validation_error` that says nothing about *why*, on a
   * public npm signature nobody was warned changed. This check exists so
   * that mistake produces a sentence naming the argument, not a server
   * round trip and a guess. It does not validate `jobId` is a well-formed
   * uuid, only that it is a string (or absent) — the platform already owns
   * that check and duplicating it here would be a second place to keep in
   * sync with `z.uuid()`.
   */
  cancel(robotId: string, slug: string, jobId?: string | null, options?: SendCommandOptions): Promise<CommandResult>
  publish(robotId: string, slug: string, message: Record<string, unknown>, options?: SendCommandOptions): Promise<CommandResult>
}

/**
 * Guards `cancel`'s `jobId` position — see `CommandTransport.cancel`'s
 * doc comment for why this exists and what it deliberately does not check.
 */
function assertValidJobId(jobId: unknown): asserts jobId is string | null | undefined {
  if (jobId === undefined || jobId === null || typeof jobId === 'string') return
  throw new FleetlessError(
    'invalid_option',
    `cancel()'s third argument must be a job id (string), null, or omitted — got ${
      typeof jobId === 'object' ? 'an object' : typeof jobId
    }. If you are passing an options object (e.g. {timeoutMs}) as the third argument, note the signature changed in this release: cancel(robotId, slug) is unchanged, but a third positional argument is now the job id to cancel and options moved to a fourth argument — cancel(robotId, slug, jobId, options). See the Actions section of the SDK reference at https://docs.fleetless.dev/reference/sdk/`,
  )
}

/** The default transport: every verb travels over the shared realtime channel. */
export function createRealtimeCommandTransport(channel: RealtimeChannel): CommandTransport {
  return {
    // Declared `async` deliberately, unlike `cancel`/`publish` below: it's
    // the only one of the three that can refuse *before* sending anything
    // (`resolveLocalWaitMs`'s `invalid_option`), and every caller of this
    // interface — starting with this file's own `sendCommand` callers —
    // assumes `CommandTransport.invoke` always returns a promise, never
    // throws synchronously. Without `async` here, a synchronous throw from
    // `resolveLocalWaitMs` would escape as a thrown exception instead of a
    // rejection, breaking that assumption for a caller that isn't itself
    // inside an `async` function (e.g. a test calling this transport
    // directly).
    async invoke(robotId, slug, params, options) {
      // May throw invalid_option — before the frame is ever
      // built or sent, matching sendCommand's own "never silently dropped,
      // never partially sent" discipline.
      const timeoutMs = resolveLocalWaitMs(options ?? {}, DEFAULT_COMMAND_TIMEOUT_MS)
      // `patience_ms` omitted (not `undefined` on the wire — JSON.stringify
      // drops it) when the caller names none, which is exactly what
      // `clientInvoke.patience_ms.optional()` means: the platform default.
      const frame: ClientInvoke = {
        type: 'invoke',
        request_id: generateRequestId(),
        robot_id: robotId,
        slug,
        params,
        patience_ms: options?.patienceMs,
      }
      return sendCommand(channel, frame, { timeoutMs })
    },
    // Declared `async` for the same reason `invoke` above is:
    // `assertValidJobId` can throw before a frame is ever built, and a
    // caller of this interface is entitled to a rejected promise, never a
    // thrown exception.
    async cancel(robotId, slug, jobId, options) {
      assertValidJobId(jobId)
      const frame: ClientCancel = { type: 'cancel', request_id: generateRequestId(), robot_id: robotId, slug, job_id: jobId ?? null }
      return sendCommand(channel, frame, options)
    },
    publish(robotId, slug, message, options) {
      const frame: ClientPublish = { type: 'publish', request_id: generateRequestId(), robot_id: robotId, slug, message }
      return sendCommand(channel, frame, options)
    },
  }
}
