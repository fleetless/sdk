// SPDX-License-Identifier: MIT
import type { AuthError, AuthOk, ClientAuth, ClientIdentity } from '@fleetless/contracts'
import { FleetlessError } from './errors.js'
import type { CredentialSource } from './http.js'

/**
 * The minimal WebSocket surface `RealtimeChannel` needs, so a fake in tests
 * doesn't have to implement the whole browser/Node API.
 */
export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** The `OPEN` value of `WebSocket.readyState`, fixed by the standard rather than configurable here. */
const WS_OPEN = 1

export interface RealtimeChannelOptions {
  url: string
  WebSocket: (new (url: string) => WebSocketLike) | undefined
  credentials: CredentialSource
  /** Backoff before the first reconnect attempt, doubling each time up to `maxBackoffMs`. */
  initialBackoffMs?: number
  maxBackoffMs?: number
}

interface WireFrame {
  type: string
  [key: string]: unknown
}

type FrameHandler = (frame: WireFrame) => void
type Unlisten = () => void

/**
 * One physical WebSocket, shared by every subscription a client makes.
 * Frames route to listeners by their `type` discriminant — `datapoints.subscribe`
 * is the only consumer today, but a future `actions.subscribe`/`presence.subscribe`
 * registers its own frame types on the same channel without any change here.
 *
 * Handles the handshake: connect, send `{type:'auth', token}`, wait for
 * `auth_ok`/`auth_error`. Reconnects with exponential backoff on an
 * unexpected close and re-authenticates before re-announcing readiness —
 * `onReady` listeners fire again after every successful reconnect, which is
 * what makes resubscribe-after-reconnect automatic.
 */
export class RealtimeChannel {
  readonly #options: RealtimeChannelOptions
  #socket: WebSocketLike | null = null
  #opening = false
  #authenticated = false
  #closedByCaller = false
  #backoffAttempt = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #reauthAttempted = false
  #identity: ClientIdentity | null = null
  #connectionEpoch = 0

  readonly #frameListeners = new Map<string, Set<FrameHandler>>()
  readonly #readyListeners = new Set<() => void>()
  readonly #authFailedListeners = new Set<(error: FleetlessError) => void>()

  constructor(options: RealtimeChannelOptions) {
    this.#options = options
  }

  get isReady(): boolean {
    return this.#authenticated
  }

  get identity(): ClientIdentity | null {
    return this.#identity
  }

  /**
   * Increments on every successful authentication (first connect and every
   * reconnect). A command sent on one socket can only be answered on that
   * socket — comparing the epoch at send time against the current one is
   * how a caller (see `commands.ts`) tells "still waiting on the connection
   * it was sent over" from "that connection is gone and a new one has taken
   * its place", the moment it happens rather than after a timeout elapses.
   */
  get connectionEpoch(): number {
    return this.#connectionEpoch
  }

  /**
   * Opens the socket if not already open/opening. Idempotent.
   *
   * `#opening` closes a real race: `#open()` is async and does not assign
   * `#socket` until *after* `await credentials.token()` — so two `connect()`
   * calls issued before that await settles (e.g. a `subscribe()` and a
   * command in the same tick, or two calls in a `Promise.all`) both used to
   * see `#socket` as unset and both proceed, opening two physical sockets.
   * Each socket's own `auth_ok` bumps `connectionEpoch`, so the second
   * socket authenticating made `sendCommand`'s dead-connection watch treat
   * the *first* socket — which was fine, and may already have carried a
   * command — as replaced, failing it `command_outcome_unknown` for a
   * connection that never actually died. The orphaned first socket was also
   * never closed: `close()`/`logout()` only ever reach whichever socket
   * `#socket` currently points to. `#opening` is set as the very first
   * statement inside `#open()` (not here — `#open()` is also called
   * directly from the reconnect timer and the re-auth retry, and both need
   * the same protection against a `connect()` landing in their own async
   * gap), so it is already true by the time any *synchronous* second caller
   * runs, because `void this.#open()` executes an async function's body up
   * to its first `await` immediately, not on a later microtask.
   */
  connect(): void {
    if (this.#socket || this.#reconnectTimer || this.#opening) return
    this.#closedByCaller = false
    void this.#open()
  }

  /**
   * Sends a frame only once the current socket has actually authenticated —
   * otherwise a silent no-op (nothing server-side to address). Checking the
   * socket's own `readyState` in addition to the channel-level
   * `#authenticated` flag is deliberate belt-and-suspenders: `#authenticated`
   * is set by whichever socket's `auth_ok` arrives, so if `#socket` were ever
   * reassigned without a matching reset (the `#opening` race above was one
   * way that could happen), a frame could otherwise be sent into a socket
   * that never authenticated at all.
   */
  send(frame: WireFrame): void {
    if (this.#authenticated && this.#socket?.readyState === WS_OPEN) this.#socket.send(JSON.stringify(frame))
  }

  /** Registers a listener for one frame `type` (e.g. `'datapoint'`, `'subscribe_error'`). */
  on(type: string, handler: FrameHandler): Unlisten {
    let set = this.#frameListeners.get(type)
    if (!set) {
      set = new Set()
      this.#frameListeners.set(type, set)
    }
    set.add(handler)
    return () => set!.delete(handler)
  }

  /**
   * Fires once now if the channel is already authenticated, and again after
   * every future (re)authentication. This is how a subscription (re)sends
   * its `subscribe` frame without special-casing "already connected" itself.
   */
  onReady(fn: () => void): Unlisten {
    this.#readyListeners.add(fn)
    if (this.#authenticated) queueMicrotask(fn)
    return () => this.#readyListeners.delete(fn)
  }

  /** Fires when authentication fails in a way that will not be retried (see `#handleAuthError`). */
  onAuthFailed(fn: (error: FleetlessError) => void): Unlisten {
    this.#authFailedListeners.add(fn)
    return () => this.#authFailedListeners.delete(fn)
  }

  /** Closes the socket and stops reconnecting. */
  close(): void {
    this.#closedByCaller = true
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    this.#authenticated = false
    this.#socket?.close()
    this.#socket = null
  }

  async #open(): Promise<void> {
    // Set before anything else, including before the first `await` below —
    // see `connect()`'s doc comment. Every exit path below clears it.
    this.#opening = true

    const WebSocketCtor = this.#options.WebSocket
    if (!WebSocketCtor) {
      this.#opening = false
      this.#failAuth(new FleetlessError('no_websocket', 'No WebSocket implementation is available in this environment.'))
      return
    }

    let token: string | null
    try {
      token = await this.#options.credentials.token()
    } catch (error) {
      this.#opening = false
      this.#failAuth(error instanceof FleetlessError ? error : new FleetlessError('no_session', 'Could not obtain a credential.'))
      return
    }
    if (!token) {
      this.#opening = false
      this.#failAuth(new FleetlessError('no_session', 'Not authenticated — call auth.login() before subscribing.'))
      return
    }

    const socket = new WebSocketCtor(this.#options.url)
    this.#socket = socket
    this.#opening = false
    this.#authenticated = false

    socket.onopen = () => {
      const authFrame: ClientAuth = { type: 'auth', token }
      socket.send(JSON.stringify(authFrame))
    }
    socket.onmessage = (event) => this.#handleMessage(event.data)
    socket.onclose = () => this.#handleClose()
    socket.onerror = () => {
      // 'close' follows and does the reconnect bookkeeping.
    }
  }

  #handleMessage(raw: string): void {
    let frame: WireFrame
    try {
      frame = JSON.parse(raw) as WireFrame
    } catch {
      return
    }
    if (typeof frame?.type !== 'string') return

    if (frame.type === 'auth_ok') {
      this.#handleAuthOk(frame as unknown as AuthOk)
      return
    }
    if (frame.type === 'auth_error') {
      void this.#handleAuthError(frame as unknown as AuthError)
      return
    }

    this.#frameListeners.get(frame.type)?.forEach((handler) => handler(frame))
  }

  #handleAuthOk(frame: AuthOk): void {
    this.#authenticated = true
    this.#identity = frame.identity
    this.#backoffAttempt = 0
    this.#reauthAttempted = false
    this.#connectionEpoch += 1
    this.#readyListeners.forEach((fn) => fn())
  }

  async #handleAuthError(frame: AuthError): Promise<void> {
    // A `token_expired` auth frame is worth one silent-refresh attempt —
    // the same courtesy REST gets — before giving up; anything else (a
    // rejected/forbidden credential) is not going to change on retry.
    if (frame.code === 'token_expired' && !this.#reauthAttempted) {
      this.#reauthAttempted = true
      try {
        await this.#options.credentials.handleExpired()
        this.#socket?.close()
        this.#socket = null
        void this.#open()
        return
      } catch (refreshError) {
        this.#failAuth(refreshError instanceof FleetlessError ? refreshError : new FleetlessError(frame.code, frame.message))
        return
      }
    }
    this.#failAuth(new FleetlessError(frame.code, frame.message))
  }

  #failAuth(error: FleetlessError): void {
    this.#closedByCaller = true // a bad credential will not fix itself on reconnect
    this.#socket?.close()
    this.#socket = null
    this.#authenticated = false
    this.#authFailedListeners.forEach((fn) => fn(error))
  }

  #handleClose(): void {
    this.#authenticated = false
    this.#socket = null
    if (this.#closedByCaller) return
    this.#scheduleReconnect()
  }

  #scheduleReconnect(): void {
    const initial = this.#options.initialBackoffMs ?? 500
    const max = this.#options.maxBackoffMs ?? 30_000
    const delay = Math.min(initial * 2 ** this.#backoffAttempt, max)
    this.#backoffAttempt += 1
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      void this.#open()
    }, delay)
  }
}
