# @fleetless/sdk

[![npm version](https://img.shields.io/npm/v/@fleetless/sdk)](https://www.npmjs.com/package/@fleetless/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@fleetless/sdk)](https://www.npmjs.com/package/@fleetless/sdk)
[![license MIT](https://img.shields.io/npm/l/@fleetless/sdk)](LICENSE)
[![node >=20](https://img.shields.io/node/v/@fleetless/sdk)](https://nodejs.org)

**Your robot, as an API. This is the client.**

[Fleetless](https://fleetless.dev) turns a ROS 2 robot into a hosted REST and
realtime API. The robot runs the Fleetless Bridge, and in the
[Fleetless Console](https://console.fleetless.dev) a developer picks which
topics, services, actions, publishers and cameras it exposes, each under a
stable slug and behind a role. Your app talks to those slugs over HTTPS and
never learns a ROS name, a topic type or a message definition.

This package is the official TypeScript client for that API. It handles the
sessions, the reconnects, the subscriptions and the errors, so your code can
get on with the part that is actually about your robot. Framework-agnostic,
ESM and CJS, types included.

Fleetless is in closed beta. The waiting list is at
<https://fleetless.dev/#waiting-list>.

## ✨ What you can do with it

- **Find your robots** and read what your role lets you do on each — slugs,
  units, parameter schemas — before you draw a screen.
- **Read datapoints** once, subscribe to them live over one reconnecting
  WebSocket, or query their recorded history.
- **Run actions and call services** by slug, with feedback, progress and
  results as they arrive.
- **Publish messages** to a topic, behind a failsafe the robot enforces
  itself the moment your app goes quiet.
- **Show cameras**: a snapshot that is always there, or live video over
  WebRTC that starts with the first viewer and stops with the last.
- **Follow jobs**, sync assets, and render the robot's URDF with its meshes.
- **Sign your users in** — registration, verification, invitations, password
  reset, single sign-on and MCP consent — from screens that are entirely
  yours. Fleetless renders no page for an app user.
- **Branch on errors** instead of parsing them: every refusal is a
  `FleetlessError` with a stable `code`.

## 🚀 Getting started

```sh
npm i @fleetless/sdk
```

You need an app identifier and an **app user** of that app, both created in
the console. A console login is a Fleetless user, a different identity space,
and will not sign in here.

```ts checked
import { createClient } from '@fleetless/sdk'

const client = createClient({
  apiUrl: 'https://api.fleetless.dev',
  appIdentifier: 'warehouse_dash', // your app's identifier, shown in the console
})

await client.auth.login('user@example.com', 'correct-horse-battery')

const robotId = '4f2c1a90-7b3e-4d51-9c86-0a1b2c3d4e5f' // the console shows it

// One-shot read.
const battery = await client.datapoints.get(robotId, 'battery_percentage')
console.log(battery.value, battery.timestamp_ms)

// Live updates: the current value first, then every change.
const subscription = client.datapoints.subscribe(robotId, 'battery_percentage', {
  onEvent: (event) => console.log(event.value, event.timestamp_ms),
  onError: (error) => console.error(error.code, error.message),
})

// Later:
subscription.unsubscribe()
await client.auth.logout()
```

`battery_percentage` is a slug you chose in the console, not a ROS topic.
Rename the node on the robot and your app never notices. Rename the slug and
it does.

The SDK runs wherever `fetch` and `WebSocket` exist: browsers, webviews,
Node 22 and newer, or server-side with a server key instead of a user session.
Node 20 does REST fine but ships no global `WebSocket`, so realtime there needs
one passed in through the `WebSocket` option.

## 📚 Documentation

Everything past this point lives at **[docs.fleetless.dev](https://docs.fleetless.dev)**.

- **[SDK reference](https://docs.fleetless.dev/reference/sdk/)** — every
  method, every option, and what each one deliberately does not do.
- **[Getting started](https://docs.fleetless.dev/getting-started/)** — from a
  robot that has never connected to a value in your app.
- **[App Starter](https://docs.fleetless.dev/recipes/app-starter/)** — every
  sign-in screen, already built, on this SDK.
- **[Manage users and roles](https://docs.fleetless.dev/concepts/manage-users-and-roles/)** —
  the two identity spaces, and what a refusal licenses your UI to claim.
- **[REST and realtime API](https://docs.fleetless.dev/reference/api/)** —
  the wire underneath this package.
- **[CHANGELOG.md](CHANGELOG.md)** — what changed in each version.

Questions, bug reports and feature requests: hello@fleetless.dev.

## 🔒 Reporting a security issue

Email **security@fleetless.dev** rather than opening a public issue.
[SECURITY.md](SECURITY.md) says what is in scope for this package — tokens,
the PKCE verifier, the `state` value — and what belongs to the platform.

## 🤝 Contributing

The public repository is not open yet. Until it is, send patches and questions
to <hello@fleetless.dev>, after reading [CONTRIBUTING.md](CONTRIBUTING.md) for
the setup, the checks and the Contributor Licence Agreement.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## 📜 Licence

MIT — see [LICENSE](LICENSE). Maintained by
[Dehne Robotik GmbH](https://dehne-robotik.de).
