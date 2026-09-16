// SPDX-License-Identifier: MIT
/**
 * PKCE (RFC 7636) and OAuth `state` generation for `auth.beginOidcLogin` — the
 * app's **own** exchange against Fleetless, independent of the exchange
 * Fleetless runs against the identity provider. That is why the one-time code
 * in the redirect back is worthless to anyone who reads that URL without also
 * holding the verifier.
 *
 * Pure — no network access, no storage. Kept apart from `auth.ts`: no HTTP,
 * no token storage, and testable without a fake `fetch`.
 *
 * Uses the platform's Web Crypto API (`globalThis.crypto`), available on
 * every target this SDK already supports (Node 20+, every browser) without a
 * dependency — same reasoning `client.ts` applies to `fetch`/`WebSocket`: no
 * polyfill, but a clear refusal if the environment genuinely lacks it, rather
 * than a cryptic failure downstream.
 */

function requireCrypto(): Crypto {
  const c = globalThis.crypto
  if (!c?.subtle) {
    throw new Error(
      'auth.beginOidcLogin needs the Web Crypto API (globalThis.crypto.subtle), which is not available in this environment.',
    )
  }
  return c
}

/**
 * Bytes -> base64url, no padding. Via `btoa`, not a hand-rolled bit-shifting
 * encoder — `btoa` has been a standard global since Node 16, safely inside
 * the Node 20+ floor `globalThis.crypto` above already sets for this file (a
 * second, lower version number here would just be a misleading claim about
 * what this file needs), and reusing it is less risk than re-deriving base64
 * arithmetic for a security-sensitive value.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  requireCrypto().getRandomValues(bytes)
  return toBase64Url(bytes)
}

/**
 * RFC 7636 section 4.1: a high-entropy cryptographic random string using the
 * unreserved character set, 43-128 characters. 32 random octets, base64url
 * encoded, is 43 characters and satisfies `clientOidcExchangeRequest`'s
 * `code_verifier` regex (`@fleetless/contracts`, `client-auth.ts`) exactly —
 * the base64url alphabet (`A-Za-z0-9-_`) is a subset of what the RFC allows.
 */
export function generateCodeVerifier(): string {
  return randomBase64Url(32)
}

/**
 * No format is mandated for `state` (RFC 6749 section 10.12) beyond being
 * unguessable — same construction as the verifier, for the same entropy. 43
 * characters also sits inside `clientOidcStartQuery`'s 8..512 bound.
 */
export function generateState(): string {
  return randomBase64Url(32)
}

/**
 * RFC 7636 section 4.2 — S256 only. The contracts' `codeChallengeMethod`
 * offers no `plain`: a challenge equal to its verifier defends against
 * nothing, and OAuth 2.1 does not make it negotiable.
 */
export async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await requireCrypto().subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  return toBase64Url(new Uint8Array(digest))
}
