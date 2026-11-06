// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientIdentity, CollectionRecord } from '@fleetless/contracts'
import { createClient, FleetlessError, InMemoryTokenStore } from '../src/index.js'
// Imported from the SDK's own public surface: a type-only export gives no
// runtime signal if it is deleted from `src/index.ts`, so this import is the
// compile-time guard that a caller can still name what `subscribe` hands them.
import type { CollectionEvent, CollectionSubscribeOptions } from '../src/index.js'
import { FakeWebSocket } from './fake-websocket.js'

const ROBOT = '4f2c1a90-7b3e-4d51-9c86-0a1b2c3d4e5f'
const RECORD_ID = '0b9a4f0e-5d36-4c44-8b0a-2f6d2b8d7c11'

const IDENTITY: ClientIdentity = {
  kind: 'app_user',
  developer_id: null,
  app_user_id: 'u1',
  server_key_id: null,
  app_id: 'app1',
  role: { key: 'operate', name: 'Operate' },
  email: 'a@b.de',
  two_factor_enabled: false,
}

const RECORD: CollectionRecord = {
  id: RECORD_ID,
  robot_id: ROBOT,
  created_at: '2026-11-05T08:00:00.000Z',
  created_by: { kind: 'app_user', id: '7a1d3a52-0d0e-4f4b-9d57-6a0f5c7f8e21', label: 'ada@example.com' },
  updated_at: '2026-11-05T08:00:00.000Z',
  updated_by: { kind: 'app_user', id: '7a1d3a52-0d0e-4f4b-9d57-6a0f5c7f8e21', label: 'ada@example.com' },
  revision: 1,
  display: 'Wheel swapped',
  values: { text: 'Wheel swapped' },
}

function currentSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1)
  if (!socket) throw new Error('no FakeWebSocket was constructed')
  return socket
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** Drives a freshly-connected fake socket through open + auth_ok. */
async function authenticate(): Promise<void> {
  await flush()
  currentSocket().simulateOpen()
  currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })
}

beforeEach(() => {
  FakeWebSocket.reset()
})

function loggedInClient() {
  const tokenStore = new InMemoryTokenStore()
  tokenStore.save({ access_token: 'at1', refresh_token: 'rt1', expires_in: 900 })
  return createClient({
    apiUrl: 'https://api.fleetless.dev',
    appIdentifier: 'app_x',
    tokenStore,
    fetch: vi.fn() as unknown as typeof fetch,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
  })
}

/** The `collection_subscribe` frames the current socket was sent, in order. */
function subscribeFrames(socket: FakeWebSocket = currentSocket()) {
  return socket.sent.filter((frame) => frame.type === 'collection_subscribe')
}

/** The request id the SDK chose for the nth `collection_subscribe` on the current socket. */
function requestIdOf(index: number, socket: FakeWebSocket = currentSocket()): string {
  const frame = subscribeFrames(socket)[index]
  if (!frame) throw new Error(`no collection_subscribe frame #${index} was sent`)
  return frame.request_id as string
}

function event(requestId: string, kind: string, extra: Record<string, unknown> = {}) {
  return { type: 'collection_event', request_id: requestId, event: kind, id: RECORD_ID, ...extra }
}

describe('collections.subscribe', () => {
  it('sends collection_subscribe with robot_id and filter once the channel is ready', async () => {
    const client = loggedInClient()
    const filter = { severity: { eq: 'warning' } }
    const options: CollectionSubscribeOptions = { robot: ROBOT, filter }

    client.collections.subscribe('logbook', options, vi.fn())
    await authenticate()

    expect(currentSocket().sent).toEqual([
      { type: 'auth', token: 'at1' },
      { type: 'collection_subscribe', request_id: expect.any(String), collection: 'logbook', robot_id: ROBOT, filter },
    ])
    expect(requestIdOf(0).length).toBeGreaterThan(0)
    expect(requestIdOf(0).length).toBeLessThanOrEqual(64)
  })

  it('keeps its own copy of the filter, so mutating the caller\'s object changes neither the first send nor a resend', async () => {
    vi.useFakeTimers()
    try {
      const client = loggedInClient()
      const filter = { severity: { eq: 'warning' } }
      client.collections.subscribe('logbook', { filter }, vi.fn())

      await vi.advanceTimersByTimeAsync(0)
      currentSocket().simulateOpen()
      // Reused for the next `list` before the subscription has to be sent again.
      filter.severity.eq = 'fault'
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })
      expect(subscribeFrames()[0]).toMatchObject({ filter: { severity: { eq: 'warning' } } })

      currentSocket().simulateClose()
      await vi.advanceTimersByTimeAsync(500)
      await vi.advanceTimersByTimeAsync(0)
      currentSocket().simulateOpen()
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })

      expect(FakeWebSocket.instances).toHaveLength(2)
      expect(subscribeFrames()[0]).toMatchObject({ filter: { severity: { eq: 'warning' } } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('copies a filter that is a Proxy, as a Vue reactive or a Svelte $state hands one over', async () => {
    const client = loggedInClient()
    // `structuredClone` throws a DataCloneError on a Proxy; the filter is JSON, so it is copied as JSON.
    const filter = new Proxy({ severity: { eq: 'warning' } }, {})

    client.collections.subscribe('logbook', { filter }, vi.fn())
    await authenticate()

    expect(subscribeFrames()[0]).toMatchObject({ filter: { severity: { eq: 'warning' } } })
  })

  it.each([
    ['a BigInt', () => ({ n: { gt: 10n } })],
    ['a function', () => ({ n: { gt: () => 1 } })],
    ['a number that is not finite', () => ({ n: { gt: Number.NaN } })],
    ['a cycle', () => {
      const filter: Record<string, unknown> = {}
      filter.self = filter
      return filter
    }],
  ])('refuses a filter holding %s with invalid_option, before anything is sent', async (_what, make) => {
    const client = loggedInClient()
    let thrown: unknown
    try {
      client.collections.subscribe('logbook', { filter: make() }, vi.fn())
    } catch (error) {
      thrown = error
    }
    await flush()

    expect(thrown).toBeInstanceOf(FleetlessError)
    expect(thrown).toMatchObject({ code: 'invalid_option' })
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('sends neither robot_id nor filter when the options carry none', async () => {
    const client = loggedInClient()

    client.collections.subscribe('locations', {}, vi.fn())
    await authenticate()

    expect(Object.keys(subscribeFrames()[0]!).sort()).toEqual(['collection', 'request_id', 'type'])
  })

  it('gives every subscription its own request_id, even to the same collection', async () => {
    const client = loggedInClient()

    client.collections.subscribe('logbook', { robot: ROBOT }, vi.fn())
    client.collections.subscribe('logbook', {}, vi.fn())
    await authenticate()

    expect(requestIdOf(0)).not.toBe(requestIdOf(1))
  })

  it('delivers events to the right handler by request_id', async () => {
    const client = loggedInClient()
    const first = vi.fn()
    const second = vi.fn()
    client.collections.subscribe('logbook', { robot: ROBOT }, first)
    client.collections.subscribe('logbook', {}, second)
    await authenticate()

    currentSocket().simulateMessage(event(requestIdOf(1), 'updated', { record: RECORD }))

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    // The handler gets the change, not the transport: no frame type, no request id.
    expect(second).toHaveBeenCalledWith({ event: 'updated', id: RECORD_ID, record: RECORD })

    currentSocket().simulateMessage(event(requestIdOf(0), 'created', { record: RECORD }))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('passes a removed event without a record through as it came, and ignores an event for a subscription it does not hold', async () => {
    const client = loggedInClient()
    const onEvent = vi.fn<(change: CollectionEvent) => void>()
    client.collections.subscribe('logbook', {}, onEvent)
    await authenticate()

    currentSocket().simulateMessage(event(requestIdOf(0), 'removed'))
    currentSocket().simulateMessage(event('somebody-elses', 'created', { record: RECORD }))

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith({ event: 'removed', id: RECORD_ID })
    expect('record' in onEvent.mock.calls[0]![0]).toBe(false)
  })

  it('two subscriptions to different collections do not cross', async () => {
    const client = loggedInClient()
    const logbook = vi.fn()
    const components = vi.fn()
    const logbookErrors = vi.fn()
    const componentErrors = vi.fn()
    client.collections.subscribe('logbook', { onError: logbookErrors }, logbook)
    client.collections.subscribe('components', { onError: componentErrors }, components)
    await authenticate()
    expect(subscribeFrames().map((frame) => frame.collection)).toEqual(['logbook', 'components'])

    currentSocket().simulateMessage(event(requestIdOf(1), 'created', { record: RECORD }))
    currentSocket().simulateMessage({ type: 'collection_subscribe_error', request_id: requestIdOf(0), code: 'forbidden', message: 'no' })

    expect(components).toHaveBeenCalledTimes(1)
    expect(logbook).not.toHaveBeenCalled()
    expect(logbookErrors).toHaveBeenCalledTimes(1)
    expect(componentErrors).not.toHaveBeenCalled()

    // The refusal ended the logbook subscription only.
    currentSocket().simulateMessage(event(requestIdOf(1), 'updated', { record: RECORD }))
    expect(components).toHaveBeenCalledTimes(2)
  })

  it('resubscribes after a reconnect with a fresh send', async () => {
    vi.useFakeTimers()
    try {
      const client = loggedInClient()
      const onEvent = vi.fn()
      client.collections.subscribe('logbook', { robot: ROBOT }, onEvent)

      await vi.advanceTimersByTimeAsync(0)
      currentSocket().simulateOpen()
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })
      const firstFrame = subscribeFrames()[0]
      expect(firstFrame).toBeDefined()

      currentSocket().simulateClose()
      await vi.advanceTimersByTimeAsync(500) // default initial backoff
      await vi.advanceTimersByTimeAsync(0)
      currentSocket().simulateOpen()
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })

      expect(FakeWebSocket.instances).toHaveLength(2)
      // A new socket knows nothing of the old one's subscriptions: the same
      // subscribe is sent again, and events flow on the new socket.
      expect(subscribeFrames()).toEqual([firstFrame])
      currentSocket().simulateMessage(event(requestIdOf(0), 'created', { record: RECORD }))
      expect(onEvent).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('collection_subscribe_error calls onError with the code and stops delivering', async () => {
    vi.useFakeTimers()
    try {
      const client = loggedInClient()
      const onEvent = vi.fn()
      const onError = vi.fn<(error: FleetlessError) => void>()
      const unsubscribe = client.collections.subscribe('logbook', { onError }, onEvent)

      await vi.advanceTimersByTimeAsync(0)
      currentSocket().simulateOpen()
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })
      const requestId = requestIdOf(0)

      currentSocket().simulateMessage({ type: 'collection_subscribe_error', request_id: requestId, code: 'collection_removed', message: 'The collection was removed.' })

      expect(onError).toHaveBeenCalledTimes(1)
      const error = onError.mock.calls[0]![0]
      expect(error).toBeInstanceOf(FleetlessError)
      expect(error).toMatchObject({ code: 'collection_removed', message: 'The collection was removed.' })

      currentSocket().simulateMessage(event(requestId, 'updated', { record: RECORD }))
      expect(onEvent).not.toHaveBeenCalled()

      // Nothing to cancel on the server, so unsubscribing afterwards sends nothing...
      currentSocket().sent.length = 0
      unsubscribe()
      expect(currentSocket().sent).toEqual([])

      // ...and the ended subscription is not revived by a reconnect.
      currentSocket().simulateClose()
      await vi.advanceTimersByTimeAsync(500)
      await vi.advanceTimersByTimeAsync(0)
      currentSocket().simulateOpen()
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })
      expect(subscribeFrames()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a subscription the caller ended is not revived by a reconnect', async () => {
    vi.useFakeTimers()
    try {
      const client = loggedInClient()
      const onEvent = vi.fn()
      const unsubscribe = client.collections.subscribe('logbook', { robot: ROBOT }, onEvent)

      await vi.advanceTimersByTimeAsync(0)
      currentSocket().simulateOpen()
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })
      const requestId = requestIdOf(0)
      unsubscribe()

      currentSocket().simulateClose()
      await vi.advanceTimersByTimeAsync(500)
      await vi.advanceTimersByTimeAsync(0)
      currentSocket().simulateOpen()
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })

      expect(FakeWebSocket.instances).toHaveLength(2)
      expect(subscribeFrames()).toEqual([])
      currentSocket().simulateMessage(event(requestId, 'updated', { record: RECORD }))
      expect(onEvent).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('unsubscribe sends collection_unsubscribe once and is idempotent', async () => {
    const client = loggedInClient()
    const onEvent = vi.fn()
    const unsubscribe = client.collections.subscribe('logbook', {}, onEvent)
    await authenticate()
    const requestId = requestIdOf(0)
    currentSocket().sent.length = 0

    unsubscribe()
    unsubscribe()

    expect(currentSocket().sent).toEqual([{ type: 'collection_unsubscribe', request_id: requestId }])
    currentSocket().simulateMessage(event(requestId, 'created', { record: RECORD }))
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('unsubscribing one subscription leaves the others live', async () => {
    const client = loggedInClient()
    const kept = vi.fn()
    const unsubscribeFirst = client.collections.subscribe('logbook', {}, vi.fn())
    client.collections.subscribe('logbook', { robot: ROBOT }, kept)
    await authenticate()
    const keptId = requestIdOf(1)

    unsubscribeFirst()

    currentSocket().simulateMessage(event(keptId, 'created', { record: RECORD }))
    expect(kept).toHaveBeenCalledTimes(1)
  })

  it('unsubscribing before the channel ever authenticates sends nothing — and nothing is sent once it does', async () => {
    const client = loggedInClient()
    const unsubscribe = client.collections.subscribe('logbook', {}, vi.fn())
    unsubscribe()

    await authenticate()

    expect(currentSocket().sent).toEqual([{ type: 'auth', token: 'at1' }])
  })

  it('unsubscribing on the tick the channel is already ready does not leave a subscription behind', async () => {
    const client = loggedInClient()
    client.collections.subscribe('logbook', {}, vi.fn())
    await authenticate()
    currentSocket().sent.length = 0

    // The channel is authenticated, so this subscribe is announced from a
    // microtask. Cancelling before that runs must cancel the announcement too.
    const unsubscribe = client.collections.subscribe('components', {}, vi.fn())
    unsubscribe()
    await flush()

    expect(currentSocket().sent.filter((frame) => frame.type === 'collection_subscribe')).toEqual([])
    expect(currentSocket().sent.filter((frame) => frame.type === 'collection_unsubscribe')).toEqual([])
  })

  it('onSchemaPublished fires for every subscription', async () => {
    const client = loggedInClient()
    const onFirst = vi.fn()
    const onSecond = vi.fn()
    client.collections.subscribe('logbook', { onSchemaPublished: onFirst }, vi.fn())
    client.collections.subscribe('components', { onSchemaPublished: onSecond }, vi.fn())
    // One without a handler must not get in the way.
    client.collections.subscribe('locations', {}, vi.fn())
    await authenticate()

    currentSocket().simulateMessage({ type: 'collections_schema_published', version: 6 })

    expect(onFirst).toHaveBeenCalledExactlyOnceWith(6)
    expect(onSecond).toHaveBeenCalledExactlyOnceWith(6)
  })

  it('onSchemaPublished stops firing for a subscription that unsubscribed', async () => {
    const client = loggedInClient()
    const onGone = vi.fn()
    const onKept = vi.fn()
    const unsubscribe = client.collections.subscribe('logbook', { onSchemaPublished: onGone }, vi.fn())
    client.collections.subscribe('components', { onSchemaPublished: onKept }, vi.fn())
    await authenticate()

    unsubscribe()
    currentSocket().simulateMessage({ type: 'collections_schema_published', version: 7 })

    expect(onGone).not.toHaveBeenCalled()
    expect(onKept).toHaveBeenCalledExactlyOnceWith(7)
  })

  it('onSchemaPublished does not reach a subscription that a callback earlier in the same pass ended', async () => {
    const client = loggedInClient()
    const onSecond = vi.fn()
    let unsubscribeSecond: () => void = () => {}
    client.collections.subscribe('logbook', { onSchemaPublished: () => unsubscribeSecond() }, vi.fn())
    unsubscribeSecond = client.collections.subscribe('components', { onSchemaPublished: onSecond }, vi.fn())
    await authenticate()

    currentSocket().simulateMessage({ type: 'collections_schema_published', version: 8 })

    expect(onSecond).not.toHaveBeenCalled()
  })

  it('reports a failed authentication to every live subscription through onError', async () => {
    // No session was ever saved: the channel cannot obtain a credential.
    const client = createClient({
      apiUrl: 'https://api.fleetless.dev',
      appIdentifier: 'app_x',
      fetch: vi.fn() as unknown as typeof fetch,
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    })
    const onErrorA = vi.fn<(error: FleetlessError) => void>()
    const onErrorB = vi.fn<(error: FleetlessError) => void>()
    client.collections.subscribe('logbook', { onError: onErrorA }, vi.fn())
    client.collections.subscribe('components', { onError: onErrorB }, vi.fn())

    await flush()

    expect(onErrorA).toHaveBeenCalledTimes(1)
    expect(onErrorA.mock.calls[0]![0]).toMatchObject({ code: 'no_session' })
    expect(onErrorB).toHaveBeenCalledTimes(1)
  })

  it('a failed authentication does not reach a subscription that an earlier onError ended', async () => {
    const client = createClient({
      apiUrl: 'https://api.fleetless.dev',
      appIdentifier: 'app_x',
      fetch: vi.fn() as unknown as typeof fetch,
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    })
    const onErrorSecond = vi.fn<(error: FleetlessError) => void>()
    let unsubscribeSecond: () => void = () => {}
    client.collections.subscribe('logbook', { onError: () => unsubscribeSecond() }, vi.fn())
    unsubscribeSecond = client.collections.subscribe('components', { onError: onErrorSecond }, vi.fn())

    await flush()

    expect(onErrorSecond).not.toHaveBeenCalled()
  })

  it('a connection the cloud ends with close 4003 reports token_revoked to every live subscription and does not reconnect', async () => {
    vi.useFakeTimers()
    try {
      const client = loggedInClient()
      const onErrorA = vi.fn<(error: FleetlessError) => void>()
      const onErrorB = vi.fn<(error: FleetlessError) => void>()
      client.collections.subscribe('logbook', { onError: onErrorA }, vi.fn())
      client.collections.subscribe('components', { onError: onErrorB }, vi.fn())
      await vi.advanceTimersByTimeAsync(0)
      currentSocket().simulateOpen()
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })

      currentSocket().simulateClose(4003, 'account_unavailable')
      await vi.advanceTimersByTimeAsync(60_000)

      expect(onErrorA).toHaveBeenCalledTimes(1)
      expect(onErrorA.mock.calls[0]![0]).toMatchObject({ code: 'token_revoked' })
      expect(onErrorB).toHaveBeenCalledTimes(1)
      expect(FakeWebSocket.instances).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
