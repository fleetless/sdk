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

const RUNNING_JOB: Job = {
  id: 'job1',
  robot_id: 'robot1',
  slug: 'dock',
  state: 'running',
  started_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  seq: 1,
  result: null,
  error: null,
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

describe('actions.invoke', () => {
  it('sends invoke with a request_id and resolves with the created job', async () => {
    const client = loggedInClient()
    const promise = client.actions.invoke('robot1', 'dock', { speed: 1 })
    await authenticate()

    const sent = currentSocket().sent.find((f) => f.type === 'invoke')
    expect(sent).toMatchObject({ type: 'invoke', robot_id: 'robot1', slug: 'dock', params: { speed: 1 } })
    expect(typeof sent?.request_id).toBe('string')
    expect((sent?.request_id as string).length).toBeGreaterThan(0)

    currentSocket().simulateMessage({ type: 'command_result', request_id: sent?.request_id, ok: true, job: RUNNING_JOB, code: null, message: null })
    await expect(promise).resolves.toEqual(RUNNING_JOB)
  })

  it('rejects busy with what is running in error.details', async () => {
    const client = loggedInClient()
    const promise = client.actions.invoke('robot1', 'dock', {})
    await authenticate()
    const requestId = currentSocket().sent.find((f) => f.type === 'invoke')?.request_id

    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: requestId,
      ok: false,
      job: RUNNING_JOB,
      code: 'busy',
      message: 'dock is already running',
    })

    await expect(promise).rejects.toMatchObject({ code: 'busy', details: { running: RUNNING_JOB } })
  })

  it('rejects with the server code on robot_offline / parameter_invalid', async () => {
    const client = loggedInClient()
    const promise = client.actions.invoke('robot1', 'dock', { speed: 999 })
    await authenticate()
    const requestId = currentSocket().sent.find((f) => f.type === 'invoke')?.request_id

    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: requestId,
      ok: false,
      job: null,
      code: 'parameter_invalid',
      message: "speed exceeds max",
    })

    await expect(promise).rejects.toMatchObject({ code: 'parameter_invalid' })
  })

  it('omits patience_ms from the wire frame entirely when the caller names no preference', async () => {
    // Real serialization, not a mock object: FakeWebSocket.send() receives
    // the JSON string channel.send() actually produces and parses it back,
    // so `'patience_ms' in sent` being false here means JSON.stringify
    // dropped the key — the platform default applies, not a sent `null`
    // or `0` that would mean something else on the wire.
    const client = loggedInClient()
    const promise = client.actions.invoke('robot1', 'dock', {})
    await authenticate()

    const sent = currentSocket().sent.find((f) => f.type === 'invoke')
    expect(sent).toBeDefined()
    expect('patience_ms' in sent!).toBe(false)

    currentSocket().simulateMessage({ type: 'command_result', request_id: sent?.request_id, ok: true, job: RUNNING_JOB, code: null, message: null })
    await promise
  })

  it('sends patience_ms on the wire frame when the caller names one', async () => {
    const client = loggedInClient()
    const promise = client.actions.invoke('robot1', 'dock', {}, { patienceMs: 45_000 })
    await authenticate()

    const sent = currentSocket().sent.find((f) => f.type === 'invoke')
    expect(sent).toMatchObject({ patience_ms: 45_000 })

    currentSocket().simulateMessage({ type: 'command_result', request_id: sent?.request_id, ok: true, job: RUNNING_JOB, code: null, message: null })
    await promise
  })
})

describe('actions.cancel', () => {
  it('resolves with null when there was nothing running to cancel', async () => {
    const client = loggedInClient()
    const promise = client.actions.cancel('robot1', 'dock')
    await authenticate()

    // job_id: null on the wire, not omitted — clientCancel.job_id is
    // required-and-nullable; null means "stop whatever is running",
    // distinct from an absent field, which would be a bug.
    const sent = currentSocket().sent.find((f) => f.type === 'cancel')
    expect(sent).toMatchObject({ type: 'cancel', robot_id: 'robot1', slug: 'dock', job_id: null })

    currentSocket().simulateMessage({ type: 'command_result', request_id: sent?.request_id, ok: true, job: null, code: null, message: null })
    await expect(promise).resolves.toBeNull()
  })

  it('resolves with the job the cancel was actually sent to — cancelling "nothing running" and a real job must not be indistinguishable', async () => {
    const client = loggedInClient()
    const promise = client.actions.cancel('robot1', 'dock')
    await authenticate()

    const sent = currentSocket().sent.find((f) => f.type === 'cancel')
    currentSocket().simulateMessage({ type: 'command_result', request_id: sent?.request_id, ok: true, job: RUNNING_JOB, code: null, message: null })
    await expect(promise).resolves.toEqual(RUNNING_JOB)
  })

  it('cancel(robotId, slug, jobId) addresses that job on the wire', async () => {
    const client = loggedInClient()
    const promise = client.actions.cancel('robot1', 'dock', 'job1')
    await authenticate()

    const sent = currentSocket().sent.find((f) => f.type === 'cancel')
    expect(sent).toMatchObject({ type: 'cancel', robot_id: 'robot1', slug: 'dock', job_id: 'job1' })

    currentSocket().simulateMessage({ type: 'command_result', request_id: sent?.request_id, ok: true, job: RUNNING_JOB, code: null, message: null })
    await expect(promise).resolves.toEqual(RUNNING_JOB)
  })

  it('never falls back to the slug-only form when a named job_id is not_found — surfaces the refusal and sends exactly one frame', async () => {
    const client = loggedInClient()
    const promise = client.actions.cancel('robot1', 'dock', 'stale-job-id')
    await authenticate()

    const sent = currentSocket().sent.find((f) => f.type === 'cancel')
    currentSocket().simulateMessage({
      type: 'command_result',
      request_id: sent?.request_id,
      ok: false,
      job: null,
      code: 'not_found',
      message: "job 'stale-job-id' is not running on 'dock'",
    })

    await expect(promise).rejects.toMatchObject({ code: 'not_found' })
    // Exactly the one frame above — a caller who named an id that turned out
    // stale gets that fact, not a silent retry against the slug.
    expect(currentSocket().sent.filter((f) => f.type === 'cancel')).toHaveLength(1)
  })

  it('rejects invalid_option (not a server round trip) when the third argument is an object — the options-as-third-argument mistake', async () => {
    // `cancel` once took `(robotId, slug, options?)`. A plain-JS caller who
    // upgraded and kept passing an options object third would have it
    // silently become job_id on the wire — eventually refused by the
    // platform, but as a validation_error that never says why. No
    // FakeWebSocket should even be constructed: this is refused before
    // transport.cancel builds a frame or connects.
    const client = loggedInClient()
    // @ts-expect-error — exercising exactly the mistake a JS caller (no
    // compiler to stop them) would make: an options object where jobId goes.
    const promise = client.actions.cancel('robot1', 'dock', { timeoutMs: 5000 })

    await expect(promise).rejects.toMatchObject({ code: 'invalid_option' })
    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})

describe('actions.subscribe', () => {
  it('subscribes by slug and delivers job events', async () => {
    const client = loggedInClient()
    const onJob = vi.fn()

    client.actions.subscribe('robot1', 'dock', { onJob })
    await authenticate()

    expect(currentSocket().sent).toContainEqual({ type: 'subscribe', robot_id: 'robot1', slug: 'dock' })

    const event = { type: 'job', robot_id: 'robot1', slug: 'dock', job: RUNNING_JOB, feedback: { progress: 'left dock' }, progress: 0.5, timestamp_ms: 10 }
    currentSocket().simulateMessage(event)
    expect(onJob).toHaveBeenCalledWith(event)
  })

  it('does not deliver a datapoint event to a job subscriber, or vice versa', async () => {
    const client = loggedInClient()
    const onJob = vi.fn()
    const onEvent = vi.fn()

    client.actions.subscribe('robot1', 'dock', { onJob })
    client.datapoints.subscribe('robot1', 'battery-percentage', { onEvent })
    await authenticate()

    currentSocket().simulateMessage({ type: 'datapoint', robot_id: 'robot1', slug: 'battery-percentage', value: 50, timestamp_ms: 1 })
    expect(onJob).not.toHaveBeenCalled()
    expect(onEvent).toHaveBeenCalledTimes(1)
  })

  it('reference-counts subscriptions to the same (robot, slug): one wire subscribe, and unsubscribing one leaves the other live', async () => {
    const client = loggedInClient()
    const onJobA = vi.fn()
    const onJobB = vi.fn()

    const subA = client.actions.subscribe('robot1', 'dock', { onJob: onJobA })
    const subB = client.actions.subscribe('robot1', 'dock', { onJob: onJobB })
    await authenticate()

    expect(currentSocket().sent.filter((f) => f.type === 'subscribe')).toHaveLength(1)

    const event1 = { type: 'job', robot_id: 'robot1', slug: 'dock', job: RUNNING_JOB, feedback: null, progress: null, timestamp_ms: 1 }
    currentSocket().simulateMessage(event1)
    expect(onJobA).toHaveBeenCalledTimes(1)
    expect(onJobB).toHaveBeenCalledTimes(1)

    currentSocket().sent.length = 0
    subA.unsubscribe()
    expect(currentSocket().sent).toEqual([]) // B still subscribed — no unsubscribe frame yet

    const event2 = { ...event1, timestamp_ms: 2 }
    currentSocket().simulateMessage(event2)
    expect(onJobA).toHaveBeenCalledTimes(1) // unchanged
    expect(onJobB).toHaveBeenCalledTimes(2)

    subB.unsubscribe()
    expect(currentSocket().sent).toEqual([{ type: 'unsubscribe', robot_id: 'robot1', slug: 'dock' }])
  })

  it('routes subscribe_error to the job subscriber', async () => {
    const client = loggedInClient()
    const onError = vi.fn()

    client.actions.subscribe('robot1', 'dock', { onJob: vi.fn(), onError })
    await authenticate()

    currentSocket().simulateMessage({ type: 'subscribe_error', robot_id: 'robot1', slug: 'dock', code: 'forbidden', message: 'no access' })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toMatchObject({ code: 'forbidden' })
  })

  it('resubscribes automatically after the channel reconnects, and delivers nothing fabricated in between', async () => {
    // A socket cycling under a job subscription must never invent a job
    // update on its own — only resend the wire `subscribe` and wait for
    // whatever the server actually pushes next. This is the deterministic,
    // FakeWebSocket-provable half of "a socket cycle after the
    // acknowledgement does not fabricate an outcome" — the other half (a real
    // disconnect under a real in-flight command) is scripts/verify-live.mjs,
    // which needs a live cloud.
    vi.useFakeTimers()
    try {
      const client = loggedInClient()
      const onJob = vi.fn()
      client.actions.subscribe('robot1', 'dock', { onJob })

      await vi.advanceTimersByTimeAsync(0)
      currentSocket().simulateOpen()
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })
      expect(currentSocket().sent).toContainEqual({ type: 'subscribe', robot_id: 'robot1', slug: 'dock' })

      currentSocket().simulateClose()
      await vi.advanceTimersByTimeAsync(500) // default initial backoff
      await vi.advanceTimersByTimeAsync(0)
      // Nothing fabricated while disconnected or mid-reconnect — no event, no error.
      expect(onJob).not.toHaveBeenCalled()

      currentSocket().simulateOpen()
      currentSocket().simulateMessage({ type: 'auth_ok', identity: IDENTITY })

      expect(FakeWebSocket.instances).toHaveLength(2)
      expect(currentSocket().sent).toContainEqual({ type: 'subscribe', robot_id: 'robot1', slug: 'dock' })
      expect(onJob).not.toHaveBeenCalled() // still nothing, until the server actually says something

      const event = { type: 'job', robot_id: 'robot1', slug: 'dock', job: RUNNING_JOB, feedback: null, progress: null, timestamp_ms: 20 }
      currentSocket().simulateMessage(event)
      expect(onJob).toHaveBeenCalledTimes(1)
      expect(onJob).toHaveBeenCalledWith(event)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sharing the realtime channel', () => {
  // Regression: a subscribe and a command issued in the same synchronous
  // tick both called RealtimeChannel.connect() before the pending #open()'s
  // credential lookup resolved, opening two physical sockets — the second
  // one's auth_ok then failed the invoke, already sent on the first, with
  // command_outcome_unknown, though nothing was wrong with it. This is the
  // exact shape from the client's public surface, not RealtimeChannel's
  // internals (see realtime.test.ts for that).
  it('subscribing to a datapoint and invoking an action in the same tick share one socket, and the invoke resolves normally', async () => {
    const client = loggedInClient()
    const onEvent = vi.fn()

    client.datapoints.subscribe('robot1', 'battery-percentage', { onEvent })
    const invokePromise = client.actions.invoke('robot1', 'dock', { speed: 1 })
    await authenticate()

    expect(FakeWebSocket.instances).toHaveLength(1)

    const invokeFrame = currentSocket().sent.find((f) => f.type === 'invoke')
    expect(invokeFrame).toBeDefined()
    currentSocket().simulateMessage({ type: 'command_result', request_id: invokeFrame?.request_id, ok: true, job: RUNNING_JOB, code: null, message: null })

    await expect(invokePromise).resolves.toEqual(RUNNING_JOB)
  })
})

describe('the wire subscription is shared across kinds, not counted twice', () => {
  // Regression: datapoints.ts and
  // job-subscriptions.ts each kept their OWN counter over the same
  // (robotId, slug) key, both driving the same wire subscribe/unsubscribe —
  // so releasing the last holder in EITHER registry sent a real unsubscribe
  // that silently cancelled the OTHER registry's still-active subscription,
  // with no error reported anywhere. Fixed by moving the count into
  // slug-subscriptions.ts, shared by both. The same literal slug is used for
  // both kinds here on purpose — this test is about the SDK's own
  // client-side bookkeeping, not about a slug legitimately being both kinds
  // at once (a slug names one namespace, so it cannot be).
  it('releasing a datapoint subscription does not cancel a job subscription on the same slug', async () => {
    const client = loggedInClient()
    const onEvent = vi.fn()
    const onJob = vi.fn()

    const dpSub = client.datapoints.subscribe('robot1', 'shared-slug', { onEvent })
    const jobSub = client.actions.subscribe('robot1', 'shared-slug', { onJob })
    await authenticate()

    // One wire subscribe for the shared key, not two.
    expect(currentSocket().sent.filter((f) => f.type === 'subscribe')).toHaveLength(1)

    currentSocket().sent.length = 0
    dpSub.unsubscribe()
    // The job subscription is still live: no wire unsubscribe yet.
    expect(currentSocket().sent).toEqual([])

    const event = { type: 'job', robot_id: 'robot1', slug: 'shared-slug', job: RUNNING_JOB, feedback: null, progress: null, timestamp_ms: 1 }
    currentSocket().simulateMessage(event)
    expect(onJob).toHaveBeenCalledTimes(1)
    expect(onJob).toHaveBeenCalledWith(event)

    // Now the last holder releases: the real wire unsubscribe goes out, exactly once.
    jobSub.unsubscribe()
    expect(currentSocket().sent).toEqual([{ type: 'unsubscribe', robot_id: 'robot1', slug: 'shared-slug' }])
  })
})
