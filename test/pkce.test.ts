// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import { clientOidcExchangeRequest, clientOidcStartQuery } from '@fleetless/contracts'
import { computeCodeChallenge, generateCodeVerifier, generateState } from '../src/pkce.js'

// **The schema itself, not a copy of its regex.**
//
// This file used to hold `/^[A-Za-z0-9\-._~]{43,128}$/` with a comment
// claiming it was `oauthTokenRequest`'s. Two things were wrong. The route is
// gone from this SDK's world — since 3.0.0 a verifier travels only to
// `POST /api/client/oidc/exchange`, so `clientOidcExchangeRequest` is what
// actually accepts or refuses it. And a copied regex can only ever catch the
// generator moving — the claimed "fails if the SDK drifts from what the wire
// accepts" was structurally unreachable, since the copy moves with whoever
// edits this file, never with contracts.
//
// Parsing through the real schema closes both. A contracts change that
// narrows `code_verifier` fails here on the next `pnpm install`, with no edit
// to this file.
const parseVerifier = (verifier: string) => clientOidcExchangeRequest.safeParse({ code: 'c', code_verifier: verifier })

describe('generateCodeVerifier', () => {
  it('produces a value clientOidcExchangeRequest accepts (RFC 7636 §4.1)', () => {
    const verifier = generateCodeVerifier()
    expect(parseVerifier(verifier).success).toBe(true)
    expect(verifier.length).toBe(43)
  })

  // The control: the schema is what is deciding, and it does decide. Without
  // this, a schema that had lost its `regex` would leave the assertion above
  // green for every string in the world.
  it('and the schema it is checked against actually refuses a bad verifier', () => {
    expect(parseVerifier('too-short').success).toBe(false)
    expect(parseVerifier(`${'a'.repeat(42)}+`).success).toBe(false)
    expect(parseVerifier('a'.repeat(129)).success).toBe(false)
  })

  it('is different every call', () => {
    const a = generateCodeVerifier()
    const b = generateCodeVerifier()
    expect(a).not.toBe(b)
  })
})

describe('generateState', () => {
  it('is a non-empty, URL-safe string, different every call', () => {
    const a = generateState()
    const b = generateState()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(0)
    // Must survive being placed in a URL query string unescaped and read
    // back — base64url guarantees this; a padded/standard-base64 encoder
    // would leak `+`, `/` or `=` here instead.
    expect(a).toMatch(/^[A-Za-z0-9\-_]+$/)
  })
})

describe('computeCodeChallenge', () => {
  it('produces a challenge clientOidcStartQuery accepts', async () => {
    const challenge = await computeCodeChallenge(generateCodeVerifier())
    const parsed = clientOidcStartQuery.safeParse({
      app_identifier: 'app_x',
      slug: 'okta',
      redirect_uri: 'https://app.example.com/cb',
      state: generateState(),
      code_challenge: challenge,
    })
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('is deterministic for the same verifier', async () => {
    const verifier = generateCodeVerifier()
    const a = await computeCodeChallenge(verifier)
    const b = await computeCodeChallenge(verifier)
    expect(a).toBe(b)
  })

  it('differs for different verifiers', async () => {
    const a = await computeCodeChallenge(generateCodeVerifier())
    const b = await computeCodeChallenge(generateCodeVerifier())
    expect(a).not.toBe(b)
  })

  it('matches the known RFC 7636 Appendix B test vector', async () => {
    // RFC 7636 Appendix B's worked example: this exact verifier must
    // produce this exact challenge. Verifies the SHA-256 + base64url
    // pipeline against a value neither generated nor checked by this SDK —
    // a fixture that can't share a bug with the code it tests.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const challenge = await computeCodeChallenge(verifier)
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('is not the plain verifier — S256 must actually hash, not pass through', async () => {
    const verifier = generateCodeVerifier()
    const challenge = await computeCodeChallenge(verifier)
    expect(challenge).not.toBe(verifier)
  })
})
