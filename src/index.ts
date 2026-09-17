// SPDX-License-Identifier: MIT
/**
 * `@fleetless/sdk` — the TypeScript client a developer builds a Fleetless
 * app with: framework-agnostic, ESM and CJS, no browser assumed.
 *
 * `createClient` builds a client for one app and everything else hangs off
 * it. `auth` is the whole client auth API — registration, verification,
 * login, logout, password reset, invitations, federated sign-in per app, the
 * MCP consent screen and the app user's own standing MCP grants — or a server
 * key for a caller that holds no user session. `datapoints` reads a topic's
 * latest value, subscribes to it over the realtime channel, and reads recorded
 * history. `actions`, `services` and `publishers` send commands over that same
 * channel, each reply correlated back to its own call. `cameras` fetches
 * snapshot bytes and opens a live video session. `jobs` lists what a robot is
 * running and `assets` reads its URDF and meshes. `robots` is where a screen
 * starts: which robots the caller reaches, and what their role lets them do
 * on each.
 *
 * The wire types the API returns are re-exported from `@fleetless/contracts`
 * rather than redefined here, so app code and the SDK always agree on the
 * shape of a value.
 *
 * @module
 */
export { createClient } from './client.js'
export type { FleetlessClient, FleetlessClientOptions, FleetlessClientConfig } from './client.js'

export { FleetlessError, SDK_ERROR_CODES } from './errors.js'
export type { FleetlessErrorOptions, FleetlessErrorCode, SdkErrorCode } from './errors.js'

export { InMemoryTokenStore } from './token-store.js'
export type { TokenStore, StoredSession } from './token-store.js'

export type {
  AuthApi,
  RegisterOptions,
  AcceptInvitationOptions,
  ProviderButton,
  BeginOidcLoginOptions,
  OidcLoginRequest,
  CompleteOidcLoginOptions,
  McpInteractionDecision,
} from './auth.js'
export type { DatapointsApi, DatapointSubscription, DatapointSubscriptionHandlers, HistoryOptions, HistoryAggregation } from './datapoints.js'
export type { ActionsApi } from './actions.js'
export type { ServicesApi } from './services.js'
export type { PublishersApi } from './publishers.js'
export type { CamerasApi, CameraSnapshot, CameraSnapshotMeta, CameraLiveSession } from './cameras.js'
export type { JobSubscription, JobSubscriptionHandlers } from './job-subscriptions.js'
export type { JobsApi } from './jobs.js'
export type { RobotsApi } from './robots.js'
export type { SendCommandOptions, InvokeOptions } from './commands.js'
export type {
  AssetsApi,
  AssetBytes,
  MeshLoaderDelegate,
  CreateMeshLoaderOptions,
  UrdfSceneManager,
  PrepareUrdfSceneOptions,
  UrdfSceneResources,
} from './assets.js'

// Wire types a consumer needs to hold values the SDK returns, re-exported
// rather than redefined so app code and the SDK always agree on the shape.
export type {
  DatapointValue,
  DatapointEvent,
  ClientIdentity,
  Job,
  JobState,
  JobEvent,
  BusyDetails,
  CameraDescriptor,
  HistorySamplesResponse,
  HistoryBucketsResponse,
  // What `assets.list` resolves with, and one asset's row inside it — naming
  // either (e.g. "N meshes, M missing") would otherwise mean reaching into
  // `@fleetless/contracts` directly. Same reasoning as `ClientMcpInteraction`
  // below.
  AssetListResponse,
  Asset,
  UrdfCompleteness,
  // `error.details` of a `rate_limited` refusal. The SDK reference's
  // Errors section (`rate_limited` — surfaced, never retried) is the only place
  // that describes what it does and does not carry, so this points there
  // rather than at a doc comment.
  RateLimitDetails,
  // What `auth.mcpInteraction` resolves with — the pending MCP authorization
  // an app renders its own consent screen from. Same reasoning as
  // `AssetListResponse`/`Asset` above: holding one would otherwise mean
  // reaching into `@fleetless/contracts` directly.
  ClientMcpInteraction,
  // One entry of `auth.listMcpGrants()` — a standing consent, for a
  // "connected apps" list.
  McpConsentGrant,
  // What `robots.list` resolves with, one row per reachable robot, and what
  // `robots.describe` resolves with: the datasheet, its exposures and its
  // capabilities. Holding any of them would otherwise mean reaching into
  // `@fleetless/contracts` directly, as with `AssetListResponse` above.
  ClientRobotListItem,
  McpRobotDatasheet,
  McpExposure,
  McpCapabilities,
} from '@fleetless/contracts'

/**
 * The `error.code` of a `FleetlessError` that `auth.oidcErrorFromCallback`
 * built from a failed federated sign-in, for a caller writing an exhaustive
 * switch over the reasons: `no_access`, `email_taken`, `email_unverified`,
 * `domain_not_allowed`, `registration_closed`, `idp_unavailable`,
 * `exchange_failed`, `claims_incomplete`, `provider_misconfigured`,
 * `provider_disabled`, `invalid_request`, `quota_exceeded`.
 *
 * **On its own line, with a JSDoc, rather than inside the block above.** It is
 * the only re-export here with no JSON Schema artifact behind it — the enum is
 * not exported as a schema, so the docs site cannot alias it to a field table,
 * and a comment inside a multi-specifier `export type { … }` is attached to
 * the statement rather than to the member. So this is the only description
 * the generated SDK reference renders for it — move it back into the block
 * and that section goes silently blank.
 */
export type { ClientOidcErrorCode } from '@fleetless/contracts'

// `error.details` of a `parameter_invalid` refusal (§4.4) is exactly this
// shape — re-exported as a runtime schema, not just a type, so a caller
// parses it (`parameterInvalidDetails.parse(error.details)`) instead of
// guessing at the fields the way this SDK itself once did.
export { parameterInvalidDetails } from '@fleetless/contracts'
export type { ParameterInvalidDetails, ParameterViolation } from '@fleetless/contracts'
