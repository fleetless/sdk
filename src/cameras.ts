// SPDX-License-Identifier: MIT
import type { CameraDescriptor, CameraListResponse, LiveSessionResponse, SnapshotMetaResponse } from '@fleetless/contracts'
import { SNAPSHOT_HEADERS } from '@fleetless/contracts'
import { FleetlessError } from './errors.js'
import { mimeFromContentType, pathSegment, type HttpClient } from './http.js'

/**
 * The snapshot's metadata alone, without the bytes. All fields
 * are `null` together when nothing has been captured yet for this camera —
 * a fresh configuration before the first `snapshot_interval_ms` elapses, say
 * — which is a state, not a failure: the wire answers it with
 * `no_snapshot_yet`, and both `snapshot`/`snapshotMeta` absorb that code
 * here rather than throw it, so a caller checks `age_ms === null` instead of
 * wrapping every poll in a try/catch for something that is not exceptional.
 *
 * `age_ms` is **always** the cloud's own figure, never recomputed client-side
 * as `Date.now() - timestamp_ms`: the cloud is the one clock that knows how
 * long it has actually held the frame, and recomputing would reintroduce the
 * viewer's own clock skew as a source of lying about freshness (see
 * `SNAPSHOT_HEADERS`'s doc comment in `@fleetless/contracts`).
 */
export interface CameraSnapshotMeta {
  /** The image's media type, e.g. `image/jpeg`. */
  mime: string | null
  /** The image's width in pixels. */
  width: number | null
  /** The image's height in pixels. */
  height: number | null
  /** The bridge's capture time, in unix milliseconds — when the frame was taken, not when it was served. */
  timestamp_ms: number | null
  /** How long the cloud has held this frame, in milliseconds. The one figure to read for freshness. */
  age_ms: number | null
}

/** One snapshot read: the image bytes plus everything needed to state how old they are. */
export interface CameraSnapshot extends CameraSnapshotMeta {
  /** The encoded image, or `null` when nothing has been captured yet. */
  image: Uint8Array | null
}

/**
 * What a LiveKit client needs to join, plus the means to leave. Returned by
 * `cameras.live`. Hand `url` and `token` straight to a LiveKit client SDK
 * (e.g. `Room.connect(url, token)`) — this SDK stops there on purpose: no
 * video widget and no teleop-style helper, so that the app owns how the
 * video is presented.
 */
export interface CameraLiveSession {
  /**
   * This viewer's own hold — what `release()` releases, and the only
   * thing distinguishing this session from every other tab of the same
   * identity watching the same camera.
   */
  session_id: string
  /** The LiveKit server URL to connect to. */
  url: string
  /** The LiveKit room this session joins. */
  room: string
  /**
   * The LiveKit access token for this session. It is checked when the
   * participant connects and not again afterwards, so it bounds *joining*,
   * not the session: a viewer who has already joined keeps receiving video
   * past `expires_at`. What ends a joined session is `release()` together
   * with disconnecting the room, the cloud reconciling the hold away
   * against LiveKit's real participants, or a revocation — a membership,
   * role or key change — kicking the participant out.
   */
  token: string
  /**
   * When this token can no longer be used to **join** — not when an
   * already-joined session ends. LiveKit checks a token at connect time
   * only, so a `Room` that joined before this timestamp keeps streaming
   * past it untouched; this field bounds how long an unused token sits
   * around, nothing more.
   *
   * It is **not** a backstop for a forgotten `release()`, a crash, or a
   * `kill -9` after joining: what ends an already-joined session is
   * `release()` plus disconnecting the `Room`, the cloud noticing (via its
   * own reconciliation against LiveKit's actual room participants) that
   * this viewer is gone, or revocation kicking the participant outright.
   * Do not design around `expires_at` as if it were any of those.
   */
  expires_at: string
  /**
   * Tells the cloud this viewer no longer wants to hold the camera live —
   * **this** hold, addressed by `session_id`, and no other tab's. Each
   * `CameraLiveSession` releases only the hold it itself took, so one tab's
   * cleanup never stops the robot out from under another tab of the same
   * logged-in user.
   *
   * **This alone does not stop the stream.** The cloud makes LiveKit room
   * participation the authoritative refcount, not this call — precisely
   * because a closing tab cannot be relied on to make it. `release()` is a
   * courteous fast path; the robot actually stops publishing once every
   * viewer's LiveKit `Room` has disconnected, which the SFU notices on its
   * own with no cooperation required. **Always pair this with disconnecting
   * the `Room` you connected with `url`/`token`** — see the Cameras
   * section of the SDK reference for the paired cleanup pattern; a `release()` that ran
   * alone while the `Room` stayed connected would stop nothing.
   *
   * Safe to call more than once (only the first call does anything) and
   * never rejects — this is a courtesy notification, not the thing that
   * actually stops the stream (see above), so there is nothing a caller
   * could usefully do with a rejection here. That also makes this safe to
   * use directly as e.g. a React effect's cleanup return value, including
   * from `beforeunload`, where a call that could throw would be a liability.
   *
   * **A failed DELETE here is not observable anywhere** — not as a
   * rejection, a realtime event, or a field on this object. Deliberate, not
   * an oversight: the only consumer of that information would be code
   * deciding whether to retry, and the reconciliation backstop described
   * above already makes a retry unnecessary for correctness. A future need
   * to know "did my release actually reach the cloud" (telemetry, say) is a
   * new, additive signal to design, not a change to this method's contract.
   */
  release(): Promise<void>
}

/**
 * A robot's cameras, reachable as `client.cameras`: what exists, the latest
 * still frame, and a live video session. All of it is REST — no realtime
 * channel is involved.
 */
export interface CamerasApi {
  /** Every camera exposed on this robot, as descriptors — the same per-robot list the other kinds use. */
  list(robotId: string): Promise<CameraDescriptor[]>
  /**
   * The current snapshot: image bytes plus its age. Independent of `live` —
   * a snapshot keeps updating on `snapshot_interval_ms` whether or not
   * anyone is watching live, and keeps being served, with a growing
   * age, even while the bridge is offline.
   */
  snapshot(robotId: string, slug: string): Promise<CameraSnapshot>
  /**
   * The snapshot's metadata alone — for polling "is there a newer frame
   * yet?" without re-downloading the image on every check. Prefer this over
   * `snapshot` for a view that only needs to show an age (e.g. "updated 2s
   * ago") and fetches pixels on demand.
   */
  snapshotMeta(robotId: string, slug: string): Promise<CameraSnapshotMeta>
  /**
   * Takes a refcounted hold on this camera's live stream: the
   * first `live()` on a slug starts the robot publishing, the last viewer
   * leaving stops it. Deliberately not deduplicated locally across multiple
   * `live()` calls for the same `(robotId, slug)` — unlike a datapoint
   * subscription, each call needs its own distinct LiveKit participant, so
   * a local counter here would just be the same shared-count bug the
   * subscription layer already fixed, self-inflicted on a resource the
   * cloud counts correctly on its own.
   */
  live(robotId: string, slug: string): Promise<CameraLiveSession>
}

const EMPTY_SNAPSHOT_META: CameraSnapshotMeta = { mime: null, width: null, height: null, timestamp_ms: null, age_ms: null }

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}


export function createCamerasApi(http: HttpClient): CamerasApi {
  return {
    async list(robotId) {
      const response: CameraListResponse = await http.request(`/api/robots/${pathSegment(robotId)}/cameras`, {})
      return response.cameras
    },

    async snapshot(robotId, slug) {
      try {
        const { body, headers } = await http.requestBinary(`/api/robots/${pathSegment(robotId)}/cameras/${pathSegment(slug)}/snapshot`)
        return {
          image: body,
          mime: mimeFromContentType(headers),
          width: headerNumber(headers, SNAPSHOT_HEADERS.width),
          height: headerNumber(headers, SNAPSHOT_HEADERS.height),
          timestamp_ms: headerNumber(headers, SNAPSHOT_HEADERS.timestampMs),
          age_ms: headerNumber(headers, SNAPSHOT_HEADERS.ageMs),
        }
      } catch (error) {
        if (error instanceof FleetlessError && error.code === 'no_snapshot_yet') return { image: null, ...EMPTY_SNAPSHOT_META }
        throw error
      }
    },

    async snapshotMeta(robotId, slug) {
      try {
        const response: SnapshotMetaResponse = await http.request(`/api/robots/${pathSegment(robotId)}/cameras/${pathSegment(slug)}/snapshot/meta`, {})
        return {
          mime: response.mime,
          width: response.width,
          height: response.height,
          timestamp_ms: response.timestamp_ms,
          age_ms: response.age_ms,
        }
      } catch (error) {
        // Defensive: JSON already encodes "nothing yet" as nulls, but
        // absorb `no_snapshot_yet` here too, so one camera route doesn't
        // throw where the other doesn't.
        if (error instanceof FleetlessError && error.code === 'no_snapshot_yet') return { ...EMPTY_SNAPSHOT_META }
        throw error
      }
    },

    async live(robotId, slug) {
      const response: LiveSessionResponse = await http.request(`/api/robots/${pathSegment(robotId)}/cameras/${pathSegment(slug)}/live`, {
        method: 'POST',
      })

      // `session_id` rides as a query param on the DELETE (contracts'
      // `releaseLiveQuery`), not a body — same precedent as `?force=true`
      // on robot deletion. URLSearchParams, not string interpolation, same
      // as historyQueryString, so a pathological session_id can't smuggle
      // in extra query syntax. `robotId`/`slug` get the same `pathSegment`
      // treatment as everywhere else — the query half was already
      // defended, the path half was not.
      const releasePath = `/api/robots/${pathSegment(robotId)}/cameras/${pathSegment(slug)}/live?${new URLSearchParams({ session_id: response.session_id })}`

      // Memoised so releasing twice (e.g. an explicit call racing an
      // unmount cleanup) never fires two DELETEs — the same idempotent
      // release()/unsubscribe() idiom used elsewhere in this SDK, just
      // async here because this, unlike a WS unsubscribe, is a real round
      // trip.
      let releasePromise: Promise<void> | null = null
      const release = (): Promise<void> => {
        if (!releasePromise) {
          // expectEmptyBody: true — this route answers 204 (contracts
          // rest.ts route table). `request()` doesn't exempt 204 from its
          // "did this route actually owe a body" check, so every
          // genuinely-204 call site says so explicitly.
          releasePromise = http
            .request(releasePath, { method: 'DELETE', expectEmptyBody: true })
            .then(() => undefined)
            // Best-effort: a courtesy notification, not what actually stops
            // the stream (see the release() doc comment on
            // CameraLiveSession) — nothing better to do with a failure from
            // here, so it is swallowed rather than surfaced.
            .catch(() => undefined)
        }
        return releasePromise
      }

      return {
        session_id: response.session_id,
        url: response.url,
        room: response.room,
        token: response.token,
        expires_at: response.expires_at,
        release,
      }
    },
  }
}
