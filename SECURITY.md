# Security policy

## Reporting a vulnerability

Email **security@fleetless.dev**. Please do not open a public GitHub issue for
a security report.

Include what you found, the SDK version and runtime it happens on (a browser
name and version, or a Node version), and the smallest sequence of SDK calls
that shows it. A reproduction against a published version of this package is
the most useful thing you can send.

We acknowledge every report within **3 working days** and follow up with
either a fix or a written plan within **30 days**. If a report leads to a
released fix, we credit you by name unless you ask us not to.

## What is in scope

This repository is the TypeScript SDK that client applications use to talk to
Fleetless. It runs **in your users' browsers and on your servers**, and it
holds credentials while it does. That is its security surface.

Specifically in scope:

### Tokens

The SDK receives an access token and a refresh token from the platform and
hands them to a `TokenStore` that **you** implement; the built-in default keeps
them in memory only and writes them nowhere. A report is in scope if the SDK:

- puts a token somewhere the caller did not ask for it to go — a global, a
  URL, a query string, a log line, an error message, or a thrown object's
  properties;
- sends a token to an origin other than the `apiUrl` the client was
  constructed with;
- attaches a token to a request it should not have (the SDK refuses an
  absolute URL it did not build — see `untrusted_absolute_url`);
- keeps a token reachable after `logout()`, or fails to clear the store;
- races its own silent refresh in a way that lets a stale or a foreign token
  be used.

Where you persist tokens — `localStorage`, a cookie, a native keystore — is
your decision and your risk. A defect in how the SDK *hands* them to your
store is ours.

### PKCE and `state` in the federated sign-in flow

`beginOidcLogin` generates a PKCE verifier and a `state` value and hands them
back to you: a redirect is a fresh page load, and the SDK has nowhere of its
own to keep them. `completeOidcLogin` checks `state` before it exchanges
anything.

In scope: a verifier or a `state` with insufficient entropy or a predictable
source; S256 not being enforced; `completeOidcLogin` exchanging a code when
`state` does not match, is missing, or when `expectedState` is empty — that
last case is checked first and explicitly, because two empty strings compare
equal; any path that reaches the token exchange without the check.

**Where you store the verifier and the `state` between the two calls is your
application's decision**, and this policy cannot cover it. The README shows
`sessionStorage`, a reasonable default and not the only correct one.

### The rest of the package

- Request construction: path segments are percent-encoded (`pathSegment`), so
  a slug or an identifier shaped like `../../../admin` must not escape its
  position in the URL.
- The realtime channel: its authentication, its reconnection, and what it
  resends after one.
- `prepareUrdfScene` and `createMeshLoader`: a robot's own URDF names the URLs
  three.js is asked to fetch, so a reference the SDK does not own must not
  become a network request from your users' browsers.
- Anything the SDK writes into browser-reachable state.
- The published npm package `@fleetless/sdk` and its contents, including a
  dependency of it.

## What is not in scope

**The Fleetless cloud is not in this repository.** A server that fails to
enforce a permission, an authentication or authorisation flaw in the platform,
a rate limit, a data leak from an API endpoint, anything about how a token is
minted or validated — none of that lives here, and none of it can be fixed by
a change to this package. Report it to the same address, say which service you
were looking at, and we will route it. We will not treat this repository's
issue tracker as the place where it is tracked.

Also out of scope here: the Fleetless console, the robot-side bridge, the
`@fleetless/contracts` schemas (they have their own repository and their own
policy), the documentation site, and any deployment of Fleetless operated by
someone else.

Out of scope in your own application: where you store tokens, how you protect
your own pages, and any XSS in your app — an attacker who can run script in
your page can read anything your page can, and no SDK design prevents that.

## Supported versions

The latest published minor of `@fleetless/sdk` receives fixes. Older minors do
not; a security fix is released as a new patch on the current minor, and
upgrading is the remedy.
