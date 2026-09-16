// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientIdentity } from '@fleetless/contracts'
import { createRealtimeCommandTransport, resolveLocalWaitMs, sendCommand } from '../src/commands.js'
import { RealtimeChannel } from '../src/realtime.js'
import { FakeWebSocket } from './fake-websocket.js'

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

function newChannel(): RealtimeChannel {
  return new RealtimeChannel({
    url: 'wss://api.fleetless.dev/realtime',
    WebSocket: FakeWebSocket as unknown as new (url: string) => import('../src/realtime.js').WebSocketLike,
    credentials: {
      async token() {
        return 'tok'
      },
      async handleExpired() {
        return false
      },
    },
  })
}

async function authenticate(): Promise<void> {
  await flush()
  currentSocket().simulateOpen()
  currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })
}

beforeEach(() => {
  FakeWebSocket.reset()
})

describe('sendCommand', () => {
  it('sends immediately when the channel is already ready and resolves on the matching command_result', async () => {
    const channel = newChannel()
    channel.connect()
    await authenticate()
    currentSocket().sent.length = 0

    const promise = sendCommand(channel, { type: 'invoke', request_id: 'r1', robot_id: 'robot1', slug: 'dock', params: {} })
    expect(currentSocket().sent).toEqual([{ type: 'invoke', request_id: 'r1', robot_id: 'robot1', slug: 'dock', params: {} }])

    const job = { id: 'job1', robot_id: 'robot1', slug: 'dock', state: 'running', started_at: 't', updated_at: 't', result: null, error: null }
    currentSocket().simulateMessage({ type: 'command_result', request_id: 'r1', ok: true, job, code: null, message: null })

    await expect(promise).resolves.toMatchObject({ ok: true, job })
  })

  it('ignores a command_result for a different request_id', async () => {
    const channel = newChannel()
    channel.connect()
    await authenticate()

    const promise = sendCommand(channel, { type: 'invoke', request_id: 'r1', robot_id: 'robot1', slug: 'dock', params: {} }, { timeoutMs: 50 })
    currentSocket().simulateMessage({ type: 'command_result', request_id: 'other', ok: true, job: null, code: null, message: null })

    await expect(promise).rejects.toMatchObject({ code: 'command_timeout' })
  })

  it('waits for the channel to become ready before sending — never resolves as though it were sent', async () => {
    const channel = newChannel()
    const promise = sendCommand(channel, { type: 'invoke', request_id: 'r1', robot_id: 'robot1', slug: 'dock', params: {} })

    await flush()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(currentSocket().sent.find((f) => f.type === 'invoke')).toBeUndefined()

    await authenticate()
    expect(currentSocket().sent).toContainEqual({ type: 'invoke', request_id: 'r1', robot_id: 'robot1', slug: 'dock', params: {} })

    currentSocket().simulateMessage({ type: 'command_result', request_id: 'r1', ok: true, job: null, code: null, message: null })
    await expect(promise).resolves.toMatchObject({ ok: true })
  })

  it('sends the frame exactly once even if the channel briefly reports ready twice before the reply arrives', async () => {
    // Regression: onReady must not double-send.
    const channel = newChannel()
    const promise = sendCommand(channel, { type: 'invoke', request_id: 'r1', robot_id: 'robot1', slug: 'dock', params: {} }, { timeoutMs: 1000 })
    await authenticate()

    expect(currentSocket().sent.filter((f) => f.type === 'invoke')).toHaveLength(1)
    currentSocket().simulateMessage({ type: 'command_result', request_id: 'r1', ok: true, job: null, code: null, message: null })
    await expect(promise).resolves.toMatchObject({ ok: true })
  })

  it('rejects with a typed error carrying the server code and message on ok:false', async () => {
    const channel = newChannel()
    channel.connect()
    await authenticate()

    const promise = sendCommand(channel, { type: 'publish', request_id: 'r1', robot_id: 'robot1', slug: 'cmd-vel', message: {} })
    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: 'r1',
      ok: false,
      job: null,
      code: 'publisher_busy',
      message: 'another user is publishing',
    })

    await expect(promise).rejects.toMatchObject({ code: 'publisher_busy', message: 'another user is publishing' })
  })

  it('surfaces what is running as error.details on a busy refusal', async () => {
    const channel = newChannel()
    channel.connect()
    await authenticate()

    const runningJob = {
      id: 'job1',
      robot_id: 'robot1',
      slug: 'dock',
      state: 'running',
      started_at: 't',
      updated_at: 't',
      result: null,
      error: null,
    }
    const promise = sendCommand(channel, { type: 'invoke', request_id: 'r1', robot_id: 'robot1', slug: 'dock', params: {} })
    currentSocket().simulateMessage({ type: 'command_result', request_id: 'r1', ok: false, job: runningJob, code: 'busy', message: 'dock is running' })

    await expect(promise).rejects.toMatchObject({ code: 'busy', details: { running: runningJob } })
  })

  it('passes the wire details field through verbatim for a non-busy refusal (e.g. parameter_invalid)', async () => {
    const channel = newChannel()
    channel.connect()
    await authenticate()

    const violations = { violations: [{ field: 'order', rule: 'max', message: "'order' must be <= 25." }] }
    const promise = sendCommand(channel, { type: 'invoke', request_id: 'r1', robot_id: 'robot1', slug: 'count-up', params: {} })
    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: 'r1',
      ok: false,
      job: null,
      code: 'parameter_invalid',
      message: 'invalid parameters',
      details: violations,
    })

    await expect(promise).rejects.toMatchObject({ code: 'parameter_invalid', details: violations })
  })

  it('omits error.details when the wire result carries no details and the code is not busy', async () => {
    const channel = newChannel()
    channel.connect()
    await authenticate()

    const promise = sendCommand(channel, { type: 'publish', request_id: 'r1', robot_id: 'robot1', slug: 'drive', message: {} })
    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: 'r1',
      ok: false,
      job: null,
      code: 'robot_offline',
      message: 'robot is offline',
    })

    const rejection = await promise.catch((error: unknown) => error)
    expect(rejection).toMatchObject({ code: 'robot_offline' })
    expect((rejection as { details?: unknown }).details).toBeUndefined()
  })

  it('rejects with command_timeout when no reply arrives in time', async () => {
    vi.useFakeTimers()
    try {
      const channel = newChannel()
      channel.connect()
      await authenticate()

      const promise = sendCommand(channel, { type: 'invoke', request_id: 'r1', robot_id: 'robot1', slug: 'dock', params: {} }, { timeoutMs: 100 })
      const assertion = expect(promise).rejects.toMatchObject({ code: 'command_timeout' })
      await vi.advanceTimersByTimeAsync(100)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects with command_outcome_unknown when the channel reconnects before a reply arrives — never resends the command', async () => {
    vi.useFakeTimers()
    try {
      const channel = newChannel()
      channel.connect()
      await vi.advanceTimersByTimeAsync(0)
      currentSocket().simulateOpen()
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })

      const promise = sendCommand(channel, { type: 'invoke', request_id: 'r1', robot_id: 'robot1', slug: 'dock', params: {} }, { timeoutMs: 60_000 })
      const assertion = expect(promise).rejects.toMatchObject({ code: 'command_outcome_unknown' })

      // Socket drops, a new one takes over — the reply to r1 can never arrive.
      currentSocket().simulateClose()
      await vi.advanceTimersByTimeAsync(500) // default initial backoff
      await vi.advanceTimersByTimeAsync(0)
      currentSocket().simulateOpen()
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })

      await assertion
      // Sent once — a reconnect must never resend an in-flight command.
      const invokeFramesSent = FakeWebSocket.instances.flatMap((s) => s.sent).filter((f) => f.type === 'invoke')
      expect(invokeFramesSent).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects immediately when authentication fails outright, without waiting for the timeout', async () => {
    const channel = new RealtimeChannel({
      url: 'wss://api.fleetless.dev/realtime',
      WebSocket: FakeWebSocket as unknown as new (url: string) => import('../src/realtime.js').WebSocketLike,
      credentials: {
        async token() {
          return null // no session
        },
        async handleExpired() {
          return false
        },
      },
    })

    const promise = sendCommand(channel, { type: 'invoke', request_id: 'r1', robot_id: 'robot1', slug: 'dock', params: {} }, { timeoutMs: 60_000 })
    await expect(promise).rejects.toMatchObject({ code: 'no_session' })
  })
})

describe('resolveLocalWaitMs', () => {
  // The local wait and the platform's patience must be derived from one
  // another, not agree by coincidence as round numbers. These pin down the
  // four cases the doc comment claims.
  it('uses the given default when neither timeoutMs nor patienceMs is set', () => {
    expect(resolveLocalWaitMs({}, 10_000)).toBe(10_000)
  })

  it('derives the local wait from patienceMs plus a margin when timeoutMs is unset', () => {
    // Regression: a caller asking for more patience than the SDK's fixed
    // default must not be cut off by it anyway.
    expect(resolveLocalWaitMs({ patienceMs: 20_000 }, 10_000)).toBeGreaterThan(20_000)
  })

  it('uses timeoutMs unchanged when patienceMs is unset', () => {
    expect(resolveLocalWaitMs({ timeoutMs: 3_000 }, 10_000)).toBe(3_000)
  })

  it('uses timeoutMs unchanged when it is already generous enough for patienceMs', () => {
    expect(resolveLocalWaitMs({ timeoutMs: 30_000, patienceMs: 15_000 }, 10_000)).toBe(30_000)
  })

  it('throws invalid_option when timeoutMs is shorter than patienceMs, rather than racing the two', () => {
    expect(() => resolveLocalWaitMs({ timeoutMs: 5_000, patienceMs: 20_000 }, 10_000)).toThrowError(
      expect.objectContaining({ code: 'invalid_option' }),
    )
  })
})

describe('createRealtimeCommandTransport.invoke + patienceMs wiring', () => {
  it('a generous patienceMs is not cut off by the old fixed 10s local default — proves the wiring, not just resolveLocalWaitMs in isolation', async () => {
    // A wiring bug — e.g. forgetting to pass the resolved value into
    // sendCommand, falling back to its own 10s default — would pass the
    // unit tests above and still be wrong here: this drives the real
    // transport.
    vi.useFakeTimers()
    try {
      const channel = newChannel()
      channel.connect()
      await authenticate()

      const transport = createRealtimeCommandTransport(channel)
      const promise = transport.invoke('robot1', 'dock', {}, { patienceMs: 20_000 }) // no timeoutMs — must be derived
      const stillPending = Promise.race([promise.then(() => 'settled'), Promise.resolve('pending')])

      // Past the old fixed 10s default — must still be waiting.
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(stillPending).resolves.toBe('pending')

      await vi.advanceTimersByTimeAsync(15_000) // total 30s, past the derived (20s + 5s margin) window
      await expect(promise).rejects.toMatchObject({ code: 'command_timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects synchronously with invalid_option and sends no frame when timeoutMs is shorter than patienceMs', async () => {
    const channel = newChannel()
    channel.connect()
    await authenticate()
    currentSocket().sent.length = 0

    const transport = createRealtimeCommandTransport(channel)
    const promise = transport.invoke('robot1', 'dock', {}, { timeoutMs: 1_000, patienceMs: 20_000 })

    await expect(promise).rejects.toMatchObject({ code: 'invalid_option' })
    expect(currentSocket().sent.filter((f) => f.type === 'invoke')).toHaveLength(0)
  })
})
