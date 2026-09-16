// SPDX-License-Identifier: MIT
import type { SessionTokens } from '@fleetless/contracts'

/**
 * What is kept between calls to stay logged in: exactly the wire shape
 * `sessionTokens` returns, no derived fields. Refresh is reactive (a call
 * that meets an expired access token refreshes and retries) rather than
 * proactive, so there is no `expires_at` to compute or drift out of sync.
 */
export type StoredSession = SessionTokens

/**
 * Where the SDK keeps a session. A developer implements this to persist a
 * login (localStorage, a cookie, a native keystore) — the SDK itself never
 * assumes a browser, or any storage, exists.
 */
export interface TokenStore {
  /**
   * Returns the stored session, or `null` when nobody is logged in. May be
   * async, so a store backed by a native keystore or an IndexedDB read
   * works without a synchronous cache in front of it.
   */
  load(): StoredSession | null | Promise<StoredSession | null>
  /**
   * Writes the session, or clears it when passed `null`. Called after a
   * login, after every silent refresh, and on logout — so an implementation
   * that persists must expect to be called often, not once.
   */
  save(session: StoredSession | null): void | Promise<void>
}

/** The default store: works out of the box, forgets the session on reload. */
export class InMemoryTokenStore implements TokenStore {
  #session: StoredSession | null = null

  /** Nothing is loaded from anywhere — a client built with it starts logged out. */
  constructor() {}

  /** Returns the session held in memory, or `null` if there is none. */
  load(): StoredSession | null {
    return this.#session
  }

  /** Replaces the session held in memory; `null` clears it. */
  save(session: StoredSession | null): void {
    this.#session = session
  }
}
