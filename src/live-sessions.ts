// SPDX-License-Identifier: MIT
import type { LiveSessionEndReason, LiveStartRefusal } from '@fleetless/contracts'
import type { RealtimeChannel } from './realtime.js'

/**
 * Why a live camera session ended, as the cloud told the holder
 * (`live_session` on the realtime channel). What `CameraLiveSession.onEnded`
 * hands its handler.
 */
export interface CameraLiveEnded {
  /**
   * Why it ended. `start_refused`: the robot refused to start the camera's
   * live video, so the session never carried a picture; `publish_failed`: it
   * stopped after starting. A newer cloud may send a reason this version does
   * not name yet; treat an unknown one as `unknown`.
   */
  reason: LiveSessionEndReason
  /**
   * A sentence the cloud wrote, safe to show a person, or `null`. Never the
   * robot's own words. With `start_refused` it says why, e.g. "The robot's
   * link is weak, so live video is paused. Snapshots go on."
   */
  detail: string | null
  /**
   * With `start_refused`, the refusal as a class: `low_bandwidth`,
   * `source_auth`, `source_unreachable`, `not_startable` or `unknown`.
   * `null` for every other reason.
   */
  refusal: LiveStartRefusal | null
}

type Unlisten = () => void

/** How long `live()` waits for the realtime channel before it takes the hold anyway. */
export const LIVE_CHANNEL_READY_TIMEOUT_MS = 5_000
/** How many endings are kept for sessions nobody listens to yet. */
const ENDINGS_KEPT = 64

/**
 * The client's one listener on `live_session` frames
 * (fleetless/fleetless#1126). A start the robot refuses is answered in
 * milliseconds, so its ending can arrive before `live()` has even returned
 * the session; the last few endings are kept by session id, and `onEnded`
 * delivers a kept one at once.
 */
export interface LiveSessionEndings {
  /**
   * Opens the realtime channel and resolves once it has authenticated, has
   * failed for good, or `LIVE_CHANNEL_READY_TIMEOUT_MS` passed — never
   * rejects. `live()` awaits it before taking the hold, so the ending of
   * that hold cannot outrun the socket.
   */
  ready(): Promise<void>
  /** Calls `handler` once when the session `sessionId` ends, or soon if it already has. */
  onEnded(sessionId: string, handler: (ended: CameraLiveEnded) => void): Unlisten
}

export function createLiveSessionEndings(
  channel: RealtimeChannel,
  options: { readyTimeoutMs?: number } = {},
): LiveSessionEndings {
  const readyTimeoutMs = options.readyTimeoutMs ?? LIVE_CHANNEL_READY_TIMEOUT_MS
  const ended = new Map<string, CameraLiveEnded>()
  const handlers = new Map<string, Set<(ended: CameraLiveEnded) => void>>()
  let listening = false

  function listen(): void {
    if (listening) return
    listening = true
    channel.on('live_session', (frame) => {
      const parsed = parseEnding(frame)
      if (!parsed) return
      ended.set(parsed.sessionId, parsed.ended)
      if (ended.size > ENDINGS_KEPT) ended.delete(ended.keys().next().value!)
      const waiting = handlers.get(parsed.sessionId)
      if (!waiting) return
      handlers.delete(parsed.sessionId)
      for (const handler of waiting) handler(parsed.ended)
    })
  }

  return {
    ready() {
      listen()
      if (channel.isReady) return Promise.resolve()
      return new Promise<void>((resolve) => {
        let settled = false
        // Listening before `connect()`: a channel with no WebSocket at all
        // fails inside that very call, and its failure would otherwise pass
        // unheard until the timeout.
        const unlistenReady = channel.onReady(() => settle())
        const unlistenFailed = channel.onAuthFailed(() => settle())
        const timer = setTimeout(() => settle(), readyTimeoutMs)
        function settle(): void {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unlistenReady()
          unlistenFailed()
          resolve()
        }
        channel.connect()
      })
    },

    onEnded(sessionId, handler) {
      listen()
      let active = true
      const known = ended.get(sessionId)
      if (known) {
        queueMicrotask(() => {
          if (!active) return
          active = false
          handler(known)
        })
        return () => {
          active = false
        }
      }
      const once = (ending: CameraLiveEnded) => {
        if (!active) return
        active = false
        handler(ending)
      }
      let set = handlers.get(sessionId)
      if (!set) {
        set = new Set()
        handlers.set(sessionId, set)
      }
      set.add(once)
      return () => {
        active = false
        const current = handlers.get(sessionId)
        current?.delete(once)
        if (current?.size === 0) handlers.delete(sessionId)
      }
    },
  }
}

/**
 * A `live_session` frame, checked by hand: the contracts are types only in
 * this package. Anything malformed is ignored, as an unknown frame is.
 */
function parseEnding(frame: Record<string, unknown>): { sessionId: string; ended: CameraLiveEnded } | null {
  const { session_id: sessionId, state, reason, detail, refusal } = frame
  if (typeof sessionId !== 'string' || state !== 'ended' || typeof reason !== 'string') return null
  if (detail !== null && typeof detail !== 'string') return null
  if (refusal !== undefined && refusal !== null && typeof refusal !== 'string') return null
  return {
    sessionId,
    ended: {
      reason: reason as LiveSessionEndReason,
      detail,
      refusal: typeof refusal === 'string' ? (refusal as LiveStartRefusal) : null,
    },
  }
}
