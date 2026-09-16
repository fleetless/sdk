// SPDX-License-Identifier: MIT
import type { ClientSubscribe, ClientUnsubscribe } from '@fleetless/contracts'
import { FleetlessError } from './errors.js'
import type { RealtimeChannel } from './realtime.js'

/**
 * Owns the wire `subscribe`/`unsubscribe` lifecycle for one `(robotId,
 * slug)` at a time — `datapoints.ts` and `job-subscriptions.ts` both sit on
 * top of it, so there is exactly **one** ref count per key, not one per
 * kind-specific registry. The wire protocol only knows one subscription per
 * `(robot_id, slug)`, never "per local module that asked".
 *
 * Review finding: the two registries used to keep separate counters over the
 * same key, each free to send the real `unsubscribe` when *its own* count
 * hit zero — so releasing the last datapoint-side handler silently cancelled
 * the job-side subscriber too, and vice versa, with no error reported.
 * Centralising the count is the fix: a kind-specific registry only adds and
 * removes *itself* via `acquire`/`release`, and can no longer accidentally
 * cancel someone else's subscription. A third stream kind is a third caller
 * of this layer, not a third counter over the same key.
 */
export interface SlugSubscriptionCallbacks {
  /** The wire subscribe for this key was refused, e.g. `forbidden`, `unknown_datapoint` or `not_subscribable`. */
  onSubscribeError(error: FleetlessError): void
  /** The channel's authentication failed outright (no retry coming). */
  onAuthFailed(error: FleetlessError): void
}

export interface SlugSubscriptionHandle {
  /** Releases this caller's hold on the key. The wire `unsubscribe` is sent only once every holder has released. */
  release(): void
}

export interface SlugSubscriptions {
  /**
   * Registers one more holder of `(robotId, slug)`, sending the wire
   * `subscribe` frame (and connecting the channel) if this is the first
   * holder, and resending it after every reconnect for as long as anyone
   * holds the key. `callbacks` receives `subscribe_error`/auth-failure
   * notifications for exactly this key — fan them out to whatever a
   * particular kind's own subscription handlers expect.
   */
  acquire(robotId: string, slug: string, callbacks: SlugSubscriptionCallbacks): SlugSubscriptionHandle
}

interface KeyState {
  count: number
  callbacks: Set<SlugSubscriptionCallbacks>
  unlistenReady: () => void
}

function keyOf(robotId: string, slug: string): string {
  return `${robotId} ${slug}`
}

export function createSlugSubscriptions(channel: RealtimeChannel): SlugSubscriptions {
  const registry = new Map<string, KeyState>()

  // Registered once for the whole channel, not once per key: dispatches by
  // the frame's own (robot_id, slug) rather than a per-key listener that
  // would need wiring up and tearing down on every acquire/release.
  channel.on('subscribe_error', (frame) => {
    const error = frame as unknown as { robot_id: string; slug: string; code: string; message: string }
    const state = registry.get(keyOf(error.robot_id, error.slug))
    if (!state) return
    const fleetlessError = new FleetlessError(error.code, error.message)
    for (const callbacks of state.callbacks) callbacks.onSubscribeError(fleetlessError)
  })

  channel.onAuthFailed((error) => {
    for (const state of registry.values()) {
      for (const callbacks of state.callbacks) callbacks.onAuthFailed(error)
    }
  })

  return {
    acquire(robotId, slug, callbacks) {
      const key = keyOf(robotId, slug)
      let state = registry.get(key)
      if (!state) {
        const unlistenReady = channel.onReady(() => {
          const frame: ClientSubscribe = { type: 'subscribe', robot_id: robotId, slug }
          channel.send(frame)
        })
        state = { count: 0, callbacks: new Set(), unlistenReady }
        registry.set(key, state)
      }
      state.count += 1
      state.callbacks.add(callbacks)
      channel.connect()

      let released = false
      return {
        release() {
          if (released) return
          released = true

          const current = registry.get(key)
          if (!current) return
          current.callbacks.delete(callbacks)
          current.count -= 1
          if (current.count > 0) return // other holders on this key are still live

          current.unlistenReady()
          registry.delete(key)
          const frame: ClientUnsubscribe = { type: 'unsubscribe', robot_id: robotId, slug }
          channel.send(frame)
        },
      }
    },
  }
}
