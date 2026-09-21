// SPDX-License-Identifier: MIT
import type { AssetKind, AssetListResponse, AssetSyncStatus, Asset, UrdfCompleteness } from '@fleetless/contracts'
import { FleetlessError } from './errors.js'
import { mimeFromContentType, pathSegment, type HttpClient } from './http.js'

/** An asset's bytes plus its declared media type — the shape `assets.get` answers with. */
export interface AssetBytes {
  /** The asset's raw bytes, exactly as stored. */
  body: Uint8Array
  /** The declared media type, or `null` if the store did not record one. */
  mime: string | null
}

/**
 * The signature `urdf-loader`'s own `loadMeshCb` uses (verified against that
 * library's docs, not guessed): `manager`/`material` pass straight through
 * from whatever called this, and `onComplete` is how a mesh loader reports
 * success or failure — it never throws.
 *
 * This SDK does not depend on `urdf-loader` or three.js — `manager`,
 * `material` and the resolved object are all opaque here, exactly what makes
 * `createMeshLoader` usable from any renderer that speaks this same shape,
 * not only that one library.
 */
export type MeshLoaderDelegate = (
  path: string,
  manager: unknown,
  material: unknown,
  onComplete: (obj: unknown | null, err?: Error) => void,
) => void

/** What `assets.createMeshLoader` accepts beyond the robot and the delegate. */
export interface CreateMeshLoaderOptions {
  /**
   * How long to wait for `delegate`'s `onComplete` before giving up.
   * Defaults to 30s. A URDF pulls in thirty-odd meshes and a dashboard
   * using this callback can run for days — a delegate that never calls back
   * (an exception three.js swallowed internally, a parser stuck on a
   * malformed mesh) must not leak the object URL or hang the load forever.
   */
  timeoutMs?: number
}

/**
 * three.js's own `LoadingManager.setURLModifier(callback)` shape — the
 * only thing `assets.prepareUrdfScene` needs from a three.js
 * `LoadingManager`, so a caller passes theirs straight in.
 * Every load the manager oversees is routed through `callback` first — not
 * only the loader you handed the manager to, but every loader it constructs
 * internally on the same manager (`ColladaLoader`'s own `TextureLoader` for
 * a `.dae`'s `<init_from>` images, in particular). That is the one hook
 * that exists one level up, for everything, where `createMeshLoader`'s
 * per-loader `loadMeshCb` override does not reach: `TextureLoader` has no
 * override hook of its own.
 *
 * Structural, not `import('three')` — this SDK does not depend on three.js
 * or `urdf-loader`, same discipline as `MeshLoaderDelegate` above.
 */
export interface UrdfSceneManager {
  /** Installs a callback every load through this manager is routed through first. */
  setURLModifier(callback: (url: string) => string): unknown
}

/** What `assets.prepareUrdfScene` accepts beyond the robot and the manager. */
export interface PrepareUrdfSceneOptions {
  /**
   * How many assets to fetch in parallel. Default 6 — a default that keeps
   * memory and connection counts sane for the common case (dozens of
   * meshes), not a number with a sweep behind it. Pass your own if you have
   * a reason to.
   *
   * Must be a positive integer — `0` or negative rejects with
   * `invalid_option` rather than silently fetching nothing and returning a
   * scene that renders completely blank with no error to explain why.
   */
  concurrency?: number
  /**
   * Cancels this call — a caller who navigates away
   * or switches to a different robot mid-load can abort every in-flight
   * fetch this method has started, not merely stop it from starting new
   * ones. Checked before the first request; if it fires while a request is
   * already in progress, the SDK forwards it straight to `fetch()`, so the
   * connection itself is torn down, not just abandoned by this SDK while it
   * keeps running in the background.
   *
   * Every `blob:` URL already created before the abort is revoked before
   * this call rejects with `FleetlessError('aborted', ...)` — the same
   * guarantee a load that fails outright already had: an aborted load
   * must not leak what it had already fetched.
   *
   * `manager`'s URL modifier is only ever installed once every asset has
   * resolved (success or the throw below) — an aborted call never installs
   * a partial one, so `manager` is left exactly as it was if this rejects
   * before that point.
   */
  signal?: AbortSignal
}

/**
 * What `assets.prepareUrdfScene` resolves with: the URDF text to parse, what
 * the sync could not resolve, and the cleanup for everything it fetched.
 */
export interface UrdfSceneResources {
  /**
   * The robot's URDF as raw text — `package://` URIs intact, not rewritten
   * to asset URLs. Hand it straight to `URDFLoader.parse(urdfText)` once
   * `setURLModifier` is installed (this method already installed it on
   * `manager` before returning).
   */
  urdfText: string
  /**
   * The same entries `assets.list()`'s `urdf.missing` reports — verbatim,
   * not reduced to bare strings. Each carries `element`
   * (`'mesh' | 'texture'`) alongside `uri`: before this, both kinds arrived
   * as an undifferentiated `string[]` and a caller could only ever say "N
   * meshes missing", wrongly, for a URDF whose gap was actually a texture.
   * Reducing this field back to `string[]` here would throw the distinction
   * away again at
   * exactly the point a caller would render it. If you only need the URIs,
   * `missing.map(m => m.uri)`.
   *
   * **Top-level only — not a `.dae`'s internal references.** The cloud
   * builds this list from the URDF text
   * alone (`<mesh>`/`<texture>` `filename` attributes), which is the only
   * place it can see without parsing every `.dae` a sync touches; it never
   * has and never can include an internal `<init_from>` reference. Do not
   * build a completeness check on it as though it covered both: a
   * `.dae`-internal reference the sync could not resolve surfaces through
   * the sync's own failure reporting instead, not here.
   *
   * Not thrown either way: an incomplete URDF still renders what it has
   * (`urdfCompleteness`'s own contract), so the caller decides whether to
   * warn, block, or ignore before calling `URDFLoader.parse(urdfText)`. A
   * reference NOT in this list that still fails to load at render time is a
   * different failure — the store answered but the fetch itself did not.
   */
  missing: UrdfCompleteness['missing']
  /**
   * Revokes every object URL this call created that carries bytes. Call
   * once the scene has finished loading (success or failure) or on unmount
   * — safe to call more than once.
   *
   * One object URL is deliberately kept: the shared zero-byte placeholder
   * every refused reference resolves to. It costs nothing to leave alive,
   * and leaving it is what lets this method stay simple — the installed URL
   * modifier goes on refusing an owned-but-gone reference correctly, rather
   * than falling back to the original string once the map is empty.
   *
   * **Does not touch `manager`'s URL modifier.** Resetting it to the
   * identity function here would reopen the very hole the modifier exists to
   * close, the moment the same manager was used again — for a second robot,
   * or for anything else — until a later `prepareUrdfScene` call happened to
   * overwrite it. The installed modifier is left running,
   * and with this call's map now empty it already refuses anything it would
   * have owned and passes through anything it would not have, correctly,
   * on its own.
   */
  dispose(): void
}

/**
 * A robot's synced files, reachable as `client.assets`: its URDF, the meshes
 * and textures that URDF references, and the glue a three.js renderer needs
 * to fetch them with this client's credentials.
 */
export interface AssetsApi {
  /**
   * Every asset a robot has, plus whether its URDF is complete.
   * `urdf.missing` names the `package://` URIs the sync could not resolve —
   * a count alone ("2 meshes missing") sends a developer looking through a
   * workspace by hand, the URIs are what they can act on.
   */
  list(robotId: string): Promise<AssetListResponse>
  /**
   * The status of one sync by id — for **reconnecting** to a sync already in
   * flight, not for starting one.
   *
   * **Starting a sync stays out of this SDK, on purpose.** Assets are
   * transferred only on a developer's explicit request from the console —
   * an Owner-tier action, done once. This method is a different thing:
   * `list()`'s
   * `active_sync` (or a `busy` refusal's `assetSyncBusyDetails`) hands a
   * caller a `sync_id` for a sync that is **already running**, and before
   * this method existed there was no way for anything built on this SDK to
   * do anything with that id except throw it away, even though the sync was
   * readable server-side the whole time.
   *
   * A page reload is the case this exists for: whatever held the `sync_id`
   * in memory is gone, `list()` (or a fresh `busy` refusal) hands it back,
   * and this is how a caller resumes watching the same sync instead of
   * either losing the progress bar or being told to start a second one.
   */
  syncStatus(robotId: string, syncId: string): Promise<AssetSyncStatus>
  /** One asset's bytes by id — a mesh, or any asset directly, addressed the same way `createMeshLoader` reaches one internally. */
  get(robotId: string, assetId: string): Promise<AssetBytes>
  /**
   * The robot's URDF, with every `package://` mesh URI already rewritten to
   * an absolute Fleetless asset URL — ready to hand straight to
   * `URDFLoader.parse(xml)`. Decoded as UTF-8 text rather than left as
   * bytes because every consumer needs it as a string for exactly that call.
   */
  urdf(robotId: string): Promise<string>
  /**
   * The mesh callback for `urdf-loader`: an `<img>` tag and the default
   * three.js loaders cannot set an `Authorization` header, and the platform
   * deliberately has no signed URLs and no token in the query string, so
   * every app would otherwise write this glue itself, and each one
   * differently.
   *
   * Returns a function with `loadMeshCb`'s own signature — assign it
   * directly:
   *
   * ```ts
   * loader.loadMeshCb = client.assets.createMeshLoader(robotId, loader.defaultMeshLoader.bind(loader))
   * ```
   *
   * `delegate` does the actual format-specific parsing (STL/OBJ/DAE/GLTF —
   * `loader.defaultMeshLoader` already knows how); this method's own job is
   * only what a plain loader cannot do: fetch `path` with the
   * `Authorization` header, and hand the delegate something it can load
   * without one. It does that by fetching the bytes itself, wrapping them
   * in a `Blob`, and calling `delegate` with an object URL substituted for
   * `path` — so the delegate never touches the network, and the object URL
   * is revoked the moment `delegate` reports success or failure (or the
   * timeout elapses), never left for the caller to remember.
   *
   * **Refuses, via `onComplete(null, err)`, if the `manager` it is handed
   * already has `prepareUrdfScene`'s URL modifier installed** — the two
   * read different URDF sources and combining them on one manager breaks
   * one half or the other, never obviously (see `prepareUrdfScene`'s own
   * doc comment). Checked at the point the mistake would actually manifest
   * rather than left to a paragraph a developer might not read.
   */
  createMeshLoader(robotId: string, delegate: MeshLoaderDelegate, options?: CreateMeshLoaderOptions): MeshLoaderDelegate

  /**
   * Authenticated loading for everything three.js fetches to render a
   * textured robot — not only meshes. Installs
   * `manager.setURLModifier` so **every** load `manager` oversees resolves
   * to a pre-fetched `blob:` URL: a top-level `<mesh>`, a `<material>`'s
   * `<texture>`, and an image a `.dae` references internally via
   * `<init_from>` — three cases, one mechanism, because the browser never
   * fetches an asset directly. Every network read goes through this SDK
   * with the bearer token first; a `blob:` URL is document-local and dies
   * with the page, so nothing about who may read what changes.
   *
   * ```ts
   * const manager = new THREE.LoadingManager()
   * const { urdfText, missing, dispose } = await client.assets.prepareUrdfScene(robotId, manager)
   * const loader = new URDFLoader(manager)
   * const robot = loader.parse(urdfText)
   * scene.add(robot)
   * // later, once the scene has finished loading (or on unmount):
   * dispose()
   * ```
   *
   * **Do not also install `createMeshLoader` on the same manager.** The two
   * consume different URDF sources — this method fetches the URDF's *raw*
   * bytes, `createMeshLoader` is meant to pair with `urdf()`'s
   * cloud-rewritten text. **Not a double-fetch.**
   * What actually happens is asymmetric breakage,
   * whichever URDF text the combination ends up parsing: paired with
   * *this* method's raw text, `createMeshLoader` receives urdf-loader's
   * `resolvePath()` output (`/pkg/rel`) rather than an absolute Fleetless
   * URL and 404s every mesh, while textures still resolve; paired with
   * `urdf()`'s rewritten text instead, meshes load and every texture 401s
   * — `createMeshLoader` bypasses this method's URL modifier entirely for
   * meshes (that's what `loadMeshCb` means), so there is no hook left for
   * a texture. Either way a developer who combined them by accident would
   * debug the wrong symptom, which is worse than the original (already
   * wrong) warning being merely unhelpful.
   *
   * **Enforced, not only documented.** `createMeshLoader`'s returned
   * callback checks whether the `manager` it is handed already has this
   * method's URL modifier installed and fails loudly via
   * `onComplete(null, err)` before ever touching the network, rather than
   * relying on a developer having read this paragraph.
   *
   * **Why raw bytes, not `urdf()`'s rewritten text.** Both `urdf-loader`'s
   * default mesh loading and `ColladaLoader` compute the base path they use
   * to resolve a `.dae`'s internal references (`LoaderUtils.extractUrlBase`)
   * from the URL they were originally asked to load — *before*
   * `manager.resolveURL()`/the URL modifier ever runs; the modifier only
   * changes what bytes get fetched, never what further relative references
   * resolve against. Feeding it `urdf()`'s already-rewritten
   * `.../assets/<uuid>` text would compute a base of `.../assets/`, and
   * `textures/skin.png` joined onto that would never match anything this
   * method's map knows about. Raw `package://` text is what keeps the two
   * in sync.
   *
   * **`urdf-loader` resolves `package://` itself, before any of this runs —
   * a second resolution stage this method has to account for.**
   * `URDFLoader.parse()`'s own `resolvePath()`
   * rewrites `package://pkg/rel` using `this.packages` (default `''`) to
   * `/pkg/rel` — a root-relative URL — and *that* is what reaches
   * `loadMeshCb`/`ColladaLoader`/`manager.resolveURL()`, not the original
   * string. So the modifier is registered under **two** keys per asset: the
   * literal `package://` name (`asset.name`, for a caller who sets
   * `loader.packages = (pkg) => \`package://\${pkg}\`` to reconstruct it,
   * or a renderer that never went through `resolvePath()` at all) and the
   * root-relative form `urdf-loader`'s own *default* `packages: ''`
   * produces (`/pkg/rel`) — covering the common case with zero required
   * caller configuration. A `.dae`'s internal `<init_from>` ref resolves the
   * same way one level deeper: `ColladaLoader` computes its own working
   * path from *its* `url` argument (already `/pkg/rel` by the time it gets
   * there under the default), so the internal reference lands on
   * `/pkg/textures/skin.png` — exactly the second key, derived the same
   * way. A caller whose `loader.packages` does something else entirely
   * (a custom map, not the default and not the reconstruction above) is
   * outside what this method can predict — see the ownership rule below
   * for what happens to that reference.
   *
   * **This method only claims what it owns — not every unmapped
   * reference.** `manager` is frequently the
   * caller's own scene-wide `LoadingManager`, shared for an HDRI, an
   * environment map, a font atlas, a ground texture — none of which have
   * anything to do with this robot. Refusing everything unmapped would
   * silently empty every one of those the moment a caller shares their
   * manager. So the rule is narrower: a `package://`
   * reference, or a root-relative path whose leading segment names a ROS
   * package this robot's assets (or `missing`) actually mention, is this
   * method's to resolve or refuse; an unmapped one falls back to the
   * normalized form (below) and then to a shared, inert, page-local
   * `blob:` URL — never the original string, so a hostile URDF naming an
   * unsynced or off-namespace reference still cannot make three.js touch
   * the network for it. Anything else — not in that namespace — is left
   * completely alone, **except** an absolute `http(s)` URL, which is
   * refused regardless of namespace: the one case this method cannot leave
   * ambiguous, because a hostile URDF naming an attacker's host directly
   * (bypassing `package://` entirely) is exactly what this rule exists to
   * close, and three.js would otherwise fetch it for real, off-origin, the moment
   * the direct and namespace checks both miss.
   *
   * **A `.dae`'s own internal reference gets a second-chance, normalized
   * lookup, reproduced in a real browser.** three.js
   * builds the request for one by plain string concatenation — no `..`/`.`
   * collapsing — while `asset.name` carries the *normalized* tail
   * (`@fleetless/contracts`' naming rule). So `../textures/skin.png` or
   * `./textures/skin.png`, both ordinary exporter output, would otherwise
   * miss the direct key even though the reference is entirely resolvable.
   * Verified independently that the top-level `<mesh>`/`<texture>` case
   * never needs this: `asset.name` there is the URDF's own `package://` URI
   * verbatim and `resolvePath()` rewrites it by the same unnormalized
   * concatenation on both sides, so the direct key already matches.
   *
   * **`dispose()` does not undo any of this.** See its own doc comment on
   * `UrdfSceneResources`.
   *
   * **Pre-fetch is unavoidable**, not merely a choice: a URL modifier
   * cannot be asynchronous, so every asset it might be asked for has to
   * already be a `blob:` URL before `URDFLoader.parse` runs. Bounded by
   * `options.concurrency` (default 6) and scoped to only `kind: 'mesh'` and
   * `kind: 'texture'` assets — which is already "what the URDF references",
   * since a re-sync reconciles and assets the current URDF no longer
   * references stop belonging to the robot. Not an unbounded fetch of
   * everything the robot has ever had.
   */
  prepareUrdfScene(robotId: string, manager: UrdfSceneManager, options?: PrepareUrdfSceneOptions): Promise<UrdfSceneResources>
}

const DEFAULT_MESH_LOADER_TIMEOUT_MS = 30_000
const DEFAULT_SCENE_LOAD_CONCURRENCY = 6

/**
 * Every manager `prepareUrdfScene` has installed its URL modifier on —
 * checked by `createMeshLoader` so the two mechanisms cannot be combined on
 * the same manager by mistake, rather than merely documented not to be. The
 * combination does not double-fetch: one flow's meshes 404 or the other's
 * textures 401, whichever URDF text won the race, which is a much harder
 * symptom to read back to its cause than a refusal at the call.
 * A `WeakSet` rather than a property on `manager` itself: this SDK does not
 * know `manager`'s real type (`UrdfSceneManager` is structural), so it
 * cannot assume writing to it is safe or that a stray own-property would
 * not collide with something three.js itself reads.
 */
const managersWithPreparedUrdfScene = new WeakSet<object>()

/**
 * Every URL string three.js might actually ask `manager.setURLModifier` to
 * resolve for a given asset name — see `prepareUrdfScene`'s doc comment for
 * why there is more than one. For a `package://pkg/rel` name: the name
 * itself, and `/pkg/rel` — the root-relative form `urdf-loader`'s own
 * `resolvePath()` produces under its default `packages: ''`. Anything not
 * shaped like a `package://` reference (the urdf asset's own name, e.g.)
 * has only itself.
 */
function urlModifierKeysFor(name: string): string[] {
  const prefix = 'package://'
  if (!name.startsWith(prefix)) return [name]
  return [name, `/${name.slice(prefix.length)}`]
}

/**
 * A second-chance lookup key for a reference the direct lookup missed.
 *
 * three.js does not normalize a `.dae`'s internal reference the way the
 * naming rule (`@fleetless/contracts`' `assets.ts`) does when it builds
 * `asset.name`. `LoaderUtils.resolveURL`/`ImageLoader.load` build the
 * request URL by plain string concatenation (`this.path + url` — verified
 * directly against both files, not assumed), with no `..`/`.` collapsing at
 * all. So a `.dae` in `meshes/` whose `<init_from>` says
 * `../textures/skin.png` asks the URL modifier for
 * `/pkg/meshes/../textures/skin.png`, while this method's map is keyed on
 * the *normalized* `/pkg/textures/skin.png` — a miss, and on ordinary
 * exporter output: a `.dae` beside a sibling `textures/` directory is the
 * standard ROS package layout, and Blender writes `./` routinely.
 *
 * Left as `url` unchanged for a `package://` reference or anything already
 * carrying its own URI scheme (`http:`, `blob:`, `data:`, ...) — those are
 * not paths to normalize, and normalizing one by mistake would corrupt it
 * rather than fix a miss. Everything else is normalized the way a browser
 * already does it: resolved against a throwaway `file:///` base and only
 * the resulting `.pathname` kept, so `..`/`.` collapse exactly the way the
 * naming rule's own normalization does — not a hand-rolled path-join that
 * could disagree with it a second time.
 *
 * **The top-level `<mesh>`/`<texture>` case never needs this — verified
 * independently, not taken on the review's word.** `asset.name` there is
 * the URDF's own `package://` URI verbatim; `URDFLoader.parse()`'s own
 * `resolvePath()` rewrites it by the same plain concatenation with no
 * normalization on either side (read directly in `URDFLoader.js`). Both
 * sides already carry the identical unnormalized string, so the direct
 * lookup in `urlModifierKeysFor` already matches. This function only ever
 * matters for a `.dae`'s own internal reference, which is the one place the
 * two sides normalize differently.
 */
function normalizedUrlModifierKey(url: string): string {
  if (url.startsWith('package://') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url
  try {
    return new URL(url, 'file:///').pathname
  } catch {
    return url
  }
}

/**
 * The ROS package name a `package://` reference names — the first path
 * segment after the scheme, e.g. `robot_description` from
 * `package://robot_description/meshes/arm.stl`. `null` for anything else.
 */
function packageNameOf(name: string): string | null {
  const prefix = 'package://'
  if (!name.startsWith(prefix)) return null
  const rest = name.slice(prefix.length)
  const slash = rest.indexOf('/')
  return slash === -1 ? rest : rest.slice(0, slash)
}

/**
 * Whether `url` is something `prepareUrdfScene` is responsible for — a
 * `package://` reference, or a root-relative path whose first segment names
 * a ROS package this robot has an asset (or a known-missing reference) for.
 *
 * **Why this is a containment question and not an origin one.**
 * `setURLModifier` is a single global hook on whatever `LoadingManager` the
 * caller passed in, and that manager is routinely the app's own — shared for
 * an HDRI, an environment map, a font atlas, a ground texture, none of which
 * have anything to do with this robot. Refusing *everything* unmapped would
 * silently empty every one of those the moment an app shares its manager.
 *
 * An origin check is not the answer either: a `.dae`'s normalization miss
 * (`/pkg/meshes/../textures/skin.png`) is same-origin and still ours to
 * own, so refusing only cross-origin references would let a silent miss back
 * in through the fallback. The actual question is
 * whether the reference names something in the namespace this robot's
 * assets live in: `package://...` always does (no app ever legitimately
 * has content under that scheme); a root-relative path only does when its
 * leading segment is a package this robot's assets (or `urdf.missing`)
 * actually name. `knownPackages` includes `missing`'s own package names too
 * — an entirely unsynced package's reference is still ours to refuse, not a
 * coincidence to hand to the app's own fetch.
 */
function isOwnedReference(url: string, knownPackages: ReadonlySet<string>): boolean {
  if (url.startsWith('package://')) return true
  const match = /^\/([^/]+)\//.exec(url)
  return match !== null && knownPackages.has(match[1] as string)
}

/**
 * Whether `url` is a `http(s)` absolute URL — a scheme a browser will
 * actually dial out to. Deliberately the same shape as `HttpClient`'s own
 * `isAbsolute` check in `http.ts`, so the two mechanisms draw the identical
 * line for what counts as "leaves this page".
 */
function isNetworkFetchableAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * Whether `prepareUrdfScene` pre-fetches an asset of this kind — a
 * deliberate, closed set (`mesh`, `texture`), not "everything
 * `assets.list()` can return": `urdf` is fetched separately as raw text.
 * `@fleetless/contracts`' `assetKind` is exactly these three now — mesh,
 * texture and urdf are the whole set; there is no catch-all kind left to
 * decide about.
 *
 * **Written as an exhaustive `switch` over `AssetKind`, not
 * `kind === 'mesh' || kind === 'texture'`, on purpose.** A predicate that
 * enumerates some of `assetKind`'s members instead of all of them silently
 * skips the next member the kind gains — which is how `texture` itself was
 * missed by three separate call sites when it was added. A boolean OR here
 * would fail the identical way the moment
 * `assetKind` gains a fourth member: `tsc` would stay green, `renderAssets`
 * would just quietly not include it, and the symptom would be a robot that
 * renders with one surface missing, visible by looking at it rather than
 * by a build failing. The `default` branch below makes that impossible —
 * `never` is only assignable when the `switch` already covers every member
 * of `AssetKind`, so a new member fails `tsc --noEmit` right here, at the
 * next contracts re-pin, until whoever added it decides on purpose whether
 * `prepareUrdfScene` should pre-fetch it.
 */
function isRenderKind(kind: AssetKind): boolean {
  switch (kind) {
    case 'mesh':
    case 'texture':
      return true
    case 'urdf':
      return false
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once,
 * preserving no particular result order — callers here only care about side
 * effects (populating a shared map), not a returned array.
 *
 * **Every item is attempted, even after one fails.** `Promise.all` over the
 * worker loops directly rejects on the FIRST failure — but the other workers,
 * mid-flight on different items, are not cancelled by that: they keep
 * running, unobserved, and whatever side effect `fn` had for them (creating
 * a `blob:` URL, in `prepareUrdfScene`) happens AFTER the caller's own catch
 * block already decided what to clean up. For a scene of 24 meshes where one
 * 404s, that is 23 blob URLs created and none revoked: the catch runs against
 * a snapshot of `objectUrls` taken before most of the successful fetches have
 * resolved, and a whole scene's credentialed bytes stay retained for the life
 * of the document.
 *
 * So every worker catches its own errors and keeps draining the queue; only
 * once every worker has fully returned — meaning nothing is in flight
 * anymore — does this function re-throw the first error it saw. That costs
 * a little wasted work (items after the first failure are still fetched,
 * even though the whole call is going to reject anyway), and buys the
 * caller a guarantee it did not have before: by the time this rejects,
 * whatever `fn` did for every item has already happened, not a mid-flight
 * snapshot of it.
 */
async function forEachWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  let firstError: unknown
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      try {
        await fn(items[index] as T)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  if (failed) throw firstError
}

export function createAssetsApi(http: HttpClient): AssetsApi {
  // `signal` is a third, optional parameter on both — not part of
  // `AssetsApi.list`/`.get`'s own public signature, only used by
  // `prepareUrdfScene` below. A function accepting
  // an extra optional trailing parameter is still assignable to an
  // interface that declares fewer — every caller going through the public
  // `AssetsApi` type simply never supplies it.
  async function list(robotId: string, signal?: AbortSignal): Promise<AssetListResponse> {
    const response: AssetListResponse = await http.request(`/api/robots/${pathSegment(robotId)}/assets`, { signal })
    return response
  }

  async function get(robotId: string, assetId: string, signal?: AbortSignal): Promise<AssetBytes> {
    const { body, headers } = await http.requestBinary(`/api/robots/${pathSegment(robotId)}/assets/${pathSegment(assetId)}`, { signal })
    return { body, mime: mimeFromContentType(headers) }
  }

  async function syncStatus(robotId: string, syncId: string, signal?: AbortSignal): Promise<AssetSyncStatus> {
    const response: AssetSyncStatus = await http.request(
      `/api/robots/${pathSegment(robotId)}/assets/sync/${pathSegment(syncId)}`,
      { signal },
    )
    return response
  }

  return {
    list,
    get,
    syncStatus,

    async urdf(robotId) {
      const { body } = await http.requestBinary(`/api/robots/${pathSegment(robotId)}/urdf`)
      return new TextDecoder().decode(body)
    },

    createMeshLoader(robotId, delegate, options = {}) {
      const timeoutMs = options.timeoutMs ?? DEFAULT_MESH_LOADER_TIMEOUT_MS

      return (path, manager, material, onComplete) => {
        let settled = false
        let objectUrl: string | null = null

        const finish = (obj: unknown | null, err?: Error): void => {
          if (settled) return
          settled = true
          if (objectUrl) URL.revokeObjectURL(objectUrl)
          onComplete(obj, err)
        }

        // Loud, not quiet: fail before ever touching the network rather
        // than let this combination reach a real request that would 404 or
        // 401 depending on which mechanism's URDF text happened to be
        // parsed. See managersWithPreparedUrdfScene's own comment.
        if (typeof manager === 'object' && manager !== null && managersWithPreparedUrdfScene.has(manager)) {
          finish(
            null,
            new Error(
              `createMeshLoader and prepareUrdfScene were both installed on the same LoadingManager for robot ${robotId}. ` +
                'Use one or the other on a given manager, not both — see the SDK reference.',
            ),
          )
          return
        }

        const timer = setTimeout(() => {
          finish(null, new Error(`Mesh '${path}' on robot ${robotId} did not finish loading within ${timeoutMs}ms.`))
        }, timeoutMs)

        http.requestBinary(path).then(
          ({ body, headers }) => {
            // The timeout may already have fired while this fetch was in
            // flight — do not create an object URL nobody will ever revoke.
            if (settled) return
            const mime = mimeFromContentType(headers) ?? 'application/octet-stream'
            // The cast is TS 5.7's generic `Uint8Array<ArrayBufferLike>` vs.
            // `BlobPart`'s `Uint8Array<ArrayBuffer>` — a real runtime
            // Uint8Array satisfies Blob's constructor either way, only the
            // declared types disagree.
            objectUrl = URL.createObjectURL(new Blob([body as BlobPart], { type: mime }))
            try {
              delegate(objectUrl, manager, material, (obj, err) => {
                clearTimeout(timer)
                finish(obj, err)
              })
            } catch (delegateError) {
              // loadMeshCb's contract is "report failures via onComplete,
              // never throw" — but a delegate is caller-supplied code (an
              // app's own three.js wiring), so a synchronous throw there
              // must not escape into whatever called this callback (three.js's
              // own URDF traversal, typically) as an unhandled exception.
              clearTimeout(timer)
              finish(null, delegateError instanceof Error ? delegateError : new Error(String(delegateError)))
            }
          },
          (fetchError: unknown) => {
            clearTimeout(timer)
            finish(null, fetchError instanceof Error ? fetchError : new Error(String(fetchError)))
          },
        )
      }
    },

    async prepareUrdfScene(robotId, manager, options = {}) {
      const concurrency = options.concurrency ?? DEFAULT_SCENE_LOAD_CONCURRENCY
      // A non-positive value silently fetches nothing: Math.min(concurrency,
      // items.length) in forEachWithConcurrency clamps to 0 workers, the
      // whole batch resolves as if there were no assets to fetch, and the
      // caller gets back a scene that renders completely blank — every
      // mesh/texture reference falls through the "owned but unresolved"
      // path — with no error anywhere pointing at a bad option. Caught here
      // instead, before any network call, the same way `invalid_option` is
      // used elsewhere in this SDK for a caller-supplied value that cannot
      // mean what it looks like it means.
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new FleetlessError(
          'invalid_option',
          `prepareUrdfScene: options.concurrency must be a positive integer, got ${concurrency}.`,
        )
      }

      // Checked before the first request, not only
      // relied upon to propagate from `fetch()` later — a signal that was
      // already aborted before this call even started (a caller who awaited
      // something else first, then found the abort had already fired) must
      // not cause a single network request regardless.
      const signal = options.signal
      const aborted = (): FleetlessError =>
        new FleetlessError('aborted', `prepareUrdfScene for robot ${robotId} was aborted.`)
      if (signal?.aborted) throw aborted()

      const listResponse = await list(robotId, signal).catch((error: unknown) => {
        throw signal?.aborted ? aborted() : error
      })
      const urdfAsset = listResponse.assets.find((asset) => asset.kind === 'urdf')
      if (!urdfAsset) {
        throw new FleetlessError(
          'no_urdf_synced',
          `Robot ${robotId} has no synced URDF — assets.list() has no 'urdf'-kind row. Sync one first (console, Owner-tier).`,
        )
      }

      // Raw bytes, not urdf() — see this method's doc comment for why the
      // cloud's package:// -> absolute-URL rewrite would break resolving a
      // .dae's internal image references.
      const { body: urdfBytes } = await get(robotId, urdfAsset.id, signal).catch((error: unknown) => {
        throw signal?.aborted ? aborted() : error
      })
      const urdfText = new TextDecoder().decode(urdfBytes)

      const renderAssets: Asset[] = listResponse.assets.filter((asset) => isRenderKind(asset.kind))

      // Every ROS package this robot's assets — or its own missing list —
      // name. See isOwnedReference: this is what tells a reference this
      // method is responsible for apart from whatever else the caller's
      // manager might be asked to load.
      const knownPackages = new Set<string>()
      for (const asset of renderAssets) {
        const pkg = packageNameOf(asset.name)
        if (pkg) knownPackages.add(pkg)
      }
      for (const ref of listResponse.urdf.missing) {
        const pkg = packageNameOf(ref.uri)
        if (pkg) knownPackages.add(pkg)
      }

      // The answer for anything this method owns and cannot resolve — an
      // empty, page-local blob, never the original
      // string. `URDFLoader.resolvePath()` passes a non-package:// filename
      // through unchanged, so an unmapped `<mesh filename="http://...">`
      // or off-origin `<texture>` would otherwise reach the browser's own
      // fetch verbatim: no credential travels with it (three.js does not
      // carry the bearer token), but it is still a real network request to
      // a URL named by whatever is on the robot's ROS graph, driven by
      // every viewer who renders it — a beacon `http.ts`'s own
      // `untrusted_absolute_url` check already refuses for the older
      // createMeshLoader path, in these words: "not fetched anonymously...
      // fails loudly instead of quietly making an unexpected network call
      // on the app's behalf." A `blob:` URL created in this page cannot
      // resolve to any other origin, by construction, so mapping the
      // fallback to one closes this the same way, one layer down.
      //
      // Deliberately NOT in objectUrls and never revoked: it is zero bytes,
      // so keeping it alive costs nothing, and
      // never tearing it down is what lets dispose() below stay simple —
      // the installed modifier keeps refusing owned-but-gone references
      // correctly forever, without dispose() having to touch the modifier
      // itself or reason about whether it is still the one installed.
      const refusedObjectUrl = URL.createObjectURL(new Blob([]))

      const objectUrls: string[] = []
      const nameToObjectUrl = new Map<string, string>()

      try {
        await forEachWithConcurrency(renderAssets, concurrency, async (asset) => {
          const { body, mime } = await get(robotId, asset.id, signal)
          const objectUrl = URL.createObjectURL(new Blob([body as BlobPart], { type: mime ?? 'application/octet-stream' }))
          objectUrls.push(objectUrl)
          // Both the raw package:// name and the root-relative form
          // urdf-loader's own resolvePath() rewrites it to under its
          // default packages: '' — see urlModifierKeysFor and this
          // method's doc comment for why there are two.
          for (const key of urlModifierKeysFor(asset.name)) nameToObjectUrl.set(key, objectUrl)
        })
      } catch (error) {
        // A fetch that fails mid-batch (a stale asset id, a network blip, or
        // an abort) rejects the whole call — no
        // partial scene, matching `Promise.all` semantics elsewhere in this
        // SDK. forEachWithConcurrency guarantees every item has been
        // attempted by the time this runs, so objectUrls here is the
        // complete final set, not a snapshot racing whatever else was still
        // in flight; revoke all of it, since the caller never receives a
        // dispose() to do it themselves.
        //
        // `signal?.aborted` decides the code reported, not what `fn` itself
        // threw: once a caller aborts, every worker still draining the queue
        // (the "every item is attempted" guarantee) hits its own fetch
        // rejection too, in whatever shape that runtime's `fetch()` uses for
        // an aborted request — reporting one normalized `aborted` regardless
        // of which worker's rejection happened to be recorded first is more
        // useful than surfacing that shape, and correct: an aborted signal
        // is why every one of them failed, not incidentally coincident with it.
        for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl)
        throw signal?.aborted ? aborted() : error
      }

      // The batch above can finish successfully in the same tick the signal
      // fires — nothing left in flight to reject, so the catch above never
      // runs. Checked once more here, before installing anything on
      // `manager` or handing the caller resources for a load they already
      // cancelled.
      if (signal?.aborted) {
        for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl)
        throw aborted()
      }

      // Marked at the point the modifier is actually installed, not
      // earlier — a manager this method never got as far as installing
      // anything on (a failed asset fetch, no_urdf_synced) should not be
      // marked, or createMeshLoader would refuse on a manager that does
      // not actually carry this method's modifier. See
      // managersWithPreparedUrdfScene's own comment.
      if (typeof manager === 'object' && manager !== null) managersWithPreparedUrdfScene.add(manager)

      manager.setURLModifier((url) => {
        const direct = nameToObjectUrl.get(url)
        if (direct) return direct

        if (!isOwnedReference(url, knownPackages)) {
          // Not ours: an absolute network URL is refused regardless — a
          // hostile URDF must never make three.js dial out to an
          // attacker-named host, package:// or not. Anything else belongs
          // to whatever else
          // this manager is loading and is left completely alone.
          return isNetworkFetchableAbsoluteUrl(url) ? refusedObjectUrl : url
        }

        // Ours, and the direct key missed: try the normalized form —
        // three.js does not collapse ../. the way asset.name's naming rule
        // does — before giving up.
        return nameToObjectUrl.get(normalizedUrlModifierKey(url)) ?? refusedObjectUrl
      })

      let disposed = false
      return {
        urdfText,
        missing: listResponse.urdf.missing,
        dispose() {
          if (disposed) return
          disposed = true
          for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl)
          nameToObjectUrl.clear()
          // Deliberately NOT resetting manager.setURLModifier. Resetting it
          // to the identity function here would let unmapped references
          // through again the moment an app reused the
          // same manager for a second scene, or simply kept using it for
          // anything else after disposing this one — every subsequent
          // reference was fetched raw again, unrefused, until the next
          // prepareUrdfScene call happened to overwrite it. The installed
          // modifier is left running: with the map now empty and
          // refusedObjectUrl still valid, it already does the right thing
          // on its own — an owned reference refuses, anything else still
          // passes through — and a later prepareUrdfScene call on the same
          // manager replaces it with its own, entirely independent one
          // regardless, so there is nothing for dispose() to coordinate.
        },
      }
    },
  }
}
