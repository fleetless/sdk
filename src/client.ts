// SPDX-License-Identifier: MIT
import { createActionsApi, type ActionsApi } from './actions.js'
import { createAssetsApi, type AssetsApi } from './assets.js'
import { createServerKeyAuth, createSessionAuth, ServerKeyCredentials, SessionCredentials, type AuthApi } from './auth.js'
import { createCamerasApi, type CamerasApi } from './cameras.js'
import { createRealtimeCommandTransport } from './commands.js'
import { createDatapointsApi, type DatapointsApi } from './datapoints.js'
import { HttpClient, noCredentials, type CredentialSource } from './http.js'
import { createJobSubscriptions } from './job-subscriptions.js'
import { createJobsApi, type JobsApi } from './jobs.js'
import { createPublishersApi, type PublishersApi } from './publishers.js'
import { RealtimeChannel } from './realtime.js'
import { createRobotsApi, type RobotsApi } from './robots.js'
import { createServicesApi, type ServicesApi } from './services.js'
import { createSlugSubscriptions } from './slug-subscriptions.js'
import { InMemoryTokenStore, type TokenStore } from './token-store.js'

/**
 * Everything `createClient` accepts. `apiUrl` and `appIdentifier` are
 * required; the rest either select the kind of caller (`tokenStore` versus
 * `serverKey`) or replace a global the SDK would otherwise reach for.
 */
export interface FleetlessClientOptions {
  /** Base URL of the Fleetless REST API, e.g. `https://api.fleetless.dev`. */
  apiUrl: string
  /** The app's identifier (the slug shown in the console), sent on every login. */
  appIdentifier: string
  /**
   * Where refresh/access tokens live between calls. Defaults to in-memory —
   * pass your own (localStorage, a cookie, a native keystore) to persist a
   * session across reloads. The SDK never assumes a browser exists.
   */
  tokenStore?: TokenStore
  /**
   * A server key (`flk_...`) for server-side callers with full app rights.
   * Mutually exclusive with `tokenStore`-based login: a client constructed
   * with a server key never calls `auth.login`/`auth.logout`.
   */
  serverKey?: string
  /** Injectable for tests, or a non-global `fetch` implementation. */
  fetch?: typeof fetch
  /** Injectable for tests, or a non-global `WebSocket` implementation. */
  WebSocket?: typeof WebSocket
  /** Defaults to `apiUrl` with http(s) swapped for ws(s) and `/realtime` appended. */
  realtimeUrl?: string
}

/**
 * The settled configuration of a client, reachable as `client.config`. It
 * is frozen and reflects the defaults `createClient` filled in, which is
 * what makes it worth reading: `realtimeUrl` is usually derived rather than
 * passed.
 */
export interface FleetlessClientConfig {
  /** The REST base URL this client calls, exactly as passed to `createClient`. */
  readonly apiUrl: string
  /** The app this client acts as, exactly as passed to `createClient`. */
  readonly appIdentifier: string
  /** The realtime WebSocket URL in use, derived from `apiUrl` unless one was passed. */
  readonly realtimeUrl: string
}

/**
 * One app's client, returned by `createClient`. Every API the SDK offers is
 * a property on it, and all of them share this client's identity, its
 * single realtime channel and its token refresh.
 */
export interface FleetlessClient {
  /** The settled configuration, including the defaults `createClient` filled in. */
  readonly config: FleetlessClientConfig
  /**
   * The whole client auth API: registration, verification, login, logout,
   * password reset, invitations, the app's federated sign-in providers, the
   * MCP consent screen, and the app user's own standing MCP grants.
   */
  readonly auth: AuthApi
  /** A topic's latest value, a live subscription to it, and its recorded history. */
  readonly datapoints: DatapointsApi
  /** Long-running work on the robot: invoke, cancel, and watch a job as it runs. */
  readonly actions: ActionsApi
  /** Request/response calls to the robot that answer once and are done. */
  readonly services: ServicesApi
  /** One-way messages to a robot's publisher, such as a velocity command. */
  readonly publishers: PublishersApi
  /** Camera snapshots, their age, and live video sessions. */
  readonly cameras: CamerasApi
  /**
   * Robot-wide job reads that do not fit under `actions`/`services` because
   * they are not addressed by slug — see `JobsApi.list`.
   */
  readonly jobs: JobsApi
  /** URDF and mesh reads — list/get/urdf, plus the `urdf-loader` mesh callback. */
  readonly assets: AssetsApi
  /** Which robots this caller reaches, and what their role lets them do on each — the calls every screen starts from. */
  readonly robots: RobotsApi
  /**
   * Closes the realtime channel and stops it from reconnecting. Safe with
   * no subscription ever made, and safe to call twice. A Node script (the
   * exact use case `serverKey` is for) that never calls this after
   * subscribing will not exit on its own — an open WebSocket keeps the
   * event loop alive. `auth.logout()` calls this automatically; call it
   * yourself if the process should exit without logging out (e.g. a
   * server-side shutdown).
   */
  close(): void
}

/**
 * Builds a client for one app. Pass `tokenStore` (or nothing — the default
 * keeps the session in memory) for an app-user client that signs in with
 * `auth.login` or a federated provider; pass `serverKey` for a server-side
 * caller that never holds a user session. Passing both throws, because the
 * two are different identities and a client acts as exactly one.
 *
 * Nothing is fetched here: the realtime channel opens on the first
 * subscription and closes on `close()` or `auth.logout()`.
 */
export function createClient(options: FleetlessClientOptions): FleetlessClient {
  if (options.serverKey !== undefined && options.tokenStore !== undefined) {
    throw new Error(
      'createClient: pass either `tokenStore` (end-user login) or `serverKey` (a server-side caller), not both.',
    )
  }

  const config: FleetlessClientConfig = Object.freeze({
    apiUrl: options.apiUrl,
    appIdentifier: options.appIdentifier,
    realtimeUrl: options.realtimeUrl ?? deriveRealtimeUrl(options.apiUrl),
  })

  // `.bind(globalThis)` is load-bearing, not defensive style. `HttpClient`
  // stores whatever it's given and later calls it detached — `this.#fetch(url,
  // init)` — so the receiver inside `fetch`'s own implementation is the
  // `HttpClient` instance, not `window`. Node's undici does not check its
  // receiver, so a suite that never leaves Node (`Response` objects, an
  // injected server) cannot see this at all. In a real browser every call
  // fails at the first `fetch`: "Failed to execute 'fetch' on 'Window':
  // Illegal invocation" — a browser's `fetch` is a Web IDL method with a
  // brand check on `this`.
  // Only the implicit global default needs this: a caller passing their own
  // `options.fetch` is responsible for handing over something callable
  // standalone (every test double in this SDK's own suite already is).
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis)
  if (!fetchImpl) {
    throw new Error('createClient: no global `fetch` is available in this environment — pass one explicitly.')
  }
  // Cast at the boundary: lib.dom's WebSocket type declares its event
  // handler properties in terms of `Event`/`CloseEvent`, which is stricter
  // than the minimal `WebSocketLike` RealtimeChannel needs (and a test fake
  // implements) — the runtime shapes are compatible, only the declared
  // types are not.
  const webSocketImpl = (options.WebSocket ?? globalThis.WebSocket) as unknown as
    | (new (url: string) => import('./realtime.js').WebSocketLike)
    | undefined

  let auth: AuthApi
  let http: HttpClient
  let credentials: CredentialSource
  if (options.serverKey !== undefined) {
    credentials = new ServerKeyCredentials(options.serverKey)
    http = new HttpClient({ baseUrl: config.apiUrl, fetch: fetchImpl, credentials })
    auth = createServerKeyAuth(http, config.appIdentifier)
  } else {
    const tokenStore = options.tokenStore ?? new InMemoryTokenStore()
    // Built with a placeholder credential source first: SessionCredentials
    // needs this same HttpClient to call /api/client/refresh.
    http = new HttpClient({ baseUrl: config.apiUrl, fetch: fetchImpl, credentials: noCredentials })
    credentials = new SessionCredentials(http, tokenStore)
    http.setCredentials(credentials)
    auth = createSessionAuth(http, tokenStore, config.appIdentifier)
  }

  // Realtime reuses the same credential source (session refresh or server
  // key) for its auth frame — one source of truth for "what token
  // authenticates this client" across both transports.
  const channel = new RealtimeChannel({ url: config.realtimeUrl, WebSocket: webSocketImpl, credentials })
  // One shared subscription layer for the whole client: a slug's wire
  // subscribe/unsubscribe is ref-counted once here, not once per kind of
  // consumer — see slug-subscriptions.ts.
  const slugSubscriptions = createSlugSubscriptions(channel)
  const datapoints = createDatapointsApi(http, channel, slugSubscriptions)
  const commandTransport = createRealtimeCommandTransport(channel)
  const jobSubscriptions = createJobSubscriptions(channel, slugSubscriptions)
  const actions = createActionsApi(commandTransport, jobSubscriptions)
  const services = createServicesApi(commandTransport, jobSubscriptions)
  const publishers = createPublishersApi(commandTransport)
  // REST-only, deliberately: no realtime channel involved (see cameras.ts).
  const cameras = createCamerasApi(http)
  // REST-only too: a robot-wide job read, not addressed by slug (see jobs.ts).
  const jobs = createJobsApi(http)
  const assets = createAssetsApi(http)
  // REST-only, like cameras and jobs: discovery is a read, not a stream.
  const robots = createRobotsApi(http)

  // logout() ends the session; an authenticated socket left streaming after
  // that is not a session anymore, it's a leak. Server-key clients never
  // call logout() (it throws — no session to end), so nothing to wrap there.
  if (options.serverKey === undefined) {
    const baseLogout = auth.logout.bind(auth)
    auth = {
      ...auth,
      async logout() {
        await baseLogout()
        channel.close()
      },
    }
  }

  return {
    config,
    auth,
    datapoints,
    actions,
    services,
    publishers,
    cameras,
    jobs,
    assets,
    robots,
    close() {
      channel.close()
    },
  }
}

/** `https://api.fleetless.dev` -> `wss://api.fleetless.dev/realtime`, etc. */
function deriveRealtimeUrl(apiUrl: string): string {
  const url = new URL(apiUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `${url.pathname.replace(/\/$/, '')}/realtime`
  return url.toString()
}
