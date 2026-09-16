# Contributing to `@fleetless/sdk`

This is the TypeScript client for the Fleetless API — the thing a developer's
app calls directly. Change a method here and every app built on it feels it;
change what a method *sends* and the platform feels it too.

## Setup

Node 22 and pnpm (through corepack):

```sh
nvm use 22
corepack enable
pnpm install
```

No private dependencies — `pnpm install` needs nothing but a network
connection to npm. The wire schemas come from `@fleetless/contracts`, a
public package.

`pnpm install` runs `prepare` and builds `dist/`. Some checks below read the
built bundle, so a fresh checkout is already ready for them.

## The checks

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` over the whole project. |
| `pnpm test` | The vitest suite. No network beyond loopback. |
| `pnpm build` | `tsup` into `dist/` — ESM, CJS, and a declaration file for each. |
| `pnpm run test:pack` | Packs the tarball, asserts what is and is not inside it, then installs it into a scratch project and both typechecks and runs real code against it. |

To run one test file, use `pnpm vitest run test/<name>.test.ts`.

## 🔌 The rule this repository is most serious about: a real server, not a mocked `fetch`

**The auth suites drive the SDK's own default `fetch` against a real
`node:http` server** (`test/local-api.ts`) — no `fetch` option passed to
`createClient`.

Not ceremony. A suite that supplies its own `fetch` never touches the code
that ships: `client.ts` resolves `globalThis.fetch.bind(globalThis)`, so "what
the SDK sends" becomes "what a `vi.fn()` agreed to pretend to send." This
package's two most expensive defects were both invisible to a mocked `fetch`
and both obvious to a socket:

- `createClient` defaulted to a **detached** `globalThis.fetch`. A real
  browser's `fetch` is a Web IDL method and throws "Illegal invocation"
  unless the receiver is the global object; Node's undici doesn't check.
  Every test passed, every browser failed on the first call.
- `../../../admin` reached a real server as a traversal — the encoding was
  asserted against a double that never parsed the URL.

**If your change touches what leaves the process, test it against
`test/local-api.ts`.** A double is fine for branching, refcounting, timers,
error mapping — most of the suite uses one for exactly that.

`test/client.test.ts` names a test for this property on its own, so removing
it shows up in a diff instead of in production.

## Licence headers

Every source file's first line is the SPDX header
`// SPDX-License-Identifier: MIT` — only a `#!` shebang may sit above it.
`test/license-headers.test.ts` checks the whole set, sourced from
`git ls-files` rather than a list of directories, so a new file is swept the
day it's added.

## 📦 Nothing internal reaches the published bytes

`tsup` bundles `@fleetless/contracts` **into** `dist/index.js` and
`dist/index.cjs` — doc comments and all — and writes the source path of each
inlined module as a comment beside it. A comment meant for the people who
build this is therefore a comment an editor shows to whoever installed it.
Four published versions did exactly that: German paragraphs, internal defect
ids, an internal hostname — none of it in this repository's source.

Write a comment for what the code does for a caller, not for how the
behaviour was found, on which machine, under which ticket, or in which
language the team happened to be thinking that day.

`test/published-prose.test.ts` checks `dist/`, `src/`, `test/`, `scripts/`
and the shipped markdown, and names which class of thing came back and on
which line.

## Pull requests

**The public repository is not open yet.** It will be — this section
describes how it works once it is. Until then, send patches and questions to
<hello@fleetless.dev>. Either way: raise anything that changes an existing
method signature or what a method sends *before* you write it, so we can
tell you what else has to move with it.

**CI runs on GitHub Actions**, in this repository
(`.github/workflows/verify.yml`) — the suite, on every push and every pull
request. `release.yml` publishes on a release tag and calls that same file
first, so a release is never checked by a different pipeline than a push.

**Your pull request is verified, a fork's included** — the same suite, the
same file. GitHub holds a first-time contributor's first run until a
maintainer approves it, so the checks can sit idle for a while before they
start; that is the queue, not a failure. The run reads the code and nothing
else: it is granted `contents: read`, no secret is available to it, and
publishing lives in a workflow a pull request cannot trigger. Running
`pnpm typecheck && pnpm test && pnpm run test:pack` yourself first still
saves you a round trip — it is everything `verify` will tell you.

## The CLA

Your first pull request will ask you to sign a Contributor Licence Agreement.
It grants Dehne Robotik GmbH the right to license your contribution under
terms other than MIT later — that's the whole point, and why the project can
relicense without hunting down every past contributor. It doesn't take your
copyright, and it doesn't stop you from using your own contribution however
you like.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `refactor:`, `test:`. Changing an
existing method's signature or what it sends is breaking — mark it with a
`!` and a `BREAKING CHANGE:` footer, since that's what decides the next
version number.

Everything here is written in **English** — code, comments, commit messages,
documentation.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Releasing (maintainers)

See RELEASING.md in the repository — it is not part of the published
package. The `release` workflow publishes; `npm publish` from a working tree
is not how a version gets to the registry.
