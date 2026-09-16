#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Live verification against a running dev stack (`./infra/dev.sh` from the
// umbrella repo) — the properties a
// suite built on FakeWebSocket structurally cannot prove, because both cross real
// process boundaries (SDK, cloud, and — for [2] — a real WebSocket dying):
//
//   [1] A `busy` refusal carries the job that is *already* running, not the
//       caller's own — the wire shape three repos (SDK, cloud, contracts)
//       have to agree on and can each independently get "right" in a mocked
//       test while still disagreeing in production.
//   [2] `command_outcome_unknown` fires when the realtime connection cycles
//       out from under an in-flight command, *and* the documented recovery
//       — reading the job by slug via `actions.subscribe` — actually finds
//       it. An honest error that leaves the caller with no way to learn the
//       truth is only half of an error.
//   [3] A `parameter_invalid` refusal names the flat key the caller actually
//       typed (e.g. 'order'), not a nested path or a ROS field name — the
//       entire reason params are flat (§4.4) is so a refusal is legible;
//       nothing before this asserted that end to end. Asserts the bridge is
//       online as an explicit precondition first: the cloud currently
//       checks robot_offline before validating parameters, so this is only
//       observable while connected — a disconnected robot must fail this
//       check by name, not produce a confusing code mismatch below it.
//   [4] `cancel(robotId, slug, jobId)` addresses THAT job, not
//       whatever is running on the slug when the cancel arrives — the
//       cross-repository seam: the contracts package says what job_id means,
//       the SDK builds the frame, the cloud is the one that actually has
//       to look the id up and refuse a stale one rather than falling back
//       to the slug. A unit test against FakeWebSocket can prove the SDK
//       sends the right frame; it cannot prove the cloud reads it the way
//       the SDK assumes — this is that proof.
//   [5] Two `live()` calls under the SAME identity (two tabs) get
//       DISTINCT `session_id`s from the real cloud, and each `release()`
//       sends its own session's id as `?session_id=`. Read
//       the comment on `checkPerSessionRelease` for exactly where this
//       check's authority ends: `release()` never rejects and the DELETE
//       always answers 204 regardless of whether the cloud actually scoped
//       it correctly, so a green [5] proves the WIRE is right and cannot by
//       itself prove the cloud's refcount is — that half is the cloud
//       repo's own test's job, not this script's to fake.
//
// [2] deliberately targets a SERVICE call, not an action invoke. An action's
// `command_result` comes back the moment the job is *created* (by design —
// see the README's Actions section), so the window between sending it and
// the reply is a couple of milliseconds of cloud work: disrupting "right
// after" the call would almost always lose that race and silently test
// nothing while still reporting green. A service call's `command_result`
// instead waits for the terminal update, so the window is as wide as the
// service itself — deterministic, no scaffolding needed. Point SERVICE_SLUG
// at a deliberately slow service.
//
// [2]'s disruption is entirely CLIENT-side: it terminates this process's own
// WebSocket to the cloud (`ws`'s `.terminate()` — an abrupt socket kill, no
// close handshake, the closest thing to a real network drop) rather than
// touching the shared dev cloud process in any way. The property under test
// — a command's own socket dies before the reply, the SDK rejects with
// command_outcome_unknown, and the outcome is then discoverable by slug — is
// about the CLIENT's reaction to losing its connection; the cause of that
// loss is irrelevant to it, and killing a process three other people depend
// on to produce it was needlessly destructive AND weakened the second half
// of the check: with the server down, the job-by-slug recovery query cannot
// succeed either, so a full-server-kill version was testing "everything is
// down", not "the connection went, the truth is still there". With only the
// client socket dying, the cloud stays up, the bridge stays connected, the
// job keeps running, and the recovery path proves the thing it claims.
//
// Runs against the *built* package (`dist/`), not `src/` — the point of a
// live check is to exercise exactly what an external developer gets.
//
// Usage (from sdk/, with `./infra/dev.sh` already running):
//
//   FLEETLESS_API_URL=http://localhost:8080 \
//   # (or API=..., which the surrounding tooling exports and every other
//   # tool here reads — see the note by `apiUrl` below for why
//   # both are accepted rather than one being silently ignored)
//   APP_IDENTIFIER=<app identifier from the console> \
//   EMAIL=<app user email>  PASSWORD=<app user password> \
//   OBSERVER_EMAIL=<a THIRD app user, for [6]'s password round trip; falls
//                   back to EMAIL, which [6] says out loud when it happens> \
//   SECOND_EMAIL=<a DIFFERENT app user, same role — for [1]'s busy check;
//                 falls back to EMAIL if unset, which only proves "a second
//                 request is refused", not "a different user's is"> \
//   ROBOT_ID=<a robot with a configured, published action, service and camera> \
//   ACTION_SLUG=<a long-enough-running action slug, for [1]/[4]'s cancels> \
//   SERVICE_SLUG=<a deliberately SLOW service slug, for [2]'s disruption> \
//   CAMERA_SLUG=<a configured camera slug, for [5]'s per-session release> \
//   node scripts/verify-live.mjs

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocket as NodeWebSocket } from 'ws'
// **By name from contracts, never spelt out here.** This script asked for
// `'bridge-state'` — a HYPHEN — long after slugs became
// underscore-separated, until a run made check [3] throw its precondition
// on `not granted to your role, or it does not exist on this robot`. A third
// spelling of a name two other files already agree on is how a mailed link
// ends up pointing nowhere, so this reads the value rather than repeating it.
import { RESERVED_SLUGS } from '@fleetless/contracts'
const BRIDGE_STATE_SLUG = RESERVED_SLUGS.find((s) => s === 'bridge_state')
if (!BRIDGE_STATE_SLUG) throw new Error('verify-live: RESERVED_SLUGS no longer carries bridge_state, which check [3] reads as its precondition')

const sdkRoot = fileURLToPath(new URL('..', import.meta.url))

function env(name, fallback) {
  const value = process.env[name]
  if (value !== undefined && value !== '') return value
  if (fallback !== undefined) return fallback
  throw new Error(`verify-live: missing required env var ${name} (see the usage comment at the top of this script)`)
}

/**
 * This script once read only `FLEETLESS_API_URL`, defaulting to
 * `:8080` if unset — but the seeding tool and every other script around it
 * export `API`, not `FLEETLESS_API_URL`. Somebody who
 * set `API=http://localhost:8081` got a script that
 * silently fell back to `:8080` instead — a real, running cloud, just the
 * wrong one, so every check that touched the network produced a confident,
 * specific, WRONG result (a robot that read as offline, because its bridge
 * was pointed at :8081 and this script was talking to :8080). A required
 * value that is silently ignored in favour of a default is worse than a
 * missing one, which at least throws via `env()` above. `API` is accepted
 * as the fallback here rather than the reverse (refusing when they disagree)
 * because it is the name this whole repo already uses; `FLEETLESS_API_URL`
 * stays primary so a caller who sets both, deliberately, is not overridden.
 */
const apiUrl = env('FLEETLESS_API_URL', process.env.API ?? 'http://localhost:8080')
const appIdentifier = env('APP_IDENTIFIER')
const email = env('EMAIL')
const password = env('PASSWORD')
const robotId = env('ROBOT_ID')
const actionSlug = env('ACTION_SLUG')
const serviceSlug = env('SERVICE_SLUG')
const cameraSlug = env('CAMERA_SLUG')
/**
 * The two parameter names `SERVICE_SLUG` declares, exported by the seed
 * because they are its choice and not the service's: a `message` maps them
 * onto whatever the ROS request calls its fields, and the two sets are
 * deliberately different (§4.4 — a caller types the flat parameter, never the
 * ROS field). Defaulted to the seed's own names so an older env still runs;
 * a wrong pair here is a `parameter_invalid` refusal in check [2], which is
 * exactly how the drift was found.
 */
const serviceParamFirst = env('SERVICE_PARAM_FIRST', 'first')
const serviceParamSecond = env('SERVICE_PARAM_SECOND', 'second')
// A second, distinct app user (same role) for check [1]'s busy refusal.
// Two sessions of the SAME user are the same holder and prove nothing about
// "a different user is refused" — falls back to EMAIL
// so the script still runs without it, but that only proves "a second
// request is refused", not "a different user's request is", and check [1]
// says so explicitly when it falls back.
const secondEmail = env('SECOND_EMAIL', email)
/**
 * The identity check [6]'s password round trip rotates and restores. The seed
 * exports an `observe`-role user nothing else in this file signs in as, which
 * is the point of preferring it: a failure between the change and the restore
 * then costs one user that no other check depends on, instead of the one every
 * other check logs in as. Falls back to `EMAIL` so the script still runs
 * without it, and [6] says out loud when it has fallen back.
 */
const passwordSubjectEmail = env('OBSERVER_EMAIL', email)

// `parameter_invalid`'s `details` shape is pinned in contracts (as of
// bca81ca) — `{ violations: [{field, rule, message}, ...] }`, at least one,
// `field` the flat key exactly as sent. Parsed with the schema in check [3]
// rather than read off ad hoc: a shape mismatch must fail loudly and name
// what's wrong, not quietly find a field somewhere and let a wrong shape by.

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

console.log('== build (verifying against dist/, exactly what a consumer installs) ==')
execFileSync('pnpm', ['build'], { cwd: sdkRoot, stdio: 'inherit' })

const { createClient, parameterInvalidDetails } = await import(new URL('../dist/index.js', import.meta.url))

/**
 * A real `ws` WebSocket, tracked so the script can reach the *current* live
 * socket from outside the SDK (whose public `FleetlessClient` API has no
 * such hook, on purpose) and kill it — `.terminate()`, not `.close()`, so no
 * close frame reaches the cloud and this is an abnormal close exactly the
 * way a dropped connection is, not a polite handshake the server could tell
 * apart from one. `sentFrames` records outgoing frames so the disruption can
 * wait until the actual command frame went out before killing the socket —
 * otherwise a too-early kill would interrupt nothing and the check would
 * pass without ever exercising the thing it claims to.
 */
class TrackingWebSocket extends NodeWebSocket {
  static instances = []
  sentFrames = []

  constructor(url) {
    super(url)
    TrackingWebSocket.instances.push(this)
  }

  send(data, ...args) {
    this.sentFrames.push(data)
    return super.send(data, ...args)
  }
}

async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

/**
 * Wraps a real `fetch` to record every call's method, URL and response
 * status — the same reason `TrackingWebSocket` exists above:
 * `CameraLiveSession.release()` deliberately never rejects and is never
 * given the response (see its doc comment in `cameras.ts` — a courtesy
 * notification, not the thing that stops the stream), so there is no hook
 * on the public SDK surface to observe what the DELETE actually carried or
 * how the cloud answered it. This is the one legitimate way to look anyway,
 * same spirit as tracking outgoing WebSocket frames in [2].
 */
function createTrackingFetch(baseFetch) {
  const calls = []
  const wrapped = async (input, init) => {
    const response = await baseFetch(input, init)
    calls.push({ method: init?.method ?? 'GET', url: String(input), status: response.status })
    return response
  }
  wrapped.calls = calls
  return wrapped
}

/**
 * Each check runs in isolation: one throwing (a real refusal an inner
 * `try/catch` didn't anticipate, e.g. no bridge connected at all) must not
 * silently cancel the others. A live stack is rarely all-or-nothing ready —
 * exactly what happened developing this script: [1] hit `robot_offline`
 * because no bridge was connected yet, which used to take [2] and [3] down
 * with it, including [3]'s own precondition guard for that very case.
 */
const CHECKS = [
  ['[1] busy refusal carries the job that is already running', checkBusy],
  ['[2] command_outcome_unknown when the socket dies mid-call, and recovery by reading the job', checkOutcomeUnknown],
  ['[3] parameter_invalid names the field the caller actually typed (the whole point of the flat parameter shape)', checkParameterInvalid],
  ['[4] cancel(robotId, slug, jobId) addresses that job, never falls back to whatever runs on the slug', checkCancelByJobId],
  ['[5] two live() sessions of the same identity get distinct session_ids and release() addresses only its own', checkPerSessionRelease],
  ['[6] the client auth API: providers are public, login yields an app_user identity, logout ends it locally, the password round-trips, and a reset is acknowledged the same for a known and an unknown address', checkClientAuth],
]

async function main() {
  // api=... first and on the SAME line as what it's measuring: the
  // whole point is that a base URL and a robot id can each look correct in
  // isolation while together they name a robot that isn't where this script
  // is looking — a reader scanning this one line can catch that a robot id
  // from one environment is being checked against another's api, which two
  // separate lines let three people miss on three separate days.
  console.log(`\nFleetless SDK live verification — api=${apiUrl} robot=${robotId} action=${actionSlug} service=${serviceSlug} camera=${cameraSlug}`)

  for (const [label, run] of CHECKS) {
    console.log(`\n${label}`)
    try {
      await run()
    } catch (error) {
      failures += 1
      console.log(`  FAIL  check threw before finishing — ${error?.stack ?? error}`)
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * **The client auth surface, end to end against the real cloud** (3.0.0).
 *
 * **What this check deliberately does NOT drive, and where it is driven
 * instead.** Registration, email verification, invitation acceptance and
 * spending a reset token all need the mailbox: the token exists only in the
 * mail, and a script that invented one would be measuring a refusal rather
 * than a flow. Those four are a browser check's subject, driven against a
 * real mailbox so that the link under test is the one that was sent.
 * This file says so in its own output as well as here —
 * "the suite is green" about a surface whose mail-bound half nothing drove is
 * exactly the claim a reader would over-read.
 *
 * What IS reachable without a mailbox is driven here, against the seed's
 * already-active users: the public provider list, login and `me()`, the
 * password round trip, and both halves of the reset acknowledgement.
 *
 * **`listProviders` is a smoke test, not a guard, and the distinction is the
 * point.** A seeded org configures no OIDC provider, so the honest expected
 * answer is `[]` — which means an `.every()` over the entries proves nothing
 * — a check that cannot fail. So the assertion
 * is the one thing an empty array still supports — that the route answered at
 * all, **unauthenticated**, with the envelope unwrapped into an array — and the
 * count is printed rather than asserted. If a provider ever is seeded, the
 * shape check below starts having something to say; until then it is honest
 * about saying nothing.
 *
 * **The password round trip changes a real credential and changes it back.**
 * It runs on `OBSERVER_EMAIL` where the seed exported one — a user no other
 * check in this file logs in as — so a failure between the two writes cannot
 * strand the identity checks [1] to [5] depend on. The restore is in a
 * `finally` and its success is itself asserted, because "the world was left
 * as it was found" is the half a later run pays for if it is wrong.
 */
async function checkClientAuth() {
  // No session at all: `listProviders` must answer anyway. This is the half
  // that IS a guard — a login screen has to draw its buttons before anybody
  // has signed in, so a route that needed a credential here would be broken
  // for its only caller.
  const anonymous = createClient({ apiUrl, appIdentifier })
  const providers = await anonymous.auth.listProviders()
  check('[6a] listProviders() answers without any session', Array.isArray(providers), `got ${typeof providers}`)
  console.log(`  INFO  the app lists ${providers.length} sign-in provider(s) — an empty list is the seed's expected state, so [6b] below is vacuous on a plain seed`)
  check(
    '[6b] every listed provider carries a slug and a name',
    providers.every((provider) => typeof provider?.slug === 'string' && typeof provider?.name === 'string'),
    JSON.stringify(providers),
  )

  const client = createClient({ apiUrl, appIdentifier })
  await client.auth.login(email, password)
  const me = await client.auth.me()
  // The rename is the thing to prove here: `end_user_id` became `app_user_id`
  // and `kind: 'end_user'` became `app_user`. A consumer reading the old key
  // would have typechecked against the old contracts and silently got
  // `undefined` — which is exactly why the cut renamed rather than kept it.
  check('[6c] me() reports kind app_user', me.kind === 'app_user', JSON.stringify(me))
  check('[6d] me() carries this app user\'s own id under app_user_id', typeof me.app_user_id === 'string', JSON.stringify(me))
  check('[6e] me() reports the address that logged in', me.email === email, `${me.email} !== ${email}`)
  check('[6f] me() is scoped to an app and a role', typeof me.app_id === 'string' && typeof me.role_id === 'string', JSON.stringify(me))

  await client.auth.logout()
  // Not a claim that the access token stopped working — it is a stateless JWT
  // and keeps working until it expires, which logout's own doc comment says at
  // length. This asserts the narrower, real thing: the SDK cleared its store,
  // so the next call carries no bearer and the cloud refuses it.
  const afterLogout = await client.auth.me().then(
    (identity) => ({ code: null, identity }),
    (error) => ({ code: error?.code ?? String(error), identity: null }),
  )
  check(
    '[6g] after logout the client holds nothing, so me() is refused',
    afterLogout.code === 'unauthorized',
    `code=${afterLogout.code} identity=${JSON.stringify(afterLogout.identity)}`,
  )
  client.close()
  anonymous.close()

  await checkPasswordRoundTrip()
  await checkResetAcknowledgement()

  console.log('  INFO  register / verifyEmail / acceptInvitation / confirmPasswordReset are NOT driven here — each needs the token that exists only in the mail. They are a browser check\'s subject, driven against a real mailbox.')
}

/**
 * **changePassword, proved by what stops working** (3.0.0).
 *
 * A `200` from the change route says the route answered, not that the
 * credential moved: a handler that hashed the new password and forgot to
 * store it would answer exactly the same way. So the assertion that carries
 * this check is the **refusal** — a fresh client offering the OLD password is
 * told `invalid_credentials`. The change is then reversed and the original
 * password is proved to work again, which is both the second half of the round
 * trip and the guarantee that the seeded world survives this run.
 *
 * `changePassword` re-issues the session, so the client that made the change
 * keeps working; `me()` after it is what says so.
 */
async function checkPasswordRoundTrip() {
  const subject = passwordSubjectEmail
  if (subject === email) {
    console.log('  INFO  OBSERVER_EMAIL is unset, so the password round trip runs on EMAIL — the identity every other check in this file logs in as. A failure between the two writes would leave the seeded world holding a password nothing else knows.')
  }
  const rotated = `${password}-rotated-${Date.now()}`
  const client = createClient({ apiUrl, appIdentifier })
  // **`attempted`, not `changed`.** The flag used to be
  // set *after* `changePassword` resolved, which made the restore skip
  // exactly the failure it exists to cover: a call that reaches the
  // credential and whose *response* the SDK then rejects (a route that
  // regressed to `204`, a socket cut after the write) throws before the
  // assignment, so the `finally` restored nothing and the seeded world was
  // left on a password only this process ever knew. The write is a
  // possibility from the moment the request leaves, so the flag is set from
  // that moment — and `restoreSeedPassword` below decides what actually
  // happened by measuring, not by remembering.
  let attempted = false
  try {
    await client.auth.login(subject, password)
    attempted = true
    await client.auth.changePassword(password, rotated)
    // The session survived the change: `changePassword` stores the re-issued
    // pair rather than leaving the caller holding a token minted against the
    // old credential.
    const stillMe = await client.auth.me()
    check(
      '[6h] changePassword re-issues the session, so the same client stays signed in',
      stillMe.email === subject,
      JSON.stringify(stillMe),
    )

    // The load-bearing one. A change that answered 200 and stored nothing
    // passes every assertion above and fails only here.
    const stale = createClient({ apiUrl, appIdentifier })
    const withOld = await stale.auth.login(subject, password).then(
      () => ({ code: null }),
      (error) => ({ code: error?.code ?? String(error) }),
    )
    check(
      '[6i] the old password stops working — the change reached the credential, not just the response',
      withOld.code === 'invalid_credentials',
      `code=${withOld.code}`,
    )
    stale.close()
  } finally {
    if (attempted) await restoreSeedPassword(subject, rotated)
    client.close()
  }
}

/**
 * **Put the seeded password back, whatever state the round trip left behind.**
 *
 * The old restore assumed it knew: it reversed the change through the client
 * that had made it, under an `if` that was only true when the change had
 * visibly succeeded. Both halves of that are the wrong shape. The state after
 * a failed round trip is *unknown* — the write may or may not have landed,
 * and the session that made it may or may not still be usable — and the only
 * thing that can answer it is a login attempt. So this measures first and
 * writes second:
 *
 *   1. Does the ORIGINAL password work? Then nothing moved — the change never
 *      reached the credential — and there is nothing to reverse.
 *   2. Does the ROTATED one work? Then the change landed; sign in with it and
 *      change back, then prove the original works again.
 *   3. Neither? Say so as loudly as this script can, and print the rotated
 *      value — it is the only thing that can get the seed back, and it exists
 *      nowhere but in this process.
 *
 * **A `rate_limited` refusal is not an answer to "does this password work".**
 * The failed-login probe earlier in this file spends the same bucket, so each
 * attempt waits out the `retry_after_ms` the refusal carries and asks once
 * more. Twice is the whole of the patience: a limiter that is still refusing
 * after its own stated wait is a finding, not a delay to sit through.
 */
async function restoreSeedPassword(subject, rotated) {
  const attempt = async (candidate) => {
    for (let tries = 0; tries < 2; tries++) {
      const probe = createClient({ apiUrl, appIdentifier })
      const outcome = await probe.auth.login(subject, candidate).then(
        () => ({ ok: true, code: null, client: probe }),
        (error) => ({ ok: false, code: error?.code ?? String(error), retryMs: error?.details?.retry_after_ms ?? null, client: probe }),
      )
      if (outcome.ok || outcome.code !== 'rate_limited' || tries === 1) return outcome
      probe.close()
      const waitMs = Math.min(Number(outcome.retryMs) || 2000, 30_000)
      console.log(`  INFO  the login limiter refused the restore probe; waiting ${waitMs} ms it asked for and trying once more`)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
    return { ok: false, code: 'unreachable', client: null }
  }

  const original = await attempt(password)
  if (original.ok) {
    original.client.close()
    check(
      '[6j] the seeded password is what the app user holds — this run left the world as it found it',
      true,
      'the original password signs in, so nothing needed reversing',
    )
    check('[6k] the original password works again — the round trip closed', true, 'measured by the same login')
    return
  }
  original.client?.close()

  const withRotated = await attempt(rotated)
  if (!withRotated.ok) {
    withRotated.client?.close()
    check(
      '[6j] the seeded password is what the app user holds — this run left the world as it found it',
      false,
      `NEITHER password signs in (original: ${original.code}, rotated: ${withRotated.code}). The seed may be locked out and this script cannot repair it. The rotated value this run generated is ${JSON.stringify(rotated)} — it is the only handle left, and it exists nowhere else.`,
    )
    check('[6k] the original password works again — the round trip closed', false, 'not reached: the restore could not sign in at all')
    return
  }

  const restored = await withRotated.client.auth.changePassword(rotated, password).then(() => true, (error) => error?.code ?? String(error))
  withRotated.client.close()
  if (restored !== true) {
    check(
      '[6j] the seeded password is what the app user holds — this run left the world as it found it',
      false,
      `the restore call was refused (${restored}). The app user is on ${JSON.stringify(rotated)} and nothing else knows it.`,
    )
    check('[6k] the original password works again — the round trip closed', false, 'not reached: the restore write was refused')
    return
  }
  check('[6j] the seeded password is what the app user holds — this run left the world as it found it', true, 'the rotated password was changed back')

  const confirm = await attempt(password)
  confirm.client?.close()
  check(
    '[6k] the original password works again — the round trip closed',
    confirm.ok,
    `code=${confirm.code}`,
  )
}

/**
 * **The reset acknowledgement, on both sides of the thing it must not
 * reveal**.
 *
 * `requestPasswordReset` resolves for an address the app knows and for one it
 * does not, identically. Driving only the known address would assert that the
 * route works; driving only the unknown one would assert that it does not
 * crash. The rule is about the *pair* being indistinguishable, and a
 * requirement about a set guarded by one example is guarded by nothing —
 * so both run, and the assertion is that the two answers are
 * **the same bytes**, not that both resolved. Asserting only that both
 * resolved admits every difference that stays inside the 2xx range.
 *
 * **What this cannot see.** That a mail was actually sent for the first and
 * not for the second, and that the link in it works. Those need a mailbox and
 * belong to 6.3. What it does see is the only thing an unauthenticated caller
 * can see, which is exactly the surface the enumeration rule is about.
 *
 * The known-address call really does hand a mail to whatever SMTP server the
 * cloud is configured with, addressed to the seed's `@example.com` user. That
 * is stated at the moment it happens rather than discovered afterwards.
 */
/**
 * **Headers that differ between two responses without either being an
 * oracle.** `date` moves with the clock and a request id is unique by
 * definition; everything else is compared, values included. Keeping this list
 * short and explicit is the point — a comparison that excluded whatever
 * happened to differ would be a comparison of nothing.
 */
const VOLATILE_HEADERS = new Set(['date', 'x-request-id', 'request-id', 'connection', 'keep-alive'])

/** The comparable part of a response, as one string. Two of these are equal or they are not. */
function acknowledgementSignature(recorded) {
  const headers = [...recorded.headers]
    .filter(([name]) => !VOLATILE_HEADERS.has(name.toLowerCase()))
    .map(([name, value]) => `${name.toLowerCase()}: ${value}`)
    .sort()
    .join('\n')
  return `HTTP ${recorded.status} ${recorded.statusText}\n${headers}\n\n${recorded.body}`
}

async function checkResetAcknowledgement() {
  // **The two answers have to be COMPARED, and the SDK's return value cannot
  // do it.** `requestPasswordReset` resolves to nothing
  // on any 2xx, so `known.ok && unknown.ok` — what this check used to assert
  // — is a conjunction over "neither threw". A cloud that answered `200
  // {"delivered":true}` for a known address and `202` with an empty body for
  // an unknown one is a browser-readable enumeration oracle, and it passed.
  // So the responses themselves are captured through an injected `fetch` and
  // compared byte for byte: status, reason phrase, every non-volatile header,
  // and the body.
  const recorded = []
  const recordingFetch = async (input, init) => {
    const response = await globalThis.fetch(input, init)
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    let isReset = false
    try { isReset = new URL(url, apiUrl).pathname === '/api/client/password/reset' } catch { isReset = false }
    if (!isReset) return response
    // The body is read here, so the caller is handed a replacement carrying
    // the same bytes rather than a stream this function has already drained.
    const body = await response.text()
    recorded.push({ status: response.status, statusText: response.statusText, headers: response.headers, body })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  const client = createClient({ apiUrl, appIdentifier, fetch: recordingFetch })
  console.log(`  INFO  the next call asks for a real reset mail for ${email} — the cloud hands it to its configured SMTP server; the address is a reserved @example.com one and no part of this check reads the mailbox`)
  const knownStarted = Date.now()
  const known = await client.auth.requestPasswordReset(email).then(() => ({ ok: true, code: null }), (error) => ({ ok: false, code: error?.code ?? String(error) }))
  const knownMs = Date.now() - knownStarted
  const unknownStarted = Date.now()
  const unknown = await client.auth
    .requestPasswordReset(`no-such-user-${Date.now()}@example.com`)
    .then(() => ({ ok: true, code: null }), (error) => ({ ok: false, code: error?.code ?? String(error) }))
  const unknownMs = Date.now() - unknownStarted

  if (recorded.length !== 2) {
    check(
      '[6l] requestPasswordReset is acknowledged identically for a known and an unknown address (the enumeration rule)',
      false,
      `the recording fetch saw ${recorded.length} reset responses, not 2 — nothing was compared. known=${JSON.stringify(known)} unknown=${JSON.stringify(unknown)}`,
    )
  } else {
    const [a, b] = recorded.map(acknowledgementSignature)
    check(
      '[6l] requestPasswordReset is acknowledged identically for a known and an unknown address (the enumeration rule)',
      a === b,
      a === b
        ? `both answered, byte for byte: ${JSON.stringify(a)}`
        : `THE TWO ANSWERS DIFFER, which is an account-enumeration oracle any browser can read.\n        known:   ${JSON.stringify(a)}\n        unknown: ${JSON.stringify(b)}`,
    )
  }
  // **Timing is printed, not gated.** One sample each on a shared dev stack
  // cannot separate a real difference from scheduling noise, and a check that
  // went red on that would be red for a reason that says nothing. The cloud's
  // own defence is structural — the decoy path does the same work — and it is
  // asserted in the cloud's suite, not here. Printed because a large,
  // repeatable gap is worth somebody looking at.
  console.log(`  INFO  [6l] round-trip times: known ${knownMs} ms, unknown ${unknownMs} ms (not asserted — one sample each)`)
  client.close()
}

async function checkBusy() {
  const clientA = createClient({ apiUrl, appIdentifier })
  const clientB = createClient({ apiUrl, appIdentifier })
  try {
    await clientA.auth.login(email, password)
    await clientB.auth.login(secondEmail, password)
    if (secondEmail === email) {
      console.log('  SECOND_EMAIL not set — clientB is a second SESSION of the same user, not a different user')
    }

    // Best-effort: `count-up` runs ~30s regardless of params, so a rapid
    // re-run of this script can still find the *previous* run's job active
    // and get busy immediately on the FIRST invoke — a leftover-state
    // collision, not a finding. Clear the slug first; ignore any error
    // (nothing to cancel is the common, fine case).
    await clientA.actions.cancel(robotId, actionSlug).catch(() => {})

    // order: 20 — a real, valid parameter (the seed's `count-up` declares
    // `order` as `{min:1, max:25, required:true}`), high enough that the
    // job is still running by the time the second client invokes. An
    // empty {} would itself be refused parameter_invalid once §4.4 is
    // enforced (see check [3] below) — that is a correct refusal, not a
    // busy one, and would make this check pass for the wrong reason.
    const jobA = await clientA.actions.invoke(robotId, actionSlug, { order: 20 })
    check('first invoke resolves with a running job', jobA.state === 'running', `state=${jobA.state}`)

    let busyError
    try {
      await clientB.actions.invoke(robotId, actionSlug, { order: 20 })
      check('second invoke on the same slug is refused', false, 'it resolved instead of rejecting')
    } catch (error) {
      busyError = error
    }
    if (busyError) {
      check('second invoke rejects with code=busy', busyError.code === 'busy', `code=${busyError.code}`)
      const running = busyError.details?.running
      check(
        'error.details.running is the FIRST job (not the caller\'s, which does not exist)',
        running?.id === jobA.id,
        `expected id=${jobA.id}, got details=${JSON.stringify(busyError.details)}`,
      )
    }

    await clientA.actions.cancel(robotId, actionSlug).catch(() => {}) // best-effort: leave the slug idle for later checks
  } finally {
    clientA.close()
    clientB.close()
  }
}

async function checkOutcomeUnknown() {
  const instancesBefore = TrackingWebSocket.instances.length
  const client = createClient({ apiUrl, appIdentifier, WebSocket: TrackingWebSocket })
  try {
    await client.auth.login(email, password)

    // a/b: the seed's `add-slowly` (AddTwoInts-shaped) declares both
    // required. An empty {} would itself be refused parameter_invalid
    // before the service ever ran — a real, fast refusal that would beat
    // the disruption below and prove nothing about a mid-call socket death.
    // **The PARAMETER names, which are not the ROS request's field names.**
    // This line sent `{a, b}` — `example_interfaces/srv/AddTwoInts`' own
    // fields — while the seed's `add_slowly` declares the parameters `first`
    // and `second` and maps them onto `a`/`b` in its `message`. The cloud
    // refused it `parameter_invalid` long before any socket died, so check [2]
    // reported `command_outcome_unknown` missing for a reason that had nothing
    // to do with the disruption it exists to measure. The names come from the
    // seed now (`SERVICE_PARAM_*`), so the two cannot drift again in silence.
    const callPromise = client.services.call(robotId, serviceSlug, { [serviceParamFirst]: 2, [serviceParamSecond]: 3 })
    // A rejection here (e.g. a fast robot_offline, no gap needed to
    // reproduce it) between now and the `await callPromise` below is an
    // *unhandled* rejection until something observes it — and Node kills
    // the whole process on one by default. This no-op catch just prevents
    // that; the real outcome is still read from the same promise later.
    callPromise.catch(() => {})
    console.log('  called a (deliberately slow) service — its command_result waits for the terminal update, so this window is real, not a race')

    // Wait for the actual `call` frame to go out before killing anything —
    // otherwise a too-early kill interrupts a connection attempt, not a
    // pending command, and the check would pass without proving anything.
    const sent = await waitUntil(() => {
      const socket = TrackingWebSocket.instances.at(instancesBefore)
      return socket?.sentFrames.some((f) => JSON.parse(f).type === 'invoke') ?? false
    })
    if (!sent) throw new Error('the call frame never went out over the socket within 5s — nothing to disrupt')

    // This client must have opened exactly one socket. `instances.at(instancesBefore)`
    // assumes that; if a second socket ever sneaks in (the exact SDK bug
    // once found here — two connect() calls racing before the
    // credential lookup settles), this assumption silently instruments
    // whichever one happened to open first, which may not be the one
    // actually carrying the pending command. Assert it rather than trust it.
    check(
      'exactly one realtime socket was opened for this client',
      TrackingWebSocket.instances.length === instancesBefore + 1,
      `expected ${instancesBefore + 1}, got ${TrackingWebSocket.instances.length}`,
    )

    const socket = TrackingWebSocket.instances.at(instancesBefore)
    socket.terminate() // abrupt: no close handshake, the cloud/bridge/job are entirely untouched
    console.log('  terminated this process\'s own realtime socket (client-side only — the cloud, the bridge and the job are untouched)')

    let outcome
    try {
      await callPromise
      outcome = { rejected: false }
    } catch (error) {
      outcome = { rejected: true, code: error.code }
    }
    check(
      'service call rejects with command_outcome_unknown (not a plain command_timeout, and not a silent resolve)',
      outcome.rejected && outcome.code === 'command_outcome_unknown',
      JSON.stringify(outcome),
    )

    console.log('  recovering: reading the job by slug via actions.subscribe — job-subscriptions are kind-agnostic, so this works for a service slug too...')
    const recovery = await new Promise((resolve) => {
      let sub
      const timer = setTimeout(() => {
        sub.unsubscribe()
        resolve({ outcome: 'timeout' })
      }, 15_000)
      sub = client.actions.subscribe(robotId, serviceSlug, {
        onJob(event) {
          clearTimeout(timer)
          sub.unsubscribe()
          resolve({ outcome: 'job', job: event.job })
        },
        onError(error) {
          clearTimeout(timer)
          sub.unsubscribe()
          resolve({ outcome: 'subscribe_error', code: error.code, message: error.message })
        },
      })
    })
    check(
      'the job is discoverable by slug after the reconnect (the recovery path actually recovers)',
      recovery.outcome === 'job',
      JSON.stringify(recovery),
    )
    if (recovery.outcome === 'job' && recovery.job.state === 'lost') {
      console.log(
        '  NOTE: job reported lost — a known finding (a job that finishes while the link is down does not reach the subscriber); not this script\'s bug, tell the lead',
      )
    }
    if (recovery.outcome === 'job') console.log(`  observed: job id=${recovery.job.id} state=${recovery.job.state}`)
  } finally {
    client.close()
  }
}

async function checkParameterInvalid() {
  const client = createClient({ apiUrl, appIdentifier })
  try {
    await client.auth.login(email, password)

    // As of this writing the cloud checks robot_offline BEFORE validating
    // parameters, on both REST and realtime; whether that ordering holds is
    // not this script's to decide. Either way, this check
    // only proves what it claims while the bridge is actually connected —
    // assert that precondition explicitly rather than relying on it
    // silently. Against a disconnected robot this must fail saying so,
    // not report a confusing robot_offline vs parameter_invalid mismatch.
    const bridgeState = await client.datapoints.get(robotId, BRIDGE_STATE_SLUG)
    check(
      'precondition: the bridge is online (parameter_invalid is only observable while connected)',
      bridgeState.value?.online === true,
      `${BRIDGE_STATE_SLUG}=${JSON.stringify(bridgeState.value)}`,
    )

    if (bridgeState.value?.online === true) {
      let paramError
      try {
        // Deliberately missing `order`, which the seed's `count-up`
        // declares required. §4.4 enforcement must refuse this before it
        // ever reaches a robot, and must name the flat key a caller would
        // actually send — 'order', not a nested path, not the ROS field.
        await client.actions.invoke(robotId, actionSlug, {})
        check('invoke with a missing required parameter is refused', false, 'it resolved instead of rejecting')
      } catch (error) {
        paramError = error
      }
      if (paramError) {
        check('rejects with code=parameter_invalid', paramError.code === 'parameter_invalid', `code=${paramError.code}`)

        // Parsed with the pinned schema, not read off ad hoc — a shape
        // mismatch must fail loudly and name what's wrong, never quietly
        // find a field somewhere and let a wrong shape through.
        const parsed = parameterInvalidDetails.safeParse(paramError.details)
        check(
          'error.details matches the pinned parameterInvalidDetails shape ({violations: [...]})',
          parsed.success,
          parsed.success ? undefined : `${parsed.error} — raw details=${JSON.stringify(paramError.details)}`,
        )
        if (parsed.success) {
          const fieldsNamed = parsed.data.violations.map((v) => v.field)
          check(
            "violations name the field 'order' — the exact flat key a caller would type",
            fieldsNamed.includes('order'),
            `violations=${JSON.stringify(parsed.data.violations)}`,
          )
        }
      }
    } else {
      console.log('  skipping the parameter_invalid assertions — the bridge is not online, so this would only test robot_offline')
    }
  } finally {
    client.close()
  }
}

/**
 * Retries `invoke` on a `busy` refusal until the slug is free or `maxWaitMs`
 * elapses — used only where there is no specific job to wait on
 * (the very first invoke of a run, where whatever might be running is a
 * leftover from an earlier check, not a job this check knows the id of).
 * The platform allows exactly one job per action slug, and a leftover may not have
 * fully settled yet. **This is deliberately NOT used between cancelling a
 * known job and invoking the next one** — see `waitForTerminalJob`
 * below for why blind retrying is the wrong tool once a specific job id is
 * in hand.
 */
async function invokeWhenFree(client, robotId, slug, params, { maxWaitMs = 15_000, intervalMs = 300 } = {}) {
  const start = Date.now()
  for (;;) {
    try {
      return await client.actions.invoke(robotId, slug, params)
    } catch (error) {
      if (error?.code !== 'busy' || Date.now() - start > maxWaitMs) throw error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
}

const JOB_TERMINAL_STATES = ['succeeded', 'failed', 'cancelled', 'lost']

/**
 * Waits for a SPECIFIC job to reach a terminal state, by subscribing to its
 * slug and watching for an update carrying that job's id.
 *
 * This replaced a version of `checkCancelByJobId` that retried `invoke` on
 * `busy` after cancelling job A — which races a known behaviour of the
 * platform: a cancel's `command_result` is answered before the
 * robot has actually stopped (on this fixture, about 3s later), so the job
 * reads `running` for a window after the caller was told it was cancelled.
 * Retrying `invoke` blindly during that window spent the retry budget
 * fighting a known, documented gap instead of observing it directly. This
 * function asks the only question that actually matters here — *is job A
 * itself done* — rather than inferring it from whether a later, unrelated
 * call happens to succeed.
 *
 * Uses `actions.subscribe`, not a raw REST poll: subscribing pushes the
 * *current* job for the slug immediately (the cloud's "most recent job, not
 * just currently running" semantics — §11.3), so this resolves at once if
 * the job already settled by the time we ask, and otherwise on the next
 * matching update.
 *
 * `maxWaitMs` defaults generously (30s), not tuned to a single observed
 * number: `count-up`'s own fixture checks for a cancel once per ~1s step
 * (`fake_robot.py`), so a lone run settles in a couple of seconds — but a
 * live measurement against this same isolated stack, while writing this
 * function, settled in ~15.5s instead (16 Fibonacci steps ran before the
 * cancel was honoured), plausibly because another process was also
 * exercising this fixture's action slug at the time. A bound tuned to the
 * fast case would be exactly the "measures almost the right thing" mistake;
 * 30s is a sanity bound, not a
 * timing prediction.
 */
async function waitForTerminalJob(client, robotId, slug, jobId, { maxWaitMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`job ${jobId} on '${slug}' did not reach a terminal state within ${maxWaitMs}ms`)))
    }, maxWaitMs)
    const sub = client.actions.subscribe(robotId, slug, {
      onJob(event) {
        if (event.job.id !== jobId || !JOB_TERMINAL_STATES.includes(event.job.state)) return
        settle(() => resolve(event.job))
      },
      onError(error) {
        settle(() => reject(error))
      },
    })
    function settle(fn) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sub.unsubscribe()
      fn()
    }
  })
}

/**
 * [4]: `cancel(robotId, slug, jobId)` addresses that specific job.
 *
 * Only one job runs per action slug at a time (busy refusal otherwise), so
 * "two jobs on one slug" for this check means sequential, not concurrent:
 * job A runs and is stopped, job B starts on the same slug, and a cancel
 * still naming job A's (now stale) id must be refused — never silently
 * fall back to stopping whatever IS running (job B). That is the exact
 * failure this closes: a cancel arriving a moment after its own job ended
 * used to stop the *next* caller's job on the same slug.
 */
async function checkCancelByJobId() {
  const client = createClient({ apiUrl, appIdentifier })
  try {
    await client.auth.login(email, password)
    await client.actions.cancel(robotId, actionSlug).catch(() => {}) // best-effort: leave the slug idle first

    const jobA = await invokeWhenFree(client, robotId, actionSlug, { order: 20 })
    check('job A invoked and running', jobA.state === 'running', `state=${jobA.state}`)

    const cancelledA = await client.actions.cancel(robotId, actionSlug, jobA.id)
    check('cancel(jobId) addressing the running job actually stops it', cancelledA?.id === jobA.id, `expected id=${jobA.id}, got=${JSON.stringify(cancelledA)}`)

    // The cancel's own reply does not mean job A has actually stopped: a
    // cancel's command_result is answered before the robot has
    // finished terminating the goal. Wait for job A itself to settle,
    // rather than retrying invoke and hoping the timing works out.
    const settledA = await waitForTerminalJob(client, robotId, actionSlug, jobA.id)
    check('job A actually reached a terminal state after the cancel (not just acknowledged)', settledA.state === 'cancelled', `state=${settledA.state}`)

    const jobB = await client.actions.invoke(robotId, actionSlug, { order: 21 })
    check('job B invoked on the same slug is a NEW job, not A reused', jobB.state === 'running' && jobB.id !== jobA.id, `jobA=${jobA.id} jobB=${jobB.id} state=${jobB.state}`)

    let staleError
    try {
      await client.actions.cancel(robotId, actionSlug, jobA.id)
      check('cancelling the now-stale job A.id is refused, not silently accepted', false, 'it resolved instead of rejecting')
    } catch (error) {
      staleError = error
    }
    if (staleError) {
      check(
        'stale job_id rejects with not_found — never falls back to stopping whatever IS running',
        staleError.code === 'not_found',
        `code=${staleError.code}`,
      )
    }

    // The actual regression: job B must be untouched by the stale cancel
    // above. Proven by cancelling it BY ITS OWN id and confirming it was
    // still there to find and stop, not already gone.
    const cancelledB = await client.actions.cancel(robotId, actionSlug, jobB.id)
    check(
      "job B was left running by the stale cancel — cancel(jobB.id) still finds and stops it",
      cancelledB?.id === jobB.id,
      `expected id=${jobB.id}, got=${JSON.stringify(cancelledB)}`,
    )
  } finally {
    await client.actions.cancel(robotId, actionSlug).catch(() => {}) // best-effort: leave the slug idle for later runs
    client.close()
  }
}

/**
 * [5]: two `live()` calls under the SAME identity — the two-tabs
 * scenario — get distinct `session_id`s from the real cloud, and each
 * `release()` sends its own id as `?session_id=` on the DELETE.
 *
 * **Where this check's authority ends, stated plainly rather than implied:**
 * `CameraLiveSession.release()` never rejects and always answers 204
 * whether or not the cloud actually scoped the release correctly — that is
 * a deliberate SDK design choice (see `release()`'s doc comment), not a
 * limitation of this script. So this check proves two things solidly (the
 * cloud mints distinct session_ids; the SDK sends each one's own id on its
 * own DELETE, captured via `TrackingFetch` since the public API exposes
 * neither) and one thing it explicitly does NOT: whether the cloud's
 * refcount actually treats those two holds independently end to end (i.e.
 * whether releasing A truly leaves B's stream running) is only observable
 * by joining LiveKit as a real participant and watching who is still
 * publishing, which needs a LiveKit client this SDK deliberately does not
 * depend on (§14.3: no video widget). That half belongs to the CLOUD
 * repo's own test of `CameraLiveRegistry`, not to this script pretending it
 * can see further than it can.
 */
async function checkPerSessionRelease() {
  const trackedFetch = createTrackingFetch(globalThis.fetch)
  const clientA = createClient({ apiUrl, appIdentifier, fetch: trackedFetch })
  const clientB = createClient({ apiUrl, appIdentifier, fetch: trackedFetch })
  try {
    // Same identity logged in twice — two tabs, not two different users;
    // that is the exact scenario a bare DELETE used to collapse into one
    // hold.
    await clientA.auth.login(email, password)
    await clientB.auth.login(email, password)

    const sessionA = await clientA.cameras.live(robotId, cameraSlug)
    const sessionB = await clientB.cameras.live(robotId, cameraSlug)
    check(
      'two live() calls for the same identity get DISTINCT session_ids from the cloud',
      typeof sessionA.session_id === 'string' && sessionA.session_id.length > 0 && sessionA.session_id !== sessionB.session_id,
      `A=${sessionA.session_id} B=${sessionB.session_id}`,
    )

    await sessionA.release()
    const deleteA = trackedFetch.calls.find((c) => c.method === 'DELETE' && c.url.includes(cameraSlug) && c.url.includes(sessionA.session_id))
    check('releasing session A sent a DELETE naming A\'s own session_id', deleteA !== undefined, `calls=${JSON.stringify(trackedFetch.calls)}`)
    check('the cloud answered A\'s release with 204', deleteA?.status === 204, `status=${deleteA?.status}`)

    await sessionB.release()
    const deleteB = trackedFetch.calls.find(
      (c) => c.method === 'DELETE' && c.url.includes(cameraSlug) && c.url.includes(sessionB.session_id) && c !== deleteA,
    )
    check('releasing session B sent a SEPARATE DELETE naming B\'s own, different session_id', deleteB !== undefined, `calls=${JSON.stringify(trackedFetch.calls)}`)
    check('the cloud answered B\'s release with 204', deleteB?.status === 204, `status=${deleteB?.status}`)

    console.log(
      '  NOTE: this proves the wire (distinct ids minted, each release names its own) — it cannot prove the cloud\'s refcount kept the two holds independent end to end; that needs a LiveKit participant check, out of scope here (see this check\'s doc comment)',
    )
  } finally {
    clientA.close()
    clientB.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
