// SPDX-License-Identifier: MIT
import type { JobEvent } from '@fleetless/contracts'
import { FleetlessError } from './errors.js'
import type { RealtimeChannel } from './realtime.js'
import type { SlugSubscriptionHandle, SlugSubscriptions } from './slug-subscriptions.js'

/**
 * The callbacks `actions.subscribe` reports through: one for every job
 * update on the slug, one for a refusal of the subscription itself.
 */
export interface JobSubscriptionHandlers {
  /** Called on every update pushed for the slug's current job — state, feedback, progress and result. */
  onJob(event: JobEvent): void
  /** Called once if the subscription is refused, e.g. `forbidden` or an unknown slug. */
  onError?(error: FleetlessError): void
}

/** A live job subscription, returned by `actions.subscribe`. */
export interface JobSubscription {
  /**
   * Stops this subscription. The `unsubscribe` frame reaches the server only
   * when this was the **last** holder of the robot/slug pair and the channel
   * is connected — subscriptions are reference-counted across kinds, so a
   * second `actions.subscribe`, `datapoints.subscribe` or in-flight
   * `services.call` on the same pair keeps its stream running. Safe to call
   * more than once.
   */
  unsubscribe(): void
}

export interface JobSubscriptions {
  /**
   * Subscribes to job updates for one `(robotId, slug)` — the same wire
   * `subscribe`/`unsubscribe` frames `datapoints.subscribe` uses — slugs
   * are one namespace across kinds — filtered here to `job` frames instead
   * of `datapoint` ones. Ref-counted exactly like `datapoints.subscribe`,
   * and over the *same* count: one shared layer owns the wire lifecycle for
   * a key regardless of which kind-specific
   * registry is asking, so a concurrent `actions.subscribe` and an in-flight
   * `services.call` on the same slug never issue two wire subscriptions for
   * it, and releasing one never cancels the other's stream out from under it
   * (a real bug this design replaced: two independent counters over the same
   * key).
   */
  subscribe(robotId: string, slug: string, handlers: JobSubscriptionHandlers): JobSubscription
}

/** One entry per distinct `(robotId, slug)` currently subscribed, shared by every caller on that pair. */
interface KeyState {
  handlers: Set<JobSubscriptionHandlers>
  unlistenEvent: () => void
  slugHandle: SlugSubscriptionHandle
}

function keyOf(robotId: string, slug: string): string {
  return `${robotId} ${slug}`
}

function createKeyState(channel: RealtimeChannel, slugSubscriptions: SlugSubscriptions, robotId: string, slug: string): KeyState {
  const handlers = new Set<JobSubscriptionHandlers>()

  const unlistenEvent = channel.on('job', (frame) => {
    const event = frame as unknown as JobEvent
    if (event.robot_id !== robotId || event.slug !== slug) return
    for (const handler of handlers) handler.onJob(event)
  })

  // The wire subscribe/unsubscribe and its ref count are owned by the
  // shared layer, not here — see slug-subscriptions.ts for why.
  const slugHandle = slugSubscriptions.acquire(robotId, slug, {
    onSubscribeError(error) {
      for (const handler of handlers) handler.onError?.(error)
    },
    onAuthFailed(error) {
      for (const handler of handlers) handler.onError?.(error)
    },
  })

  return { handlers, unlistenEvent, slugHandle }
}

export function createJobSubscriptions(channel: RealtimeChannel, slugSubscriptions: SlugSubscriptions): JobSubscriptions {
  const registry = new Map<string, KeyState>()

  return {
    subscribe(robotId, slug, handlers) {
      const key = keyOf(robotId, slug)
      let state = registry.get(key)
      if (!state) {
        state = createKeyState(channel, slugSubscriptions, robotId, slug)
        registry.set(key, state)
      }
      state.handlers.add(handlers)

      let active = true
      return {
        unsubscribe() {
          if (!active) return
          active = false

          const current = registry.get(key)
          if (!current) return
          current.handlers.delete(handlers)
          if (current.handlers.size > 0) return // other subscribers on this key are still live

          current.unlistenEvent()
          current.slugHandle.release()
          registry.delete(key)
        },
      }
    },
  }
}
