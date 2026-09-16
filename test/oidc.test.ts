// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import type { ApiError, ClientOidcExchangeRequest, ClientProviderListResponse, SessionTokens } from '@fleetless/contracts'
import { clientOidcErrorCode } from '@fleetless/contracts'
import { createClient, InMemoryTokenStore } from '../src/index.js'
import { FleetlessError } from '../src/errors.js'
import { listen, type LocalApi, type RecordedRequest, type StubReply } from './local-api.js'

// Every test here drives the SDK's DEFAULT `fetch` against a real `node:http`
// server — see `test/auth.test.ts`'s header and `test/local-api.ts` for why.

let api: LocalApi | undefined

afterEach(async () => {
  await api?.close()
  api = undefined
})

async function start(reply: (request: RecordedRequest) => StubReply): Promise<LocalApi> {
  api = await listen(reply)
  return api
}

function always(status: number, body?: unknown): (request: RecordedRequest) => StubReply {
  return () => ({ status, body })
}

const SESSION: SessionTokens = { access_token: 'at1', refresh_token: 'rt1', expires_in: 900 }

function client(url: string, tokenStore = new InMemoryTokenStore()): ReturnType<typeof createClient> {
  return createClient({ apiUrl: url, appIdentifier: 'app_x', tokenStore })
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ------------------------------------------------------------------- providers

describe('auth.listProviders', () => {
  it('reads the app\'s enabled sign-in buttons, sending the app identifier as a QUERY parameter', async () => {
    const body: ClientProviderListResponse = { providers: [{ slug: 'okta', name: 'Okta' }, { slug: 'entra', name: 'Microsoft Entra' }] }
    const local = await start(always(200, body))

    await expect(client(local.url).auth.listProviders()).resolves.toEqual(body.providers)

    const sent = local.requests[0]!
    expect(sent.method).toBe('GET')
    expect(sent.path).toBe('/api/client/providers')
    // A GET carries the app identifier in the query, not the body — the one
    // place in this family that differs. A GET body is dropped by `fetch`
    // silently, with no error anybody sees.
    expect(sent.query.get('app_identifier')).toBe('app_x')
    expect(sent.body).toBe('')
  })

  it('surfaces the 404 an unknown app identifier gets', async () => {
    const local = await start(always(404, { code: 'not_found', message: 'No app with that identifier.' } satisfies ApiError))

    await expect(client(local.url).auth.listProviders()).rejects.toMatchObject({ code: 'not_found' })
  })
})

// ----------------------------------------------------------------------- start

describe('auth.beginOidcLogin', () => {
  it('builds the start URL with PKCE and touches nothing — the app navigates, this SDK never does', async () => {
    const local = await start(always(500, { code: 'internal_error', message: 'must not be called' } satisfies ApiError))

    const request = await client(local.url).auth.beginOidcLogin({ slug: 'okta', redirectUri: 'https://app.example.com/cb' })

    // Nothing is validated until the browser actually reaches the route, so
    // "made no request" is the property, not an incidental detail.
    expect(local.requests).toHaveLength(0)

    const url = new URL(request.url)
    expect(`${url.protocol}//${url.host}`).toBe(local.url)
    expect(url.pathname).toBe('/api/client/oidc/okta/start')
    expect(url.searchParams.get('app_identifier')).toBe('app_x')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/cb')
    expect(url.searchParams.get('state')).toBe(request.state)
    // S256 only, computed rather than asserted against a constant: the
    // challenge must be the sha256 of the verifier this same call returned —
    // that's the whole of PKCE. Recomputed with node:crypto, a second
    // implementation, so a bug in `pkce.ts` cannot agree with itself.
    expect(url.searchParams.get('code_challenge')).toBe(base64Url(createHash('sha256').update(request.codeVerifier).digest()))
    // `clientOidcStartQuery` requires 8..512 characters of state.
    expect(request.state.length).toBeGreaterThanOrEqual(8)
    expect(request.state.length).toBeLessThanOrEqual(512)
  })

  it('generates a fresh state and verifier per attempt — two calls never share either', async () => {
    const local = await start(always(200, {}))
    const auth = client(local.url).auth

    const first = await auth.beginOidcLogin({ slug: 'okta', redirectUri: 'https://app.example.com/cb' })
    const second = await auth.beginOidcLogin({ slug: 'okta', redirectUri: 'https://app.example.com/cb' })

    expect(first.state).not.toBe(second.state)
    expect(first.codeVerifier).not.toBe(second.codeVerifier)
  })

  it('encodes the provider slug into the path', async () => {
    const local = await start(always(200, {}))

    const request = await client(local.url).auth.beginOidcLogin({ slug: '../../admin', redirectUri: 'https://app.example.com/cb' })

    expect(new URL(request.url).pathname).toBe('/api/client/oidc/..%2F..%2Fadmin/start')
  })
})

// -------------------------------------------------------------------- complete

describe('auth.completeOidcLogin', () => {
  it('exchanges the one-time code for a session, sending the code and the verifier as JSON', async () => {
    const local = await start(always(200, SESSION))
    const tokenStore = new InMemoryTokenStore()

    await client(local.url, tokenStore).auth.completeOidcLogin({
      code: 'one-time-code',
      state: 'the-state',
      expectedState: 'the-state',
      codeVerifier: 'the-verifier',
    })

    const sent = local.requests[0]!
    expect(sent.method).toBe('POST')
    expect(sent.path).toBe('/api/client/oidc/exchange')
    // `clientOidcExchangeRequest` is strict, exactly these two fields: the
    // app identifier is already bound to the interaction, and `state` has
    // done its job before this call is made.
    expect(sent.json()).toEqual({ code: 'one-time-code', code_verifier: 'the-verifier' } satisfies ClientOidcExchangeRequest)
    expect(tokenStore.load()).toEqual(SESSION)
  })

  it('surfaces the route\'s token_spent for a code that is expired, replayed or unknown, and stores nothing', async () => {
    const local = await start(always(410, { code: 'token_spent', message: 'That sign-in code is no longer valid.' } satisfies ApiError))
    const tokenStore = new InMemoryTokenStore()

    const error = await client(local.url, tokenStore)
      .auth.completeOidcLogin({ code: 'stale', state: 's-value', expectedState: 's-value', codeVerifier: 'v' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(FleetlessError)
    expect((error as FleetlessError).code).toBe('token_spent')
    expect((error as FleetlessError).status).toBe(410)
    expect(tokenStore.load()).toBeNull()
  })

  // RFC 6749 §10.12: a client must not complete an authorization response it
  // did not itself request. "Before any request" is the assertion, not a
  // detail — a check that ran after the exchange would already have spent a
  // code for a flow this client never started.
  it.each([
    ['a mismatched state', { state: 'from-somewhere-else', expectedState: 'the-state' }],
    ['no state on the callback at all', { state: '', expectedState: 'the-state' }],
    // Two empty strings compare EQUAL, so without an explicit emptiness check
    // this case sails past `state !== expectedState` undefended — and it's
    // the commonest one in practice (a callback landing in a different tab,
    // a restored session, cleared storage).
    ['nothing persisted for this attempt', { state: 'the-state', expectedState: '' }],
    ['neither side present', { state: '', expectedState: '' }],
  ])('throws state_mismatch for %s, before any request is sent', async (_name, states) => {
    const local = await start(always(200, SESSION))
    const tokenStore = new InMemoryTokenStore()

    const error = await client(local.url, tokenStore)
      .auth.completeOidcLogin({ code: 'one-time-code', codeVerifier: 'v', ...states })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(FleetlessError)
    expect((error as FleetlessError).code).toBe('state_mismatch')
    expect(local.requests).toHaveLength(0)
    expect(tokenStore.load()).toBeNull()
  })

  it('names which of the two causes it was in the message, since the code no longer splits them', async () => {
    const local = await start(always(200, SESSION))
    const auth = client(local.url).auth

    const nothingPersisted = await auth
      .completeOidcLogin({ code: 'c', state: 'the-state', expectedState: '', codeVerifier: 'v' })
      .then(() => null, (e: unknown) => e as FleetlessError)
    const mismatch = await auth
      .completeOidcLogin({ code: 'c', state: 'other', expectedState: 'the-state', codeVerifier: 'v' })
      .then(() => null, (e: unknown) => e as FleetlessError)

    expect(nothingPersisted?.message).toContain('nothing was persisted')
    expect(mismatch?.message).toBeDefined()
    expect(mismatch?.message).not.toContain('nothing was persisted')
    expect(local.requests).toHaveLength(0)
  })
})

// ------------------------------------------------------------ callback failures

describe('auth.oidcErrorFromCallback', () => {
  it('returns null when the callback carries no error — a successful redirect is not an error', async () => {
    const local = await start(always(200, {}))
    const auth = client(local.url).auth

    expect(auth.oidcErrorFromCallback(new URLSearchParams('code=abc&state=s'))).toBeNull()
    expect(auth.oidcErrorFromCallback(new URLSearchParams(''))).toBeNull()
    expect(local.requests).toHaveLength(0)
  })

  // The set, not one example of it. A hand-picked code proves nothing about
  // the other eleven; `clientOidcErrorCode` is the list the cloud actually
  // redirects with — reading it from contracts means a code added there
  // without a mapping here fails this test, not silently becomes
  // `unexpected_response`.
  it('maps EVERY clientOidcErrorCode onto a FleetlessError carrying that same code', async () => {
    const local = await start(always(200, {}))
    const auth = client(local.url).auth

    expect(clientOidcErrorCode.options.length).toBeGreaterThan(0)
    for (const code of clientOidcErrorCode.options) {
      const error = auth.oidcErrorFromCallback(new URLSearchParams(`error=${code}&state=s`))
      expect(error, code).toBeInstanceOf(FleetlessError)
      expect(error!.code, code).toBe(code)
      expect(error!.message.length, code).toBeGreaterThan(0)
    }
    expect(local.requests).toHaveLength(0)
  })

  it('turns a code it does not know into unexpected_response, keeping the raw value in the message', async () => {
    const local = await start(always(200, {}))

    const error = client(local.url).auth.oidcErrorFromCallback(new URLSearchParams('error=something_new&state=s'))

    expect(error).toBeInstanceOf(FleetlessError)
    // Not passed through as its own code: a caller branching on `error.code`
    // would be handed a value neither this SDK nor contracts define — the
    // honest statement is "the server said something we do not know".
    expect(error!.code).toBe('unexpected_response')
    expect(error!.message).toContain('something_new')
    expect(local.requests).toHaveLength(0)
  })
})
