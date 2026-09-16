// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from 'vitest'
import type {
  ApiError,
  ClientAcceptInvitationRequest,
  ClientIdentity,
  ClientLoginRequest,
  ClientLogoutRequest,
  ClientMcpInteraction,
  ClientPasswordResetConfirmRequest,
  ClientPasswordResetRequest,
  ClientRegisterRequest,
  ClientResendVerificationRequest,
  ClientVerifyEmailRequest,
  McpConsentGrantListResponse,
  PasswordChangeRequest,
  SessionTokens,
} from '@fleetless/contracts'
import { createClient, InMemoryTokenStore } from '../src/index.js'
import { FleetlessError } from '../src/errors.js'
// Imported from the SDK's own public surface, not `@fleetless/contracts` —
// deliberately, unlike the request shapes above (a consumer never builds
// those; the SDK takes plain strings). A consumer needs to *hold* this type
// (a `rate_limited` refusal's `details`), so this import doubles as the
// compile-time guard that it's still re-exported from `src/index.ts`. A
// type-only export gives no runtime signal if that's deleted — this is the
// only thing that would catch it.
import type { RateLimitDetails } from '../src/index.js'
import { listen, type LocalApi, type RecordedRequest, type StubReply } from './local-api.js'

// **Every test here drives the SDK's DEFAULT `fetch` against a real
// `node:http` server** — no `fetch` option is ever passed to `createClient`,
// so `client.ts`'s `globalThis.fetch?.bind(globalThis)` sends the bytes.
// Deliberate: a suite that passes its own `fetch` never exercises the SDK's
// default, so "what the SDK sends" becomes "what a `vi.fn()` was asked to
// pretend to send". See `test/local-api.ts` for what a real socket shows
// that a double can't — and what it still can't.

let api: LocalApi | undefined

afterEach(async () => {
  await api?.close()
  api = undefined
})

/** Starts the local API and returns it; `afterEach` closes it. */
async function start(reply: (request: RecordedRequest) => StubReply): Promise<LocalApi> {
  api = await listen(reply)
  return api
}

/** The commonest handler: one route, one answer, whatever was asked. */
function always(status: number, body?: unknown): (request: RecordedRequest) => StubReply {
  return () => ({ status, body })
}

const SESSION: SessionTokens = { access_token: 'at1', refresh_token: 'rt1', expires_in: 900 }
const NEW_SESSION: SessionTokens = { access_token: 'at2', refresh_token: 'rt2', expires_in: 900 }
const IDENTITY: ClientIdentity = {
  kind: 'app_user',
  developer_id: null,
  app_user_id: 'u1',
  server_key_id: null,
  app_id: 'app1',
  role_id: 'role1',
  email: 'a@b.de',
}

function sessionClient(url: string, tokenStore = new InMemoryTokenStore()): ReturnType<typeof createClient> {
  return createClient({ apiUrl: url, appIdentifier: 'app_x', tokenStore })
}

// ---------------------------------------------------------------- registration

describe('auth — registration and verification (the 202 family)', () => {
  it('register posts the app identifier, address, password and display name, and resolves on a 202 that carries no body', async () => {
    const local = await start(always(202))
    const client = sessionClient(local.url)

    await expect(
      client.auth.register({ email: 'a@b.de', password: 'correct-horse-battery', displayName: 'Ada' }),
    ).resolves.toBeUndefined()

    expect(local.requests).toHaveLength(1)
    expect(local.requests[0]!.method).toBe('POST')
    expect(local.requests[0]!.path).toBe('/api/client/register')
    expect(local.requests[0]!.json()).toEqual({
      app_identifier: 'app_x',
      email: 'a@b.de',
      password: 'correct-horse-battery',
      display_name: 'Ada',
    } satisfies ClientRegisterRequest)
  })

  it('register omits display_name entirely when the caller passed none — clientRegisterRequest is strict, so a stray key is a 422', async () => {
    const local = await start(always(202))
    const client = sessionClient(local.url)

    await client.auth.register({ email: 'a@b.de', password: 'correct-horse-battery' })

    // `toEqual` would pass for `{ display_name: undefined }` too; the wire
    // question is whether the KEY is there, and only the raw body answers it.
    expect(Object.keys(local.requests[0]!.json() as object)).toEqual(['app_identifier', 'email', 'password'])
    expect(local.requests[0]!.body).not.toContain('display_name')
  })

  // The distinction the enumerated refusal codes are built on, asserted as
  // one `it` because it is one property: a caller must be able to tell "we sent
  // a mail, or would have" from "we refused you", and nothing else. Splitting
  // it into two would let either half pass while the pair said nothing.
  it('register resolves on 202 and throws the server\'s own policy code on a refusal — the two are distinguishable', async () => {
    const accepted = await start(always(202))
    await expect(sessionClient(accepted.url).auth.register({ email: 'a@b.de', password: 'correct-horse-battery' })).resolves.toBeUndefined()
    await accepted.close()

    for (const [status, code] of [
      [403, 'registration_closed'],
      [403, 'domain_not_allowed'],
      [409, 'quota_exceeded'],
      [404, 'not_found'],
    ] as const) {
      const refused = await listen(always(status, { code, message: `refused: ${code}` } satisfies ApiError))
      const error = await sessionClient(refused.url)
        .auth.register({ email: 'a@b.de', password: 'correct-horse-battery' })
        .catch((e: unknown) => e)
      await refused.close()

      expect(error).toBeInstanceOf(FleetlessError)
      // Relayed verbatim: the SDK invents no code of its own for a server
      // refusal, so a policy the cloud adds later reaches a caller unchanged.
      expect((error as FleetlessError).code).toBe(code)
      expect((error as FleetlessError).status).toBe(status)
    }
  })

  it('verifyEmail spends the token and stores the session it answers with — the person is not asked to log in again', async () => {
    const local = await start(always(200, SESSION))
    const tokenStore = new InMemoryTokenStore()
    const client = sessionClient(local.url, tokenStore)

    await client.auth.verifyEmail('verification-token')

    expect(local.requests[0]!.method).toBe('POST')
    expect(local.requests[0]!.path).toBe('/api/client/verify-email')
    expect(local.requests[0]!.json()).toEqual({ token: 'verification-token' } satisfies ClientVerifyEmailRequest)
    expect(tokenStore.load()).toEqual(SESSION)
  })

  it('verifyEmail leaves the store untouched when the token is spent', async () => {
    const local = await start(always(410, { code: 'token_spent', message: 'That link has already been used.' } satisfies ApiError))
    const tokenStore = new InMemoryTokenStore()

    await expect(sessionClient(local.url, tokenStore).auth.verifyEmail('stale')).rejects.toMatchObject({ code: 'token_spent' })
    expect(tokenStore.load()).toBeNull()
  })

  it('resendVerification posts the app-scoped pair and resolves on 202', async () => {
    const local = await start(always(202))

    await expect(sessionClient(local.url).auth.resendVerification('a@b.de')).resolves.toBeUndefined()

    expect(local.requests[0]!.path).toBe('/api/client/resend-verification')
    expect(local.requests[0]!.json()).toEqual({ app_identifier: 'app_x', email: 'a@b.de' } satisfies ClientResendVerificationRequest)
  })
})

// ------------------------------------------------------------- password + session

describe('auth — login, logout and the session', () => {
  it('login sends the app identifier the client was built with and stores the returned session', async () => {
    const local = await start(always(200, SESSION))
    const tokenStore = new InMemoryTokenStore()

    await sessionClient(local.url, tokenStore).auth.login('a@b.de', 'pw')

    expect(local.requests[0]!.path).toBe('/api/client/login')
    expect(local.requests[0]!.json()).toEqual({ app_identifier: 'app_x', email: 'a@b.de', password: 'pw' } satisfies ClientLoginRequest)
    expect(tokenStore.load()).toEqual(SESSION)
  })

  it('logout posts the refresh token, resolves with nothing on the route\'s 204, and clears the store', async () => {
    const local = await start(always(204))
    const tokenStore = new InMemoryTokenStore()
    tokenStore.save(SESSION)

    await expect(sessionClient(local.url, tokenStore).auth.logout()).resolves.toBeUndefined()

    expect(local.requests[0]!.method).toBe('POST')
    expect(local.requests[0]!.path).toBe('/api/client/logout')
    expect(local.requests[0]!.json()).toEqual({ refresh_token: 'rt1' } satisfies ClientLogoutRequest)
    expect(tokenStore.load()).toBeNull()
  })

  it('logout clears the store and does not reject when the server refuses — a user who pressed log out is logged out locally', async () => {
    const local = await start(always(500, { code: 'internal_error', message: 'boom' } satisfies ApiError))
    const tokenStore = new InMemoryTokenStore()
    tokenStore.save(SESSION)

    await expect(sessionClient(local.url, tokenStore).auth.logout()).resolves.toBeUndefined()
    expect(tokenStore.load()).toBeNull()
  })

  it('logout with no local session sends nothing at all', async () => {
    const local = await start(always(204))

    await sessionClient(local.url).auth.logout()

    expect(local.requests).toHaveLength(0)
  })

  it('me() reads the identity behind the current bearer token', async () => {
    const local = await start(always(200, IDENTITY))
    const tokenStore = new InMemoryTokenStore()
    tokenStore.save(SESSION)

    await expect(sessionClient(local.url, tokenStore).auth.me()).resolves.toEqual(IDENTITY)

    expect(local.requests[0]!.method).toBe('GET')
    expect(local.requests[0]!.path).toBe('/api/client/me')
    expect(local.requests[0]!.headers.authorization).toBe('Bearer at1')
  })

  it('changePassword authenticates with the OLD token and stores the fresh pair the route re-issues', async () => {
    const local = await start(always(200, NEW_SESSION))
    const tokenStore = new InMemoryTokenStore()
    tokenStore.save(SESSION)

    await sessionClient(local.url, tokenStore).auth.changePassword('old-correct-horse-battery', 'new-correct-horse-battery')

    expect(local.requests[0]!.path).toBe('/api/client/password/change')
    expect(local.requests[0]!.headers.authorization).toBe('Bearer at1')
    expect(local.requests[0]!.json()).toEqual({
      current_password: 'old-correct-horse-battery',
      new_password: 'new-correct-horse-battery',
    } satisfies PasswordChangeRequest)
    // The caller must end this call still holding WORKING credentials — the
    // old ones were just revoked server-side along with every other session.
    expect(tokenStore.load()).toEqual(NEW_SESSION)
  })
})

// -------------------------------------------------------------- reset + invitation

describe('auth — password reset and invitations', () => {
  it('requestPasswordReset posts the app-scoped pair and resolves on 202, saying nothing about whether the address exists', async () => {
    const local = await start(always(202))

    await expect(sessionClient(local.url).auth.requestPasswordReset('a@b.de')).resolves.toBeUndefined()

    expect(local.requests[0]!.path).toBe('/api/client/password/reset')
    expect(local.requests[0]!.json()).toEqual({ app_identifier: 'app_x', email: 'a@b.de' } satisfies ClientPasswordResetRequest)
  })

  it('confirmPasswordReset spends the token and stores the session it answers with', async () => {
    const local = await start(always(200, SESSION))
    const tokenStore = new InMemoryTokenStore()

    await sessionClient(local.url, tokenStore).auth.confirmPasswordReset('reset-token', 'new-correct-horse-battery')

    expect(local.requests[0]!.path).toBe('/api/client/password/reset/confirm')
    expect(local.requests[0]!.json()).toEqual({
      token: 'reset-token',
      new_password: 'new-correct-horse-battery',
    } satisfies ClientPasswordResetConfirmRequest)
    expect(tokenStore.load()).toEqual(SESSION)
  })

  it('acceptInvitation posts token, password and display name and stores the session', async () => {
    const local = await start(always(200, SESSION))
    const tokenStore = new InMemoryTokenStore()

    await sessionClient(local.url, tokenStore).auth.acceptInvitation({
      token: 'invite-token',
      password: 'correct-horse-battery',
      displayName: 'Ada',
    })

    expect(local.requests[0]!.path).toBe('/api/client/invitations/accept')
    expect(local.requests[0]!.json()).toEqual({
      token: 'invite-token',
      password: 'correct-horse-battery',
      display_name: 'Ada',
    } satisfies ClientAcceptInvitationRequest)
    expect(tokenStore.load()).toEqual(SESSION)
  })

  it('acceptInvitation omits display_name when none was passed — the request shape is strict', async () => {
    const local = await start(always(200, SESSION))

    await sessionClient(local.url).auth.acceptInvitation({ token: 'invite-token', password: 'correct-horse-battery' })

    expect(Object.keys(local.requests[0]!.json() as object)).toEqual(['token', 'password'])
  })
})

// ------------------------------------------------------------------- MCP consent

const INTERACTION: ClientMcpInteraction = {
  id: 'int_123',
  app_id: '11111111-1111-4111-8111-111111111111',
  client_name: 'Some Client',
  client_name_verified: false,
  scopes: ['fleetless:read'],
  already_granted: false,
  expires_at: '2026-09-06T12:00:00.000Z',
}

describe('auth — the MCP interaction trio', () => {
  it('mcpInteraction reads the pending authorization by id, and SENDS the session bearer', async () => {
    const local = await start(always(200, INTERACTION))
    const tokenStore = new InMemoryTokenStore()
    tokenStore.save(SESSION)

    await expect(sessionClient(local.url, tokenStore).auth.mcpInteraction('int_123')).resolves.toEqual(INTERACTION)

    // **Two requests, and the first is the point.** The interaction route
    // treats an EXPIRED bearer as an absent one and answers `200
    // already_granted: false` — so the SDK's refresh, which only fires on a
    // `401`, never sees it. `me()` is the probe that does refuse, so the
    // read below carries a token just proved live.
    expect(local.requests.map((r) => r.path)).toEqual([
      '/api/client/me',
      '/api/client/mcp/interactions/int_123',
    ])
    expect(local.requests[1]!.method).toBe('GET')
    // The route answers without a credential, so `skipAuth` here would look
    // like a harmless tidy-up. It isn't: the cloud reads an OPTIONAL bearer
    // and derives `already_granted` from it alone, so an anonymous read
    // always answers `already_granted: false` — showing a consent screen to
    // somebody who already consented. This assertion is what stops that
    // "simplification".
    expect(local.requests[1]!.headers.authorization).toBe('Bearer at1')
  })

  // The defect this exists for: a stale access token is INVISIBLE to this
  // route. It answers 200 with `already_granted: false` rather than 401, so
  // nothing in the SDK's error path can react — and the app shows a consent
  // screen to somebody who consented last week. Break test: delete the probe
  // in `mcpInteraction` and this goes red on the bearer, which is the
  // assertion under test, not on the request count alone.
  it('mcpInteraction refreshes an expired session first, so the interaction is read with a LIVE bearer', async () => {
    let meCalls = 0
    const local = await start((request) => {
      if (request.path === '/api/client/me') {
        meCalls += 1
        return meCalls === 1
          ? { status: 401, body: { code: 'token_expired', message: 'expired' } satisfies ApiError }
          : { status: 200, body: IDENTITY }
      }
      if (request.path === '/api/client/refresh') return { status: 200, body: NEW_SESSION }
      return { status: 200, body: INTERACTION }
    })
    const tokenStore = new InMemoryTokenStore()
    tokenStore.save(SESSION)

    await expect(sessionClient(local.url, tokenStore).auth.mcpInteraction('int_123')).resolves.toEqual(INTERACTION)

    const read = local.requests.find((r) => r.path === '/api/client/mcp/interactions/int_123')
    expect(read?.headers.authorization).toBe('Bearer at2')
    expect(local.requests.some((r) => r.path === '/api/client/refresh')).toBe(true)
  })

  it('mcpInteraction sends no probe when there is no session at all — the anonymous read is unchanged', async () => {
    const local = await start(always(200, INTERACTION))

    await expect(sessionClient(local.url).auth.mcpInteraction('int_123')).resolves.toEqual(INTERACTION)

    expect(local.requests.map((r) => r.path)).toEqual(['/api/client/mcp/interactions/int_123'])
  })

  it('mcpInteraction still answers when the session is dead and cannot be refreshed — a consent page must render for a stranger', async () => {
    const local = await start((request) =>
      request.path === '/api/client/me'
        ? { status: 401, body: { code: 'token_expired', message: 'expired' } satisfies ApiError }
        : request.path === '/api/client/refresh'
          ? { status: 401, body: { code: 'token_revoked', message: 'gone' } satisfies ApiError }
          : { status: 200, body: INTERACTION },
    )
    const tokenStore = new InMemoryTokenStore()
    tokenStore.save(SESSION)

    await expect(sessionClient(local.url, tokenStore).auth.mcpInteraction('int_123')).resolves.toEqual(INTERACTION)
  })

  it('mcpInteraction surfaces the 410 an expired or unknown id gets, rather than a null the caller would render as a live screen', async () => {
    const local = await start(always(410, { code: 'interaction_expired', message: 'That took too long.' } satisfies ApiError))

    await expect(sessionClient(local.url).auth.mcpInteraction('int_123')).rejects.toMatchObject({ code: 'interaction_expired' })
  })

  for (const [method, segment] of [
    ['approveMcpInteraction', 'approve'],
    ['denyMcpInteraction', 'deny'],
  ] as const) {
    it(`${method} posts a BODYLESS request to /${segment} and returns where to send the browser`, async () => {
      const local = await start(always(200, { redirect_to: 'https://client.example/cb?code=abc' }))
      const tokenStore = new InMemoryTokenStore()
      tokenStore.save(SESSION)

      await expect(sessionClient(local.url, tokenStore).auth[method]('int_123')).resolves.toEqual({
        redirectTo: 'https://client.example/cb?code=abc',
      })

      const sent = local.requests[0]!
      expect(sent.method).toBe('POST')
      expect(sent.path).toBe(`/api/client/mcp/interactions/int_123/${segment}`)
      expect(sent.headers.authorization).toBe('Bearer at1')
      // The bodyless-POST rule, checked on the wire rather than on what we
      // asked `fetch` for: the cloud refuses `content-type: application/json`
      // with an empty body outright (`validation_error`). A fake `fetch`
      // records the absence of a header exactly as it records its presence,
      // so only a real request can show this.
      expect(sent.body).toBe('')
      expect(sent.headers['content-type']).toBeUndefined()
    })
  }

  it('the decision methods encode the id into the path — a caller-supplied id can never climb out of the route', async () => {
    const local = await start(always(200, { redirect_to: 'https://client.example/cb' }))

    await sessionClient(local.url).auth.approveMcpInteraction('../../../admin')

    expect(local.requests[0]!.path).toBe('/api/client/mcp/interactions/..%2F..%2F..%2Fadmin/approve')
  })
})

describe('auth — the app user\'s own MCP grants', () => {
  it('listMcpGrants unwraps the envelope into the array a caller renders', async () => {
    const body: McpConsentGrantListResponse = {
      grants: [{ client_id: 'c1', client_name: 'Some Client', client_name_verified: false, granted_at: '2026-09-01T10:00:00.000Z' }],
    }
    const local = await start(always(200, body))
    const tokenStore = new InMemoryTokenStore()
    tokenStore.save(SESSION)

    await expect(sessionClient(local.url, tokenStore).auth.listMcpGrants()).resolves.toEqual(body.grants)

    expect(local.requests[0]!.method).toBe('GET')
    expect(local.requests[0]!.path).toBe('/api/client/mcp/grants')
    expect(local.requests[0]!.headers.authorization).toBe('Bearer at1')
  })

  it('revokeMcpGrant deletes by client id, tolerates the route\'s empty 204, and encodes the id', async () => {
    const local = await start(always(204))
    const tokenStore = new InMemoryTokenStore()
    tokenStore.save(SESSION)

    await expect(sessionClient(local.url, tokenStore).auth.revokeMcpGrant('../secrets')).resolves.toBeUndefined()

    expect(local.requests[0]!.method).toBe('DELETE')
    expect(local.requests[0]!.path).toBe('/api/client/mcp/grants/..%2Fsecrets')
  })
})

// ----------------------------------------------------------------- the server key

describe('auth (server key)', () => {
  /**
   * **The names a server-key client is allowed to answer**, each with the
   * reason it is on this list rather than in the refusal set. Everything else
   * `createServerKeyAuth` returns must refuse — which is what the test below
   * derives, rather than restating.
   */
  const SERVER_KEY_ALLOWED: Record<string, string> = {
    me: 'the one method a server key is for — it answers kind: server_key',
    listProviders: 'a public route that reads no caller',
    mcpInteraction: 'a public read; the bearer only decides already_granted',
    oidcErrorFromCallback: 'pure — it parses a query string and asks nothing',
    register: 'a public route that names its subject in the body and answers nothing',
    resendVerification: 'same — the address is the argument, not the caller',
    requestPasswordReset: 'same',
  }

  // A set guarded by an example is guarded by nothing — this was that
  // example. Fifteen names, typed by hand: a method added to `AuthApi` and
  // implemented on the server-key client was in neither list, so the suite
  // stayed green while a full-rights credential hit a route meant for a
  // person's own session.
  //
  // The set is now DERIVED from what `createServerKeyAuth` actually returns:
  // every enumerable member not in `SERVER_KEY_ALLOWED` must refuse, and the
  // invocation table below must cover exactly that set — a new member fails
  // on the set comparison, before any call is made.
  it('refuses every method that needs an app user\'s own session, with invalid_option and without touching the network', async () => {
    const local = await start(always(200, {}))
    const client = createClient({ apiUrl: local.url, appIdentifier: 'app_x', serverKey: 'flk_abc' })
    const auth = client.auth
    const invocations: Record<string, () => Promise<unknown>> = {
      verifyEmail: () => auth.verifyEmail('t'),
      login: () => auth.login('a@b.de', 'pw'),
      logout: () => auth.logout(),
      changePassword: () => auth.changePassword('old', 'new-correct-horse-battery'),
      confirmPasswordReset: () => auth.confirmPasswordReset('t', 'new-correct-horse-battery'),
      acceptInvitation: () => auth.acceptInvitation({ token: 't', password: 'correct-horse-battery' }),
      beginOidcLogin: () => auth.beginOidcLogin({ slug: 'okta', redirectUri: 'https://app.example/cb' }),
      completeOidcLogin: () => auth.completeOidcLogin({ code: 'c', state: 's', expectedState: 's', codeVerifier: 'v' }),
      approveMcpInteraction: () => auth.approveMcpInteraction('i'),
      denyMcpInteraction: () => auth.denyMcpInteraction('i'),
      listMcpGrants: () => auth.listMcpGrants(),
      revokeMcpGrant: () => auth.revokeMcpGrant('c1'),
    }

    // `client.auth` IS the object `createServerKeyAuth` built (client.ts wraps
    // nothing), so its own keys are the members `AuthApi` obliges it to carry.
    const mustRefuse = Object.keys(auth).filter((name) => !(name in SERVER_KEY_ALLOWED)).sort()
    expect(
      mustRefuse,
      'every auth member is either in SERVER_KEY_ALLOWED with a reason, or exercised by the refusal table above — a new one is in neither until somebody decides which',
    ).toEqual(Object.keys(invocations).sort())

    for (const name of mustRefuse) {
      const error = await invocations[name]!().catch((e: unknown) => e)
      expect(error, name).toBeInstanceOf(FleetlessError)
      expect((error as FleetlessError).code, name).toBe('invalid_option')
      expect((error as FleetlessError).message, name).toContain('serverKey')
    }
    expect(local.requests).toHaveLength(0)
  })

  // The other half of the set above: the allowed names really are answered,
  // and the three public client-auth calls reach the routes they name. A
  // member could otherwise be parked in SERVER_KEY_ALLOWED and never called.
  it('answers the three public client-auth calls on a server key, with no bearer attached', async () => {
    const local = await start(always(202, undefined))
    const client = createClient({ apiUrl: local.url, appIdentifier: 'app_x', serverKey: 'flk_abc' })

    await expect(client.auth.register({ email: 'a@b.de', password: 'correct-horse-battery' })).resolves.toBeUndefined()
    await expect(client.auth.resendVerification('a@b.de')).resolves.toBeUndefined()
    await expect(client.auth.requestPasswordReset('a@b.de')).resolves.toBeUndefined()

    expect(local.requests.map((r) => r.path)).toEqual([
      '/api/client/register',
      '/api/client/resend-verification',
      '/api/client/password/reset',
    ])
    // The app identifier comes from the client, and the subject from the
    // argument — the caller is not the subject, which is the whole reason
    // these three are allowed here.
    expect(local.requests[0]!.json()).toMatchObject({ app_identifier: 'app_x', email: 'a@b.de' })
    // `skipAuth`: these routes read no caller, so the key is not offered to
    // them. A server key travelling to a public route is a credential leaked
    // for nothing.
    for (const request of local.requests) expect(request.headers.authorization).toBeUndefined()
  })

  it('still answers the three calls that need no session of their own', async () => {
    const local = await start((request) =>
      request.path === '/api/client/me'
        ? { status: 200, body: { ...IDENTITY, kind: 'server_key', app_user_id: null, server_key_id: 'sk1' } }
        : request.path === '/api/client/providers'
          ? { status: 200, body: { providers: [{ slug: 'okta', name: 'Okta' }] } }
          : { status: 200, body: INTERACTION },
    )
    const client = createClient({ apiUrl: local.url, appIdentifier: 'app_x', serverKey: 'flk_abc' })

    await expect(client.auth.me()).resolves.toMatchObject({ kind: 'server_key' })
    await expect(client.auth.listProviders()).resolves.toEqual([{ slug: 'okta', name: 'Okta' }])
    await expect(client.auth.mcpInteraction('int_123')).resolves.toEqual(INTERACTION)
    // Pure and local — it parses a query string and never asks anything.
    expect(client.auth.oidcErrorFromCallback(new URLSearchParams('error=no_access'))?.code).toBe('no_access')

    // The three reads do NOT agree about the credential, and the difference is
    // the design rather than an oversight. `me` is answered FROM the key;
    // the interaction read takes an optional bearer that decides
    // `already_granted`, so it is sent (the cloud treats a non-app-user one as
    // absent); `providers` reads no caller at all, so nothing is attached to it.
    const byPath = Object.fromEntries(local.requests.map((r) => [r.path, r.headers.authorization]))
    expect(byPath['/api/client/me']).toBe('Bearer flk_abc')
    expect(byPath['/api/client/mcp/interactions/int_123']).toBe('Bearer flk_abc')
    expect(byPath['/api/client/providers']).toBeUndefined()
  })

  it('never attempts a refresh — a server key that is rejected as expired just fails', async () => {
    const local = await start(always(401, { code: 'token_expired', message: 'expired' } satisfies ApiError))
    const client = createClient({ apiUrl: local.url, appIdentifier: 'app_x', serverKey: 'flk_abc' })

    await expect(client.auth.me()).rejects.toMatchObject({ code: 'token_expired' })
    expect(local.requests).toHaveLength(1)
  })
})

// --------------------------------------------------------------------- the rest

describe('rate_limited — surfaced with retry_after_ms, never retried', () => {
  it('login: a rate_limited refusal throws with retry_after_ms intact, and is never retried', async () => {
    const local = await start(
      always(429, {
        code: 'rate_limited',
        message: 'Too many attempts.',
        details: { retry_after_ms: 800 } satisfies RateLimitDetails,
      } satisfies ApiError),
    )

    const error = await sessionClient(local.url).auth.login('a@b.de', 'pw').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FleetlessError)
    expect((error as FleetlessError).code).toBe('rate_limited')
    expect((error as FleetlessError).details).toEqual({ retry_after_ms: 800 } satisfies RateLimitDetails)
    // The one behaviour that must never exist: a client library that retries
    // a rate limit is the attack it exists to stop.
    expect(local.requests).toHaveLength(1)
  })
})

describe('SessionCredentials.handleExpired', () => {
  it('throws the SDK-side no_session code (not a server code) when the store has nothing to refresh from', async () => {
    const { SessionCredentials } = await import('../src/auth.js')
    const { HttpClient, noCredentials } = await import('../src/http.js')
    const local = await start(always(200, SESSION))
    const tokenStore = new InMemoryTokenStore() // never logged in — nothing to refresh
    const http = new HttpClient({ baseUrl: local.url, fetch: globalThis.fetch.bind(globalThis), credentials: noCredentials })
    const credentials = new SessionCredentials(http, tokenStore)

    const error = await credentials.handleExpired().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FleetlessError)
    expect((error as FleetlessError).code).toBe('no_session')
    expect(local.requests).toHaveLength(0)
  })

  it('refreshes once for concurrent expired requests and retries each with the NEW token', async () => {
    const local = await start((request) => {
      if (request.path === '/api/client/refresh') return { status: 200, body: NEW_SESSION }
      if (request.headers.authorization === 'Bearer at1') {
        return { status: 401, body: { code: 'token_expired', message: 'expired' } satisfies ApiError }
      }
      return { status: 200, body: IDENTITY }
    })
    const tokenStore = new InMemoryTokenStore()
    tokenStore.save(SESSION)
    const client = sessionClient(local.url, tokenStore)

    await Promise.all([client.auth.me(), client.auth.me(), client.auth.me()])

    // Three 401s, ONE refresh, three retries — the single-flight property.
    expect(local.requests.filter((r) => r.path === '/api/client/refresh')).toHaveLength(1)
    expect(local.requests.filter((r) => r.path === '/api/client/me' && r.headers.authorization === 'Bearer at2')).toHaveLength(3)
  })
})

describe('the SDK\'s default fetch', () => {
  // Named on its own even though every test above already uses it: the
  // property this file must not lose belongs to the whole suite, not to one
  // method — every suite that passes its own `fetch` leaves the SDK's default
  // unexercised. If a later edit reintroduces a `fetch` double as this file's
  // default, THIS is the test that has to be deleted to do it — visible in a
  // diff.
  it('is what actually sends the request when createClient is given no fetch option', async () => {
    const local = await start(always(200, SESSION))
    const tokenStore = new InMemoryTokenStore()
    const client = createClient({ apiUrl: local.url, appIdentifier: 'app_x', tokenStore })

    await client.auth.login('a@b.de', 'pw')

    const sent = local.requests[0]!
    // Real bytes, parsed by a real (if minimal) server: the header undici set
    // from `HttpClient`'s own `headers` object, and a body that survived
    // `JSON.stringify` and the socket.
    expect(sent.headers['content-type']).toBe('application/json')
    expect(sent.body).toBe(JSON.stringify({ app_identifier: 'app_x', email: 'a@b.de', password: 'pw' }))
    expect(tokenStore.load()).toEqual(SESSION)
  })
})
