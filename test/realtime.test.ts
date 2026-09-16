// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeChannel } from '../src/realtime.js'
import { FleetlessError } from '../src/errors.js'
import type { CredentialSource } from '../src/http.js'
import { FakeWebSocket } from './fake-websocket.js'

function stubCredentials(rawToken: string | null, handleExpired: () => Promise<boolean> = async () => false): CredentialSource {
  return { token: async () => rawToken, handleExpired }
}

/** A credential source whose token can be swapped, to simulate a refresh rotating it. */
function mutableCredentials(initialToken: string): { credentials: CredentialSource; setToken: (t: string) => void } {
  let current = initialToken
  return {
    credentials: {
      token: async () => current,
      handleExpired: async () => {
        current = `${current}-refreshed`
        return true
      },
    },
    setToken: (t: string) => {
      current = t
    },
  }
}

function currentSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1)
  if (!socket) throw new Error('no FakeWebSocket was constructed')
  return socket
}

beforeEach(() => {
  FakeWebSocket.reset()
})

describe('RealtimeChannel handshake', () => {
  it('sends an auth frame with the raw token as soon as the socket opens', () => {
    const channel = new RealtimeChannel({
      url: 'ws://x/realtime',
      WebSocket: FakeWebSocket,
      credentials: stubCredentials('at1'),
    })
    channel.connect()
    // token() resolves asynchronously; the socket is only constructed after that microtask.
    return Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => {
        currentSocket().simulateOpen()
        expect(currentSocket().sent).toEqual([{ type: 'auth', token: 'at1' }])
      })
  })

  it('is ready and fires onReady listeners once auth_ok arrives', async () => {
    const channel = new RealtimeChannel({ url: 'ws://x/realtime', WebSocket: FakeWebSocket, credentials: stubCredentials('at1') })
    const ready = vi.fn()
    channel.onReady(ready)
    channel.connect()
    await flush()
    currentSocket().simulateOpen()
    expect(channel.isReady).toBe(false)
    currentSocket().simulateMessage({ type: 'auth_ok', identity: identity() })
    expect(channel.isReady).toBe(true)
    expect(channel.identity).toEqual(identity())
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('calls a late-registered onReady listener immediately if already authenticated', async () => {
    const channel = new RealtimeChannel({ url: 'ws://x/realtime', WebSocket: FakeWebSocket, credentials: stubCredentials('at1') })
    channel.connect()
    await flush()
    currentSocket().simulateOpen()
    currentSocket().simulateMessage({ type: 'auth_ok', identity: identity() })

    const ready = vi.fn()
    channel.onReady(ready)
    expect(ready).not.toHaveBeenCalled() // fires on a microtask, not synchronously
    await flush()
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('does not require a WebSocket to exist until connect() is called', () => {
    expect(() => new RealtimeChannel({ url: 'ws://x/realtime', WebSocket: undefined, credentials: stubCredentials(null) })).not.toThrow()
  })

  it('fails with no_session (not the server code unauthorized) when there is no token — no socket is even opened', async () => {
    const channel = new RealtimeChannel({ url: 'ws://x/realtime', WebSocket: FakeWebSocket, credentials: stubCredentials(null) })
    const failed = vi.fn()
    channel.onAuthFailed(failed)
    channel.connect()
    await flush()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(failed.mock.calls[0][0]).toBeInstanceOf(FleetlessError)
    expect(failed.mock.calls[0][0].code).toBe('no_session')
  })

  it('fails with no_websocket (an SDK-side code, not a server refusal) when no WebSocket implementation is available', async () => {
    const channel = new RealtimeChannel({ url: 'ws://x/realtime', WebSocket: undefined, credentials: stubCredentials('at1') })
    const failed = vi.fn()
    channel.onAuthFailed(failed)
    channel.connect()
    await flush()
    expect(failed).toHaveBeenCalledTimes(1)
    expect(failed.mock.calls[0][0]).toBeInstanceOf(FleetlessError)
    expect(failed.mock.calls[0][0].code).toBe('no_websocket')
  })
})

describe('RealtimeChannel connect() race', () => {
  // Regression for a real bug: `#open()` is async and doesn't assign the
  // socket until *after* `await credentials.token()`. Two `connect()` calls
  // issued before that microtask settles — e.g. a subscribe and a command in
  // the same tick, or two calls inside a `Promise.all` — both saw no socket
  // yet and both proceeded, opening two physical sockets. Each one's own
  // `auth_ok` bumped `connectionEpoch`, so the second socket authenticating
  // made the command already sent on the first look replaced — failing it
  // `command_outcome_unknown` though nothing was wrong with it. The orphaned
  // first socket was also never reachable by `close()`/`logout()` again: a
  // leaked, still-authenticated connection.
  it('two connect() calls in the same tick open exactly one socket', async () => {
    const channel = new RealtimeChannel({ url: 'ws://x/realtime', WebSocket: FakeWebSocket, credentials: stubCredentials('at1') })
    channel.connect()
    channel.connect() // same synchronous tick — must be a no-op, not a second socket
    await flush()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('subscribing then sending a command in the same tick shares one socket and one connectionEpoch', async () => {
    const channel = new RealtimeChannel({ url: 'ws://x/realtime', WebSocket: FakeWebSocket, credentials: stubCredentials('at1') })
    // The reproducing shape: a subscribe-style connect() immediately followed,
    // before any await, by a command-style connect().
    channel.connect()
    channel.connect()
    await flush()
    currentSocket().simulateOpen()
    const epochBefore = channel.connectionEpoch
    currentSocket().simulateMessage({ type: 'auth_ok', identity: identity() })

    expect(FakeWebSocket.instances).toHaveLength(1)
    // Exactly one auth_ok landed — connectionEpoch moved once, not twice, as
    // a second socket authenticating behind the first would.
    expect(channel.connectionEpoch).toBe(epochBefore + 1)
  })

  it('close() reaches the socket that was actually opened — no orphan left running', async () => {
    const channel = new RealtimeChannel({ url: 'ws://x/realtime', WebSocket: FakeWebSocket, credentials: stubCredentials('at1') })
    channel.connect()
    channel.connect()
    await flush()
    currentSocket().simulateOpen()
    currentSocket().simulateMessage({ type: 'auth_ok', identity: identity() })

    channel.close()
    expect(currentSocket().closeSpy).toHaveBeenCalledTimes(1)
  })
})

describe('RealtimeChannel auth_error', () => {
  it('on token_expired, refreshes once and reconnects with the freshly-read token — no reconnect backoff involved', async () => {
    const { credentials } = mutableCredentials('stale')
    const channel = new RealtimeChannel({ url: 'ws://x/realtime', WebSocket: FakeWebSocket, credentials })
    channel.connect()
    await flush()
    currentSocket().simulateOpen()
    currentSocket().simulateMessage({ type: 'auth_error', code: 'token_expired', message: 'expired' })
    await flush()
    await flush()

    expect(FakeWebSocket.instances).toHaveLength(2) // the failed one, then the reconnect
    currentSocket().simulateOpen()
    // handleExpired() rotated the token; the reconnect's auth frame carries the new value.
    expect(currentSocket().sent).toEqual([{ type: 'auth', token: 'stale-refreshed' }])
  })

  it('on any other auth_error, gives up and does not reconnect', async () => {
    const channel = new RealtimeChannel({ url: 'ws://x/realtime', WebSocket: FakeWebSocket, credentials: stubCredentials('at1') })
    const failed = vi.fn()
    channel.onAuthFailed(failed)
    channel.connect()
    await flush()
    currentSocket().simulateOpen()
    currentSocket().simulateMessage({ type: 'auth_error', code: 'forbidden', message: 'nope' })
    await flush()

    expect(failed).toHaveBeenCalledTimes(1)
    expect(failed.mock.calls[0][0].code).toBe('forbidden')
    expect(FakeWebSocket.instances).toHaveLength(1) // no reconnect attempt
  })
})

describe('RealtimeChannel reconnect', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reconnects with exponential backoff after an unexpected close, resetting the backoff on success', async () => {
    const channel = new RealtimeChannel({
      url: 'ws://x/realtime',
      WebSocket: FakeWebSocket,
      credentials: stubCredentials('at1'),
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
    })
    channel.connect()
    await flushFake()
    currentSocket().simulateOpen()
    currentSocket().simulateMessage({ type: 'auth_ok', identity: identity() })

    currentSocket().simulateClose()
    expect(FakeWebSocket.instances).toHaveLength(1) // not yet — waiting on backoff

    await vi.advanceTimersByTimeAsync(99)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await flushFake()
    expect(FakeWebSocket.instances).toHaveLength(2)

    // A second failure without ever reaching auth_ok doubles the backoff.
    currentSocket().simulateOpen()
    currentSocket().simulateClose()
    await vi.advanceTimersByTimeAsync(199)
    expect(FakeWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await flushFake()
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('re-sends onReady listeners (resubscribe) after every reconnect', async () => {
    const channel = new RealtimeChannel({
      url: 'ws://x/realtime',
      WebSocket: FakeWebSocket,
      credentials: stubCredentials('at1'),
      initialBackoffMs: 50,
    })
    const ready = vi.fn()
    channel.onReady(ready)
    channel.connect()
    await flushFake()
    currentSocket().simulateOpen()
    currentSocket().simulateMessage({ type: 'auth_ok', identity: identity() })
    expect(ready).toHaveBeenCalledTimes(1)

    currentSocket().simulateClose()
    await vi.advanceTimersByTimeAsync(50)
    await flushFake()
    currentSocket().simulateOpen()
    currentSocket().simulateMessage({ type: 'auth_ok', identity: identity() })
    expect(ready).toHaveBeenCalledTimes(2)
  })

  it('does not reconnect once close() was called by the caller', async () => {
    const channel = new RealtimeChannel({ url: 'ws://x/realtime', WebSocket: FakeWebSocket, credentials: stubCredentials('at1'), initialBackoffMs: 50 })
    channel.connect()
    await flushFake()
    currentSocket().simulateOpen()
    currentSocket().simulateMessage({ type: 'auth_ok', identity: identity() })

    channel.close()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

function identity() {
  return { kind: 'app_user', developer_id: null, app_user_id: 'u1', server_key_id: null, app_id: 'a1', role_id: 'r1', email: 'a@b.de' }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** Same as flush(), but under fake timers a microtask-only wait still needs a real tick. */
async function flushFake(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
}
