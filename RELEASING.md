# Releasing `@fleetless/sdk`

Maintainer notes: the development setup, the checks, and the release
procedure. This file is not part of the published package.

**CI runs on GitHub Actions**, in two files.
`.github/workflows/verify.yml` is the suite, on every push and every pull
request, and the same file a release calls on the commit it is about to
publish; `.github/workflows/release.yml` is the **Release** button — it never
runs on a push — and calls `verify.yml` on that commit, so a release is never
checked by a different pipeline than a push. It is the only publish path this
repository defines.

A pull request from a fork — the only kind an outside contributor can open —
runs `verify` like any other. GitHub holds a first-time contributor's first
run for maintainer approval, which is a button in the checks list, not a
setting to change. That run gets `contents: read` and no secret; there is no
secret in this repository to leak (see
[CONTRIBUTING.md](CONTRIBUTING.md), which tells the contributor the same
thing).

**Every commit here is public the moment it's pushed** —
`verify:commits` and the published-prose sweep enforce that regardless, so
nothing internal goes into a commit or its message.

## Development setup

Node 22 via `nvm`, and pnpm through corepack:

```sh
nvm use 22
corepack enable
pnpm install
```

**That install needs nothing private.** `@fleetless/contracts` — the source
of truth for every wire type this SDK reads or writes — is a devDependency on
the public npm package, pinned to an exact version. It used to be a private
git URL needing group access on a host you would not have; no longer. The published SDK
doesn't care either way: `tsup` inlines contracts' types into `dist/`, so a
consumer of `@fleetless/sdk` never resolves it.

Never redefine a shape the SDK sends to or reads from the API. Import it from
`@fleetless/contracts` instead.

## Checks

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` over the package. |
| `pnpm test` | vitest. Most suites drive a fake `fetch` and a fake WebSocket; the three auth suites drive the SDK's own default `fetch` against a real `node:http` server (`test/local-api.ts`). No cloud needed. |
| `pnpm build` | tsup into `dist/` — ESM, CJS and `.d.ts`. |
| `pnpm run test:pack` | `npm pack`s the tarball, installs it into a bare project with only `typescript`, and typechecks and runs real usage against it — catches a `dist/index.d.ts` still importing `@fleetless/contracts`, a devDependency no consumer of the SDK installs. |

Two further scripts check the built package against a **running** cloud
(`./infra/dev.sh` in the umbrella repo). Both run against `dist/`, not
`src/` — build first — and both fail by name on a missing variable rather
than default quietly.

- `pnpm run verify:live` — a `busy` refusal carrying the already-running job,
  `command_outcome_unknown` and its documented recovery, a `parameter_invalid`
  naming the flat key, job-id-addressed cancel, and per-session camera
  release. Needs `FLEETLESS_API_URL` (or `API`), `APP_IDENTIFIER`, `EMAIL`,
  `PASSWORD`, `ROBOT_ID`, `ACTION_SLUG`, `SERVICE_SLUG`, `CAMERA_SLUG`, and
  two optional identities:
  - `SECOND_EMAIL` — a second, distinct **app user** with the same role.
    Without it the busy check only proves a second request is refused, not a
    different user's.
  - `OBSERVER_EMAIL` — a **third** app user, the one whose password check
    [6] rotates and restores. Left unset, the round trip runs on `EMAIL`
    instead — the identity every other check in the file signs in as — and
    the script says so out loud. `infra/seed-dev.mjs --env` exports all
    three.

  Since 3.0.0 it also drives the client auth API as check [6]: `listProviders`
  without a session, `login`, `me` (kind, app, role, address), `logout`, the
  `changePassword` round trip with its restore, and the reset acknowledgement
  compared byte for byte across a known and an unknown address. It does
  **not** drive anything needing a mailed token — `register`, `verifyEmail`,
  `acceptInvitation`, `confirmPasswordReset` — or the federated and
  MCP-consent flows. Those belong to `infra/browser/app-auth-check.mjs`,
  which reads maildev and drives a real Keycloak.
- `pnpm run verify:history` — a relative range and its absolute equivalent
  returning the same samples, aggregation matching arithmetic done here from
  the raw rows, and the `not_recorded` / `not_aggregatable` refusals. Needs
  `FLEETLESS_API_URL`, `APP_IDENTIFIER`, `EMAIL`, `PASSWORD`, `ROBOT_ID`,
  `RECORDED_NUMERIC_SLUG`, `LIVE_ONLY_SLUG`, and optionally
  `NON_NUMERIC_RECORDED_SLUG`.
(`verify:hosted-login` is gone. The hosted login flow it drove —
`beginHostedLogin` / `completeHostedLogin` and the app OAuth client behind
them — was removed in 3.0.0 along with the script and its `package.json`
entry.)

`infra/seed-dev.mjs --env` in the umbrella repo exports most of those
variables for a freshly seeded world.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/). English, for
code, comments, commit messages and everything else that lands in the
repository.

## Releasing

Every version on npm is published by this repository's **Release** workflow
(GitHub Actions), not by a pushed tag. `npm publish` from a working tree is
refused by a `prepublishOnly` script — a mechanism, not just a rule stated in
prose. (`publish` is unaffected: it publishes the tarball `verify` packed,
and npm runs no prepare lifecycle for a tarball argument.)

1. Actions tab → **release** → **Run workflow**, on `main`. Leave `bump` at
   `auto` unless the Conventional Commits since the last tag undercount the
   change; an override only raises what `auto` would have picked.
2. `prepare` works out the version and, on a plain release, opens (or
   reuses) a release PR that turns `CHANGELOG.md`'s `## [Unreleased]` into
   that version and sets it in `package.json`. The required `verify` check
   passes it and it merges itself — nothing to review or click.
3. The merge commit is tagged, `verify.yml` runs again on it and packs the
   tarball, and `publish` ships exactly that tarball. app-starter is then
   asked to open the pull request that pins the new version.
4. Check the registry yourself. The `publish` job already asserts the first
   line; this is the independent look, and the second line is the one that
   says which dist-tag moved.

   ```sh
   npm view @fleetless/sdk@X.Y.Z version   # answers X.Y.Z
   npm view @fleetless/sdk dist-tags       # latest -> X.Y.Z, or next -> X.Y.Z
   ```

   Name the version. A bare `npm view @fleetless/sdk version` resolves the
   `latest` dist-tag, so after a pre-release publish it answers the *previous*
   stable release and reads as a publish that did not happen.

**`prerelease`**, tickable from any branch: publishes `X.Y.Z-next.N` under the
npm dist-tag `next`, for a branch elsewhere that must pin this change before
it is final. No tag, no release PR, no changelog entry — the version exists
only in the `package.json` of the job that packs it, and only in the tarball
it publishes.

**A run that failed can be started again.** An open release PR is reused
rather than duplicated, a merged release commit is tagged rather than
re-committed, a tag already on `HEAD` continues that same release rather than
starting a new one, and a version npm already lists is never published
twice — npm refuses a version twice, so a retry that reached publish once
cannot republish, only pick up from wherever it stopped.

**A red `publish` job does not mean nothing was published.** `npm publish`
can succeed and the job still die later — most likely inside `npm-wait`
(`release.mjs`), which polls the registry for up to 20 minutes before giving
up, because npm's own metadata lists a version before its tarball is served.
A run that dies there, or before the app-starter dispatch, has already
published. **Run Release again** rather than `npm publish` by hand: `npm-state`
sees npm already has the version, skips `npm publish`, and goes straight to
the wait and the dispatch — nothing is published twice. As long as `main`'s
`HEAD` still carries the tag this release already created, Release continues
that exact release. If `main` moved on in the meantime, a fresh press starts
the *next* version instead, and this one's pin has to be sent by hand:
dispatch app-starter's `sdk-bump.yml` with the version that never got asked
for.

On a timeout, `npm-wait` names what it saw:

> `@fleetless/sdk@X.Y.Z is listed on npm, not served, after 20 minutes`

Before running Release again on that, check `npm view @fleetless/sdk@$VERSION`
by hand — `listed` there already means the publish happened and only the
wait timed out.

**A `publish` job that fails on credentials published nothing**, so running
Release again is safe. There is no token to fix: the job authenticates by
trusted publishing, and the thing that can be wrong is the publisher
configured on npmjs.com. It is bound to this repository *and to the workflow
filename* `release.yml` — rename that file and publishing stops until the
publisher is updated to match. The other way in is `permissions: id-token:
write` going missing from the job, which the first step of `publish` refuses
by name rather than let npm fail deep inside the upload with something less
obvious.

### The one-time setting

**There is no npm token in this repository, and there is not meant to be one.**
`publish` authenticates by **trusted publishing**: the job asks GitHub for a
short-lived OIDC credential and npm checks it against a publisher configured
on npmjs.com. No secret, no `.npmrc`, nothing to rotate or leak.

npm also signs a provenance statement linking the version to this commit and
this run — visible on the package page, checkable with
`npm audit signatures`. **That part has a condition**: npm generates the
attestation only for a public package published over trusted publishing from
a **public repository**. Published from a private one the publish still
succeeds, it just carries no attestation. A missing badge means the
repository was private when that version went out, not that the release
broke.

**Outstanding until a maintainer does it**: the trusted publisher must exist
on npmjs.com for `@fleetless/sdk` before the first real tag. It cannot be
created from here, and a tag pushed before it exists fails in `publish` with
nothing published. Under the package's *Settings > Trusted publisher*, all
five fields:

| field | value |
|---|---|
| organisation | `fleetless` |
| repository | `sdk` |
| workflow filename | `release.yml` |
| environment | **empty** — the job declares none |
| `Allow npm publish` | **ticked** |

Leave `Allow npm publish` unticked and npm permits only `npm stage publish`,
which this workflow does not use. Fill the environment in and the credential
stops matching, because the job asks for none. **None of the five can be
edited afterwards** — a publisher is deleted and created again — so they are
worth reading twice at the keyboard.

Two things that make the setup brittle, both worth knowing before touching
the workflow:

- **The publisher names the workflow *file*, not the workflow.** Renaming
  `release.yml` breaks publishing until the publisher is updated to the new
  name. The comment at the top of that file says so too.
- **It needs a cloud-hosted runner** (`ubuntu-latest`), npm >= 11.5.1 and
  node >= 22.14. Self-hosted runners cannot do trusted publishing at all, so
  neither workflow may move to one. The runner's bundled npm is older than
  11.5.1, which is why `publish` installs npm before publishing.

The job refuses early rather than late in both directions: it fails by name
if the OIDC credential is missing (`permissions: id-token: write` gone), and
again if the artifact from `verify` carries no `DIST_TAG` or no tarball.
