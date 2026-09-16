// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientIdentity, Job } from '@fleetless/contracts'
import { createClient, InMemoryTokenStore } from '../src/index.js'
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

function jobWith(state: Job['state'], overrides: Partial<Job> = {}): Job {
  return {
    id: 'job1',
    robot_id: 'robot1',
    slug: 'get-status',
    state,
    started_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    seq: 1,
    result: null,
    error: null,
    ...overrides,
  }
}

describe('services.call', () => {
  it('resolves directly with the result when the initial reply already carries a terminal job', async () => {
    const client = loggedInClient()
    const promise = client.services.call('robot1', 'get-status', {})
    await authenticate()
    const requestId = currentSocket().sent.find((f) => f.type === 'invoke')?.request_id

    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: requestId,
      ok: true,
      job: jobWith('succeeded', { result: { battery: 87 } }),
      code: null,
      message: null,
    })

    await expect(promise).resolves.toEqual({ battery: 87 })
  })

  it('waits for the job to reach a terminal state via a job event, then resolves with the result — never subscribes twice', async () => {
    const client = loggedInClient()
    const promise = client.services.call('robot1', 'get-status', {})
    await authenticate()
    const requestId = currentSocket().sent.find((f) => f.type === 'invoke')?.request_id

    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: requestId,
      ok: true,
      job: jobWith('running'),
      code: null,
      message: null,
    })
    await flush() // let the invoke's promise settle and the internal job subscription wire itself up

    expect(currentSocket().sent.filter((f) => f.type === 'subscribe')).toHaveLength(1)

    currentSocket().simulateMessage({
      type: 'job',
      robot_id: 'robot1',
      slug: 'get-status',
      job: jobWith('succeeded', { result: { battery: 42 } }),
      feedback: null,
      progress: null,
      timestamp_ms: 1,
    })

    await expect(promise).resolves.toEqual({ battery: 42 })
    // The internal subscription is torn down once the result is known.
    expect(currentSocket().sent).toContainEqual({ type: 'unsubscribe', robot_id: 'robot1', slug: 'get-status' })
  })

  it('ignores a job event for a different job id on the same slug', async () => {
    const client = loggedInClient()
    const promise = client.services.call('robot1', 'get-status', {}, { timeoutMs: 50 })
    await authenticate()
    const requestId = currentSocket().sent.find((f) => f.type === 'invoke')?.request_id

    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: requestId,
      ok: true,
      job: jobWith('running', { id: 'job1' }),
      code: null,
      message: null,
    })
    await flush()
    currentSocket().simulateMessage({
      type: 'job',
      robot_id: 'robot1',
      slug: 'get-status',
      job: jobWith('succeeded', { id: 'job-other', result: 'wrong' }),
      feedback: null,
      progress: null,
      timestamp_ms: 1,
    })

    await expect(promise).rejects.toMatchObject({ code: 'command_timeout' })
  })

  it('rejects with the job error on a failed terminal state', async () => {
    const client = loggedInClient()
    const promise = client.services.call('robot1', 'get-status', {})
    await authenticate()
    const requestId = currentSocket().sent.find((f) => f.type === 'invoke')?.request_id

    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: requestId,
      ok: true,
      job: jobWith('running'),
      code: null,
      message: null,
    })
    await flush()
    currentSocket().simulateMessage({
      type: 'job',
      robot_id: 'robot1',
      slug: 'get-status',
      job: jobWith('failed', { error: { code: 'ros_service_error', message: 'service unavailable' } }),
      feedback: null,
      progress: null,
      timestamp_ms: 1,
    })

    await expect(promise).rejects.toMatchObject({ code: 'ros_service_error', message: 'service unavailable' })
  })

  it('passes job.error.details through — job_queue_full is discovered after the job is minted, so its {limit, queued} rides here', async () => {
    // contracts cf82a74: job.error gained an optional `details`. job_queue_full
    // surfaces only once the bridge already has the job — never as the call's
    // own refusal, always the job's terminal error. Before this fix, unwrap()
    // never read error.details, so a caller saw the code and message but
    // nothing to decide whether retrying was worth it.
    const client = loggedInClient()
    const promise = client.services.call('robot1', 'get-status', {})
    await authenticate()
    const requestId = currentSocket().sent.find((f) => f.type === 'invoke')?.request_id

    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: requestId,
      ok: true,
      job: jobWith('running'),
      code: null,
      message: null,
    })
    await flush()
    currentSocket().simulateMessage({
      type: 'job',
      robot_id: 'robot1',
      slug: 'get-status',
      job: jobWith('failed', {
        error: { code: 'job_queue_full', message: "the bridge's job queue is full", details: { limit: 32, queued: 32 } },
      }),
      feedback: null,
      progress: null,
      timestamp_ms: 1,
    })

    await expect(promise).rejects.toMatchObject({ code: 'job_queue_full', details: { limit: 32, queued: 32 } })
  })

  it('rejects immediately on a busy refusal, without waiting on any job event', async () => {
    const client = loggedInClient()
    const promise = client.services.call('robot1', 'get-status', {})
    await authenticate()
    const requestId = currentSocket().sent.find((f) => f.type === 'invoke')?.request_id

    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: requestId,
      ok: false,
      job: jobWith('running'),
      code: 'busy',
      message: 'a call is already in flight',
    })

    await expect(promise).rejects.toMatchObject({ code: 'busy' })
    expect(currentSocket().sent.filter((f) => f.type === 'subscribe')).toHaveLength(0)
  })

  it('rejects lost as a job outcome, distinct from a timeout', async () => {
    const client = loggedInClient()
    const promise = client.services.call('robot1', 'get-status', {})
    await authenticate()
    const requestId = currentSocket().sent.find((f) => f.type === 'invoke')?.request_id

    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: requestId,
      ok: true,
      job: jobWith('running'),
      code: null,
      message: null,
    })
    await flush()
    currentSocket().simulateMessage({
      type: 'job',
      robot_id: 'robot1',
      slug: 'get-status',
      job: jobWith('lost'),
      feedback: null,
      progress: null,
      timestamp_ms: 1,
    })

    await expect(promise).rejects.toMatchObject({ code: 'lost' })
  })

  it('passes patience_ms through to the invoke frame when both are given explicitly', async () => {
    // patience_ms bounds the *platform's* wait for this call (the whole
    // wait, unlike an action's acceptance-only bound). timeoutMs (60s) is
    // already generous enough for patienceMs (5s) here, so it passes through
    // unchanged — see the derived-window tests below for when it isn't, or
    // is left unset.
    const client = loggedInClient()
    const promise = client.services.call('robot1', 'get-status', {}, { patienceMs: 5_000, timeoutMs: 60_000 })
    await authenticate()

    const sent = currentSocket().sent.find((f) => f.type === 'invoke')
    expect(sent).toMatchObject({ patience_ms: 5_000 })

    const requestId = sent?.request_id
    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: requestId,
      ok: true,
      job: jobWith('succeeded', { result: { battery: 1 } }),
      code: null,
      message: null,
    })

    await expect(promise).resolves.toEqual({ battery: 1 })
  })

  it('a generous patienceMs is not cut off by the old fixed 30s local default', async () => {
    // Before the window was derived, timeoutMs (30s) and patience_ms (15s)
    // agreed only by coincidence: raising patienceMs past the SDK's fixed
    // local default used to cut the call off with nobody having refused it.
    // Reproduced here with patienceMs (40s) past the old 30s default, on a
    // real timer.
    vi.useFakeTimers()
    try {
      const client = loggedInClient()
      const promise = client.services.call('robot1', 'get-status', {}, { patienceMs: 40_000 })
      await authenticate()

      // command_result never arrives — this call is waiting out its own
      // local clock. Past the old fixed 30s default: must still be
      // waiting, not already rejected with command_timeout.
      await vi.advanceTimersByTimeAsync(30_000)
      const stillPending = Promise.race([promise.then(() => 'settled').catch(() => 'settled'), Promise.resolve('pending')])
      await expect(stillPending).resolves.toBe('pending')

      // Now let the derived window (patienceMs + margin) actually elapse.
      await vi.advanceTimersByTimeAsync(20_000) // total 50s, past 40s + 5s margin
      await expect(promise).rejects.toMatchObject({ code: 'command_timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects with invalid_option and sends no frame when timeoutMs is shorter than patienceMs', async () => {
    // Refused before transport.invoke is called — no socket needed, which is
    // part of the claim: authenticating first (as every other test here
    // does) would be wrong, since a real caller never gets that far either.
    const client = loggedInClient()
    const promise = client.services.call('robot1', 'get-status', {}, { timeoutMs: 1_000, patienceMs: 40_000 })

    await expect(promise).rejects.toMatchObject({ code: 'invalid_option' })
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('bounds the WHOLE call at timeoutMs, not twice it — a late ack must not reset the terminal-wait clock', async () => {
    // The compounding bug: timeoutMs bounded the ack-wait, then separately
    // started a fresh terminal-wait timer once the ack arrived — an ack
    // arriving just before its own deadline bought a second full window, up
    // to ~2x timeoutMs. This asserts the actual bound: a late ack leaves
    // only what's left of the ORIGINAL deadline, not a fresh one.
    vi.useFakeTimers()
    try {
      const client = loggedInClient()
      const promise = client.services.call('robot1', 'get-status', {}, { timeoutMs: 10_000 })
      await authenticate()
      const requestId = currentSocket().sent.find((f) => f.type === 'invoke')?.request_id

      // Ack arrives late — at t=9s of the 10s budget, well inside the
      // ack-wait's own timeout, but leaving only ~1s of the shared deadline.
      await vi.advanceTimersByTimeAsync(9_000)
      currentSocket().simulateMessage({
        type: 'command_result',
        request_id: requestId,
        ok: true,
        job: jobWith('running'),
        code: null,
        message: null,
      })
      await flush() // let the invoke's promise settle and the terminal-wait timer get scheduled

      // No terminal event ever arrives. Still within the ~1s left of the
      // ORIGINAL 10s deadline (total elapsed 9.5s) — must still be pending.
      await vi.advanceTimersByTimeAsync(500)
      const stillPending = Promise.race([promise.then(() => 'settled').catch(() => 'settled'), Promise.resolve('pending')])
      await expect(stillPending).resolves.toBe('pending')

      // Past the ORIGINAL 10s deadline (total elapsed 10.1s). With a fresh
      // window started at the ack there would still be ~9.4s left — this
      // must reject now instead.
      await vi.advanceTimersByTimeAsync(600)
      await expect(promise).rejects.toMatchObject({ code: 'command_timeout' })
    } finally {
      vi.useRealTimers()
    }
  })
})
