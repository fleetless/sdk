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

/** Brings a fresh client's first socket up to auth_ok; fake timers must be on. */
async function connectFirst(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  currentSocket().simulateOpen()
  currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })
}

/** Drops the current socket and brings the reconnect up to auth_ok; fake timers must be on. */
async function reconnect(): Promise<void> {
  currentSocket().simulateClose()
  await vi.advanceTimersByTimeAsync(500) // default initial backoff
  await vi.advanceTimersByTimeAsync(0)
  currentSocket().simulateOpen()
  currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })
}

/** The whole frame of `collection_subscribe` 'logbook' as the first subscription of a client sends it, in bytes. */
function frameBytes(filter: Record<string, unknown>): number {
  const frame = { type: 'collection_subscribe', request_id: 'c1', collection: 'logbook', filter }
  return new TextEncoder().encode(JSON.stringify(frame)).length
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

  describe('a subscription frame larger than the cloud takes', () => {
    // The cloud closes the whole realtime socket (code 1009) for a frame above
    // 16,384 bytes. Sent anyway, the SDK would reconnect, send the same frame
    // again and be closed again, taking every other subscription of the client
    // down with it, so such a subscription is refused before it is sent.
    const LIMIT = 16_384

    /** A filter whose subscribe frame is exactly `bytes` long: `char`, padded with ASCII to the byte. */
    function filterOfFrameSize(bytes: number, char = 'a'): Record<string, unknown> {
      const missing = bytes - frameBytes({ note: { eq: '' } })
      const width = new TextEncoder().encode(char).length
      const whole = Math.floor(missing / width)
      return { note: { eq: char.repeat(whole) + 'a'.repeat(missing - whole * width) } }
    }

    it('sends a frame of exactly 16,384 bytes', async () => {
      const client = loggedInClient()
      const filter = filterOfFrameSize(LIMIT)
      expect(frameBytes(filter)).toBe(LIMIT)

      client.collections.subscribe('logbook', { filter }, vi.fn())
      await authenticate()

      expect(subscribeFrames()).toHaveLength(1)
    })

    it('refuses a frame one byte over with invalid_option, before anything is sent and without opening the channel', async () => {
      const client = loggedInClient()
      const filter = filterOfFrameSize(LIMIT + 1)
      expect(frameBytes(filter)).toBe(LIMIT + 1)

      let thrown: unknown
      try {
        client.collections.subscribe('logbook', { filter }, vi.fn())
      } catch (error) {
        thrown = error
      }
      await flush()

      expect(thrown).toBeInstanceOf(FleetlessError)
      expect(thrown).toMatchObject({ code: 'invalid_option', message: expect.stringContaining('16,384') })
      expect(FakeWebSocket.instances).toHaveLength(0)
    })

    it('counts bytes, not characters: three-byte characters that fit as text but not as UTF-8 are refused', async () => {
      const client = loggedInClient()
      const filter = filterOfFrameSize(LIMIT + 1, '€')
      expect(frameBytes(filter)).toBe(LIMIT + 1)
      expect(JSON.stringify({ type: 'collection_subscribe', request_id: 'c1', collection: 'logbook', filter }).length).toBeLessThan(LIMIT)

      expect(() => client.collections.subscribe('logbook', { filter }, vi.fn())).toThrow(
        expect.objectContaining({ code: 'invalid_option' }),
      )
      expect(FakeWebSocket.instances).toHaveLength(0)
    })

    it('names the subscription that is refused and leaves the other subscriptions of the client alone', async () => {
      const client = loggedInClient()
      const onEvent = vi.fn()
      client.collections.subscribe('logbook', {}, onEvent)
      await authenticate()
      const requestId = requestIdOf(0)

      expect(() => client.collections.subscribe('components', { filter: filterOfFrameSize(LIMIT + 1) }, vi.fn())).toThrow(
        expect.objectContaining({ code: 'invalid_option' }),
      )
      await flush()

      // No second socket, no frame for the refused one, and the first still delivers.
      expect(FakeWebSocket.instances).toHaveLength(1)
      expect(subscribeFrames()).toHaveLength(1)
      currentSocket().simulateMessage(event(requestId, 'created', { record: RECORD }))
      expect(onEvent).toHaveBeenCalledTimes(1)
    })
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

  describe('onReady', () => {
    /** What the cloud answers to the nth `collection_subscribe` of the current socket once it has registered it. */
    function confirm(index: number, socket: FakeWebSocket = currentSocket()): void {
      socket.simulateMessage({ type: 'collection_subscribed', request_id: requestIdOf(index, socket) })
    }

    it('is called when the cloud confirms the subscription, not when the frame is sent, and again after every reconnect that is confirmed', async () => {
      vi.useFakeTimers()
      try {
        const client = loggedInClient()
        const framesWhenCalled: number[] = []
        const onReady = vi.fn(() => {
          framesWhenCalled.push(subscribeFrames().length)
        })
        client.collections.subscribe('logbook', { robot: ROBOT, onReady }, vi.fn())

        await connectFirst()
        await flush()
        // Sent, not yet confirmed: the cloud may still be judging it.
        expect(subscribeFrames()).toHaveLength(1)
        expect(onReady).not.toHaveBeenCalled()

        confirm(0)
        expect(onReady).toHaveBeenCalledTimes(1)
        expect(framesWhenCalled).toEqual([1])

        await reconnect()
        await flush()
        expect(subscribeFrames()).toHaveLength(1) // on the new socket
        expect(onReady).toHaveBeenCalledTimes(1) // sent again, not confirmed yet
        confirm(0)
        expect(onReady).toHaveBeenCalledTimes(2)
        expect(FakeWebSocket.instances).toHaveLength(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('is called with no arguments, and only for the subscription the cloud confirmed', async () => {
      vi.useFakeTimers()
      try {
        const client = loggedInClient()
        const seen: Array<{ collection: string; args: unknown[] }> = []
        const readyOf = (collection: string) =>
          (...args: unknown[]) => {
            seen.push({ collection, args })
          }
        client.collections.subscribe('logbook', { onReady: readyOf('logbook') }, vi.fn())
        client.collections.subscribe('components', { onReady: readyOf('components') }, vi.fn())
        await connectFirst()

        confirm(1)
        expect(seen).toEqual([{ collection: 'components', args: [] }])
        confirm(0)
        expect(seen).toEqual([
          { collection: 'components', args: [] },
          { collection: 'logbook', args: [] },
        ])
      } finally {
        vi.useRealTimers()
      }
    })

    it('is called before the first event of the subscription, which the cloud sends after the confirmation', async () => {
      vi.useFakeTimers()
      try {
        const client = loggedInClient()
        const order: string[] = []
        client.collections.subscribe('logbook', { onReady: () => order.push('ready') }, (change) => order.push(change.event))
        await connectFirst()

        confirm(0)
        currentSocket().simulateMessage(event(requestIdOf(0), 'created', { record: RECORD }))
        currentSocket().simulateMessage(event(requestIdOf(0), 'updated', { record: RECORD }))
        expect(order).toEqual(['ready', 'created', 'updated'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('is not called for a subscription made on a channel that was already ready until the cloud confirms that one', async () => {
      const client = loggedInClient()
      const onReady = vi.fn()
      client.collections.subscribe('components', {}, vi.fn())
      await authenticate()

      client.collections.subscribe('logbook', { onReady }, vi.fn())
      await flush()

      expect(subscribeFrames()).toHaveLength(2)
      expect(onReady).not.toHaveBeenCalled()
      confirm(1)
      expect(onReady).toHaveBeenCalledTimes(1)
    })

    it('is not called when the connection drops before the cloud confirmed, and is called when the next connection does', async () => {
      vi.useFakeTimers()
      try {
        const client = loggedInClient()
        const onReady = vi.fn()
        client.collections.subscribe('logbook', { onReady }, vi.fn())
        await connectFirst()
        expect(subscribeFrames()).toHaveLength(1)

        // The socket goes before the cloud answered: that frame was never confirmed.
        await reconnect()
        await flush()
        expect(onReady).not.toHaveBeenCalled()
        expect(subscribeFrames()).toHaveLength(1)

        confirm(0)
        expect(onReady).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('is not called for a subscription that was never sent: the connection dropped before it authenticated', async () => {
      vi.useFakeTimers()
      try {
        const client = loggedInClient()
        const onReady = vi.fn()
        client.collections.subscribe('logbook', { onReady }, vi.fn())
        await vi.advanceTimersByTimeAsync(0)
        currentSocket().simulateOpen()
        // Closed before auth_ok: nothing was sent, so there is nothing to confirm.
        await reconnect()
        await flush()

        expect(subscribeFrames()).toHaveLength(1)
        expect(onReady).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('is not called for a subscription the caller ended or the cloud ended, nor for a confirmation nobody asked for', async () => {
      vi.useFakeTimers()
      try {
        const client = loggedInClient()
        const endedByCaller = vi.fn()
        const endedByCloud = vi.fn()
        const alive = vi.fn()
        const unsubscribe = client.collections.subscribe('logbook', { onReady: endedByCaller }, vi.fn())
        client.collections.subscribe('components', { onReady: endedByCloud, onError: vi.fn() }, vi.fn())
        client.collections.subscribe('locations', { onReady: alive }, vi.fn())
        await connectFirst()
        currentSocket().simulateMessage({ type: 'collection_subscribe_error', request_id: requestIdOf(1), code: 'collection_removed', message: 'gone' })
        unsubscribe()

        // A late or stray confirmation, for all three and for an id that was never used.
        confirm(0)
        confirm(1)
        currentSocket().simulateMessage({ type: 'collection_subscribed', request_id: 'never-sent' })
        expect(endedByCaller).not.toHaveBeenCalled()
        expect(endedByCloud).not.toHaveBeenCalled()
        expect(alive).not.toHaveBeenCalled()

        await reconnect()
        await flush()
        confirm(0) // only the subscription that is alive is sent again: it is the first frame of the new socket
        expect(alive).toHaveBeenCalledTimes(1)
        expect(endedByCaller).not.toHaveBeenCalled()
        expect(endedByCloud).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('is not called when the caller ends the subscription before the confirmation arrives', async () => {
      vi.useFakeTimers()
      try {
        const client = loggedInClient()
        const onReady = vi.fn()
        const unsubscribe = client.collections.subscribe('logbook', { onReady }, vi.fn())
        await connectFirst()
        const requestId = requestIdOf(0)

        unsubscribe() // the cloud is still judging the subscribe
        currentSocket().simulateMessage({ type: 'collection_subscribed', request_id: requestId })

        expect(onReady).not.toHaveBeenCalled()
        // The unsubscribe went out, so the cloud drops it when it gets to it.
        expect(currentSocket().sent.at(-1)).toEqual({ type: 'collection_unsubscribe', request_id: requestId })
      } finally {
        vi.useRealTimers()
      }
    })

    it('is not called for a subscription the cloud refuses', async () => {
      vi.useFakeTimers()
      try {
        const client = loggedInClient()
        const onReady = vi.fn()
        const onError = vi.fn<(error: FleetlessError) => void>()
        client.collections.subscribe('nope', { onReady, onError }, vi.fn())
        await connectFirst()
        currentSocket().simulateMessage({ type: 'collection_subscribe_error', request_id: requestIdOf(0), code: 'collection_not_found', message: 'no such collection' })

        expect(onError).toHaveBeenCalledTimes(1)
        expect(onReady).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('is called when a connection the cloud ended with 4003 is opened again by a later call and the cloud confirms the old subscription', async () => {
      vi.useFakeTimers()
      try {
        const client = loggedInClient()
        const onReady = vi.fn()
        client.collections.subscribe('logbook', { onReady, onError: vi.fn() }, vi.fn())
        await connectFirst()
        confirm(0)
        expect(onReady).toHaveBeenCalledTimes(1)

        currentSocket().simulateClose(4003, 'account_unavailable')
        await vi.advanceTimersByTimeAsync(60_000)
        expect(FakeWebSocket.instances).toHaveLength(1)

        // A later subscribe opens the channel again, and the old subscription is sent with it.
        client.collections.subscribe('components', {}, vi.fn())
        await connectFirst()
        await flush()

        expect(subscribeFrames().map((frame) => frame.collection)).toEqual(['logbook', 'components'])
        expect(onReady).toHaveBeenCalledTimes(1)
        confirm(0)
        expect(onReady).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    describe('a reader that lists in it', () => {
      /** The cloud of these tests: a table of records, and the subscriptions it has registered. */
      function cloud() {
        const table: string[] = []
        const registered = new Set<string>()
        return {
          table,
          registered,
          /** A record is written: held by the table, and told to every registered subscription of the socket that is up. */
          write(id: string) {
            table.push(id)
            for (const requestId of registered) currentSocket().simulateMessage(event(requestId, 'created', { id, record: { ...RECORD, id } }))
          },
          /** The cloud has judged the nth subscribe frame of the current socket: registered, then confirmed. */
          register(index: number) {
            const requestId = requestIdOf(index)
            registered.add(requestId)
            currentSocket().simulateMessage({ type: 'collection_subscribed', request_id: requestId })
          },
          /** What a `list` answers: the table as it is when the read happens. */
          async list(): Promise<string[]> {
            await Promise.resolve()
            return [...table]
          },
        }
      }

      it('misses nothing: what was written before the cloud registered the subscription is in the list, everything after arrives as an event', async () => {
        vi.useFakeTimers()
        try {
          const remote = cloud()
          const client = loggedInClient()
          const known = new Set<string>()
          const naive = new Set<string>()
          const ready = vi.fn(async () => {
            for (const id of await remote.list()) known.add(id)
          })
          const onEvent = (change: CollectionEvent) => {
            known.add(change.id)
            naive.add(change.id)
          }

          remote.write('r1')
          client.collections.subscribe('logbook', { onReady: ready }, onEvent)
          // The reader that lists as soon as it has subscribed, instead of waiting for onReady: the usual shape of the gap.
          void remote.list().then((rows) => rows.forEach((id) => naive.add(id)))
          await connectFirst()
          await vi.advanceTimersByTimeAsync(0)

          // The frame is on the socket, the cloud is still judging it: this write is neither listed by the naive reader nor delivered.
          remote.write('r2')
          remote.register(0)
          // Written right after the confirmation, while the list is being read: delivered, and perhaps in the list as well.
          remote.write('r3')
          await vi.advanceTimersByTimeAsync(0)
          remote.write('r4')

          expect(ready).toHaveBeenCalledTimes(1)
          expect([...known].sort()).toEqual(['r1', 'r2', 'r3', 'r4'])
          expect([...naive].sort()).toEqual(['r1', 'r3', 'r4']) // r2 fell between the naive list and the registration
        } finally {
          vi.useRealTimers()
        }
      })

      it('misses nothing after a reconnect either: what was written while the connection was down is in the list the confirmation triggers', async () => {
        vi.useFakeTimers()
        try {
          const remote = cloud()
          const client = loggedInClient()
          const known = new Set<string>()
          client.collections.subscribe(
            'logbook',
            {
              onReady: async () => {
                known.clear() // replace, not merge: a record deleted meanwhile must go
                for (const id of await remote.list()) known.add(id)
              },
            },
            (change) => known.add(change.id),
          )
          await connectFirst()
          remote.write('r1')
          remote.register(0)
          await vi.advanceTimersByTimeAsync(0)
          remote.write('r2')
          expect([...known].sort()).toEqual(['r1', 'r2'])

          currentSocket().simulateClose()
          remote.registered.clear() // the cloud forgot the socket's subscriptions with it
          remote.write('r3') // nobody told
          await vi.advanceTimersByTimeAsync(500)
          await vi.advanceTimersByTimeAsync(0)
          currentSocket().simulateOpen()
          currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })
          remote.write('r4') // the frame is on the new socket, not registered yet
          remote.register(0)
          await vi.advanceTimersByTimeAsync(0)
          remote.write('r5')

          expect([...known].sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5'])
        } finally {
          vi.useRealTimers()
        }
      })
    })
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
