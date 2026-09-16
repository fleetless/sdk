// SPDX-License-Identifier: MIT
import type {
  ClientAcceptInvitationRequest,
  ClientLoginRequest,
  ClientLogoutRequest,
  ClientOidcExchangeRequest,
  ClientPasswordResetConfirmRequest,
  ClientPasswordResetRequest,
  ClientRefreshRequest,
  ClientRegisterRequest,
  ClientResendVerificationRequest,
  ClientVerifyEmailRequest,
  PasswordChangeRequest,
} from '@fleetless/contracts'
import { FleetlessError } from './errors.js'

/**
 * Supplies the `Authorization` header value for a request, and knows what to
 * do when the server says the token has expired. `HttpClient` is agnostic to
 * *what* is authenticating it — an end-user session with silent refresh, or
 * a static server key — so both can share one request path.
 */
export interface CredentialSource {
  /**
   * The current raw bearer credential — a JWT or a server key (`flk_...`) —
   * or null if not authenticated. Raw, not `Bearer <token>`: REST forms the
   * `Authorization` header from it, and the realtime auth frame
   * carries the very same value unprefixed, so there is exactly one place
   * that knows what "the token" currently is.
   */
  token(): Promise<string | null>
  /**
   * Called once when a request comes back `token_expired`. Three outcomes:
   * - resolves `true` — a fresh credential is ready, retry the request;
   * - resolves `false` — nothing to do (e.g. a server key, which cannot be
   *   refreshed at all), propagate the original `token_expired`;
   * - throws a `FleetlessError` — refreshing itself failed for a specific,
   *   more useful reason (e.g. `token_revoked`, a reused refresh token);
   *   that error propagates instead of the original `token_expired`, so the
   *   caller learns what actually happened, not just that a retry was tried.
   */
  handleExpired(): Promise<boolean>
}

/** A credential source for callers with nothing to authenticate yet. */
export const noCredentials: CredentialSource = {
  async token() {
    return null
  },
  async handleExpired() {
    return false
  },
}

export interface HttpClientOptions {
  baseUrl: string
  fetch: typeof fetch
  credentials: CredentialSource
}

export interface RequestOptions {
  method?: string
  body?: unknown
  /** Skip attaching a credential — used for login/sign-up calls. */
  skipAuth?: boolean
  /**
   * This route is documented as answering with no body even on success —
   * pass this for a route the contracts route table (`rest.ts`) lists with
   * no response schema, or one that answers `204`. **Required for `204`
   * routes too, not just bodyless `202`s.** Both kinds are live in this SDK:
   * the `202`s of the enumeration-safe family (`register`,
   * `resendVerification`, `requestPasswordReset`, which answer whether or not
   * an address exists) and the `204`s (`logout`, `revokeMcpGrant`, the camera
   * live-session release). A first
   * version exempted `204` unconditionally, reasoning it has no body to
   * read — true, but the wrong check: `.text()` on a `204` already
   * resolves `''` on its own, so the exemption bought nothing except a way
   * for a route that *should* answer with tokens to regress to `204` and
   * have that regression pass through here silently.
   *
   * **Why not have `request<T>()` tolerate an empty body everywhere:** an
   * empty body means two different things — "no body by design" and "the
   * server owed a body and sent nothing." Collapsing both into `undefined`
   * turns the second, a real defect, into a `TypeError` downstream at
   * whatever field the caller reads first, instead of a clear failure
   * naming the broken route. The route table already says which routes are
   * which — this flag is how a call site states which one it is, rather
   * than `request<T>()` guessing.
   */
  expectEmptyBody?: boolean
  /**
   * Forwarded straight to the underlying `fetch()` call — this is what
   * makes an abort stop the actual in-flight network
   * request rather than only stopping this SDK from *scheduling* more of
   * them. A caller that has already navigated away or moved on to a
   * different robot can abort every request built from the same
   * `AbortController` and the browser (or Node's `fetch`) tears the
   * connection down on its own; nothing here has to detect that itself.
   */
  signal?: AbortSignal
}

/**
 * The request-body contract shape for every literal REST path this SDK
 * sends a body to.
 *
 * **What this closes:** `request()`'s body used to be `unknown` end to end
 * — a call site typed its own local `const body: SomeType = {...}` and
 * nothing checked that `SomeType` was the type this *route* actually wanted.
 * The end-user password-reset call (since removed) sent the developer's
 * `passwordResetRequest { email }` for many commits after that
 * route split into `clientPasswordResetRequest { app_identifier, email }` —
 * a real shape reaching a real server, wrong, and `tsc` had no way to know,
 * because nothing tied the path string to any particular type at all.
 *
 * This map is that tie, via `RequestOptionsFor<P>` below: calling
 * `request()` with one of these literal paths requires `options.body` to
 * satisfy the matching contract type — so the *next* time a contracts
 * change splits or renames a shape used here, the call site that still
 * sends the old one fails to build, not fails in production. Every route
 * not listed here (GETs, DELETEs, and any body-bearing route with dynamic
 * path segments — none exist yet) keeps the untyped `body?: unknown`
 * behaviour unchanged; adding a new body-bearing static route to this SDK
 * should add it here too, but omitting it only forfeits the check for that
 * one route, it does not break anything.
 */
interface RequestBodyByRoute {
  '/api/client/login': ClientLoginRequest
  '/api/client/logout': ClientLogoutRequest
  '/api/client/refresh': ClientRefreshRequest
  '/api/client/password/change': PasswordChangeRequest
  '/api/client/register': ClientRegisterRequest
  '/api/client/verify-email': ClientVerifyEmailRequest
  '/api/client/resend-verification': ClientResendVerificationRequest
  '/api/client/password/reset': ClientPasswordResetRequest
  '/api/client/password/reset/confirm': ClientPasswordResetConfirmRequest
  '/api/client/invitations/accept': ClientAcceptInvitationRequest
  '/api/client/oidc/exchange': ClientOidcExchangeRequest
}

/**
 * What `request()` requires as `options` for a given literal path `P`:
 * the matching contract type as a *required* `body`, for a path this SDK
 * sends a body to; otherwise `RequestOptions` unchanged, `body`
 * still optional and untyped. `Omit<RequestOptions, 'body'>` rather than
 * `RequestOptions` for the first branch so `body: unknown` from the base
 * interface can't paper over the stricter type in an `&` intersection.
 */
type RequestOptionsFor<P extends string> = P extends keyof RequestBodyByRoute
  ? Omit<RequestOptions, 'body'> & { body: RequestBodyByRoute[P] }
  : RequestOptions

interface ErrorBody {
  code?: unknown
  message?: unknown
  details?: unknown
}

/** A binary body plus the raw response headers, for endpoints that answer with bytes rather than JSON (e.g. a camera snapshot). */
export interface BinaryResponse {
  body: Uint8Array
  headers: Headers
}

/**
 * `content-type` may carry parameters (`image/jpeg; charset=...`); only the
 * mime itself is ever useful to a caller. Shared by every binary-response
 * namespace (cameras, assets) rather than duplicated per file.
 */
export function mimeFromContentType(headers: Headers): string | null {
  const raw = headers.get('content-type')
  if (raw === null) return null
  return raw.split(';')[0]?.trim() || null
}

/**
 * Every namespace that addresses a route by an id or slug the caller
 * supplied (`robotId`, `slug`, `assetId`) interpolates it into a path
 * template — `request()`/`requestBinary()` never construct a `URL` object
 * first, they hand the concatenated string straight to `fetch`, and `fetch`
 * itself parses that string as a URL before sending anything (RFC 3986
 * section 5.2.4's dot-segment removal). This is not hypothetical:
 * `client.cameras.snapshot('id', '../../../admin')` reached a real server as
 * `/api/admin/snapshot`, with this client's own `Authorization` header
 * attached — an app that hands the SDK a value it read from a request
 * parameter or an end user, without validating it itself, sends that user's
 * credentials to an endpoint the app never named. The same class of bug the
 * contracts already refuse for a V4L2 device path (a prefix rule *and* an
 * explicit `..`-segment refusal), and the one the bridge's `package://`
 * resolver was hardened against — carried across here rather than left to
 * be found a third time.
 *
 * `encodeURIComponent` turns a `..` segment into `%2E%2E`, which a URL
 * parser treats as an ordinary path character, not a dot-segment — the class
 * becomes impossible rather than merely unlikely for a slug or id that
 * happens to be well-formed today.
 */
export function pathSegment(value: string): string {
  return encodeURIComponent(value)
}

/**
 * The generic REST call every namespace (auth, datapoints, and later
 * actions/services/publishers/cameras) is built on: one place that attaches
 * credentials, retries exactly once on `token_expired`, and turns every
 * non-2xx response into a `FleetlessError`.
 */
export class HttpClient {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch
  #credentials: CredentialSource

  constructor(options: HttpClientOptions) {
    this.#baseUrl = options.baseUrl
    this.#fetch = options.fetch
    this.#credentials = options.credentials
  }

  /**
   * Swaps the credential source after construction. Exists to break a
   * construction cycle: a session's `CredentialSource` needs this
   * `HttpClient` to call `/api/client/refresh`, so the client is built
   * first with a placeholder and the real source attached once it exists.
   */
  setCredentials(credentials: CredentialSource): void {
    this.#credentials = credentials
  }

  /**
   * Calling `request()` with one of `RequestBodyByRoute`'s
   * literal paths requires `options.body` to match that route's contract
   * type exactly, via `RequestOptionsFor<P>` below.
   *
   * **Deliberately not a pair of overloads** — a first version was:
   * `request<T, P extends keyof RequestBodyByRoute>(path: P, options: {
   * body: RequestBodyByRoute[P] } & ...): Promise<T>` followed by a looser
   * `request<T>(path: string, options?: RequestOptions): Promise<T>`
   * fallback. Verified wrong before it ever landed: TypeScript overload
   * resolution tries each signature in order and silently falls through to
   * the next one on a mismatch — so a call with the WRONG body for a mapped
   * route simply failed to match the strict overload and matched the loose
   * one instead, with **no diagnostic at all**. A single generic signature
   * whose `options` type is *computed* from `P` (below) has no looser
   * sibling to fall back to, so a mismatch has nowhere to go but an error.
   *
   * **`options` has no default value, on purpose.** A default of `{} as
   * RequestOptionsFor<P>` would type-check by construction — the cast
   * bypasses the very check this exists to add, which is the identical
   * "special case that quietly exempts calls from the general rule" shape
   * this file has already made once. Every current call site to a route
   * with no body already passes `{}` explicitly for exactly this reason.
   */
  async request<T, P extends string>(path: P, options: RequestOptionsFor<P>): Promise<T> {
    const response = await this.#send(path, options, true)
    // The status code doesn't say whether a response carries a body:
    // `POST /api/client/password/change` answers 200 WITH `sessionTokens`,
    // while the camera live-session release answers 204 with nothing at all
    // (route table in contracts' rest.ts — the second has no response
    // schema listed). A first version branched on `status === 202` — wrong,
    // for the same reason.
    //
    // A second version special-cased `status === 204` above this,
    // unconditionally, reasoning a 204 has no body *by definition* — true,
    // but beside the point: `.text()` on a 204 already resolves `''`
    // (confirmed: WHATWG Fetch semantics, and covered by tests), so
    // that branch bought nothing except an exemption from the
    // check two lines below. And that exemption was a live bug —
    // `changePassword` expects `sessionTokens` back (no `expectEmptyBody`),
    // and a route that regressed to answering 204 (exactly what
    // `/api/client/password/change` answered before contracts `d344d5a`
    // made it re-issue) would silently resolve `undefined` here and get
    // handed straight to `tokenStore.save(undefined)` — the identical
    // silent-corruption failure this whole mechanism exists to turn into a
    // loud one, just reached through status instead of an empty 200 body.
    // So there is now exactly one check, and it does not read the status at
    // all: an empty body is a contract violation unless the caller declared
    // one expected, regardless of *why* the body came back empty.
    const text = await response.text()
    if (text.length === 0) {
      if (options.expectEmptyBody) return undefined as T
      throw new FleetlessError(
        'unexpected_response',
        `${options.method ?? 'GET'} ${path} answered ok (${response.status}) but the body was empty; this route is expected to always return one.`,
      )
    }
    return JSON.parse(text) as T
  }

  /**
   * Like `request`, but for an endpoint that answers with raw bytes instead
   * of a JSON body (a camera snapshot) — same auth attachment, same
   * single retry on `token_expired`, same `FleetlessError` on a non-2xx
   * response; only what a *successful* response is made of differs, so both
   * methods share `#send` rather than duplicating that logic.
   */
  async requestBinary(path: string, options: RequestOptions = {}): Promise<BinaryResponse> {
    const response = await this.#send(path, options, true)
    const body = new Uint8Array(await response.arrayBuffer())
    return { body, headers: response.headers }
  }

  /**
   * The base URL this client was constructed with — exposed so a caller
   * building a URL that is not itself a `request()`/`requestBinary()` call
   * (today: `auth.beginOidcLogin`'s federated sign-in link, which is handed to
   * a browser rather than fetched) does not need its own copy of the value
   * `HttpClient` already holds.
   */
  get baseUrl(): string {
    return this.#baseUrl
  }


  /** Fetches with credentials attached and the token_expired retry applied; returns the raw successful `Response`, or throws `FleetlessError`. */
  async #send(path: string, options: RequestOptions, allowRetry: boolean): Promise<Response> {
    // `path` arrives absolute rather than baseUrl-relative exactly once
    // today: a URDF's rewritten mesh URIs. They
    // have to be absolute — the consumer is an app on some other origin, and
    // a root-relative URL would resolve against *that* origin, not ours
    // (the same mistake as `LIVEKIT_URL=localhost`, handed to a
    // viewer's browser). Not a leniency worth tightening later — a real,
    // load-bearing case, not a caller forgetting to strip the origin.
    const isAbsolute = /^https?:\/\//.test(path)
    const url = isAbsolute ? path : `${this.#baseUrl}${path}`

    // A URDF is ROS graph input, not first-party data (the platform chose
    // `defusedxml` over stdlib XML server-side for the identical reason) —
    // anything on a robot's graph can publish one. `rewriteMeshUris`
    // (cloud) only rewrites `package://` URIs; a `<mesh filename="...">`
    // naming a URL outright passes through unchanged (a later review closed that
    // half separately). Without this check, `createMeshLoader` would hand
    // an attacker-chosen absolute URL straight to `#fetch` with this
    // caller's own `Authorization` header attached — a URDF an app never
    // wrote exfiltrating the token of every viewer who renders it. "Legitimate
    // host" needs no allowlist to define here: it is this client's own
    // configured `baseUrl`, the API the caller chose to trust — anything
    // else is refused outright, not fetched anonymously, so a malicious
    // reference fails loudly instead of quietly making an unexpected
    // network call on the app's behalf.
    if (isAbsolute && new URL(url).origin !== new URL(this.#baseUrl).origin) {
      throw new FleetlessError(
        'untrusted_absolute_url',
        `Refusing to fetch '${url}': its origin does not match this client's own API (${this.#baseUrl}). ` +
          `This SDK only attaches credentials to requests aimed at the API it was configured with.`,
      )
    }

    const headers: Record<string, string> = {}
    // Only when there is actually a body to describe — a bodyless POST/DELETE
    // (e.g. cameras.live()'s take/release) sent `content-type: application/json`
    // with nothing after it, and the cloud refuses that combination outright
    // (`validation_error`: "Body cannot be empty when content-type is set to
    // 'application/json'"). A browser's own `fetch()` does not set this header
    // unless you give it a body either; matching that default is what makes
    // every server accept a bodyless call regardless of how lenient it is.
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (!options.skipAuth) {
      const token = await this.#credentials.token()
      if (token) headers.authorization = `Bearer ${token}`
    }

    const response = await this.#fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    })

    if (response.ok) return response

    const body = await safeJson(response)
    // A real response arrived (unlike no_session/no_websocket, which never
    // reach the network) — it just wasn't shaped like the platform's error body.
    const code = typeof body?.code === 'string' ? body.code : 'unparseable_error'
    const message = typeof body?.message === 'string' ? body.message : response.statusText || 'Request failed'

    if (!options.skipAuth && allowRetry && code === 'token_expired') {
      let canRetry: boolean
      try {
        canRetry = await this.#credentials.handleExpired()
      } catch (refreshError) {
        if (refreshError instanceof FleetlessError) throw refreshError
        throw new FleetlessError(code, message, { details: body?.details, status: response.status })
      }
      if (canRetry) return this.#send(path, options, false)
    }

    throw new FleetlessError(code, message, { details: body?.details, status: response.status })
  }
}

async function safeJson(response: Response): Promise<ErrorBody | undefined> {
  try {
    return (await response.json()) as ErrorBody
  } catch {
    return undefined
  }
}
