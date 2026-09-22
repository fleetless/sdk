// SPDX-License-Identifier: MIT
import {
  clientOidcErrorCode,
  type ClientAcceptInvitationRequest,
  type ClientIdentity,
  type ClientLoginRequest,
  type ClientLogoutRequest,
  type ClientMcpInteraction,
  type ClientMcpInteractionDecisionResponse,
  type ClientOidcExchangeRequest,
  type ClientPasswordResetConfirmRequest,
  type ClientPasswordResetRequest,
  type ClientProviderListResponse,
  type ClientRefreshRequest,
  type ClientRegisterRequest,
  type ClientResendVerificationRequest,
  type ClientVerifyEmailRequest,
  type McpConsentGrant,
  type McpConsentGrantListResponse,
  type PasswordChangeRequest,
  type SessionTokens,
} from '@fleetless/contracts'
import { FleetlessError } from './errors.js'
import { pathSegment, type CredentialSource, type HttpClient } from './http.js'
import { computeCodeChallenge, generateCodeVerifier, generateState } from './pkce.js'
import type { StoredSession, TokenStore } from './token-store.js'

/**
 * `register()`'s input. The app identifier is **not** here: the client already
 * holds one (`createClient({ appIdentifier })`) and sends it itself, so there
 * is no way for a caller to register somebody into a different app than the
 * one this client speaks for.
 */
export interface RegisterOptions {
  /** The address the verification mail goes to. Nothing works until that link is spent. */
  email: string
  /** At least 12 characters — `clientRegisterRequest` refuses less with a `validation_error`. */
  password: string
  /**
   * What the app should call this person. Optional, and **omitted from the
   * request entirely** when you do not pass it — `clientRegisterRequest` is a
   * strict schema, so a key carrying `undefined` would be a `422` rather than a
   * default.
   */
  displayName?: string
}

/** `acceptInvitation()`'s input — the token out of the mailed link, plus the password the account gets. */
export interface AcceptInvitationOptions {
  /** The `token` from the invitation link the developer's app was linked to. */
  token: string
  /** At least 12 characters. The invitation fixes the role; this call fixes the credential. */
  password: string
  /** Optional, and omitted from the request entirely when absent — same strict-schema reason as `RegisterOptions.displayName`. */
  displayName?: string
}

/** One sign-in button on the app's own login screen, as `listProviders()` lists it. */
export interface ProviderButton {
  /** What `beginOidcLogin` addresses this provider by. */
  slug: string
  /** The label the developer configured, to be rendered on the button. */
  name: string
}

/** `beginOidcLogin()`'s input: which provider, and where Fleetless should send the browser back to. */
export interface BeginOidcLoginOptions {
  /** A `slug` from `listProviders()`. An unknown one is a `404` when the browser reaches the start route, not here. */
  slug: string
  /**
   * Where the browser comes back to with `?code=…&state=…` (or `?error=…`).
   * Checked against the app's **allowed origins** server-side, by origin — so
   * the path is yours to choose and the origin is not.
   *
   * **Two shapes are refused outright, before the origin is compared**, and
   * neither refusal mentions them: a URL carrying a **fragment**
   * (`https://app.example.com/#/auth/callback`) and one carrying **userinfo**
   * (`https://someone@app.example.com/cb`). Both come back as a flat
   * `400 invalid_redirect_uri` reading "The redirect_uri is not an origin this
   * app answers for", which sends people to re-check an allow-list that was
   * never the problem.
   *
   * The fragment case is the one that costs time, because hash routing is the
   * default for a static-hosted SPA with no server rewrite. Give the callback
   * a real path (`/auth/callback`) and let your router pick the hash route up
   * from there; a fragment is a browser-side construct the redirect could not
   * carry a code in anyway.
   */
  redirectUri: string
}

/** What `beginOidcLogin()` returns. Nothing here has touched the network. */
export interface OidcLoginRequest {
  /**
   * Send the end user's browser here. **This SDK does not navigate** — it has
   * no opinion about whether that is a full page load, a popup or a native web
   * view, the same boundary `cameras.live` draws by handing back a URL and a
   * token and stopping there.
   */
  url: string
  /**
   * Persist this next to `codeVerifier` **before navigating away**, and pass
   * both back into `completeOidcLogin`. The SDK does not persist them for you:
   * the redirect back is a fresh page load for a browser app, and nothing kept
   * in this SDK's memory survives it. `sessionStorage`, a signed cookie or a
   * plain variable (a popup flow that never truly navigates) are all valid —
   * that choice is the caller's, and an in-memory default here would look like
   * it worked right up until the first real redirect.
   */
  state: string
  /**
   * The PKCE code verifier for this attempt — persist it exactly as `state`.
   * **The app runs its own PKCE against Fleetless**, a second exchange
   * independent of the one Fleetless runs against the identity provider, which
   * is what makes the one-time code in the redirect worth nothing to whoever
   * else reads that URL.
   */
  codeVerifier: string
}

/** `completeOidcLogin()`'s input — the redirect back, plus what `beginOidcLogin` returned for this same attempt. */
export interface CompleteOidcLoginOptions {
  /** The `code` query parameter from the redirect back to `redirectUri`. It lives 60 seconds. */
  code: string
  /** The `state` query parameter from that same redirect. */
  state: string
  /** The `state` this attempt's `beginOidcLogin` returned. Compared **before any network call**. */
  expectedState: string
  /** The `codeVerifier` this attempt's `beginOidcLogin` returned. */
  codeVerifier: string
}

/**
 * What `approveMcpInteraction`/`denyMcpInteraction` resolve with: **where to
 * send the browser**, and nothing else.
 *
 * A denial carries a redirect too, with `error=access_denied` on it — a client
 * that is refused has to learn so from its own callback rather than from a page
 * nobody sent it, so both outcomes end the same way for the app: navigate here.
 */
export interface McpInteractionDecision {
  /** The absolute URL to navigate to. Wire field `redirect_to`. */
  redirectTo: string
}

/**
 * Who the caller is, reachable as `client.auth` — the whole client
 * authentication API, as JSON.
 *
 * **Fleetless serves an app user no page.** The developer's own UI owns every
 * screen: login, registration, verification, invitation acceptance, password
 * reset, the provider buttons and the MCP consent. These methods are what those
 * screens call. The hosted, app-branded login and consent pages this SDK used
 * to drive are gone, along with `beginHostedLogin`/`completeHostedLogin`.
 *
 * **The enumeration discipline is the design's, and it shapes this surface.**
 * `register`, `resendVerification` and `requestPasswordReset` resolve for every
 * policy-allowed request whether or not the address exists, and `login` answers
 * the identical `invalid_credentials` for a wrong password, a blocked account
 * and an unverified one. So: *resolving does not mean an account exists*, and
 * the only honest refusals are the ones about policy rather than about a
 * person — `registration_closed`, `domain_not_allowed`, `quota_exceeded`.
 *
 * **A client built with a `serverKey` refuses everything that needs an app
 * user's own session** with `invalid_option`, before any request. `me()`,
 * `listProviders()`, `mcpInteraction()` and `oidcErrorFromCallback()` still
 * work on one: the first is what a server key is *for*, the next two are public
 * reads the cloud answers without any credential at all, and the last touches
 * no network.
 */
export interface AuthApi {
  /**
   * Self-registration. Writes the account as `pending_verification` and mails
   * the app's verification link; **the account cannot log in until that link is
   * spent** (`verifyEmail`).
   *
   * Resolves on the route's `202` — which the cloud answers for every
   * policy-allowed request, whether the address was new or already known. It is
   * not a claim that an account was created, and an app that renders it as one
   * ("welcome, Ada!") is showing a stranger the enumeration oracle this whole
   * family is built to avoid. Render "check your mail" instead.
   *
   * Throws a `FleetlessError` carrying the cloud's own code for a refusal, and
   * that is the distinction this method exists to preserve: `registration_closed`
   * (the app has self-registration off), `domain_not_allowed` (the address is
   * outside the app's allowed domains), `quota_exceeded` (the org has as many
   * app users as its quota allows) and `not_found` (no app carries this
   * client's `appIdentifier`) are all things the app can say out loud, because
   * none of them is about whether a person exists.
   */
  register(input: RegisterOptions): Promise<void>
  /**
   * Spends a verification token and **stores the session it answers with**, so
   * the person is not asked to log in immediately after proving they can read
   * the mail.
   *
   * `token_spent` covers unknown, expired and already-used alike — one code,
   * because the remedy is one thing: ask for a fresh link with
   * `resendVerification`. An app rendering this refusal should offer that.
   */
  verifyEmail(token: string): Promise<void>
  /** Asks for the verification mail again. Resolves on `202` for every policy-allowed request, existing address or not — same reason as `register`. */
  resendVerification(email: string): Promise<void>
  /**
   * Exchanges email + password, and the client's configured app identifier, for
   * a session.
   *
   * `invalid_credentials` is answered identically for a wrong password, a
   * blocked account and one still waiting to verify. Do not try to tell them
   * apart — there is nothing in the answer that does, deliberately.
   */
  login(email: string, password: string): Promise<void>
  /**
   * Ends the session: revokes the whole refresh-token family server-side (a
   * stolen refresh token stops working immediately), closes this client's live
   * realtime connection if it has one, and clears the local store.
   *
   * **Never rejects, and always clears the store**, even if the server call
   * fails: a user who presses "log out" must end up logged out locally
   * regardless of the network.
   *
   * **What this does not do:** invalidate the access token already issued.
   * Access-token checks are stateless (a signed JWT, verified without a lookup),
   * so logout has nothing to flip on that token — only on the refresh family
   * behind it. A token stolen before logout keeps working on REST, and can
   * still open a *new* realtime connection, until it expires on its own, at
   * most 15 minutes. That is a deliberate boundary of the stateless-JWT design,
   * not a bug, but a kiosk or a shared workstation needs to know the number.
   *
   * **Nor does it end a session at the identity provider.** It used to report
   * what was left of one; that apparatus belonged to the hosted login, where
   * Fleetless owned the browser. The app owns it now, and an app that wants to
   * end a provider session redirects there itself — knowing its own provider,
   * which Fleetless never did better than it.
   */
  logout(): Promise<void>
  /** Who the caller turned out to be, without decoding a token client-side — which is how apps end up trusting claims nobody verified. */
  me(): Promise<ClientIdentity>
  /**
   * Changes the current app user's password.
   *
   * `currentPassword` is required even though the session already proves
   * identity — it is what stops a stolen *session* from becoming a stolen
   * *account*.
   *
   * **Every other session of this identity is revoked, and this call's own
   * session is re-issued rather than spared.** The request carries nothing
   * identifying the caller's own refresh family, so the server revokes all of
   * them and hands back a fresh pair, which this method stores exactly like
   * `login`. A user with other tabs or devices signed in will see those signed
   * out the moment this resolves; if your app does not make that consequence
   * visible before they confirm, they will find out from a support ticket.
   */
  changePassword(currentPassword: string, newPassword: string): Promise<void>
  /** Asks for a reset link. Resolves on `202` for a known and an unknown address alike — the answer says nothing about which it was. */
  requestPasswordReset(email: string): Promise<void>
  /**
   * Spends a reset token, sets the new password and **stores the session it
   * answers with**. Every refresh family of that user is revoked first — a
   * forgotten password is one of the two states where somebody else may be
   * holding a session.
   */
  confirmPasswordReset(token: string, newPassword: string): Promise<void>
  /**
   * Accepts an app invitation: creates the account (or activates one invited
   * before it existed) with the role the invitation fixed, and **stores the
   * session**.
   *
   * An invitation always bypasses the app's domain whitelist — a developer
   * inviting somebody by hand has already made the decision the whitelist
   * automates.
   */
  acceptInvitation(input: AcceptInvitationOptions): Promise<void>
  /**
   * The app's **enabled** sign-in providers, for drawing the buttons on your
   * own login screen. A disabled provider is not a button that refuses; it is a
   * button that is not there.
   *
   * Public and unauthenticated, and it carries nothing but `slug` and `name` on
   * purpose: the issuer, the client id, the scopes and the linking policy are
   * management-side facts that would tell a stranger how the app's federation
   * is configured.
   */
  listProviders(): Promise<ProviderButton[]>
  /**
   * Builds the URL that starts a federated sign-in, with a fresh `state` and a
   * fresh PKCE verifier. **Makes no network call and does not navigate** —
   * persist `state` and `codeVerifier`, then send the browser to `url`.
   *
   * Nothing about the app, the provider or the redirect URI is validated here;
   * it is all checked when the browser actually reaches the route, in that
   * order, with the redirect target checked before the provider so that a
   * caller who got the target wrong learns nothing about which providers the
   * app has.
   *
   * Async only because the S256 `code_challenge` needs `crypto.subtle.digest`,
   * which the Web Crypto API only ever offers as a promise.
   */
  beginOidcLogin(input: BeginOidcLoginOptions): Promise<OidcLoginRequest>
  /**
   * Completes a federated sign-in: checks `state` against `expectedState`,
   * trades the one-time `code` for a session, and stores it.
   *
   * **The state check runs before any request is sent.** RFC 6749 §10.12's
   * whole point is that a client must not complete an authorization response it
   * did not itself request — a check made after the exchange would already have
   * spent a code for a flow this client never started. Both an outright
   * mismatch and an *empty* `expectedState` throw `state_mismatch`; the message
   * says which, because the remedies differ ("check how your app persisted the
   * value" versus "this response belongs to a sign-in you did not start") even
   * though the next step is the same either way — start the sign-in again.
   *
   * The code lives 60 seconds and is single-use. Unknown, expired, replayed and
   * "the account was blocked in between" all arrive as one `token_spent`,
   * because the app has nothing different to do about any of them.
   */
  completeOidcLogin(input: CompleteOidcLoginOptions): Promise<void>
  /**
   * Reads a **failed** federated sign-in off the redirect back, as a
   * `FleetlessError` you can branch on, or `null` when the callback carries no
   * `error` at all.
   *
   * Fleetless renders no page for these: the reason is carried to your own
   * `redirectUri` as `?error=<code>`, and this turns that string into the same
   * error type every other method throws. A code the contracts define (see
   * `ClientOidcErrorCode`) becomes that code verbatim; anything else becomes
   * `unexpected_response` with the raw value in the message, rather than being
   * passed through as a code neither side defines.
   *
   * Purely local — it parses a query string and asks nothing.
   */
  oidcErrorFromCallback(params: URLSearchParams): FleetlessError | null
  /**
   * Reads a pending MCP authorization by the interaction id the browser
   * arrived with, so the app can render its own consent screen.
   *
   * **`client_name` is a string the client typed about itself** during an
   * unauthenticated dynamic registration — nobody checked it, which is why
   * `client_name_verified` is the literal `false` rather than a boolean with a
   * `true` branch that could never happen. Do not render it as an identity.
   *
   * `interaction_expired` means exactly that: ten minutes ran out, or the id
   * was never real. Both answer the same way, so the screen to show is "that
   * took too long, start again" rather than an error.
   *
   * **Call this with the app user already signed in.** The route needs no
   * credential, but it reads one if present, and `already_granted` is `false`
   * for an anonymous read whatever the truth is — so a consent screen rendered
   * from an unauthenticated call asks a person to agree to something they
   * agreed to already. An **expired** token counts as anonymous to this route,
   * which answers `200` rather than refusing, so this method probes the
   * session's liveness first and refreshes if it can; a session that cannot be
   * refreshed is not an error here, it is genuinely anonymous.
   */
  mcpInteraction(id: string): Promise<ClientMcpInteraction>
  /** Approves a pending MCP authorization on behalf of the signed-in app user, and returns where to send the browser. */
  approveMcpInteraction(id: string): Promise<McpInteractionDecision>
  /** Denies one. Also returns a redirect — with `error=access_denied` on it, so the client learns from its own callback. */
  denyMcpInteraction(id: string): Promise<McpInteractionDecision>
  /**
   * Every MCP client this app user has standing consent for — the "connected
   * apps" list, and the door out of a decision a person could otherwise make
   * once and never unmake. A withdrawn grant is never listed.
   *
   * `client_name_verified` is `false` here for the reason it is on
   * `mcpInteraction`, and it matters more rather than less: a list like this is
   * read long after the moment of approval, when nobody remembers what they
   * clicked.
   */
  listMcpGrants(): Promise<McpConsentGrant[]>
  /**
   * Withdraws one standing consent by the client's id.
   *
   * Resolves whether or not there was anything to withdraw — a client id this
   * account never approved and one it withdrew a minute ago both land on the
   * end state the caller asked for. A refusal there would tell a caller which
   * clients an account has connected, and would turn a double-clicked button
   * into a failure.
   */
  revokeMcpGrant(clientId: string): Promise<void>
}

/**
 * Bearer credentials backed by a user session, with silent, single-flight
 * refresh: concurrent requests that meet an expired access
 * token share one `/api/client/refresh` call instead of each firing their
 * own, and every one of them re-reads the *new* token from the store before
 * retrying — none captures the stale token ahead of time.
 */
export class SessionCredentials implements CredentialSource {
  #refreshing: Promise<StoredSession> | null = null

  constructor(
    private readonly http: HttpClient,
    private readonly tokenStore: TokenStore,
  ) {}

  async token(): Promise<string | null> {
    const session = await this.tokenStore.load()
    return session ? session.access_token : null
  }

  async handleExpired(): Promise<boolean> {
    // Deliberately not caught: a refresh failure (e.g. `token_revoked` for a
    // reused refresh token) is more specific and more useful than the
    // `token_expired` that triggered this call, so it propagates out of
    // HttpClient instead of flattening to `false`.
    await this.#ensureRefreshed()
    return true
  }

  /** Single-flight — a refresh already in progress is awaited, never duplicated. */
  #ensureRefreshed(): Promise<StoredSession> {
    if (this.#refreshing) return this.#refreshing
    const attempt = this.#refresh().finally(() => {
      this.#refreshing = null
    })
    this.#refreshing = attempt
    return attempt
  }

  async #refresh(): Promise<StoredSession> {
    const current = await this.tokenStore.load()
    if (!current) throw new FleetlessError('no_session', 'No session to refresh.')
    const body: ClientRefreshRequest = { refresh_token: current.refresh_token }
    // No explicit `<SessionTokens>` type argument — request()'s second type
    // parameter is inferred from the literal path, which requires T to come from
    // context instead (the `: SessionTokens` annotation here) rather than
    // from an explicit type argument; TypeScript does not infer a later
    // type parameter from a value argument once an earlier one is given
    // explicitly, defaults or not.
    const tokens: SessionTokens = await this.http.request('/api/client/refresh', {
      method: 'POST',
      skipAuth: true,
      body,
    })
    await this.tokenStore.save(tokens)
    return tokens
  }
}

/** Bearer credentials backed by a static server key — full app rights, never expires, never refreshes. */
export class ServerKeyCredentials implements CredentialSource {
  constructor(private readonly serverKey: string) {}

  async token(): Promise<string> {
    return this.serverKey
  }

  async handleExpired(): Promise<boolean> {
    return false
  }
}

/**
 * The one place `display_name` is turned into a wire field.
 *
 * Both request schemas that carry it are **strict** (`catchall: never`), so a
 * key holding `undefined` is not "the same as absent" the moment anything but
 * `JSON.stringify` looks at the object — and a future body builder that does
 * not go through `JSON.stringify` (a form encoding, a structured clone) would
 * turn that into a `422` with nothing in the SDK to explain it. Building the
 * key conditionally, once, is what makes "omitted" a property of the value
 * rather than a property of the serializer.
 */
function displayNameField(displayName: string | undefined): { display_name?: string } {
  return displayName === undefined ? {} : { display_name: displayName }
}

/**
 * **The three client-auth calls that need no session and answer none**, shared
 * by both `auth` namespaces.
 *
 * `register`, `resendVerification` and `requestPasswordReset` are `auth:
 * 'none'` in the route manifest, take their subject as an argument, and answer
 * `202` with an empty body. Nothing about them reads the caller, so a
 * server-key client refusing them was this SDK inventing a restriction the
 * cloud does not have — and a developer server-rendering their own sign-up or
 * forgot-password page has exactly one client in their backend. The refusal
 * messages were also arguing the wrong thing: `register` registers the address
 * in the body, not the caller.
 *
 * Written once because two copies of a body builder is how the two drift, and
 * because the strictness note on `displayNameField` applies to both.
 */
function createPublicAuthCalls(http: HttpClient, appIdentifier: string) {
  return {
    async register(input: RegisterOptions): Promise<void> {
      const body: ClientRegisterRequest = {
        app_identifier: appIdentifier,
        email: input.email,
        password: input.password,
        ...displayNameField(input.displayName),
      }
      // `expectEmptyBody` because the route answers 202 with nothing at all.
      // Without it, `request()` would refuse the empty body as a contract
      // violation — which is the right default for every route that owes one,
      // and exactly why this flag is per-call rather than a status check.
      await http.request('/api/client/register', { method: 'POST', skipAuth: true, expectEmptyBody: true, body })
    },
    async resendVerification(email: string): Promise<void> {
      const body: ClientResendVerificationRequest = { app_identifier: appIdentifier, email }
      await http.request('/api/client/resend-verification', { method: 'POST', skipAuth: true, expectEmptyBody: true, body })
    },
    async requestPasswordReset(email: string): Promise<void> {
      const body: ClientPasswordResetRequest = { app_identifier: appIdentifier, email }
      await http.request('/api/client/password/reset', { method: 'POST', skipAuth: true, expectEmptyBody: true, body })
    },
  }
}

/** The `auth` namespace for a client backed by an app user's own session. */
export function createSessionAuth(http: HttpClient, tokenStore: TokenStore, appIdentifier: string): AuthApi {
  /** Every route that answers a session stores it the same way — one place, so none of them can forget. */
  async function storeSession(tokens: SessionTokens): Promise<void> {
    await tokenStore.save(tokens)
  }

  /**
   * `GET /api/client/me`, as a plain function rather than through `this`.
   * `mcpInteraction` uses it as a liveness probe (see there), and a method on
   * an object literal cannot reach a sibling through `this` once a caller has
   * destructured the namespace — which is a thing callers do.
   */
  async function identity(): Promise<ClientIdentity> {
    return http.request('/api/client/me', {})
  }

  return {
    ...createPublicAuthCalls(http, appIdentifier),
    async verifyEmail(token) {
      const body: ClientVerifyEmailRequest = { token }
      const tokens: SessionTokens = await http.request('/api/client/verify-email', { method: 'POST', skipAuth: true, body })
      await storeSession(tokens)
    },
    async login(email, password) {
      const body: ClientLoginRequest = { app_identifier: appIdentifier, email, password }
      const tokens: SessionTokens = await http.request('/api/client/login', { method: 'POST', skipAuth: true, body })
      await storeSession(tokens)
    },
    async logout() {
      const session = await tokenStore.load()
      if (session) {
        const body: ClientLogoutRequest = { refresh_token: session.refresh_token }
        // Best-effort revoke: a user who presses "log out" must end up logged
        // out locally regardless of the network, so a failed server call clears
        // the store exactly like a successful one and does not reject.
        //
        // Nothing is reported back about it any more. The route answers 204
        // with no body (contracts `routes.ts`), so there is one fact to relay
        // and it is "the request either worked or did not" — which a caller
        // could not act on: the local store is cleared either way, and a
        // refresh family that survived is not something an app can retry into
        // submission. `revoked` was a field that made a reader think there was
        // a decision here.
        try {
          await http.request('/api/client/logout', { method: 'POST', skipAuth: true, expectEmptyBody: true, body })
        } catch {
          // Deliberately swallowed — see above.
        }
      }
      await tokenStore.save(null)
    },
    async me() {
      return identity()
    },
    async changePassword(currentPassword, newPassword) {
      const body: PasswordChangeRequest = { current_password: currentPassword, new_password: newPassword }
      // Answers fresh sessionTokens, not 204: the server revokes the whole
      // refresh family, including this caller's own, and re-issues rather than
      // trying to spare one token out of a request shape that does not identify
      // it. This call's session survives by being replaced, not by being left
      // alone — skipping the store would leave the caller holding tokens the
      // server has already revoked, working only until the access token expires
      // and then silently logged out, which is indistinguishable from the
      // change having failed.
      const tokens: SessionTokens = await http.request('/api/client/password/change', { method: 'POST', body })
      await storeSession(tokens)
    },
    async confirmPasswordReset(token, newPassword) {
      const body: ClientPasswordResetConfirmRequest = { token, new_password: newPassword }
      const tokens: SessionTokens = await http.request('/api/client/password/reset/confirm', { method: 'POST', skipAuth: true, body })
      await storeSession(tokens)
    },
    async acceptInvitation(input) {
      const body: ClientAcceptInvitationRequest = {
        token: input.token,
        password: input.password,
        ...displayNameField(input.displayName),
      }
      const tokens: SessionTokens = await http.request('/api/client/invitations/accept', { method: 'POST', skipAuth: true, body })
      await storeSession(tokens)
    },
    async listProviders() {
      // The one GET in this family that carries the app identifier, and it
      // carries it in the QUERY — `fetch` drops a body on a GET without saying
      // so, so this is not a stylistic difference from the POSTs above.
      //
      // `skipAuth` because the route reads no caller at all: it is the login
      // screen's own buttons, asked for before anybody is signed in. Attaching
      // a credential a route never looks at is how one ends up somewhere it
      // was not needed. **Contrast `mcpInteraction` below**, which looks
      // similarly public and must NOT skip it.
      const query = new URLSearchParams({ app_identifier: appIdentifier })
      const response: ClientProviderListResponse = await http.request(`/api/client/providers?${query.toString()}`, { skipAuth: true })
      return response.providers
    },
    async beginOidcLogin(input) {
      const state = generateState()
      const codeVerifier = generateCodeVerifier()
      const codeChallenge = await computeCodeChallenge(codeVerifier)
      // `pathSegment` for the same reason every id-addressed route uses it: a
      // slug this SDK got from a caller must not climb out of the route it
      // was interpolated into. `URL`'s own parser would remove a `..`
      // segment before `fetch` ever saw it — here it would be a link handed to
      // a browser, which does exactly the same thing.
      const url = new URL(`${http.baseUrl}/api/client/oidc/${pathSegment(input.slug)}/start`)
      url.searchParams.set('app_identifier', appIdentifier)
      url.searchParams.set('redirect_uri', input.redirectUri)
      url.searchParams.set('state', state)
      url.searchParams.set('code_challenge', codeChallenge)
      // No `code_challenge_method`: `clientOidcStartQuery` does not carry one.
      // S256 is not negotiable on this route — a challenge equal to its
      // verifier defends against nothing — so there is no parameter to send.
      return { url: url.toString(), state, codeVerifier }
    },
    async completeOidcLogin(input) {
      // Two absent values compare EQUAL — `'' !== ''` is `false` — so a caller
      // who reads `sessionStorage` straight into this call gets `''` for
      // `expectedState` whenever nothing was persisted (a different tab, a
      // re-opened redirect URL, a restored session, cleared storage) and the
      // comparison below would contribute nothing for exactly the callers most
      // likely to hit it. Requiring both sides non-empty first is what closes
      // that, and it is checked BEFORE the comparison rather than folded into
      // it so the message can say which of the two happened.
      if (!input.expectedState) {
        throw new FleetlessError(
          'state_mismatch',
          'completeOidcLogin: expectedState is empty — nothing was persisted for this attempt. That usually means the ' +
            'callback landed in a different tab or window than the one that called beginOidcLogin, the session was restored, ' +
            'or storage was cleared in between; it is not necessarily an attack. Check what beginOidcLogin returned and how ' +
            'your app persisted it, then start the sign-in again.',
        )
      }
      if (!input.state || input.state !== input.expectedState) {
        throw new FleetlessError(
          'state_mismatch',
          "completeOidcLogin: the redirect's state does not match the state beginOidcLogin generated for this attempt — " +
            'refusing to complete a sign-in this client did not start (RFC 6749 §10.12).',
        )
      }
      const body: ClientOidcExchangeRequest = { code: input.code, code_verifier: input.codeVerifier }
      const tokens: SessionTokens = await http.request('/api/client/oidc/exchange', { method: 'POST', skipAuth: true, body })
      await storeSession(tokens)
    },
    oidcErrorFromCallback(params) {
      return oidcErrorFromCallbackParams(params)
    },
    async mcpInteraction(id) {
      // **The bearer is checked for life before it is used.** The comment
      // below is why the token is attached at all; this is
      // why attaching a *stale* one is not good enough. An access token the
      // cloud has rejected as expired is treated by this route as **absent**,
      // not as a refusal — it answers `200` with `already_granted: false` —
      // so the SDK's refresh machinery, which only ever fires on a `401`,
      // cannot see it. The wrong answer then looks exactly like the right one.
      //
      // `me()` is the probe because it is the one client route that refuses an
      // expired token by name: the `401` drives `SessionCredentials`' single-
      // flight refresh, and the read below then carries the new token. A probe
      // that fails is **not** propagated — no session, a revoked family, a
      // refresh the cloud declined — because the interaction read is genuinely
      // public and a consent page must still be able to render for somebody
      // who is not signed in. In that case the anonymous answer is the true
      // one.
      //
      // The cost is one extra request per consent-page load **when a session
      // is stored at all** — an empty store skips the probe, so the anonymous
      // path is unchanged. It is the cheapest of the three options: the store
      // carries no absolute expiry to test locally, and refreshing
      // unconditionally would rotate a refresh family on every page load,
      // against a cloud that treats reuse as theft.
      if (await tokenStore.load()) await identity().catch(() => undefined)
      // **No `skipAuth`, and that is load-bearing rather than a default.** The
      // route needs no credential to answer — but it reads an OPTIONAL bearer,
      // and that bearer is the only thing that can set `already_granted`: the
      // cloud resolves the caller, checks they belong to this interaction's
      // app, and looks up their standing consent. Skipping auth here would
      // make `already_granted` permanently `false` and show a consent screen
      // to somebody who has already agreed — a wrong answer with a `200` on
      // it, which is the shape nothing downstream can detect.
      return http.request(`/api/client/mcp/interactions/${pathSegment(id)}`, {})
    },
    async approveMcpInteraction(id) {
      return decide(http, id, 'approve')
    },
    async denyMcpInteraction(id) {
      return decide(http, id, 'deny')
    },
    async listMcpGrants() {
      const response: McpConsentGrantListResponse = await http.request('/api/client/mcp/grants', {})
      return response.grants
    },
    async revokeMcpGrant(clientId) {
      await http.request(`/api/client/mcp/grants/${pathSegment(clientId)}`, { method: 'DELETE', expectEmptyBody: true })
    },
  }
}

/**
 * Approve and deny differ by one path segment and nothing else, so they share
 * one implementation rather than two that could drift.
 *
 * **No body at all**, not an empty object: `#send` attaches
 * `content-type: application/json` only when there is a body to describe, and
 * the cloud refuses that header with an empty body outright
 * (`validation_error`: "Body cannot be empty when content-type is set to
 * 'application/json'"). A browser's own `fetch` behaves the same way, which is
 * what makes matching it the portable choice rather than the lenient one.
 */
async function decide(http: HttpClient, id: string, decision: 'approve' | 'deny'): Promise<McpInteractionDecision> {
  const response: ClientMcpInteractionDecisionResponse = await http.request(
    `/api/client/mcp/interactions/${pathSegment(id)}/${decision}`,
    { method: 'POST' },
  )
  return { redirectTo: response.redirect_to }
}

/**
 * `?error=` on the app's own redirect, as a `FleetlessError`.
 *
 * The known set is read from `clientOidcErrorCode` at runtime rather than
 * copied into a list here: a code the contracts add later then arrives with
 * that code rather than as `unexpected_response`, and there is no second
 * spelling of the set for the two to drift apart on. The message is one
 * template for the same reason — a per-code sentence would be a twelve-entry
 * table nothing here could check against the platform's own wording.
 */
function oidcErrorFromCallbackParams(params: URLSearchParams): FleetlessError | null {
  const raw = params.get('error')
  if (raw === null || raw === '') return null
  const known = clientOidcErrorCode.safeParse(raw)
  if (!known.success) {
    return new FleetlessError(
      'unexpected_response',
      `The federated sign-in came back with an error code this SDK does not know: '${raw}'. ` +
        'Treat it as a failed sign-in; if it keeps happening, the cloud has added a code this SDK predates.',
    )
  }
  return new FleetlessError(
    known.data,
    `The federated sign-in ended without a session (${known.data}). See ClientOidcErrorCode in @fleetless/contracts ` +
      'for what each code means, and branch on error.code rather than on this message.',
  )
}

/**
 * The refusal every **session** method makes on a `serverKey` client.
 *
 * `invalid_option` rather than a bare `Error` (which is what these threw
 * before 3.0.0): this is a caller passing an SDK-level option that cannot mean
 * what it looks like it means — a server key belongs to a backend acting with
 * the app's own full rights, and there is no "self" for it to sign in,
 * consent or revoke as. It is a client-side mistake to fix, refused before any
 * request is sent, which is exactly what that code is for everywhere else in
 * this SDK. A caller can now branch on it like any other.
 *
 * **What it does NOT cover**: a route being public. Three
 * of the calls it used to refuse — `register`, `resendVerification`,
 * `requestPasswordReset` — take their subject as an argument and answer
 * nothing, and they are allowed on both clients now. Everything still refused
 * here either needs a person's own session or answers one, and the `needs`
 * string has to say which; a message arguing that a server key "has no address
 * to verify" was arguing about the caller on a route that never reads it.
 *
 * **It names the option the caller actually passed**: `credentials`
 * reaches the same refusals, and telling somebody their `serverKey` is the
 * problem when they never passed one sends them looking for a key that does
 * not exist.
 */
function sessionlessRefusal(option: SessionlessOption, method: string, needs: string): never {
  throw new FleetlessError(
    'invalid_option',
    `auth.${method} is not available on a client constructed with ${option === 'serverKey' ? 'a serverKey' : 'a credentials source'} — ${needs}. ` +
      "Build a client with a tokenStore (an app user's own session) for this call.",
  )
}

/**
 * Which option left this client without a session of its own — a static
 * `serverKey`, or a `credentials` source the embedder owns. The two
 * refuse the same calls for the same reason and differ only in what the
 * message tells the caller to go and look at.
 */
export type SessionlessOption = 'serverKey' | 'credentials'

/** The `auth` namespace for a client with no session of its own: nothing to log in or out of. */
export function createServerKeyAuth(http: HttpClient, appIdentifier: string, option: SessionlessOption = 'serverKey'): AuthApi {
  // Annotated on the const, not only on the arrow: TypeScript only treats a
  // call as unreachable when the *variable* carries the `never` return type.
  const serverKeyRefusal: (method: string, needs: string) => never = (method, needs) => sessionlessRefusal(option, method, needs)
  // The two modes refuse the same calls; only the noun differs. Written out
  // rather than left saying "a server key" to a caller who passed none.
  const subject = option === 'serverKey' ? 'a server key' : 'a supplied credential'
  const holder = option === 'serverKey' ? 'a server-key client' : 'a client with a supplied credential'
  return {
    // **`register`, `resendVerification` and `requestPasswordReset` are
    // allowed here** — see `createPublicAuthCalls`. They are public routes
    // that name their own subject and answer nothing, so a server-rendered
    // sign-up or forgot-password page can use the one client its backend
    // already has.
    ...createPublicAuthCalls(http, appIdentifier),
    async verifyEmail() {
      // **Refused for the session it answers, not for who is calling.** The
      // route itself is public and would happily spend the token — but it
      // answers `SessionTokens`, and this method's contract is to STORE them.
      // A server-key client has no token store, so completing the call here
      // would verify the account and then drop the person's session on the
      // floor: the account moves to `active` and nobody is signed in, with a
      // resolved promise saying it went fine.
      serverKeyRefusal('verifyEmail', `the route answers a session and ${holder} has nowhere to store it, so the session would be silently discarded`)
    },
    async login() {
      serverKeyRefusal('login', `${subject} IS the credential; there is nothing to exchange`)
    },
    async logout() {
      serverKeyRefusal('logout', `${subject} holds no session to end`)
    },
    async me() {
      // The one method a server key is actually for, and the reason `auth` is
      // not simply absent on such a client: it answers `kind: 'server_key'`.
      return http.request('/api/client/me', {})
    },
    async changePassword() {
      serverKeyRefusal('changePassword', `${subject} has no password${option === 'serverKey' ? '; rotate the key in the console instead' : ''}`)
    },
    async confirmPasswordReset() {
      // Same reason as `verifyEmail`: public route, but the answer is a
      // session this client cannot keep.
      serverKeyRefusal('confirmPasswordReset', `the route answers a session and ${holder} has nowhere to store it, so the session would be silently discarded`)
    },
    async acceptInvitation() {
      serverKeyRefusal('acceptInvitation', `the route answers a session and ${holder} has nowhere to store it, so the session would be silently discarded`)
    },
    async listProviders() {
      // **Allowed, unlike the rest.** The route is public and reads no caller:
      // it is the app's own sign-in buttons, and a server-side renderer of the
      // developer's login page is a real caller for it. Refusing here would be
      // this SDK inventing a restriction the cloud does not have.
      const query = new URLSearchParams({ app_identifier: appIdentifier })
      const response: ClientProviderListResponse = await http.request(`/api/client/providers?${query.toString()}`, { skipAuth: true })
      return response.providers
    },
    async beginOidcLogin() {
      serverKeyRefusal('beginOidcLogin', 'a federated sign-in is inherently an app user\'s browser flow')
    },
    async completeOidcLogin() {
      serverKeyRefusal('completeOidcLogin', 'a federated sign-in is inherently an app user\'s browser flow')
    },
    oidcErrorFromCallback(params) {
      // Pure: it parses a query string and asks nothing, so there is no
      // identity for it to be wrong about. A server-rendered consent or
      // callback page is a real caller.
      return oidcErrorFromCallbackParams(params)
    },
    async mcpInteraction(id) {
      // Allowed for `listProviders`' reason: the read needs no credential.
      // The server key IS sent (no `skipAuth`, matching the session client),
      // and the cloud treats a bearer that is not an app user of this
      // interaction's app as absent rather than refusing it — so the answer is
      // the anonymous one, with `already_granted: false`. **The decisions
      // below are refused** — approve and deny record a person's consent, and
      // a server key is not a person; the cloud answers those `401` too.
      return http.request(`/api/client/mcp/interactions/${pathSegment(id)}`, {})
    },
    async approveMcpInteraction() {
      serverKeyRefusal('approveMcpInteraction', `a consent is a person's decision, and ${subject} is not a person`)
    },
    async denyMcpInteraction() {
      serverKeyRefusal('denyMcpInteraction', `a consent is a person's decision, and ${subject} is not a person`)
    },
    async listMcpGrants() {
      serverKeyRefusal('listMcpGrants', `${subject} never went through a consent screen, so it has no grants of its own`)
    },
    async revokeMcpGrant() {
      serverKeyRefusal('revokeMcpGrant', `${subject} never went through a consent screen, so it has no grants of its own`)
    },
  }
}
