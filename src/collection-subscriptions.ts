// SPDX-License-Identifier: MIT
import type {
  CollectionEvent as WireCollectionEvent,
  CollectionSubscribe,
  CollectionSubscribeError,
  CollectionUnsubscribe,
  CollectionsSchemaPublished,
} from '@fleetless/contracts'
import { FleetlessError } from './errors.js'
import { copyFilter } from './filter-json.js'
import type { RealtimeChannel } from './realtime.js'

/**
 * One change to a record, as `collections.subscribe` hands it to its
 * callback.
 *
 * - `event` is `created`, `updated` or `deleted` when the record was written,
 *   and `removed` or `entered` when it left or came into view of this
 *   subscription without being deleted or created: its values stopped or
 *   started matching the subscription's filter, the caller's role lost or
 *   gained the right to read it, or its robot was detached or attached.
 * - `id` is the record's id.
 * - `record` is the whole record: as it is now for `created`, `updated`,
 *   `entered` and `removed`, and as it was for `deleted`. It is absent only on
 *   a `removed` event for a record the caller may no longer read, so that its
 *   values are not told; the `id` still is.
 *
 * The wire frame is contracts' `collectionEvent`; the SDK hands over the
 * change itself, without the frame's `type` and `request_id`.
 */
export type CollectionEvent = Omit<WireCollectionEvent, 'type' | 'request_id'>

/**
 * What `collections.subscribe` takes besides the collection and the change
 * callback. Every field is optional.
 */
export interface CollectionSubscribeOptions {
  /** Only the records of this robot, in a collection that belongs to robots. */
  robot?: string
  /**
   * Only records matching this filter are delivered. It is the `filter` of
   * `collections.list` — the same grammar, at most 3 levels and 50
   * conditions — and a record that stops matching is announced once as
   * `removed`. The SDK keeps a copy, so changing the object afterwards
   * changes nothing; a reactive proxy (Vue, Svelte, MobX) is fine. The filter
   * has to be plain JSON: a value JSON cannot hold (a BigInt, a function, a
   * number that is not finite, a cycle) makes `subscribe` throw
   * `invalid_option` before anything is sent.
   *
   * The whole subscription frame, filter included, may be at most 16,384
   * bytes (UTF-8): the cloud closes the connection for a larger one. A filter
   * of a few dozen conditions fits; many long values in `in` lists may not.
   * `subscribe` throws `invalid_option` for a frame over that, before anything
   * is sent, so narrow the filter or follow the collection by `robot`.
   */
  filter?: Record<string, unknown>
  /**
   * Called when the cloud refuses the subscription (`collection_not_found`
   * for a collection that does not exist or that the caller may not read,
   * `forbidden`, `robot_not_attached`, `validation_error` for a filter it
   * cannot read), and when a running one ends: `collection_removed` after a
   * publish removed the collection, or `forbidden` / `robot_not_attached`
   * when a role change or a detached robot no longer allows it. The
   * subscription is over then and delivers nothing more. Also called, without
   * ending the subscription, when the channel cannot authenticate at all
   * (`no_session`, for instance).
   */
  onError?(error: FleetlessError): void
  /**
   * Called with the schema version now in force when a developer publishes or
   * restores the app's collections. Rights, fields and collections may have
   * changed: read `collections.definitions` again.
   */
  onSchemaPublished?(version: number): void
}

export interface CollectionSubscriptions {
  /** See `CollectionsApi.subscribe`. */
  subscribe(collection: string, options: CollectionSubscribeOptions, onEvent: (event: CollectionEvent) => void): () => void
}

/**
 * The most the cloud accepts in one frame on the realtime socket; a larger one
 * closes the whole socket (code 1009) instead of being answered. The same
 * limit applies to every frame the SDK sends, but only `collection_subscribe`,
 * carrying a caller's filter, can approach it.
 */
const MAX_FRAME_BYTES = 16_384

/** One open subscription: the wire name it goes by and what to tell the caller. */
interface LiveSubscription {
  options: CollectionSubscribeOptions
  onEvent: (event: CollectionEvent) => void
  /** Stops listening for the channel's (re)connection; the subscription is no longer announced. */
  stopAnnouncing(): void
}

/**
 * Owns the wire lifecycle of collection subscriptions on the client's one
 * channel. Unlike slug subscriptions these are not shared: each `subscribe`
 * call is its own subscription under its own `request_id`, because a caller
 * may follow the same collection twice with different filters and the events
 * of each must stay apart.
 */
export function createCollectionSubscriptions(channel: RealtimeChannel): CollectionSubscriptions {
  const live = new Map<string, LiveSubscription>()
  // The name the cloud echoes on every frame about a subscription. It only has
  // to be unique among this client's subscriptions: there is one socket per
  // client, and a new socket after a reconnect starts with none.
  let counter = 0

  // Registered once for the whole channel and dispatched by `request_id`,
  // like the slug layer does, rather than wired and torn down per subscription.
  channel.on('collection_event', (frame) => {
    const wire = frame as unknown as WireCollectionEvent
    const subscription = live.get(wire.request_id)
    if (!subscription) return
    const change: CollectionEvent = { event: wire.event, id: wire.id }
    if (wire.record !== undefined) change.record = wire.record
    subscription.onEvent(change)
  })

  channel.on('collection_subscribe_error', (frame) => {
    const wire = frame as unknown as CollectionSubscribeError
    const subscription = live.get(wire.request_id)
    if (!subscription) return
    // The cloud ended it (refused, or removed under a running subscription):
    // forget it first, so nothing resubscribes it and nothing more is delivered.
    live.delete(wire.request_id)
    subscription.stopAnnouncing()
    subscription.options.onError?.(new FleetlessError(wire.code, wire.message))
  })

  channel.on('collections_schema_published', (frame) => {
    const { version } = frame as unknown as CollectionsSchemaPublished
    for (const [requestId, subscription] of [...live]) {
      // A callback earlier in this pass may have ended this subscription.
      if (live.get(requestId) !== subscription) continue
      subscription.options.onSchemaPublished?.(version)
    }
  })

  channel.onAuthFailed((error) => {
    for (const [requestId, subscription] of [...live]) {
      if (live.get(requestId) !== subscription) continue
      subscription.options.onError?.(error)
    }
  })

  return {
    subscribe(collection, options, onEvent) {
      // A copy: the frame is built once and sent again after every reconnect,
      // so a caller that reuses its filter object for the next `list` must not
      // change what the subscription follows. Made first, so a filter that is
      // refused leaves no request id and no channel behind.
      const filter = options.filter === undefined ? undefined : copyFilter(options.filter)
      const requestId = `c${counter + 1}`

      const frame: CollectionSubscribe = { type: 'collection_subscribe', request_id: requestId, collection }
      if (options.robot !== undefined) frame.robot_id = options.robot
      if (filter !== undefined) frame.filter = filter

      // The frame is sent again after every reconnect, so a frame over the
      // limit would be closed on again and again, and every other subscription
      // of the client with it. Refused here, before the request id is taken
      // and before the channel is opened.
      const bytes = new TextEncoder().encode(JSON.stringify(frame)).length
      if (bytes > MAX_FRAME_BYTES) {
        throw new FleetlessError(
          'invalid_option',
          `This subscription is ${bytes.toLocaleString('en-US')} bytes on the wire and the cloud takes at most ${MAX_FRAME_BYTES.toLocaleString('en-US')}: narrow the filter (fewer conditions or shorter lists of values) or follow the collection by robot.`,
        )
      }
      counter += 1

      // Whether the cloud has been told on the current connection. A subscribe
      // cancelled before it was sent has nothing to cancel on the other side.
      let announced = false
      const stopAnnouncing = channel.onReady(() => {
        // `onReady` on an already-authenticated channel runs from a microtask,
        // so a cancellation in between must win.
        if (!live.has(requestId)) return
        announced = true
        channel.send(frame)
      })
      live.set(requestId, { options, onEvent, stopAnnouncing })
      channel.connect()

      return () => {
        // Already over: unsubscribed before, or ended by the cloud.
        if (!live.has(requestId)) return
        live.delete(requestId)
        stopAnnouncing()
        if (!announced) return
        const unsubscribe: CollectionUnsubscribe = { type: 'collection_unsubscribe', request_id: requestId }
        channel.send(unsubscribe)
      }
    },
  }
}
