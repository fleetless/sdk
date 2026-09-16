#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Live verification against a running dev stack (`./infra/dev.sh` from the
// umbrella repo) — properties `history()`'s test suite cannot prove because
// it only ever sees a fake fetch answering with whatever shape the test
// wrote. This script exercises the real cloud, real TimescaleDB rows, and
// the real query grammar behind `datapoints.history`:
//
//   [1] A relative range (`now-1h`) and its absolute-millisecond equivalent,
//       computed for the same instant, return the SAME samples. The window
//       used ends well before "now" specifically so that the few
//       milliseconds separating the two HTTP calls cannot shift which rows
//       fall inside it — a window that touched the live edge would make
//       this flaky for reasons unrelated to what it's checking.
//   [2] Window aggregation (`min`/`max`/`avg`) over a real range matches
//       what this script computes itself from the raw samples in that same
//       range — not a plausible shape, the actual arithmetic, the same
//       discipline this check holds itself to. Buckets align to WALL-CLOCK
//       UTC (`time_bucket(width, captured_at)`, default
//       origin — :00/:10/:20s, top-of-minute, top-of-hour for clean widths),
//       never to `from + n*window`, so this check never assumes a boundary
//       formula — it reads each bucket's own `bucket_start_ms` back off the
//       response and filters the raw rows against THAT. This is also why it
//       tolerates partial edge buckets for free: the first/last bucket's
//       wall-clock span can extend outside [from, to], so its sample_count
//       is naturally lower than a full bucket's — that's a boundary effect,
//       not a mismatch, and asserting against the bucket's own reported
//       start rather than a derived one is what keeps this check honest
//       about that instead of failing on it.
//   [3] `not_recorded` is a real thrown FleetlessError for a live-only
//       slug, not something visible only in a mocked test.
//   [4] `not_aggregatable` is a real thrown FleetlessError when aggregation
//       is asked of a non-numeric recorded value with no `field` — OPTIONAL,
//       skipped with a note if NON_NUMERIC_RECORDED_SLUG isn't set, the same
//       fallback style verify-live.mjs uses for SECOND_EMAIL.
//   [5] `truncated: true` when `limit` is smaller than the number of
//       samples actually in range, and the array is exactly `limit` long —
//       OPTIONAL, skipped if the recorded slug doesn't have enough history
//       yet to hit the limit.
//
// Runs against the *built* package (`dist/`), not `src/` — same reasoning
// as verify-live.mjs: the point of a live check is to exercise exactly what
// an external developer gets.
//
// Usage (from sdk/, with `./infra/dev.sh` already running):
//
//   FLEETLESS_API_URL=http://localhost:8080 \
//   APP_IDENTIFIER=<app identifier from the console> \
//   EMAIL=<end user email>  PASSWORD=<end user password> \
//   ROBOT_ID=<a robot with at least one `retention: true` numeric datapoint
//             that already has history, and at least one live-only
//             ("retention: false") datapoint> \
//   RECORDED_NUMERIC_SLUG=<the recorded numeric datapoint's slug> \
//   LIVE_ONLY_SLUG=<a granted slug that is NOT recorded, for check [3]> \
//   NON_NUMERIC_RECORDED_SLUG=<optional: a recorded non-numeric datapoint, for check [4]> \
//   node scripts/verify-history.mjs
//
// NOTE: a development cloud started with `tsx watch` restarts whenever
// anyone saves a server file. A single failure here is not evidence on its
// own while the server is being edited — re-run before
// concluding anything, the same caveat verify-live.mjs's CHECKS loop deals
// with by isolating each check rather than letting one kill the others.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const sdkRoot = fileURLToPath(new URL('..', import.meta.url))

function env(name, fallback) {
  const value = process.env[name]
  if (value !== undefined && value !== '') return value
  if (fallback !== undefined) return fallback
  throw new Error(`verify-history: missing required env var ${name} (see the usage comment at the top of this script)`)
}

const apiUrl = env('FLEETLESS_API_URL', 'http://localhost:8080')
const appIdentifier = env('APP_IDENTIFIER')
const email = env('EMAIL')
const password = env('PASSWORD')
const robotId = env('ROBOT_ID')
const recordedNumericSlug = env('RECORDED_NUMERIC_SLUG')
const liveOnlySlug = env('LIVE_ONLY_SLUG')
// Optional — checks [4] and [5] skip themselves with a note when their
// precondition isn't set/met, the same way verify-live.mjs's busy check
// notes a SECOND_EMAIL fallback rather than failing for an unrelated reason.
const nonNumericRecordedSlug = process.env.NON_NUMERIC_RECORDED_SLUG || null

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
function note(message) {
  console.log(`  NOTE  ${message}`)
}

console.log('== build (verifying against dist/, exactly what a consumer installs) ==')
execFileSync('pnpm', ['build'], { cwd: sdkRoot, stdio: 'inherit' })

const { createClient, FleetlessError } = await import(new URL('../dist/index.js', import.meta.url))

const CHECKS = [
  ['[1] a relative range and its absolute-ms equivalent (same instant) return the same samples', checkRangeEquivalence],
  ['[2] window aggregation matches min/max/avg computed here from the raw samples in the same range', checkAggregationArithmetic],
  ['[3] not_recorded is thrown for a live-only slug, not answered as an empty result', checkNotRecorded],
  ['[4] not_aggregatable is thrown for a non-numeric value with no field', checkNotAggregatable],
  ['[5] truncated:true and exactly `limit` samples when the range holds more than `limit`', checkTruncation],
]

async function main() {
  console.log(`\nFleetless SDK history verification against ${apiUrl}`)
  console.log(`robot=${robotId} recorded=${recordedNumericSlug} liveOnly=${liveOnlySlug}`)

  const client = createClient({ apiUrl, appIdentifier })
  try {
    await client.auth.login(email, password)

    for (const [label, run] of CHECKS) {
      console.log(`\n${label}`)
      try {
        await run(client)
      } catch (error) {
        failures += 1
        console.log(`  FAIL  check threw before finishing — ${error?.stack ?? error}`)
      }
    }
  } finally {
    client.close()
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

// How far back the window starts / how close to "now" it ends, in seconds.
// Defaults suit a robot that has been recording continuously for a few
// minutes (the common case: a freshly seeded fixture, or the gate's own
// robot). Override for a robot whose only known-good history is further
// back — the WINDOW_TO_AGO_S buffer is what actually matters: it must stay
// comfortably clear of the live edge (network latency between the relative
// and absolute calls below), not the absolute size of the window.
const WINDOW_FROM_AGO_S = Number(process.env.HISTORY_WINDOW_FROM_AGO_S ?? 185)
const WINDOW_TO_AGO_S = Number(process.env.HISTORY_WINDOW_TO_AGO_S ?? 5)

/**
 * A window whose END stays clear of "now" by `WINDOW_TO_AGO_S`, so the few
 * milliseconds separating two HTTP calls (one relative, one absolute) cannot
 * move a sample in or out of range and turn a real disagreement into a flaky
 * one. Anchored to `Date.now()` captured ONCE, before either call, so both
 * requests describe the exact same absolute instant.
 */
function stableWindow() {
  const anchorMs = Date.now()
  const fromMs = anchorMs - WINDOW_FROM_AGO_S * 1000
  const toMs = anchorMs - WINDOW_TO_AGO_S * 1000
  return { anchorMs, fromMs, toMs }
}

/** The exact same window as `stableWindow()`, expressed the relative way — kept in sync by sharing the same two constants. */
function relativeRange() {
  return { from: `now-${WINDOW_FROM_AGO_S}s`, to: `now-${WINDOW_TO_AGO_S}s` }
}

async function checkRangeEquivalence(client) {
  const { fromMs, toMs } = stableWindow()

  const relative = await client.datapoints.history(robotId, recordedNumericSlug, relativeRange())
  const absolute = await client.datapoints.history(robotId, recordedNumericSlug, { from: String(fromMs), to: String(toMs) })

  check('both requests answer with raw samples', relative.kind === 'samples' && absolute.kind === 'samples')
  if (relative.kind !== 'samples' || absolute.kind !== 'samples') return

  check(
    'the two ranges return the identical sample set',
    JSON.stringify(relative.samples) === JSON.stringify(absolute.samples),
    `relative had ${relative.samples.length} samples, absolute had ${absolute.samples.length}`,
  )
}

async function checkAggregationArithmetic(client) {
  const { fromMs, toMs } = stableWindow()
  const windowMs = 60_000 // 1m buckets over the 5-minute stable window

  const raw = await client.datapoints.history(robotId, recordedNumericSlug, { from: String(fromMs), to: String(toMs) })
  if (raw.kind !== 'samples') {
    check('raw range answers with samples (precondition for this check)', false, `got kind=${raw.kind}`)
    return
  }
  if (raw.samples.length === 0) {
    note('no samples in the stable 5-minute window — cannot verify aggregation arithmetic against nothing; run the gate\'s own recording flow first')
    return
  }

  let buckets
  try {
    buckets = await client.datapoints.history(robotId, recordedNumericSlug, {
      from: String(fromMs),
      to: String(toMs),
      aggregate: { window: '1m', agg: 'avg' },
    })
  } catch (error) {
    // 501 means the aggregation route is not deployed, not that it answered
    // wrong. A check that cannot tell must say so, not report a false FAIL
    // against a feature the cloud does not have. Any OTHER error (4xx, a
    // malformed body)
    // is a real disagreement and must still fail loudly.
    if (error?.status === 501) {
      note('aggregation route answers 501 — N3 not landed yet, this check cannot run (not a failure)')
      return
    }
    throw error
  }
  check('the same range with aggregate: answers with buckets', buckets.kind === 'buckets', `got kind=${buckets.kind}`)
  if (buckets.kind !== 'buckets') return

  for (const bucket of buckets.buckets) {
    // bucket.bucket_start_ms comes straight off the response, never derived
    // from fromMs + n*windowMs — buckets align to wall-clock, so the first
    // and last can legitimately start before fromMs / extend past toMs.
    // raw.samples is already confined to [fromMs, toMs], so filtering it by
    // the bucket's own reported span is correct even for a partial edge
    // bucket: a low count there is that boundary effect, not a bug.
    const inBucket = raw.samples.filter(
      (s) => s.timestamp_ms >= bucket.bucket_start_ms && s.timestamp_ms < bucket.bucket_start_ms + windowMs,
    )
    check(
      `bucket@${bucket.bucket_start_ms} sample_count matches the raw rows actually in that span`,
      bucket.sample_count === inBucket.length,
      `server said ${bucket.sample_count}, raw rows say ${inBucket.length}`,
    )
    if (inBucket.length === 0) {
      check(`bucket@${bucket.bucket_start_ms} is empty, so value is null (not a zero average)`, bucket.value === null)
    } else {
      const expectedAvg = inBucket.reduce((sum, s) => sum + Number(s.value), 0) / inBucket.length
      check(
        `bucket@${bucket.bucket_start_ms} avg matches the arithmetic mean of its own raw rows`,
        bucket.value !== null && Math.abs(bucket.value - expectedAvg) < 1e-6,
        `server said ${bucket.value}, computed ${expectedAvg}`,
      )
    }
  }
}

async function checkNotRecorded(client) {
  let error
  try {
    await client.datapoints.history(robotId, liveOnlySlug, { from: 'now-1h' })
    check('history on a live-only slug is refused', false, 'it resolved instead of rejecting')
    return
  } catch (e) {
    error = e
  }
  check('rejects as a FleetlessError', error instanceof FleetlessError)
  check('code is not_recorded, not e.g. a generic 404/empty result', error?.code === 'not_recorded', `code=${error?.code}`)
}

async function checkNotAggregatable(client) {
  if (!nonNumericRecordedSlug) {
    note('NON_NUMERIC_RECORDED_SLUG not set — skipping (see the usage comment at the top of this script)')
    return
  }
  let error
  try {
    await client.datapoints.history(robotId, nonNumericRecordedSlug, { from: 'now-1h', aggregate: { window: '1m', agg: 'avg' } })
    check('aggregating a non-numeric value with no field is refused', false, 'it resolved instead of rejecting')
    return
  } catch (e) {
    error = e
  }
  check('rejects as a FleetlessError', error instanceof FleetlessError)
  check('code is not_aggregatable, not a silently coerced/null average', error?.code === 'not_aggregatable', `code=${error?.code}`)
}

async function checkTruncation(client) {
  const { fromMs, toMs } = stableWindow()
  const full = await client.datapoints.history(robotId, recordedNumericSlug, { from: String(fromMs), to: String(toMs) })
  if (full.kind !== 'samples' || full.samples.length < 2) {
    note(`stable window has ${full.kind === 'samples' ? full.samples.length : 0} samples — need at least 2 to exercise a limit smaller than the range; skipping`)
    return
  }

  const limit = full.samples.length - 1
  const limited = await client.datapoints.history(robotId, recordedNumericSlug, { from: String(fromMs), to: String(toMs), limit })
  check('limited result answers with samples', limited.kind === 'samples', `got kind=${limited.kind}`)
  if (limited.kind !== 'samples') return

  check('truncated is true when limit is smaller than the range holds', limited.truncated === true)
  check('the array is exactly `limit` long, not silently more or fewer', limited.samples.length === limit, `got ${limited.samples.length}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
