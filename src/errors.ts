// SPDX-License-Identifier: MIT
import type { ErrorCode } from '@fleetless/contracts'

/**
 * Codes the SDK produces itself rather than relaying from the server. Kept
 * out of `@fleetless/contracts`' `ERROR_CODES` deliberately — that list is
 * the *wire* vocabulary, every entry something a server may actually send,
 * and none of these are.
 *
 * - `no_session` / `no_websocket`: a client-side refusal *before* a request
 *   ever reaches the network (not logged in; no WebSocket implementation
 *   available). Named apart from the server's own `unauthorized` so a
 *   caller can tell "the server refused me" from "the SDK refused before
 *   asking" by the code alone.
 * - `unparseable_error`: the opposite direction — a real response *did*
 *   arrive, its body just was not shaped like the platform's error format.
 *   Not a refusal at all, just "we do not know what the server said."
 * - `command_timeout`: a realtime command (`invoke`/`cancel`/`publish`) got
 *   no `command_result` within its timeout. The server may still answer
 *   later on the same socket — nobody knows — but the caller cannot be made
 *   to wait forever for that.
 * - `command_outcome_unknown`: worse than a timeout, and told apart from it
 *   on purpose — the connection that carried the command was replaced by a
 *   new one (a reconnect) before any reply arrived. The server, if it
 *   answered at all, answered a socket that no longer exists, so the
 *   command may or may not have run. Never retried automatically — that
 *   could run an action twice — the caller recovers by reading the job
 *   (e.g. `actions.subscribe`), since state is observed by slug regardless
 *   of which connection asked for it.
 * - `unexpected_response`: the server answered `ok:true` but left out
 *   something the command is defined to always return (e.g. no `job` on a
 *   successful `invoke`) — a contract violation the SDK noticed, not a
 *   refusal.
 * - `invalid_option`: the caller passed an *SDK-level* argument or option
 *   that cannot mean what it looks like it means. Three cases so far:
 *   `timeoutMs < patienceMs` on `invoke`/`call` — the SDK would give up
 *   locally before the platform's own patience runs out, and report
 *   `command_timeout` for a call the platform never actually refused; a
 *   non-string, non-null, non-omitted `jobId` on `cancel` — almost always a
 *   caller who upgraded past the older `cancel(robotId, slug, options?)`
 *   signature and is still passing an options object third; and a
 *   `concurrency` on `assets.prepareUrdfScene` that is not a positive
 *   integer, which would otherwise fetch nothing and return a scene that
 *   renders blank with no error to explain why. **A fourth since 3.0.0:**
 *   every `auth` method needing an app user's own session, called on a client
 *   built with a `serverKey` — `register`, `login`, `logout`, the password
 *   and invitation calls, both OIDC calls, the two MCP decisions and the two
 *   grant calls. Those threw a bare `Error` before, which a caller could only
 *   catch by message. All of them are refused
 *   before any request is sent — as a rejection, since every one of those
 *   methods is `async`. A client-side mistake to fix, not something a
 *   server response could ever produce, which is why this code belongs here
 *   and not in `@fleetless/contracts`' `ERROR_CODES`.
 * - `untrusted_absolute_url`: the SDK refused to fetch an absolute URL
 *   whose origin does not match this client's own `apiUrl` — thrown before
 *   the request is ever sent, so no `Authorization` header is ever built for
 *   it, let alone attached. The one caller that fetches an absolute URL at
 *   all is `assets.createMeshLoader`, following a URDF's rewritten mesh
 *   URIs — and a URDF is ROS graph input, not first-party data, so an app
 *   rendering one must not silently trust wherever it points.
 *   `assets.createMeshLoader`'s `onComplete` surfaces this the same way it
 *   surfaces a network failure: `(null, err)`.
 * - `no_urdf_synced`: `assets.prepareUrdfScene` looked for a `kind: 'urdf'`
 *   row in `assets.list()` and found none. Thrown before any asset fetch,
 *   rather than left to surface as a confusing downstream failure from
 *   `URDFLoader.parse(undefined)` or similar — the caller's fix is "sync a
 *   URDF first", which this error can say directly.
 * - `aborted`: `assets.prepareUrdfScene()` was given an `AbortSignal` and it
 *   fired — either already-aborted before the call started, or mid-flight
 *   while a fetch was in progress. Normalized to this one code regardless of
 *   which stage the abort landed in, rather than surfacing whatever shape
 *   the underlying `fetch()` rejects an aborted request with (a
 *   `DOMException` named `AbortError` in a browser, an `Error` named
 *   `AbortError` under Node's `fetch` — two different shapes a caller would
 *   otherwise have to detect themselves to tell "I cancelled this" from "the
 *   network actually failed"). Every partial resource this call had already
 *   created (`blob:` URLs) is revoked before this throws — an aborted load
 *   must not leak what it fetched before the signal fired, the same
 *   guarantee a failed load already had.
 * - `state_mismatch`: `auth.completeOidcLogin()` was called with a `state`
 *   that does not match the `expectedState` its own `beginOidcLogin()`
 *   returned for this attempt — or with no `state` at all (`beginOidcLogin`
 *   always sets one, so a callback carrying none does not look like a reply
 *   to a flow this client started), or with an **empty `expectedState`**,
 *   meaning nothing was persisted for this attempt at all. That last case is
 *   folded in rather than given its own code: two empty strings compare
 *   equal, so it has to be checked explicitly or the comparison defends
 *   nothing for exactly the callers most likely to hit it — but a caller
 *   branching on the code has the same next step either way, which is to
 *   start the sign-in again. Which of the two happened is in the message,
 *   because the *developer's* remedies do differ ("check how your app
 *   persisted the value" versus "this response belongs to a sign-in you did
 *   not start"). Thrown before `/api/client/oidc/exchange` is ever called:
 *   RFC 6749 section 10.12's whole point is that a caller must not complete
 *   an authorization response it did not itself request, so this check
 *   happens client-side, first, rather than being left to the server to
 *   catch — by which point a one-time code would already have been spent for
 *   a flow this client never started.
 */
export const SDK_ERROR_CODES = [
  'no_session',
  'no_websocket',
  'unparseable_error',
  'command_timeout',
  'command_outcome_unknown',
  'unexpected_response',
  'invalid_option',
  'untrusted_absolute_url',
  'state_mismatch',
  'no_urdf_synced',
  'aborted',
] as const

/**
 * The union of `SDK_ERROR_CODES` — the SDK's own client-side error
 * vocabulary. A `FleetlessError` whose `code` is one of these was raised by
 * this SDK rather than relayed from the server.
 */
export type SdkErrorCode = (typeof SDK_ERROR_CODES)[number]

/**
 * A stable code a caller can branch on: a server-defined code (open-ended —
 * see `ErrorCode`'s own doc comment), one of `SdkErrorCode`'s client-side
 * codes, or, since neither list is exhaustive, any other string.
 * `(string & {})` is the standard trick to keep autocomplete on the known
 * values while still accepting an arbitrary one.
 */
export type FleetlessErrorCode = ErrorCode | SdkErrorCode | (string & {})

/**
 * The third argument of `FleetlessError`'s constructor: what a thrower can
 * attach beyond the code and the message. Both fields are optional, and
 * both are absent on the codes the SDK raises before any request is sent.
 */
export interface FleetlessErrorOptions {
  /** Field-level detail for validation errors, passed through verbatim. */
  details?: unknown
  /** The HTTP status of the response that produced this error, if any. */
  status?: number
}

/**
 * The one error type the SDK throws for a refused API call: a stable
 * machine-readable `code` a caller can branch on (`forbidden` versus
 * `token_expired`) plus a human `message` for logs and debugging. Never
 * parse `message` — it is not part of the contract, only `code` is.
 *
 * Catch it by shape rather than by class where you can (`err.code`), since
 * a bundler that ends up with two copies of the SDK also ends up with two
 * classes and `instanceof` then answers `false` for a genuine one.
 */
export class FleetlessError extends Error {
  /** What went wrong, as a stable string — the field to branch on. */
  readonly code: FleetlessErrorCode
  /**
   * Structured detail the server sent with the refusal, if any: the
   * violations behind `parameter_invalid`, the running job behind `busy`,
   * `retry_after_ms` behind `rate_limited`. Parse it rather than assume
   * its shape — `parameterInvalidDetails` is exported for exactly that.
   */
  readonly details?: unknown
  /** The HTTP status of the response that produced this error, if it came from one. */
  readonly status?: number

  /**
   * Builds an error. `code` is what a caller branches on and `message` is
   * for a human; anything else the refusal carried goes in `options`.
   */
  constructor(code: FleetlessErrorCode, message: string, options: FleetlessErrorOptions = {}) {
    super(message)
    this.name = 'FleetlessError'
    this.code = code
    this.details = options.details
    this.status = options.status
  }
}
