// SPDX-License-Identifier: MIT
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, vi } from 'vitest'
import type { ApiError } from '@fleetless/contracts'
import { HttpClient, noCredentials, pathSegment, type CredentialSource } from '../src/http.js'
import { FleetlessError } from '../src/errors.js'

// Untyped on purpose: HttpClient is generic and shape-agnostic, and most
// bodies here (`{hello:'world'}`, `{ok:true}`) are arbitrary JSON exercising
// the transport, not stand-ins for a real contract. The one shape that IS a
// contract, apiError, is checked at its call sites (`satisfies ApiError`)
// instead.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function credentialsWith(rawToken: string | null, handleExpired: () => Promise<boolean> = async () => false): CredentialSource {
  return {
    token: async () => rawToken,
    handleExpired,
  }
}

/**
 * Checks what HttpClient *asked* fetch to send — never what a real fetch
 * puts on the wire (defaults like `content-type` that nothing here
 * constructed stay invisible to it). Proved once: dropping `requestOAuth`'s
 * explicit `content-type` header left every assertion here green while a
 * real `node:http` server got the real fetch's own default instead. A claim
 * about the actual wire format needs a real transport — `auth.test.ts` and
 * `oidc.test.ts` now run entirely on one (`test/local-api.ts`).
 */
function fakeFetch(impl: (input: string | URL | RequestInfo, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl)
}

/** Awaits a rejecting promise and narrows it to a FleetlessError, or rethrows. */
async function captureError(promise: Promise<unknown>): Promise<FleetlessError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof FleetlessError) return error
    throw error
  }
  throw new Error('expected the promise to reject')
}

describe('HttpClient', () => {
  it('resolves parsed json on a 2xx response', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ hello: 'world' }))
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })

    await expect(client.request('/api/robots', {})).resolves.toEqual({ hello: 'world' })
    expect(fetchImpl).toHaveBeenCalledWith('https://api.fleetless.dev/api/robots', expect.objectContaining({ method: 'GET' }))
  })

  it('treats a 204 as no body, when the caller declared this route bodyless', async () => {
    // A 204 has no body by definition — `.text()` on one already resolves
    // `''` (confirmed against the platform's own Response semantics). But
    // that alone does not mean the CALLER expected no body: `expectEmptyBody`
    // is still required, same as an empty 200/202. Without it here,
    // this would throw unexpected_response instead of resolving.
    const fetchImpl = fakeFetch(async () => new Response(null, { status: 204 }))
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })
    await expect(
      client.request('/api/client/logout', { method: 'POST', body: { refresh_token: 'rt1' }, expectEmptyBody: true }),
    ).resolves.toBeUndefined()
  })

  it('a 204 on a route that did NOT declare itself bodyless still fails at the boundary — status alone does not exempt it', async () => {
    // The gap this closes: an earlier version exempted 204 unconditionally
    // (true, it has no body — but beside the point). A ROUTE REGRESSING to
    // 204 when its caller expects real tokens back (changePassword's route,
    // before contracts d344d5a made it re-issue sessionTokens) would have
    // silently resolved undefined into `tokenStore.save(undefined)` — the
    // exact silent-corruption this mechanism exists to turn loud.
    const fetchImpl = fakeFetch(async () => new Response(null, { status: 204 }))
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })

    const error = await captureError(
      client.request('/api/client/password/change', { method: 'POST', body: { current_password: 'old', new_password: 'new-correct-horse-battery' } }),
    )
    expect(error.code).toBe('unexpected_response')
    expect(error.message).toContain('/api/client/password/change')
  })

  it('a route that owes a body and gets an empty one fails at the boundary, naming the route — it does not silently become undefined', async () => {
    // Before this, an empty body on a 200/202 silently resolved `undefined`,
    // surfacing as a bare TypeError on the caller's next line (`const {
    // access_token } = await ...`) with no hint which request was
    // responsible. This replaces that: a route without `expectEmptyBody`
    // must fail HERE if the server sends nothing.
    const fetchImpl = fakeFetch(async () => new Response('', { status: 200 }))
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })

    const error = await captureError(
      client.request('/api/client/login', { method: 'POST', skipAuth: true, body: { app_identifier: 'app_x', email: 'a@b.de', password: 'pw' } }),
    )
    expect(error.code).toBe('unexpected_response')
    // The route belongs in the message — that's the whole point of failing
    // here instead of downstream, where the route is no longer in scope.
    expect(error.message).toContain('/api/client/login')
  })

  it('expectEmptyBody opts a specific call OUT of that check — an empty body there resolves undefined, same as 204', async () => {
    const fetchImpl = fakeFetch(async () => new Response('', { status: 202 }))
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })

    // The camera live-session release is the SDK's one remaining
    // `expectEmptyBody` call site. The response here is a 202 with an empty
    // *string* body rather than that route's real 204, deliberately: the
    // invariant is that the opt-out is read from the option and not from
    // the status, so a 204 would let a status-based implementation pass.
    await expect(
      client.request('/api/robots/r1/cameras/front/live/s1', {
        method: 'DELETE',
        expectEmptyBody: true,
      }),
    ).resolves.toBeUndefined()
  })

  it('a 202 WITH a body still parses it normally, whether or not the call declared expectEmptyBody', async () => {
    // A route can answer 202 WITH a body. A body-detection scheme that
    // can't tell that apart from a genuinely bodyless 202 is the bug D7's
    // sibling fix (reading the body, not the status) already corrected —
    // this re-confirms it still holds now that expectEmptyBody exists too.
    // Unmapped path: the body shape is unconstrained, the invariant is
    // about status.
    const fetchImpl = fakeFetch(async () => jsonResponse({ ok: true }, 202))
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })

    await expect(
      client.request('/api/anything', { method: 'POST', skipAuth: true, body: { some: 'field' } }),
    ).resolves.toEqual({ ok: true })
  })

  // These tests assert nothing at runtime — they never call fetch. What
  // they prove is that a wrong body for a mapped route fails to COMPILE,
  // via @ts-expect-error: if request()'s body-checking ever weakens back to
  // `body?: unknown` (for these paths or in general), these lines stop
  // being errors, `@ts-expect-error` becomes "unused directive", and `tsc
  // --noEmit` fails on THAT — the same "remove the body, watch tsc fail,
  // restore" check done by hand, made permanent. There is no `expect()` for
  // "the compiler would have caught this."
  it('a body missing a required field for a mapped route fails to compile — standing regression test', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fakeFetch(async () => jsonResponse({})), credentials: noCredentials })
    // @ts-expect-error — /api/client/login requires ClientLoginRequest { app_identifier, email, password }; app_identifier is missing here.
    await client.request('/api/client/login', { method: 'POST', skipAuth: true, body: { email: 'a@b.de', password: 'pw' } })
  })

  it('omitting body entirely for a mapped route fails to compile, not just a wrong shape', async () => {
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fakeFetch(async () => jsonResponse({})), credentials: noCredentials })
    // @ts-expect-error — /api/client/password/change requires a
    // PasswordChangeRequest body; omitting it entirely must fail to compile,
    // not just a wrong shape.
    await client.request('/api/client/password/change', { method: 'POST', skipAuth: true })
  })

  it('a route NOT in RequestBodyByRoute still accepts any body — the check is additive, not a general lockdown', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ session_id: 's1' }))
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })
    // No @ts-expect-error here — this must NOT be an error. An unmapped
    // path keeps request()'s original, permissive body?: unknown, which is
    // what every GET/DELETE call in this SDK still relies on.
    await expect(
      client.request('/api/robots/1/cameras/front/live', { method: 'POST', body: { anything: 'goes' } }),
    ).resolves.toEqual({ session_id: 's1' })
  })

  it('does not set content-type on a bodyless REQUEST (e.g. cameras.live()\'s POST) — the cloud refuses application/json paired with an empty body', async () => {
    // The route answers WITH a body (liveSessionResponse) — only the
    // outgoing REQUEST has none, which is what this checks. An earlier
    // fixture used a bare 204, which worked only while 204 was exempted
    // from the "did this route owe a body" check unconditionally; unrealistic
    // once that exemption was removed, since this route was never actually
    // bodyless on the way back.
    const fetchImpl = fakeFetch(async () => jsonResponse({ session_id: 's1', url: 'wss://x', room: 'r1', token: 't1', expires_at: '2026-01-01T00:00:00.000Z' }))
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })

    await client.request('/api/robots/1/cameras/front/live', { method: 'POST' })
    const [, init] = fetchImpl.mock.calls[0]
    expect((init?.headers as Record<string, string>)['content-type']).toBeUndefined()
    expect(init?.body).toBeUndefined()
  })

  it('still sets content-type: application/json when there is a body to send', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ ok: true }))
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })

    // An unmapped path, deliberately — this test is about generic transport
    // behaviour (does ANY body trigger the header), not about login's real
    // contract shape, so the body here stays the arbitrary `{ a: 1 }` this
    // file's other bodies already are.
    await client.request('/api/robots', { method: 'POST', skipAuth: true, body: { a: 1 } })
    const [, init] = fetchImpl.mock.calls[0]
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json')
  })

  it('attaches the bearer header from the credential source', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ ok: true }))
    const client = new HttpClient({
      baseUrl: 'https://api.fleetless.dev',
      fetch: fetchImpl,
      credentials: credentialsWith('abc'),
    })
    await client.request('/api/client/me', {})
    const [, init] = fetchImpl.mock.calls[0]
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer abc')
  })

  it('does not attach a credential when skipAuth is set (e.g. login)', async () => {
    const token = vi.fn(async () => 'abc')
    const fetchImpl = fakeFetch(async () => jsonResponse({ ok: true }))
    const client = new HttpClient({
      baseUrl: 'https://api.fleetless.dev',
      fetch: fetchImpl,
      credentials: { token, handleExpired: async () => false },
    })
    // Unmapped path, same reasoning as the content-type test above — this
    // test is about credential attachment, not login's real contract.
    await client.request('/api/robots', { method: 'POST', skipAuth: true, body: { a: 1 } })
    expect(token).not.toHaveBeenCalled()
    const [, init] = fetchImpl.mock.calls[0]
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined()
    expect(init?.body).toBe(JSON.stringify({ a: 1 }))
  })

  it('maps a non-2xx response to a FleetlessError carrying code, message, details and status', async () => {
    const fetchImpl = fakeFetch(async () =>
      jsonResponse({ code: 'forbidden', message: 'no access', details: { slug: 'x' } } satisfies ApiError, 403),
    )
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })

    const error = await captureError(client.request('/api/robots/1/datapoints/x', {}))
    expect(error.code).toBe('forbidden')
    expect(error.message).toBe('no access')
    expect(error.details).toEqual({ slug: 'x' })
    expect(error.status).toBe(403)
  })

  it('falls back to unparseable_error (an SDK-side code, not a server refusal) and statusText when the body has no recognisable error shape', async () => {
    const fetchImpl = fakeFetch(async () => new Response('not json', { status: 500, statusText: 'Internal Server Error' }))
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })

    const error = await captureError(client.request('/api/robots', {}))
    expect(error.code).toBe('unparseable_error')
    expect(error.status).toBe(500)
  })

  it('on token_expired, asks the credential source to refresh and retries exactly once', async () => {
    let call = 0
    const fetchImpl = fakeFetch(async () => {
      call += 1
      if (call === 1) return jsonResponse({ code: 'token_expired', message: 'expired' } satisfies ApiError, 401)
      return jsonResponse({ ok: true }, 200)
    })
    const handleExpired = vi.fn(async () => true)
    const client = new HttpClient({
      baseUrl: 'https://api.fleetless.dev',
      fetch: fetchImpl,
      credentials: credentialsWith('abc', handleExpired),
    })

    await expect(client.request('/api/client/me', {})).resolves.toEqual({ ok: true })
    expect(handleExpired).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry a second time if the retried request is also token_expired', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ code: 'token_expired', message: 'expired' } satisfies ApiError, 401))
    const handleExpired = vi.fn(async () => true)
    const client = new HttpClient({
      baseUrl: 'https://api.fleetless.dev',
      fetch: fetchImpl,
      credentials: credentialsWith('abc', handleExpired),
    })

    const error = await captureError(client.request('/api/client/me', {}))
    expect(error.code).toBe('token_expired')
    expect(handleExpired).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('propagates token_expired as-is when the credential source cannot refresh (e.g. a server key)', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ code: 'token_expired', message: 'expired' } satisfies ApiError, 401))
    const handleExpired = vi.fn(async () => false)
    const client = new HttpClient({
      baseUrl: 'https://api.fleetless.dev',
      fetch: fetchImpl,
      credentials: credentialsWith('flk_x', handleExpired),
    })

    const error = await captureError(client.request('/api/client/me', {}))
    expect(error.code).toBe('token_expired')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never retries a token_expired on a skipAuth call (nothing to refresh into)', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ code: 'token_expired', message: 'expired' } satisfies ApiError, 401))
    const handleExpired = vi.fn(async () => true)
    const client = new HttpClient({
      baseUrl: 'https://api.fleetless.dev',
      fetch: fetchImpl,
      credentials: credentialsWith(null, handleExpired),
    })

    await expect(
      client.request('/api/client/login', { skipAuth: true, body: { app_identifier: 'app_x', email: 'a@b.de', password: 'pw' } }),
    ).rejects.toMatchObject({ code: 'token_expired' })
    expect(handleExpired).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

// `requestBinary`, added for camera snapshots, shares `#send` with
// `request` rather than duplicating the auth-attach/retry/error-mapping
// logic — these tests exercise that shared path through the binary entry
// point specifically, so a regression in the refactor shows up here even if
// every `request()` test still passes.
describe('HttpClient.requestBinary', () => {
  function binaryResponse(bytes: Uint8Array, headers: Record<string, string>, status = 200): Response {
    return new Response(bytes as BodyInit, { status, headers })
  }

  it('resolves the raw bytes and the response headers on a 2xx response', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const fetchImpl = fakeFetch(async () => binaryResponse(bytes, { 'content-type': 'image/jpeg', 'x-fleetless-age-ms': '10' }))
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })

    const { body, headers } = await client.requestBinary('/api/robots/1/cameras/front/snapshot')
    expect(body).toEqual(bytes)
    expect(headers.get('content-type')).toBe('image/jpeg')
    expect(headers.get('x-fleetless-age-ms')).toBe('10')
  })

  it('attaches the bearer header exactly like request() does', async () => {
    const fetchImpl = fakeFetch(async () => binaryResponse(new Uint8Array(), {}))
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: credentialsWith('abc') })

    await client.requestBinary('/api/robots/1/cameras/front/snapshot')
    const [, init] = fetchImpl.mock.calls[0]
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer abc')
  })

  it('maps a non-2xx response to a FleetlessError, same as request()', async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse({ code: 'no_snapshot_yet', message: 'nothing captured yet' } satisfies ApiError, 404))
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })

    const error = await captureError(client.requestBinary('/api/robots/1/cameras/front/snapshot'))
    expect(error.code).toBe('no_snapshot_yet')
  })

  it('retries exactly once on token_expired, same as request()', async () => {
    let call = 0
    const bytes = new Uint8Array([9])
    const fetchImpl = fakeFetch(async () => {
      call += 1
      if (call === 1) return jsonResponse({ code: 'token_expired', message: 'expired' } satisfies ApiError, 401)
      return binaryResponse(bytes, {})
    })
    const handleExpired = vi.fn(async () => true)
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: credentialsWith('abc', handleExpired) })

    const { body } = await client.requestBinary('/api/robots/1/cameras/front/snapshot')
    expect(body).toEqual(bytes)
    expect(handleExpired).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  // A URDF's rewritten mesh URIs arrive absolute —
  // the consumer is an app on another origin, so a root-relative URL would
  // resolve against *that* origin, not ours. This is the one case where
  // `path` is not baseUrl-relative, and it still needs auth attached — but
  // only because this absolute URL happens to point back at the SAME api
  // origin the client was configured with (the cloud's own rewrite always
  // does). See the refusal test right below for the other case.
  it('fetches an absolute http(s) path as-is, without baseUrl prefixing, but still attaches the bearer header — same-origin case', async () => {
    const meshUrl = 'https://api.fleetless.dev/api/robots/1/assets/mesh1'
    const bytes = new Uint8Array([7])
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe(meshUrl)
      return binaryResponse(bytes, { 'content-type': 'model/stl' })
    })
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: credentialsWith('abc') })

    const { body } = await client.requestBinary(meshUrl)
    expect(body).toEqual(bytes)
    const [, init] = fetchImpl.mock.calls[0]!
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer abc')
  })

  // The vulnerability this closes: `rewriteMeshUris` (cloud) only rewrites
  // `package://` URIs — a URDF's `<mesh filename="https://evil.example/x.stl">`
  // passes through unchanged, and a URDF is ROS graph input, not first-party
  // data (anything on a robot's graph can publish one). Without this check,
  // `createMeshLoader` would hand that URL straight here and this client
  // would attach the caller's own bearer token to a request aimed at
  // somebody else's host — every viewer's credential leaving for an
  // attacker-chosen origin the moment they render a hostile robot.
  it('refuses — does not fetch at all, credentials or no — an absolute URL whose origin does not match baseUrl', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('must not be called for a cross-origin absolute URL')
    })
    const client = new HttpClient({
      baseUrl: 'https://api.fleetless.dev',
      fetch: fetchImpl,
      credentials: credentialsWith('secret-token'),
    })

    const error = await captureError(client.requestBinary('https://evil.example/x.stl'))
    expect(error.code).toBe('untrusted_absolute_url')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('the refusal is about the origin, not the string — a same-origin URL with a different path is still fetched', async () => {
    const fetchImpl = fakeFetch(async () => binaryResponse(new Uint8Array([1]), { 'content-type': 'model/stl' }))
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })

    await expect(client.requestBinary('https://api.fleetless.dev/some/other/path')).resolves.toBeDefined()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('HttpClient.baseUrl', () => {
  it('exposes the constructed baseUrl unchanged', () => {
    const client = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fakeFetch(async () => jsonResponse({})), credentials: noCredentials })
    expect(client.baseUrl).toBe('https://api.fleetless.dev')
  })
})

describe('pathSegment — traversal defence, asserted against a real server', () => {
  // Against a real server, not a double: without the encoding,
  // `client.cameras.snapshot('id', '../../../admin')` reached
  // `/api/admin/snapshot`, Authorization header and all, before
  // `pathSegment()` existed — a real `fetch` removes dot-segments (RFC 3986
  // §5.2.4) before sending anything, and a fake-fetch assertion (which only
  // sees the string this SDK constructed) can't show that. Proves the
  // mechanism against a real transport ONCE; every namespace call site
  // (cameras/assets/jobs/datapoints) has its own cheap fake-fetch test
  // confirming `pathSegment()` is actually wired in, not repeating this
  // proof per site.
  it('an id/slug shaped like a traversal reaches the SAME route, as one inert path segment, not a different one', async () => {
    let receivedUrl: string | undefined
    const server: Server = createServer((req, res) => {
      receivedUrl = req.url
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}`

    // No `fetch` override on HttpClient's own options is available at this
    // level (unlike createClient's default resolution) — pass the real
    // globalThis.fetch explicitly so this hits a real socket rather than a
    // mock.
    const client = new HttpClient({ baseUrl, fetch: globalThis.fetch, credentials: noCredentials })
    const maliciousSlug = '../../../admin'

    try {
      await client.request(`/api/robots/${pathSegment('robot-1')}/cameras/${pathSegment(maliciousSlug)}/snapshot`, {})
    } finally {
      server.close()
    }

    expect(receivedUrl).toBe('/api/robots/robot-1/cameras/..%2F..%2F..%2Fadmin/snapshot')
    // The route is still /api/robots/:id/cameras/:slug/snapshot — a server
    // percent-decoding the final segment recovers the literal string
    // '../../../admin' as a slug value to validate/reject, never lands on a
    // different path the way the un-encoded version did.
  })
})
