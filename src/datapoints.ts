// SPDX-License-Identifier: MIT
import type { DatapointEvent, DatapointValue, HistoryBucketsResponse, HistorySamplesResponse } from '@fleetless/contracts'
import { FleetlessError } from './errors.js'
import { pathSegment, type HttpClient } from './http.js'
import type { RealtimeChannel } from './realtime.js'
import type { SlugSubscriptionHandle, SlugSubscriptions } from './slug-subscriptions.js'

/**
 * The callbacks `datapoints.subscribe` reports through: one for values, one
 * for a refusal. `onEvent` fires immediately with the current value and
 * again on every change.
 */
export interface DatapointSubscriptionHandlers {
  /** Called with the current value on subscribe, then again on every change. */
  onEvent(event: DatapointEvent): void
  /** Called once if the subscription is refused, e.g. `forbidden` or `unknown_datapoint`. */
  onError?(error: FleetlessError): void
}

/** A live datapoint subscription, returned by `datapoints.subscribe`. */
export interface DatapointSubscription {
  /**
   * Stops this subscription. The `unsubscribe` frame reaches the server only
   * when this was the **last** holder of the robot/slug pair and the channel
   * is connected — subscriptions are reference-counted across kinds, so
   * releasing this one while a `datapoints.subscribe`, `actions.subscribe` or
   * in-flight `services.call` still holds the same pair leaves that one's
   * stream running. Safe to call more than once.
   */
  unsubscribe(): void
}

/**
 * Window aggregation for `datapoints.history`. `window` and `agg` always
 * travel together on the wire — the cloud refuses one without the other
 * rather than defaulting either, since a silently chosen aggregation is a
 * chart that lies quietly — so they live in one object instead of two
 * optional fields a caller could set only one of. Same reasoning as
 * `cameraSource`'s discriminated union: make the impossible combination
 * unrepresentable, not merely rejected.
 */
export interface HistoryAggregation {
  /** Bucket width, e.g. `10s`, `1m`. */
  window: string
  /** How to reduce each bucket's samples to one number. */
  agg: 'min' | 'max' | 'avg'
  /** A numeric field inside an object value, e.g. `pose.x`. Only meaningful when the datapoint's own value is not itself a number. */
  field?: string
}

/**
 * The window `datapoints.history` reads. `aggregate` decides whether the
 * response is raw samples or aggregated buckets.
 */
export interface HistoryOptions {
  /**
   * `now-30s` / `now-5m` / `now-1h`, or absolute unix milliseconds — as a
   * **string** either way, exactly as the wire query expects it. The SDK
   * does not accept a `Date` or a `number` and stringify it for you: that
   * would be a convenience that quietly decides which of the two forms you
   * meant, and the next person reading the wire traffic would not know
   * which of us made that call.
   */
  from: string
  /** Same two forms as `from`. Defaults to now. */
  to?: string
  /** The most rows to return. The platform applies its own ceiling regardless. */
  limit?: number
  /** Present: the result is aggregated buckets. Absent: raw samples. */
  aggregate?: HistoryAggregation
}

/**
 * A robot's exposed values, reachable as `client.datapoints`: the latest
 * one, a live subscription to it, and — for a datapoint configured with
 * retention — its recorded history.
 */
export interface DatapointsApi {
  /**
   * Reads the datapoint's latest value over REST, once. It carries the
   * bridge's own capture time, so a caller can tell a fresh value from a
   * stale one without a subscription.
   */
  get(robotId: string, slug: string): Promise<DatapointValue>
  /**
   * Subscribes over the realtime channel. Reconnect and re-authentication
   * are handled by the shared `RealtimeChannel`; this resends its
   * `subscribe` frame after every (re)connect, so a network drop is
   * invisible to the caller beyond a gap in events.
   *
   * Reference-counted per `(robotId, slug)`: two subscriptions to the same
   * pair share one wire subscription. Unsubscribing one never affects the
   * other — the `unsubscribe` frame is sent only when the last subscriber
   * on that pair goes away. In practice: two widgets showing the same
   * battery value, or a component mounted twice under React StrictMode,
   * subscribe to the same key. That count is shared with
   * `actions.subscribe` and `services.call` — a slug is one namespace across
   * kinds, and so is its subscription.
   */
  subscribe(robotId: string, slug: string, handlers: DatapointSubscriptionHandlers): DatapointSubscription
  /**
   * Reads recorded history for a `retention: true` datapoint over REST — no
   * realtime channel involved, the same way `cameras.snapshot` isn't. **This
   * overload is the aggregated one:** `aggregate` is given, so it resolves
   * with `HistoryBucketsResponse` (`kind: 'buckets'`) — one row per window,
   * reduced by `aggregate.agg`. Leave `aggregate` out and the other overload
   * gives you raw samples instead.
   *
   * Two overloads rather than one union, so a caller who already knows which
   * one they asked for isn't forced to narrow it. `kind` carries the same
   * information either way, so dynamic code can still branch on it.
   *
   * **Rejects, does not silently empty out, two specific refusals** —
   * unlike `cameras.snapshot`'s absorption of `no_snapshot_yet` into a null
   * read, these two must reach the caller as a rejected `FleetlessError`:
   * - `not_recorded` — the slug exists and is granted, but is configured
   *   live-only. An empty result here would look exactly like "recorded,
   *   but nothing in this window", and the two need opposite fixes: turn
   *   recording on, versus look at a different range.
   * - `not_aggregatable` — `aggregate` was given for a value that isn't a
   *   number and no numeric `aggregate.field` was named.
   */
  history(
    robotId: string,
    slug: string,
    options: HistoryOptions & { aggregate: HistoryAggregation },
  ): Promise<HistoryBucketsResponse>
  /**
   * The same read without `aggregate`: resolves with
   * `HistorySamplesResponse` (`kind: 'samples'`), every recorded sample in
   * the window as a `timestamp_ms` and a `value`. `timestamp_ms` is the
   * bridge's own capture time, the same instant the live value carried, so a
   * recorded point and a live one sit on one axis without apology.
   *
   * **Read `truncated`.** The platform caps how much one read returns, by
   * row count or by bytes, and `truncated_by` says which. A short array that
   * does not admit it is indistinguishable from a quiet period, and the two
   * lead to opposite conclusions. Refuses `not_recorded` the same way the
   * aggregated overload does.
   */
  history(robotId: string, slug: string, options: HistoryOptions & { aggregate?: undefined }): Promise<HistorySamplesResponse>
}

/** One entry per distinct `(robotId, slug)` currently subscribed, shared by every caller on that pair. */
interface KeyState {
  handlers: Set<DatapointSubscriptionHandlers>
  unlistenEvent: () => void
  slugHandle: SlugSubscriptionHandle
}

function keyOf(robotId: string, slug: string): string {
  return `${robotId} ${slug}`
}

/** Wires the datapoint-event listener for a key exactly once, fanning every frame out to all of its handlers. */
function createKeyState(channel: RealtimeChannel, slugSubscriptions: SlugSubscriptions, robotId: string, slug: string): KeyState {
  const handlers = new Set<DatapointSubscriptionHandlers>()

  const unlistenEvent = channel.on('datapoint', (frame) => {
    const event = frame as unknown as DatapointEvent
    if (event.robot_id !== robotId || event.slug !== slug) return
    for (const handler of handlers) handler.onEvent(event)
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

/** `from`/`to`/`limit`/`aggregate` -> the wire query string, omitting whatever the caller didn't set rather than sending it empty. */
function historyQueryString(options: HistoryOptions): string {
  const params = new URLSearchParams()
  params.set('from', options.from)
  if (options.to !== undefined) params.set('to', options.to)
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.aggregate) {
    params.set('window', options.aggregate.window)
    params.set('agg', options.aggregate.agg)
    if (options.aggregate.field !== undefined) params.set('field', options.aggregate.field)
  }
  return params.toString()
}

export function createDatapointsApi(http: HttpClient, channel: RealtimeChannel, slugSubscriptions: SlugSubscriptions): DatapointsApi {
  const registry = new Map<string, KeyState>()

  // Declared as an overloaded function, not a method on the object literal
  // below — that's the only shape TypeScript lets an implementation's
  // broader union return type satisfy a narrower public overload set. The
  // literal just hands this through unchanged.
  function history(
    robotId: string,
    slug: string,
    options: HistoryOptions & { aggregate: HistoryAggregation },
  ): Promise<HistoryBucketsResponse>
  function history(robotId: string, slug: string, options: HistoryOptions & { aggregate?: undefined }): Promise<HistorySamplesResponse>
  async function history(robotId: string, slug: string, options: HistoryOptions): Promise<HistorySamplesResponse | HistoryBucketsResponse> {
    const query = historyQueryString(options)
    const result: HistorySamplesResponse | HistoryBucketsResponse = await http.request(
      `/api/robots/${pathSegment(robotId)}/datapoints/${pathSegment(slug)}/history?${query}`,
      {},
    )
    return result
  }

  return {
    async get(robotId, slug) {
      const value: DatapointValue = await http.request(`/api/robots/${pathSegment(robotId)}/datapoints/${pathSegment(slug)}`, {})
      return value
    },

    history,

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
