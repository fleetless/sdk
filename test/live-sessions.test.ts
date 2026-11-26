// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionResponse } from '@fleetless/contracts'
import { HttpClient, noCredentials, type CredentialSource } from '../src/http.js'
import { createCamerasApi } from '../src/cameras.js'
import { createLiveSessionEndings } from '../src/live-sessions.js'
import { RealtimeChannel } from '../src/realtime.js'
import { FakeWebSocket } from './fake-websocket.js'

/** fleetless/fleetless#1126: `CameraLiveSession.onEnded` hears why the cloud ended a session. */

const WEAK_LINK = "The robot's link is weak, so live video is paused. Snapshots go on."

function credentials(): CredentialSource {
  return { token: async () => 'at1', handleExpired: async () => false }
}

function identity() {
  return { kind: 'app_user', developer_id: null, app_user_id: 'u1', server_key_id: null, app_id: 'a1', role: { key: 'operate', name: 'Operate' }, email: 'a@b.de' }
}

function liveSessionBody(sessionId: string): LiveSessionResponse {
  return { session_id: sessionId, url: 'wss://media.fleetless.dev', room: 'r-1', token: 'tok', expires_at: '2026-08-11T12:00:00.000Z' }
}

function refusal(sessionId: string) {
  return {
    type: 'live_session',
    robot_id: '11111111-1111-4111-8111-111111111111',
    slug: 'front',
    session_id: sessionId,
    state: 'ended',
    reason: 'start_refused',
    detail: WEAK_LINK,
    refusal: 'low_bandwidth',
    ended_at_ms: 1786522606705,
  }
}

function socket(): FakeWebSocket {
  const current = FakeWebSocket.instances.at(-1)
  if (!current) throw new Error('no FakeWebSocket was constructed')
  return current
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** A cameras API on a fake channel, with the socket brought up by the test. */
function world(onPost: () => void = () => {}, readyTimeoutMs?: number) {
  const channel = new RealtimeChannel({ url: 'ws://x/realtime', WebSocket: FakeWebSocket, credentials: credentials() })
  const fetchImpl = vi.fn(async (_input: string | URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    onPost()
    return new Response(JSON.stringify(liveSessionBody('sess-1')), { status: 201, headers: { 'content-type': 'application/json' } })
  })
  const http = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl as unknown as typeof fetch, credentials: noCredentials })
  const cameras = createCamerasApi(http, createLiveSessionEndings(channel, { readyTimeoutMs }))
  return { channel, cameras, fetchImpl }
}

/** Opens and authenticates the socket `live()` asked for. */
async function authenticate(): Promise<void> {
  await flush()
  socket().simulateOpen()
  socket().simulateMessage({ type: 'auth_ok', identity: identity() })
  await flush()
}

beforeEach(() => {
  FakeWebSocket.reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CameraLiveSession.onEnded', () => {
  it('opens the channel and waits for it before taking the hold', async () => {
    const { cameras, fetchImpl } = world()
    const pending = cameras.live('robot1', 'front')
    await flush()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(fetchImpl).not.toHaveBeenCalled()

    await authenticate()
    const session = await pending
    expect(session.session_id).toBe('sess-1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('hands the handler the reason, the sentence and the refusal', async () => {
    const { cameras } = world()
    const pending = cameras.live('robot1', 'front')
    await authenticate()
    const session = await pending

    const handler = vi.fn()
    session.onEnded(handler)
    socket().simulateMessage(refusal('sess-1'))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ reason: 'start_refused', detail: WEAK_LINK, refusal: 'low_bandwidth' })
  })

  it('delivers an ending that arrived before onEnded was called, once', async () => {
    // The robot refuses within one round trip: the frame can beat the POST's answer.
    const { cameras } = world(() => socket().simulateMessage(refusal('sess-1')))
    const pending = cameras.live('robot1', 'front')
    await authenticate()
    const session = await pending

    const handler = vi.fn()
    session.onEnded(handler)
    expect(handler).not.toHaveBeenCalled() // on a microtask, not inside onEnded
    await flush()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ reason: 'start_refused', detail: WEAK_LINK, refusal: 'low_bandwidth' })

    socket().simulateMessage(refusal('sess-1'))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('ignores another session\'s ending and malformed frames', async () => {
    const { cameras } = world()
    const pending = cameras.live('robot1', 'front')
    await authenticate()
    const session = await pending

    const handler = vi.fn()
    session.onEnded(handler)
    socket().simulateMessage(refusal('sess-2'))
    socket().simulateMessage({ ...refusal('sess-1'), state: 'started' })
    socket().simulateMessage({ ...refusal('sess-1'), detail: 42 })
    expect(handler).not.toHaveBeenCalled()
  })

  it('reports refusal as null for an ending that is not a refusal', async () => {
    const { cameras } = world()
    const pending = cameras.live('robot1', 'front')
    await authenticate()
    const session = await pending

    const handler = vi.fn()
    session.onEnded(handler)
    const { refusal: _dropped, ...frame } = refusal('sess-1')
    socket().simulateMessage({ ...frame, reason: 'config_changed', detail: null })
    expect(handler).toHaveBeenCalledWith({ reason: 'config_changed', detail: null, refusal: null })
  })

  it('stops listening once unlistened', async () => {
    const { cameras } = world()
    const pending = cameras.live('robot1', 'front')
    await authenticate()
    const session = await pending

    const handler = vi.fn()
    const unlisten = session.onEnded(handler)
    unlisten()
    socket().simulateMessage(refusal('sess-1'))
    expect(handler).not.toHaveBeenCalled()
  })

  it('a handler that throws skips no other handler and does not reach the socket', async () => {
    const { cameras } = world()
    const pending = cameras.live('robot1', 'front')
    await authenticate()
    const session = await pending

    const boom = new Error('handler bug')
    const rethrown: Array<() => void> = []
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
      rethrown.push(callback)
    })
    const other = vi.fn()
    session.onEnded(() => {
      throw boom
    })
    session.onEnded(other)
    expect(() => socket().simulateMessage(refusal('sess-1'))).not.toThrow()
    spy.mockRestore()

    expect(other).toHaveBeenCalledTimes(1)
    // Reported as an uncaught error would be, off the socket's stack.
    expect(rethrown).toHaveLength(1)
    expect(() => rethrown[0]!()).toThrow(boom)
  })

  it('takes the hold anyway when the channel does not come up in time', async () => {
    vi.useFakeTimers()
    const { cameras, fetchImpl } = world(() => {}, 50)
    const pending = cameras.live('robot1', 'front')
    await vi.advanceTimersByTimeAsync(60)
    const session = await pending
    expect(session.session_id).toBe('sess-1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('takes the hold anyway where there is no WebSocket at all', async () => {
    const channel = new RealtimeChannel({ url: 'ws://x/realtime', WebSocket: undefined, credentials: credentials() })
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(liveSessionBody('sess-1')), { status: 201, headers: { 'content-type': 'application/json' } }))
    const http = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl as unknown as typeof fetch, credentials: noCredentials })
    const cameras = createCamerasApi(http, createLiveSessionEndings(channel))
    const session = await cameras.live('robot1', 'front')
    expect(session.session_id).toBe('sess-1')
    expect(session.onEnded(() => {})).toBeTypeOf('function')
  })

  it('without the channel (REST only), onEnded is a no-op', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(liveSessionBody('sess-1')), { status: 201, headers: { 'content-type': 'application/json' } }))
    const http = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl as unknown as typeof fetch, credentials: noCredentials })
    const session = await createCamerasApi(http).live('robot1', 'front')
    expect(session.onEnded(() => {})).toBeTypeOf('function')
  })
})
