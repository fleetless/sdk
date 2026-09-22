// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createClient, type CredentialSource } from '../src/index.js'
import { FakeWebSocket } from './fake-websocket.js'

/**
 * **D4 (2026-09-22 triage): a client can be handed the credential it should
 * use.**
 *
 * The two modes this SDK had both own their credential: `tokenStore` builds
 * a session that refreshes itself, `serverKey` wraps a static string. An
 * embedder that already holds a bearer — the developer console, which has
 * its own session and its own refresh — had to impersonate a token store,
 * and a `token_expired` from the cloud while its own clock still read live
 * posted one empty refresh whose `validation_error` had to be translated
 * back into a session message.
 *
 * `credentials` is the third mode: the caller answers both questions, and
 * the SDK never builds a refresh request at all.
 */
describe('createClient({ credentials })', () => {
  beforeEach(() => {
    FakeWebSocket.reset()
  })

  function source(token: string | null, handleExpired = async () => false): CredentialSource {
    return { async token() { return token }, handleExpired }
  }

  it('refuses a credential source together with either mode that owns one', () => {
    expect(() =>
      createClient({
        apiUrl: 'https://api.fleetless.dev',
        appIdentifier: 'a',
        credentials: source('t'),
        tokenStore: { load: () => null, save: () => {} },
      }),
    ).toThrow(/credentials/)
    expect(() =>
      createClient({
        apiUrl: 'https://api.fleetless.dev',
        appIdentifier: 'a',
        credentials: source('t'),
        serverKey: 'flk_' + 'a'.repeat(32),
      }),
    ).toThrow(/credentials/)
  })

  it('authorizes REST with the token the source answers, asking it every time', async () => {
    const tokens = ['first', 'second']
    const asked = vi.fn(async () => tokens.shift() ?? null)
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ cameras: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const c = createClient({
      apiUrl: 'https://api.fleetless.dev',
      appIdentifier: 'a',
      credentials: { token: asked, async handleExpired() { return false } },
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await c.cameras.list('robot1')
    await c.cameras.list('robot1')
    // Read per request, not cached at construction: an embedder whose
    // session rotates underneath must not keep authorizing with the token
    // this client happened to see first.
    expect(asked).toHaveBeenCalledTimes(2)
    const headersOf = (call: number) => (fetchImpl.mock.calls[call]![1] as RequestInit).headers as Record<string, string>
    expect(headersOf(0).authorization).toBe('Bearer first')
    expect(headersOf(1).authorization).toBe('Bearer second')
  })

  it('carries the same token into the realtime auth frame', () => {
    const c = createClient({
      apiUrl: 'https://api.fleetless.dev',
      appIdentifier: 'a',
      credentials: source('realtime-token'),
      fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    })

    c.datapoints.subscribe('robot1', 'battery', { onEvent() {} })
    return Promise.resolve().then(() => {
      const socket = FakeWebSocket.instances.at(-1)!
      socket.simulateOpen()
      return Promise.resolve().then(() => {
        expect(socket.sent).toEqual([{ type: 'auth', token: 'realtime-token' }])
        c.close()
      })
    })
  })

  it('refuses login and logout, the same way a server key does', async () => {
    const c = createClient({
      apiUrl: 'https://api.fleetless.dev',
      appIdentifier: 'a',
      credentials: source('t'),
      fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    })
    await expect(c.auth.login('a@b.c', 'pw')).rejects.toMatchObject({ code: 'invalid_option' })
    await expect(c.auth.logout()).rejects.toMatchObject({ code: 'invalid_option' })
    // The refusal names the option the caller actually passed — telling
    // somebody their `serverKey` is the problem when they never passed one
    // sends them looking for a key that does not exist.
    await expect(c.auth.login('a@b.c', 'pw')).rejects.toThrow(/credentials/)
  })

  it('never builds a refresh request when the source declines to refresh', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ code: 'token_expired', message: 'expired' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    )
    const handleExpired = vi.fn(async () => false)
    const c = createClient({
      apiUrl: 'https://api.fleetless.dev',
      appIdentifier: 'a',
      credentials: { async token() { return 'stale' }, handleExpired },
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await expect(c.cameras.list('robot1')).rejects.toMatchObject({ code: 'token_expired' })
    expect(handleExpired).toHaveBeenCalledTimes(1)
    // One request, and it was not `/api/client/refresh`: the empty refresh
    // this option exists to stop.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls.every((call) => !call[0].includes('/refresh'))).toBe(true)
  })
})
