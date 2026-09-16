// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest'
import { createClient, InMemoryTokenStore } from '../src/index.js'

describe('createClient', () => {
  it('creates a client bound to the api url and app identifier', () => {
    const c = createClient({ apiUrl: 'https://api.fleetless.dev', appIdentifier: 'app_x' })
    expect(c.config.apiUrl).toBe('https://api.fleetless.dev')
    expect(c.config.appIdentifier).toBe('app_x')
  })

  it('derives the realtime url from the api url by default', () => {
    expect(createClient({ apiUrl: 'https://api.fleetless.dev', appIdentifier: 'a' }).config.realtimeUrl).toBe(
      'wss://api.fleetless.dev/realtime',
    )
    expect(createClient({ apiUrl: 'http://localhost:8080', appIdentifier: 'a' }).config.realtimeUrl).toBe(
      'ws://localhost:8080/realtime',
    )
    expect(createClient({ apiUrl: 'http://localhost:8080/', appIdentifier: 'a' }).config.realtimeUrl).toBe(
      'ws://localhost:8080/realtime',
    )
  })

  it('lets a caller override the realtime url outright', () => {
    const c = createClient({
      apiUrl: 'https://api.fleetless.dev',
      appIdentifier: 'a',
      realtimeUrl: 'wss://realtime.fleetless.dev/ws',
    })
    expect(c.config.realtimeUrl).toBe('wss://realtime.fleetless.dev/ws')
  })

  it('refuses a tokenStore and a serverKey together — that is two auth strategies at once', () => {
    expect(() =>
      createClient({
        apiUrl: 'https://api.fleetless.dev',
        appIdentifier: 'a',
        tokenStore: { load: () => null, save: () => {} },
        serverKey: 'flk_' + 'a'.repeat(32),
      }),
    ).toThrow(/tokenStore.*serverKey|serverKey.*tokenStore/)
  })

  it('close() is safe before any subscription was ever made, and safe to call more than once', () => {
    const c = createClient({ apiUrl: 'https://api.fleetless.dev', appIdentifier: 'a' })
    expect(() => c.close()).not.toThrow()
    expect(() => c.close()).not.toThrow()
  })

  it('wires up cameras without opening a realtime channel — no socket exists until something actually subscribes', () => {
    const c = createClient({ apiUrl: 'https://api.fleetless.dev', appIdentifier: 'a' })
    expect(c.cameras).toBeDefined()
    expect(typeof c.cameras.list).toBe('function')
    expect(typeof c.cameras.snapshot).toBe('function')
    expect(typeof c.cameras.snapshotMeta).toBe('function')
    expect(typeof c.cameras.live).toBe('function')
  })

  // MCP grants moved onto `auth` in 3.0.0, with their routes
  // (`/api/client/mcp/grants`). Session-only for the same reason
  // `auth.login`/`logout` are: a server key never went through a consent
  // screen, so there is no "self" to grant as. Behaviour lives in
  // auth.test.ts — this only confirms createClient wires the right
  // implementation per mode.
  it('wires up the MCP grants — a real session on tokenStore, a refusing stub on serverKey', async () => {
    const withSession = createClient({ apiUrl: 'https://api.fleetless.dev', appIdentifier: 'a' })
    expect(typeof withSession.auth.listMcpGrants).toBe('function')
    expect(typeof withSession.auth.revokeMcpGrant).toBe('function')

    const withServerKey = createClient({ apiUrl: 'https://api.fleetless.dev', appIdentifier: 'a', serverKey: 'flk_' + 'a'.repeat(32) })
    await expect(withServerKey.auth.listMcpGrants()).rejects.toMatchObject({ code: 'invalid_option' })
    await expect(withServerKey.auth.revokeMcpGrant('client-abc')).rejects.toMatchObject({ code: 'invalid_option' })
  })

  // Regression, found in a real Chromium: `createClient` defaulted to a
  // *detached* `globalThis.fetch` — `HttpClient` calls it as
  // `this.#fetch(...)`, and a real browser's `fetch` is a Web IDL method
  // that throws "Illegal invocation" unless its receiver is the global
  // object. undici doesn't enforce that, which is why 182 green tests never
  // caught it: every other test passes its own `options.fetch`, so the
  // implicit global-default branch (`client.ts`'s
  // `globalThis.fetch?.bind(globalThis)`) was never called at all. This
  // stub reproduces the real browser check instead of trusting Node to
  // agree with it, so a regression here fails exactly the way Chromium did.
  it('calls the default global fetch bound to globalThis — a real browser throws otherwise', async () => {
    const originalFetch = globalThis.fetch
    function browserLikeFetch(this: unknown): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
      }
      return Promise.resolve(new Response(JSON.stringify({ cameras: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    globalThis.fetch = browserLikeFetch as typeof fetch

    try {
      // No `options.fetch` — this must go through the implicit global default.
      const c = createClient({ apiUrl: 'https://api.fleetless.dev', appIdentifier: 'a', serverKey: 'flk_' + 'a'.repeat(32) })
      await expect(c.cameras.list('robot1')).resolves.toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  // The regression above is structurally impossible to reintroduce
  // per-namespace — every namespace shares one HttpClient and funnels
  // through its single private `this.#fetch(url, init)`. Asserted anyway,
  // for the three call sites 3.0.0 moved or changed: listMcpGrants,
  // revokeMcpGrant and logout all go through the implicit global default
  // here too, and none throws "Illegal invocation".
  //
  // Also measures the header/URL shape a REAL fetch call receives — not the
  // Node `Response` a fake-fetch test builds: revokeMcpGrant's clientId
  // contains both `/` and `%`, the two characters most likely to make a
  // hand-rolled string differ from `pathSegment()`'s actual
  // `encodeURIComponent`, and logout's body/headers are asserted directly
  // from `init`, not from a mock's own recollection of what it was called
  // with. Both grant routes now answer 204, so this also proves the two
  // `expectEmptyBody` call sites tolerate a genuinely empty body rather
  // than raising `unexpected_response`.
  it('the MCP grant calls and auth.logout also go through the default global fetch, with the real request shape', async () => {
    const originalFetch = globalThis.fetch
    const calls: { url: string; init: RequestInit | undefined }[] = []
    function browserLikeFetch(this: unknown, input: string | URL | Request, init?: RequestInit): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
      }
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/api/client/mcp/grants')) {
        return Promise.resolve(
          new Response(JSON.stringify({ grants: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
        )
      }
      // revokeMcpGrant and logout both answer 204 with nothing at all.
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    globalThis.fetch = browserLikeFetch as typeof fetch

    try {
      const tokenStore = new InMemoryTokenStore()
      tokenStore.save({ access_token: 'at1', refresh_token: 'rt1', expires_in: 900 })
      // No `options.fetch` — same implicit global default as the test above.
      const c = createClient({ apiUrl: 'https://api.fleetless.dev', appIdentifier: 'a', tokenStore })

      await expect(c.auth.listMcpGrants()).resolves.toEqual([])
      await expect(c.auth.revokeMcpGrant('team a/b%c')).resolves.toBeUndefined()
      await expect(c.auth.logout()).resolves.toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.fleetless.dev/api/client/mcp/grants',
      // pathSegment() -> encodeURIComponent: '/' and '%' both survive as a
      // single inert path segment, not as extra path structure or a
      // mis-decoded byte.
      'https://api.fleetless.dev/api/client/mcp/grants/team%20a%2Fb%25c',
      'https://api.fleetless.dev/api/client/logout',
    ])
    // DELETE carries no body — no content-type header (see http.ts's
    // #send: a bodyless request with content-type: application/json is
    // refused outright by the cloud).
    expect((calls[1]!.init?.headers as Record<string, string> | undefined)?.['content-type']).toBeUndefined()
    // logout carries a real JSON body with the refresh token, and IS marked
    // content-type: application/json.
    expect((calls[2]!.init?.headers as Record<string, string> | undefined)?.['content-type']).toBe('application/json')
    expect(JSON.parse(calls[2]!.init?.body as string)).toEqual({ refresh_token: 'rt1' })
  })
})
