// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientIdentity, DatapointValue, HistoryBucketsResponse, HistorySamplesResponse } from '@fleetless/contracts'
import { createClient, FleetlessError, InMemoryTokenStore } from '../src/index.js'
import { FakeWebSocket } from './fake-websocket.js'

// jsonResponse() stays untyped (`unknown`) — it serves error bodies and
// other loose fixtures too. A history-response literal must be typed at the
// call site instead (`const x: T` or `satisfies T`), or a missing required
// field goes unnoticed while the file stays green, since a test only
// asserts what it cares about. Found here: two fixtures below were missing
// HistorySamplesResponse's `truncated_by` (required, nullable — not the
// same as absent) until `satisfies` caught it.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function errorResponse(code: string, message: string, status = 404): Response {
  return jsonResponse({ code, message }, status)
}

const IDENTITY: ClientIdentity = {
  kind: 'app_user',
  developer_id: null,
  app_user_id: 'u1',
  server_key_id: null,
  app_id: 'app1',
  role_id: 'role1',
  email: 'a@b.de',
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

function loggedInClient(fetchImpl: typeof fetch) {
  const tokenStore = new InMemoryTokenStore()
  tokenStore.save({ access_token: 'at1', refresh_token: 'rt1', expires_in: 900 })
  return createClient({
    apiUrl: 'https://api.fleetless.dev',
    appIdentifier: 'app_x',
    tokenStore,
    fetch: fetchImpl,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
  })
}

describe('datapoints.get', () => {
  it('reads a datapoint over REST', async () => {
    const value: DatapointValue = { slug: 'battery-percentage', value: 87, timestamp_ms: 1000 }
    const fetchImpl = vi.fn(async (input: string | URL | RequestInfo) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/robot1/datapoints/battery-percentage')
      return jsonResponse(value)
    })
    const client = loggedInClient(fetchImpl as unknown as typeof fetch)

    await expect(client.datapoints.get('robot1', 'battery-percentage')).resolves.toEqual(value)
  })

  // `pathSegment()` is proved against a real server in http.test.ts; this
  // confirms the route calls it for both robotId and slug.
  it('encodes a robotId/slug shaped like a traversal attempt rather than sending it as literal path segments', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | RequestInfo) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/..%2Fadmin/datapoints/..%2F..%2Fother-robot%2Fbattery')
      return jsonResponse({ slug: 'battery', value: 1, timestamp_ms: 1 })
    })
    const client = loggedInClient(fetchImpl as unknown as typeof fetch)

    await client.datapoints.get('../admin', '../../other-robot/battery')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('datapoints.history', () => {
  it('requests raw samples with only `from` set, and omits every unset optional field from the query', async () => {
    const response: HistorySamplesResponse = {
      slug: 'battery-percentage',
      kind: 'samples',
      samples: [{ timestamp_ms: 1000, value: 87 }],
      truncated: false,
      truncated_by: null,
    }
    const fetchImpl = vi.fn(async (input: string | URL | RequestInfo) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/api/robots/robot1/datapoints/battery-percentage/history')
      expect([...url.searchParams.keys()]).toEqual(['from'])
      expect(url.searchParams.get('from')).toBe('now-30s')
      return jsonResponse(response)
    })
    const client = loggedInClient(fetchImpl as unknown as typeof fetch)

    const result = await client.datapoints.history('robot1', 'battery-percentage', { from: 'now-30s' })
    expect(result).toEqual(response)
    expect(result.kind).toBe('samples')
  })

  it('sends `from` and absolute-ms `to` as the literal strings given — never converts a Date or number itself', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | RequestInfo) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('from')).toBe('1700000000000')
      expect(url.searchParams.get('to')).toBe('1700000030000')
      return jsonResponse({ slug: 's', kind: 'samples', samples: [], truncated: false, truncated_by: null } satisfies HistorySamplesResponse)
    })
    const client = loggedInClient(fetchImpl as unknown as typeof fetch)

    await client.datapoints.history('robot1', 's', { from: '1700000000000', to: '1700000030000' })
  })

  it('sends `limit` as a query param when set', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | RequestInfo) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('limit')).toBe('50')
      // truncated_by: 'limit', not null — null means "was not truncated"
      // (see the contract's doc comment), and this fixture claims it was.
      return jsonResponse({ slug: 's', kind: 'samples', samples: [], truncated: true, truncated_by: 'limit' } satisfies HistorySamplesResponse)
    })
    const client = loggedInClient(fetchImpl as unknown as typeof fetch)

    const result = await client.datapoints.history('robot1', 's', { from: 'now-1h', limit: 50 })
    expect(result.truncated).toBe(true)
  })

  it('requests aggregated buckets when `aggregate` is given, sending `window` and `agg` together', async () => {
    const response: HistoryBucketsResponse = {
      slug: 'battery-percentage',
      kind: 'buckets',
      window_ms: 10_000,
      agg: 'avg',
      buckets: [
        { bucket_start_ms: 0, value: 50, sample_count: 3 },
        { bucket_start_ms: 10_000, value: null, sample_count: 0 }, // empty, not zero — must stay distinguishable
      ],
    }
    const fetchImpl = vi.fn(async (input: string | URL | RequestInfo) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('window')).toBe('10s')
      expect(url.searchParams.get('agg')).toBe('avg')
      expect(url.searchParams.has('field')).toBe(false) // not given, must not be sent
      return jsonResponse(response)
    })
    const client = loggedInClient(fetchImpl as unknown as typeof fetch)

    const result = await client.datapoints.history('robot1', 'battery-percentage', {
      from: 'now-1m',
      aggregate: { window: '10s', agg: 'avg' },
    })
    // No narrowing needed: passing `aggregate` already tells the overload this is buckets.
    expect(result.kind).toBe('buckets')
    expect(result.buckets[1]!.value).toBeNull()
    expect(result.buckets[1]!.sample_count).toBe(0)
  })

  it('sends `aggregate.field` when given, for aggregating a numeric field inside an object value', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | RequestInfo) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('field')).toBe('pose.x')
      return jsonResponse({ slug: 's', kind: 'buckets', window_ms: 1000, agg: 'max', buckets: [] } satisfies HistoryBucketsResponse)
    })
    const client = loggedInClient(fetchImpl as unknown as typeof fetch)

    await client.datapoints.history('robot1', 's', { from: 'now-1m', aggregate: { window: '1s', agg: 'max', field: 'pose.x' } })
  })

  it('rejects with `not_recorded` instead of returning an empty result — turning recording on and looking at a different window are opposite fixes', async () => {
    const fetchImpl = vi.fn(async () => errorResponse('not_recorded', 'this datapoint is not recorded', 409))
    const client = loggedInClient(fetchImpl as unknown as typeof fetch)

    const call = client.datapoints.history('robot1', 'live-only-slug', { from: 'now-1h' })
    await expect(call).rejects.toBeInstanceOf(FleetlessError)
    await expect(call).rejects.toMatchObject({ code: 'not_recorded' })
  })

  it('rejects with `not_aggregatable` rather than silently coercing a non-numeric value', async () => {
    const fetchImpl = vi.fn(async () => errorResponse('not_aggregatable', 'value is not numeric and no field was given', 422))
    const client = loggedInClient(fetchImpl as unknown as typeof fetch)

    const call = client.datapoints.history('robot1', 'string-slug', { from: 'now-1h', aggregate: { window: '10s', agg: 'avg' } })
    await expect(call).rejects.toBeInstanceOf(FleetlessError)
    await expect(call).rejects.toMatchObject({ code: 'not_aggregatable' })
  })
})

describe('datapoints.subscribe', () => {
  it('authenticates the channel, sends subscribe, and delivers datapoint events', async () => {
    const client = loggedInClient(vi.fn() as unknown as typeof fetch)
    const onEvent = vi.fn()

    client.datapoints.subscribe('robot1', 'battery-percentage', { onEvent })
    await authenticate()

    expect(currentSocket().sent).toEqual([
      { type: 'auth', token: 'at1' },
      { type: 'subscribe', robot_id: 'robot1', slug: 'battery-percentage' },
    ])

    currentSocket().simulateMessage({ type: 'datapoint', robot_id: 'robot1', slug: 'battery-percentage', value: 42, timestamp_ms: 5 })
    expect(onEvent).toHaveBeenCalledWith({ type: 'datapoint', robot_id: 'robot1', slug: 'battery-percentage', value: 42, timestamp_ms: 5 })
  })

  it('routes subscribe_error only to the matching (robot_id, slug) subscription', async () => {
    const client = loggedInClient(vi.fn() as unknown as typeof fetch)
    const onErrorA = vi.fn()
    const onErrorB = vi.fn()
    const onEventB = vi.fn()

    client.datapoints.subscribe('robot1', 'robot-details', { onEvent: vi.fn(), onError: onErrorA })
    client.datapoints.subscribe('robot1', 'battery-percentage', { onEvent: onEventB, onError: onErrorB })
    await authenticate()

    currentSocket().simulateMessage({ type: 'subscribe_error', robot_id: 'robot1', slug: 'robot-details', code: 'forbidden', message: 'no access' })

    expect(onErrorA).toHaveBeenCalledTimes(1)
    expect(onErrorA.mock.calls[0][0]).toMatchObject({ code: 'forbidden', message: 'no access' })
    expect(onErrorB).not.toHaveBeenCalled()
    expect(onEventB).not.toHaveBeenCalled()
  })

  it('does not deliver another subscription\'s events (isolation by robot_id + slug)', async () => {
    const client = loggedInClient(vi.fn() as unknown as typeof fetch)
    const eventsRobotA = vi.fn()
    const eventsRobotB = vi.fn()

    client.datapoints.subscribe('robotA', 'battery-percentage', { onEvent: eventsRobotA })
    client.datapoints.subscribe('robotB', 'battery-percentage', { onEvent: eventsRobotB })
    await authenticate()

    currentSocket().simulateMessage({ type: 'datapoint', robot_id: 'robotB', slug: 'battery-percentage', value: 1, timestamp_ms: 1 })

    expect(eventsRobotA).not.toHaveBeenCalled()
    expect(eventsRobotB).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe sends the unsubscribe frame and stops delivering further events', async () => {
    const client = loggedInClient(vi.fn() as unknown as typeof fetch)
    const onEvent = vi.fn()

    const subscription = client.datapoints.subscribe('robot1', 'battery-percentage', { onEvent })
    await authenticate()
    currentSocket().sent.length = 0 // discard auth + subscribe frames already asserted elsewhere

    subscription.unsubscribe()
    expect(currentSocket().sent).toEqual([{ type: 'unsubscribe', robot_id: 'robot1', slug: 'battery-percentage' }])

    currentSocket().simulateMessage({ type: 'datapoint', robot_id: 'robot1', slug: 'battery-percentage', value: 99, timestamp_ms: 9 })
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('reference-counts subscriptions to the same (robot, slug): sends subscribe once, and unsubscribing one leaves the other live', async () => {
    const client = loggedInClient(vi.fn() as unknown as typeof fetch)
    const onEventA = vi.fn()
    const onEventB = vi.fn()

    const subA = client.datapoints.subscribe('robot1', 'robot-details', { onEvent: onEventA })
    const subB = client.datapoints.subscribe('robot1', 'robot-details', { onEvent: onEventB })
    await authenticate()

    // Exactly one wire subscribe for the shared key, not one per caller.
    expect(currentSocket().sent.filter((f) => f.type === 'subscribe')).toHaveLength(1)

    currentSocket().simulateMessage({ type: 'datapoint', robot_id: 'robot1', slug: 'robot-details', value: 1, timestamp_ms: 1 })
    expect(onEventA).toHaveBeenCalledTimes(1)
    expect(onEventB).toHaveBeenCalledTimes(1)

    currentSocket().sent.length = 0
    subA.unsubscribe()
    // The other subscriber is still live: no unsubscribe frame sent yet, and it keeps receiving events.
    expect(currentSocket().sent).toEqual([])
    currentSocket().simulateMessage({ type: 'datapoint', robot_id: 'robot1', slug: 'robot-details', value: 2, timestamp_ms: 2 })
    expect(onEventA).toHaveBeenCalledTimes(1) // unchanged
    expect(onEventB).toHaveBeenCalledTimes(2)

    subB.unsubscribe()
    // Last subscriber gone: now the wire unsubscribe is sent, exactly once.
    expect(currentSocket().sent).toEqual([{ type: 'unsubscribe', robot_id: 'robot1', slug: 'robot-details' }])
    currentSocket().simulateMessage({ type: 'datapoint', robot_id: 'robot1', slug: 'robot-details', value: 3, timestamp_ms: 3 })
    expect(onEventB).toHaveBeenCalledTimes(2) // unchanged
  })

  it('a second unsubscribe() call on the same subscription is a no-op (does not double-decrement the count)', async () => {
    const client = loggedInClient(vi.fn() as unknown as typeof fetch)
    const onEventA = vi.fn()
    const onEventB = vi.fn()

    const subA = client.datapoints.subscribe('robot1', 'robot-details', { onEvent: onEventA })
    client.datapoints.subscribe('robot1', 'robot-details', { onEvent: onEventB })
    await authenticate()

    subA.unsubscribe()
    subA.unsubscribe() // repeated — must not affect B's count
    currentSocket().sent.length = 0

    currentSocket().simulateMessage({ type: 'datapoint', robot_id: 'robot1', slug: 'robot-details', value: 1, timestamp_ms: 1 })
    expect(onEventB).toHaveBeenCalledTimes(1)
    expect(currentSocket().sent).toEqual([]) // B is still the sole subscriber; no unsubscribe frame yet
  })

  it('unsubscribing before the channel ever authenticates cancels the pending subscribe — nothing is sent', async () => {
    const client = loggedInClient(vi.fn() as unknown as typeof fetch)
    const subscription = client.datapoints.subscribe('robot1', 'battery-percentage', { onEvent: vi.fn() })
    subscription.unsubscribe()

    await authenticate()
    expect(currentSocket().sent).toEqual([{ type: 'auth', token: 'at1' }])
  })

  it('resubscribes automatically after the channel reconnects', async () => {
    vi.useFakeTimers()
    try {
      const client = loggedInClient(vi.fn() as unknown as typeof fetch)
      const onEvent = vi.fn()
      client.datapoints.subscribe('robot1', 'battery-percentage', { onEvent })

      await vi.advanceTimersByTimeAsync(0)
      currentSocket().simulateOpen()
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })
      expect(currentSocket().sent).toContainEqual({ type: 'subscribe', robot_id: 'robot1', slug: 'battery-percentage' })

      currentSocket().simulateClose()
      await vi.advanceTimersByTimeAsync(500) // default initial backoff
      await vi.advanceTimersByTimeAsync(0)
      currentSocket().simulateOpen()
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })

      expect(FakeWebSocket.instances).toHaveLength(2)
      expect(currentSocket().sent).toContainEqual({ type: 'subscribe', robot_id: 'robot1', slug: 'battery-percentage' })

      currentSocket().simulateMessage({ type: 'datapoint', robot_id: 'robot1', slug: 'battery-percentage', value: 7, timestamp_ms: 1 })
      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ value: 7 }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('client.close() closes the socket and stops it from reconnecting', async () => {
    const client = loggedInClient(vi.fn() as unknown as typeof fetch)
    client.datapoints.subscribe('robot1', 'battery-percentage', { onEvent: vi.fn() })
    await authenticate()

    client.close()
    expect(currentSocket().closeSpy).toHaveBeenCalledTimes(1)

    const instancesAfterClose = FakeWebSocket.instances.length
    // A real close event still fires (the socket really did close) — must not trigger a reconnect.
    currentSocket().simulateClose()
    await flush()
    expect(FakeWebSocket.instances).toHaveLength(instancesAfterClose)
  })

  it('auth.logout() closes the realtime channel — a session that ended must not keep an authenticated socket streaming', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | RequestInfo) => {
      if (String(input).endsWith('/api/client/logout')) return new Response(null, { status: 204 })
      throw new Error(`unexpected fetch to ${String(input)}`)
    })
    const client = loggedInClient(fetchImpl as unknown as typeof fetch)
    client.datapoints.subscribe('robot1', 'battery-percentage', { onEvent: vi.fn() })
    await authenticate()

    await client.auth.logout()
    expect(currentSocket().closeSpy).toHaveBeenCalledTimes(1)
  })

  it('reports unauthorized without opening a socket when the client has no session yet', async () => {
    const tokenStore = new InMemoryTokenStore() // never logged in
    const client = createClient({
      apiUrl: 'https://api.fleetless.dev',
      appIdentifier: 'app_x',
      tokenStore,
      fetch: vi.fn() as unknown as typeof fetch,
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    })
    const onError = vi.fn()

    client.datapoints.subscribe('robot1', 'battery-percentage', { onEvent: vi.fn(), onError })
    await flush()

    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toMatchObject({ code: 'no_session' })
  })
})
