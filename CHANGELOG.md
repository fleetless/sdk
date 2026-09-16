# Changelog

All notable changes to `@fleetless/sdk`. The format follows Keep a Changelog; the versions follow semver.

## [Unreleased]

## [3.0.3] — 2026-09-16

- Published from GitHub Actions by npm trusted publishing: no publish token exists anywhere, and every version from this one on carries a provenance attestation linking it to the commit and the run that built it. `npm audit signatures` checks it.

- **The README is a lobby now, not the reference.** What Fleetless is, what this package does, one snippet, and links into docs.fleetless.dev; the seven walkthroughs it carried are the SDK reference's job. The four doc comments and the one runtime error message that sent a developer to a README section point at the SDK reference instead, and the test that resolved those pointers now refuses any new one.
- `RELEASING.md` no longer ships in the package; the published `CONTRIBUTING.md` points at it without a link.
- The prose guard treats a path into the company-site repository the way it treats every other sibling repository's path.

## [3.0.2] — 2026-09-07

No API change, and one documentation example that now compiles. The guard
that was supposed to prove 3.0.1 clean was **green over four internal
references still inside the published bundle**, so it was rebuilt around the
question rather than around three directory names.

### Fixed

- **Four internal references in the published 3.0.1 bundle**, which the guard
  could not see: an internal decision label in `dist/index.js` and
  `dist/index.cjs`, and a sentence in both about how a defect class had been
  found. Measured against the registry rather than against this tree — 3.0.1
  scores 4, 3.0.2 scores 0, and 3.0.0 scores 423.
- **The README's error-handling example did not compile.** `details` is
  `unknown` on `FleetlessError`, deliberately, and the block read fields off
  it directly — two `TS2339`s in a TypeScript SDK's own README, in the block a
  reader copies first. It now narrows before reading, and it is opted in to
  the documentation type check so it cannot drift again.
- **`Node 20 or newer` was listed as a runtime for the whole SDK.** Node 20
  has no global `WebSocket` — it is behind a flag there — so anything realtime
  fails on it with the SDK's own `no_websocket`. The README names Node 22, and
  says what to pass on Node 20 instead.
- **Everything published pointed at a public repository that does not exist
  yet.** `repository`, `bugs.url`, the README, `CONTRIBUTING.md` and
  `RELEASING.md` all named it, and its four relative links resolved to 404s on
  the npm page. They point at the maintainer address until the repository is
  opened.
- **`CONTRIBUTING.md` linked `RELEASING.md`, which the tarball did not
  carry.** `RELEASING.md` ships now, and every relative link in every shipped
  document is checked against the tarball's own entries.
- **Each published file declares exactly one licence.** The bundler inlines
  `@fleetless/contracts`, which is Apache-2.0, and the declaration files
  carried six of its SPDX identifiers below this package's MIT one. A licence
  scan over `node_modules` reported Apache obligations for a package that
  ships no Apache text. The inherited identifiers are stripped at build time.
- **A CI comment sent whoever was reading a red publish job to a README
  section that does not exist**, and `RELEASING.md` told a maintainer the
  suite runs against a fake `fetch` — which `CONTRIBUTING.md` devotes a
  section to denying, and which is untrue of three of the nineteen suites.

### Changed

- **The guard scans what becomes public, computed rather than named.** The
  union of what `npm pack` reports, what `git ls-files` reports and a walk of
  every directory in `files`. Ten tracked files were outside the previous
  shape, two of them published bytes; one of those two had already carried an
  internal host to the registry inside `devDependencies`.
- **Only the German scan strips anything**, and only URLs and single-token
  code spans. Stripping links and backticks before every class made the six
  shipped documents blind to an internal hostname inside a markdown link.
- **Eighteen detectors, each carrying its own two fixtures**, with a floor
  over the count. Seven of the previous fifteen had no fixture proving they
  could fire, and two could be deleted with the whole suite green.
- **The tarball guard asserts absence as well as presence**: nothing outside
  `files`, no sourcemaps, no source. It reads every dependency section rather
  than the runtime one alone, and runs the marker detectors over the packed
  manifest.

### Added

- **`test/readme-pointers.test.ts`**: every pointer from the code into the
  README resolves to a heading that is there. That was the defect 3.0.1 fixed
  and left unguarded, one of them inside a runtime error message.
- **`scripts/verify-commit-messages.mjs`**, wired into the verify job. A
  commit message is public the moment it is pushed.

## [3.0.1] — 2026-09-07

No API change. This release exists because **3.0.0 published internal material
to the registry**, and the only way to withdraw it is to publish a version
without it.

### Fixed

- **The published bundle no longer carries internal text.** `tsup` inlines
  `@fleetless/contracts` into `dist/index.js` and `dist/index.cjs` with its doc
  comments intact, and it writes the path each inlined module came from as a
  comment beside it. In 3.0.0 those paths encoded a `git+ssh://` dependency
  specifier, so an internal hostname appeared **48 times** across the two
  bundles; the inlined comments carried German paragraphs and internal defect
  ids with them.

  The table this entry first carried cited "the same seventeen detectors",
  while the entry below it said the guard had fifteen classes and the guard
  itself asserted fifteen. No seventeen-detector artefact ever existed, so
  the numbers could not be reproduced from anything shipped. They are
  replaced here by a measurement of the two **published tarballs** with the
  guard as rebuilt in 3.0.2, which is a thing a reader can run:

  | class | 3.0.0 | 3.0.1 |
  |---|---:|---:|
  | terse schedule label | 134 | 0 |
  | German prose | 58 | 0 |
  | internal host or workspace name | 49 | 0 |
  | internal decision label | 44 | **2** |
  | a reference to this package rather than the reader's | 30 | 0 |
  | internal review codename | 28 | 0 |
  | a reference to a document the reader does not have | 26 | 0 |
  | longer schedule label | 16 | 0 |
  | how the behaviour was found | 16 | **2** |
  | internal defect id | 14 | 0 |
  | internal feature id | 4 | 0 |
  | the reference robot by name | 4 | 0 |
  | **total** | **423** | **4** |

  The four remaining in 3.0.1 are the subject of 3.0.2 below. They are here
  rather than in that entry because this is the entry that claimed zero.

  None of it appeared in this repository's own source, which is why no sweep of
  the source had found it. The fix is the contracts pin — `@fleetless/contracts`
  is a public npm package at an exact version now — plus a sweep of this
  repository's own comments.

- **`publishers.publish`, `commands.cancel`, `cameras.live` and the error
  re-exports pointed at README sections that did not exist.** One of them
  (`cancel`'s upgrade message) is a **runtime error** telling a developer to
  read "the README's Actions section" of a README whose sections were named
  something else. The README now has *Actions*, *Errors*, and *Publishers, and
  no teleop helpers*, and every pointer resolves.

### Added

- **`SECURITY.md`, `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`**, and all three
  ship inside the tarball, so the README's links resolve from `node_modules` and
  from the npm page. `SECURITY.md` says what is in scope here — how this package
  handles tokens, the PKCE verifier and the `state` value — and that the cloud
  is not in this repository. Security reports go to **security@fleetless.dev**,
  which the README now states literally rather than only by link.
- **`repository` and `bugs.url`** in `package.json`, pointing at
  <https://github.com/fleetless/sdk>.
- **An `Errors` section in the README**, documenting the `FleetlessError` `code`
  you branch on, that `rate_limited` is surfaced with its `retry_after_ms` and
  never retried, and that `token_expired` is the one retry the SDK performs.
- **The SPDX header `// SPDX-License-Identifier: MIT`** on every source file and
  on all four published `dist/` files. `test/license-headers.test.ts` asserts it
  over the repository; `pnpm run test:pack` asserts it over the tarball's own
  bytes, which is the only place that can tell a stamped build from a stamped
  publish.
- **`test/published-prose.test.ts`**, which is what stops the top item here from
  happening again: fifteen detector classes over `dist/`, `src/`, `test/`,
  `scripts/` and the shipped markdown, with fixtures in both directions.

## [3.0.0] — 2026-09-06

Fleetless shows an app user **no page**. The developer's own UI owns every
screen — login, registration, verification, invitation acceptance, password
reset, the provider buttons, the MCP consent — and this release replaces the
SDK's auth surface with the JSON API those screens call. The hosted,
app-branded login and consent pages are gone from the platform, so they are
gone from here.

### Removed

- **`auth.beginHostedLogin` and `auth.completeHostedLogin`**, with
  `BeginHostedLoginOptions`, `HostedLoginRequest` and
  `CompleteHostedLoginOptions`. The `/oauth/authorize` + `/oauth/token` flow
  they drove no longer runs for app users. Use `auth.beginOidcLogin` and
  `auth.completeOidcLogin` for federated sign-in, or `auth.login` for a
  password.
- **`client.grants`** (`GrantsApi`, `grants.list`, `grants.revoke`), with the
  `ConsentGrantSummary` and `ConsentRevokeResponse` re-exports. The routes
  behind it are gone. The MCP consents an app user can withdraw are now
  `auth.listMcpGrants()` and `auth.revokeMcpGrant(clientId)`.
- **`auth.passwordResetUrl()`**. It pointed at a Fleetless-served page that is
  now the developer console's own, for Fleetless users rather than app users.
  An app user's reset is `auth.requestPasswordReset` and
  `auth.confirmPasswordReset`, in your own UI.
- **`LogoutResult`**, and with it everything `logout()` used to report about
  the identity provider behind a session. That apparatus belonged to the
  hosted login, where Fleetless owned the browser; an app that wants to end a
  provider session redirects there itself, knowing its own provider.
- **`no_hosted_login_attempt`** from `SDK_ERROR_CODES`. The case it named —
  nothing persisted for this attempt — still throws, as `state_mismatch`, and
  the message still says which of the two happened.
- `HttpClient.requestOAuth`, the SDK's only form-urlencoded call. Nothing
  reaches `/oauth/token` from here any more.

### Added

- **Registration and verification**: `auth.register({ email, password,
  displayName? })`, `auth.verifyEmail(token)`,
  `auth.resendVerification(email)`.
- **Recovery and invitations**: `auth.requestPasswordReset(email)`,
  `auth.confirmPasswordReset(token, newPassword)`,
  `auth.acceptInvitation({ token, password, displayName? })`. Every one of
  these that spends a mailed token stores the session it answers with, so a
  person is not asked to sign in again immediately after proving they can read
  the mail.
- **Federated sign-in, per app**: `auth.listProviders()` for the buttons,
  `auth.beginOidcLogin({ slug, redirectUri })` to build the start URL with
  PKCE, `auth.completeOidcLogin({ code, state, expectedState, codeVerifier })`
  to trade the one-time code for a session, and
  `auth.oidcErrorFromCallback(params)` to read a failed sign-in off the
  redirect back as a `FleetlessError`. The SDK builds the URL and **never
  navigates**; the app does.
- **The MCP consent screen**: `auth.mcpInteraction(id)`,
  `auth.approveMcpInteraction(id)`, `auth.denyMcpInteraction(id)`. Both
  decisions answer where to send the browser, a denial included.
- **The app user's own standing consents**: `auth.listMcpGrants()` and
  `auth.revokeMcpGrant(clientId)`.
- New option and result types: `RegisterOptions`, `AcceptInvitationOptions`,
  `ProviderButton`, `BeginOidcLoginOptions`, `OidcLoginRequest`,
  `CompleteOidcLoginOptions`, `McpInteractionDecision`. New wire re-exports:
  `ClientMcpInteraction`, `McpConsentGrant`, `ClientOidcErrorCode`.

### Changed

- **`ClientIdentity` renamed two fields**: `kind: 'end_user'` is now
  `'app_user'`, and `end_user_id` is now `app_user_id`. A rename rather than a
  kept key, deliberately — the old subject was a member of the org's one pool,
  the new one is a row belonging to exactly one app, and a consumer reading
  `.end_user_id` would have typechecked while meaning something subtly
  different.
- **`logout()` resolves with `void`**, not a `LogoutResult`. It still never
  rejects and still always clears the local store.
- **A `serverKey` client refuses session methods with a `FleetlessError` whose
  code is `invalid_option`**, where it used to throw a bare `Error` a caller
  could only catch by message. `me()`, `listProviders()`, `mcpInteraction()`
  and `oidcErrorFromCallback()` still work on one: the first is what a server
  key is for, the next two are reads the cloud answers without a credential,
  and the last touches no network.
- `state_mismatch` is now thrown by `completeOidcLogin`, before any request.
- Pinned to `@fleetless/contracts` `48acd56`.

### Verification

- The `auth` and OIDC suites now drive the SDK's **default** `fetch` against a
  real `node:http` server (`test/local-api.ts`) rather than a `vi.fn()`. Every
  assertion about a path, a method, a header or a body is made against bytes
  that actually left the process — which is what shows, for instance, that the
  two MCP decisions send no `content-type` on their bodyless `POST`, a header
  a fake `fetch` records as absent exactly as convincingly when it is wrong.

## [2.1.0] — 2026-09-04

### Added

- `InvokeOptions` is exported — the type of `actions.invoke`'s options
  argument, which a caller constructs and could not name.

### Changed

- Every exported member carries a doc comment; the generated SDK reference
  on docs.fleetless.dev is rendered from them.
- `InMemoryTokenStore` declares an explicit empty `constructor()`. It exists
  only to carry a doc comment: TypeDoc reflects a synthesized constructor
  for a class without one, and an undocumented member is what the reference
  is built to have none of. Behaviour is unchanged — the class had an
  implicit no-argument constructor before and has an explicit one now.

## [2.0.2] — 2026-09-04

No code change; the published `dist/` is byte-identical to 2.0.0.

### Changed

- The README's getting-started section speaks of the hosted platform only;
  the paragraph about pointing `apiUrl` at a local stack is gone. Fleetless
  is not offered for self-hosting.

## [2.0.1] — 2026-09-04

No code change; the published `dist/` is byte-identical to 2.0.0.

### Changed

- The contact address in the README and in `package.json` (`author`,
  `bugs`) is hello@fleetless.dev.
- The README's closing section states that the source repository is private
  and takes no outside contributions; the `CONTRIBUTING.md` it linked to is
  gone.

## [2.0.0] — 2026-09-04

The first release since 1.0.0, and it is a breaking one. The entries below are
the **complete** difference in the published surface, established by unpacking
`@fleetless/sdk@1.0.0` from npm and diffing its bundled `dist/index.d.ts`
against this tree's, declaration by declaration — not read off the commit log.
Everything not named here is byte-identical between the two builds.

### Removed

- **`client.auth.register(email, password)` and
  `client.auth.confirmRegistration(token)`.** Self-registration through the SDK
  is gone, with no successor. The org-central identity redesign removed per-app
  user pools: users belong to one pool per organisation and a group grows by
  invitation (or, once the federation work lands, by OIDC just-in-time
  provisioning). There is no client-side sign-up call any more, and the routes
  behind both methods no longer exist.
- **`client.auth.requestPasswordReset(email)` and
  `client.auth.confirmPasswordReset(token, newPassword)`.** Same reason: the
  routes are gone. Link the user to the platform's hosted reset page instead —
  `client.auth.passwordResetUrl()` builds the URL, and nothing about it is a
  network call.
- **The exported types `MailStatus` and `ClientRegisterResponse`**, which
  described `register()`'s result and went with it.
- **The error code `not_a_member`**, from `FleetlessErrorCode` and from
  `ERROR_CODES`. No route emits it any more. Removing a member of a
  string-literal union is a *compile-time* break for an exhaustive `switch` on
  `error.code` and for any `error.code === 'not_a_member'` comparison.

### Changed

- **`CameraDescriptor.snapshot_interval_ms` is now
  `CameraDescriptor.snapshot_interval_seconds`.** This is a rename **and a unit
  change**: the value is now seconds, so it is a thousand times smaller than
  the field it replaces. Following the compile error by renaming the property
  and nothing else silently gives you the wrong number — divide by 1000 as
  well, or read the field as the seconds it now is.
- **`UrdfCompleteness.missing` is no longer `string[]`.** It is now
  `{ uri: string; element: 'mesh' | 'texture' }[]`, so a caller can tell a
  missing mesh from a missing texture instead of reporting every gap as a
  mesh. `UrdfSceneResources.missing` (returned by `assets.prepareUrdfScene`)
  carries the same change; it is now typed as `UrdfCompleteness['missing']`.
  If you only want the URIs: `missing.map((m) => m.uri)`.
- **`client.auth.logout()` returns `LogoutResult`** rather than an inline
  `{ revoked: boolean }`. Additive in practice — `.revoked` is unchanged — but
  the result now also carries `idp_logout`, five separable facts about the
  session at the identity provider: `redirect` (with the URL to send the
  browser to), `not_federated`, `unsupported_by_idp`, `hint_unavailable`,
  `session_unknown`, or `null` when there was no response to report. Only
  `not_federated` means the user is fully signed out. The type is exported, so
  it can be named.
- Types and bundled contract values follow the platform's contracts at the
  release's pin.

### Added

- **`client.grants`**, an end user's own record of the OAuth clients they have
  authorized: `list()` returns `ConsentGrantSummary[]`, `revoke(clientId)`
  returns `ConsentRevokeResponse` and takes one grant back without touching the
  others. `GrantsApi`, `ConsentGrantSummary` and `ConsentRevokeResponse` are
  exported.
- **`client.auth.passwordResetUrl(): string`** — the hosted password-reset page
  for every user of the platform, served by the cloud. A pure string builder,
  no request; it is what replaces the two removed reset methods.
- **`client.assets.syncStatus(robotId, syncId)`** — the state of one asset sync
  run: how far it has got, and what it could not resolve or upload.
- **`AssetListResponse.active_sync`** — the sync currently running for the
  robot, or `null`. Nullable, and always present.
- **`ClientIdentity.act`** (optional) — `{ admin_user_id: string }`, the admin
  actually driving when the session is an impersonation. Absent on an ordinary
  session, which is not the same fact as an unknown actor.
- **`LogoutResult`** — exported; see `logout()` above.
- **Eight error codes** in `FleetlessErrorCode` / `ERROR_CODES`:
  `unknown_slug`, `capability_required`, `last_owner`, `group_not_deletable`,
  `group_in_use`, `target_state_conflict`, `mcp_access_denied`,
  `signup_closed`.
- **Licence (MIT) and package metadata.** The tarball now carries `LICENSE`
  and `CHANGELOG.md`, and the manifest an SPDX id, author, homepage, bugs
  address and keywords. Every version from this one on is published by the
  repository's own pipeline from a release tag; `npm publish` by hand is
  retired.

### Fixed

- **A CommonJS consumer can type the package.** The `exports` map offered
  `require` a JavaScript entry point but only ever an ESM `.d.ts` beside it,
  so under `node16`/`nodenext` resolution TypeScript refused the require with
  `TS1479` — the runtime worked, the types did not. Each condition now carries
  its own declarations (`dist/index.d.ts` for `import`, `dist/index.d.cts` for
  `require`), and `pnpm test:pack` typechecks both against the packed tarball.
  Present in 1.0.0.

## [1.0.0] — 2026-08-18

First published version.
