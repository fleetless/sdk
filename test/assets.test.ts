// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Asset, AssetListResponse, AssetSyncStatus } from '@fleetless/contracts'
// A value import, not `import type` — the one test below that needs the
// actual zod schema, not just its inferred type (see that describe block's
// own comment for why).
import { assetFailure } from '@fleetless/contracts'
import { HttpClient, noCredentials } from '../src/http.js'
import { createAssetsApi, type MeshLoaderDelegate, type UrdfSceneManager } from '../src/assets.js'
import { FleetlessError } from '../src/errors.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function errorResponse(code: string, message: string, status = 403): Response {
  return jsonResponse({ code, message }, status)
}

function bytesResponse(bytes: Uint8Array, headers: Record<string, string>, status = 200): Response {
  return new Response(bytes as BodyInit, { status, headers })
}

function fakeFetch(impl: (input: string | URL | RequestInfo, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl)
}

function client(fetchImpl: typeof fetch, baseUrl = 'https://api.fleetless.dev') {
  const http = new HttpClient({ baseUrl, fetch: fetchImpl, credentials: noCredentials })
  return createAssetsApi(http)
}

const LIST_RESPONSE: AssetListResponse = {
  assets: [
    {
      id: 'asset1',
      robot_id: 'robot1',
      kind: 'mesh',
      name: 'package://robot_description/meshes/arm.stl',
      media_type: 'model/stl',
      size_bytes: 4096,
      sha256: 'a'.repeat(64),
      created_at: '2026-08-13T00:00:00.000Z',
    },
  ],
  urdf: { present: true, mesh_count: 3, missing: [{ uri: 'package://robot_description/meshes/gripper.stl', element: 'mesh' }] },
  urdf_available: true,
  active_sync: null,
  store: { bytes: 1_000_000_000, used_bytes: 4096 },
  joint_state_slug: 'joint_states',
}

describe('assets.list', () => {
  it('reads the full envelope — assets, urdf completeness, and availability — not just the array', async () => {
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/robot1/assets')
      return jsonResponse(LIST_RESPONSE)
    })

    await expect(client(fetchImpl as unknown as typeof fetch).list('robot1')).resolves.toEqual(LIST_RESPONSE)
  })

  it('rejects a forbidden read as a FleetlessError, same as every other route', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse('forbidden', 'not granted'))
    await expect(client(fetchImpl as unknown as typeof fetch).list('robot1')).rejects.toMatchObject({ code: 'forbidden' })
  })
})

const RUNNING_SYNC: AssetSyncStatus = {
  sync_id: 'sync1',
  robot_id: 'robot1',
  state: 'running',
  done: 3,
  total: 10,
  failed: [],
  reason: null,
  started_at: '2026-08-19T10:00:00.000Z',
  updated_at: '2026-08-19T10:00:03.000Z',
}

describe('assets.syncStatus', () => {
  // reconnecting to a sync a caller already has the id
  // for — from `list()`'s `active_sync` after a reload, or from a `busy`
  // refusal's `assetSyncBusyDetails` — not starting a new one. The route
  // (`GET .../assets/sync/{id}`) predates this method; nothing in the SDK
  // called it before.
  it('fetches the named sync by id and returns the full status envelope', async () => {
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/robot1/assets/sync/sync1')
      return jsonResponse(RUNNING_SYNC)
    })

    await expect(client(fetchImpl as unknown as typeof fetch).syncStatus('robot1', 'sync1')).resolves.toEqual(RUNNING_SYNC)
  })

  it('encodes both robotId and syncId rather than sending either as a literal path segment', async () => {
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/robot%2F..%2Fx/assets/sync/sync%2F..%2Fy')
      return jsonResponse(RUNNING_SYNC)
    })

    await client(fetchImpl as unknown as typeof fetch).syncStatus('robot/../x', 'sync/../y')
  })

  it('rejects an unknown or foreign sync id as a FleetlessError, same as every other route', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse('not_found', "no sync 'sync1' for robot robot1", 404))
    await expect(client(fetchImpl as unknown as typeof fetch).syncStatus('robot1', 'sync1')).rejects.toMatchObject({ code: 'not_found' })
  })

  // A generic error body's `details` always reaches `FleetlessError`
  // unconditionally — `http.ts` forwards `body?.details` for every route, no
  // per-code special-casing. Proven here against `quota_exceeded`'s actual
  // shape rather than trusted by name, the same discipline `services.call`'s
  // `unwrap()` applies to `job.error.details`. Stays even though the next
  // test found the real path: this generic mechanism is what the raw `409`
  // on the bridge-upload route still uses, and nothing else covers it if
  // this breaks.
  it('passes a structured error body straight through to FleetlessError.details, unmodified', async () => {
    const details = { store_bytes: 1_000_000_000, used_bytes: 998_000_000, size_bytes: 5_000_000 }
    const fetchImpl = fakeFetch(async () => jsonResponse({ code: 'quota_exceeded', message: 'no room', details }, 409))
    await expect(client(fetchImpl as unknown as typeof fetch).syncStatus('robot1', 'sync1')).rejects.toMatchObject({
      code: 'quota_exceeded',
      details,
    })
  })

  // The actual answer: a store-full refusal never reaches a developer-
  // authenticated route as an HTTP error — it's reported inside the sync's
  // own progress, as a `failed[]` entry with `kind: 'refused'` and
  // `details: {store_bytes, used_bytes, size_bytes}`. Both tests below prove
  // the same for `active_sync` as a whole: the SDK does no field-by-field
  // mapping of `assetSyncStatus`/`assetFailure`, so a new contract shape
  // arrives unmodified with no SDK change.
  it("carries a refused entry's reference AND all three numbers through unmodified, the file over the store's room named among files that kept syncing", async () => {
    const refused = {
      reference: 'package://robot_description/meshes/base.dae',
      kind: 'refused' as const,
      details: { store_bytes: 1_000_000_000, used_bytes: 998_000_000, size_bytes: 5_000_000 },
    }
    const status: AssetSyncStatus = {
      ...RUNNING_SYNC,
      state: 'failed',
      // The rest of the sync kept going — a resolved entry sits beside the
      // refused one; it didn't stop at the first refusal.
      failed: [refused, { reference: 'package://robot_description/meshes/gripper.stl', kind: 'unresolvable' }],
    }
    const fetchImpl = fakeFetch(async () => jsonResponse(status))

    const result = await client(fetchImpl as unknown as typeof fetch).syncStatus('robot1', 'sync1')
    expect(result.failed).toEqual(status.failed)
    expect(result.failed[0]).toMatchObject({
      kind: 'refused',
      details: { store_bytes: 1_000_000_000, used_bytes: 998_000_000, size_bytes: 5_000_000 },
    })
  })

  it("the same refused entry survives list()'s active_sync too — the reload case", async () => {
    const refused = {
      reference: 'package://robot_description/meshes/base.dae',
      kind: 'refused' as const,
      details: { store_bytes: 1_000_000_000, used_bytes: 998_000_000, size_bytes: 5_000_000 },
    }
    const listResponse: AssetListResponse = {
      ...LIST_RESPONSE,
      active_sync: { ...RUNNING_SYNC, state: 'failed', failed: [refused] },
    }
    const fetchImpl = fakeFetch(async () => jsonResponse(listResponse))

    const result = await client(fetchImpl as unknown as typeof fetch).list('robot1')
    expect(result.active_sync?.failed).toEqual([refused])
  })
})

describe('assetFailure — the refused/details pairing is enforced, not described', () => {
  // Deliberately runtime `.safeParse()` against the real schema, not a typed
  // fixture — unlike everywhere else in this file, `tsc` cannot catch a
  // violation here: `details` is `.nullish()` at the type level regardless
  // of `kind` (the pairing lives in `.superRefine()`, invisible to
  // `z.infer`), so only actually parsing proves the rule holds: `details`
  // belongs to `refused` and nothing else. Unlike the removed `too_large`
  // kind, `refused` does not itself require `details` — a producer-side
  // ceiling refuses with no store number to report.
  it('refuses details on anything but refused', () => {
    expect(
      assetFailure.safeParse({
        reference: 'x',
        kind: 'unresolvable',
        details: { store_bytes: 1, used_bytes: 0, size_bytes: 2 },
      }).success,
    ).toBe(false)
    expect(
      assetFailure.safeParse({
        reference: 'x',
        kind: 'upload_failed',
        details: { store_bytes: 1, used_bytes: 0, size_bytes: 2 },
      }).success,
    ).toBe(false)
  })

  it('accepts refused with or without details, and accepts every other kind with none', () => {
    expect(
      assetFailure.safeParse({
        reference: 'x',
        kind: 'refused',
        details: { store_bytes: 1, used_bytes: 0, size_bytes: 2 },
      }).success,
    ).toBe(true)
    expect(assetFailure.safeParse({ reference: 'x', kind: 'refused' }).success).toBe(true)
    for (const kind of ['unresolvable', 'upload_failed'] as const) {
      expect(assetFailure.safeParse({ reference: 'x', kind }).success).toBe(true)
    }
  })
})

describe('assets.get', () => {
  it('returns the bytes and the mime read from content-type', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/robot1/assets/asset1')
      return bytesResponse(bytes, { 'content-type': 'model/stl' })
    })

    const result = await client(fetchImpl as unknown as typeof fetch).get('robot1', 'asset1')
    expect(result.body).toEqual(bytes)
    expect(result.mime).toBe('model/stl')
  })

  it('propagates asset_missing rather than absorbing it — unlike a camera snapshot, a missing asset is a real failure', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse('asset_missing', 'no such asset', 404))
    await expect(client(fetchImpl as unknown as typeof fetch).get('robot1', 'asset1')).rejects.toMatchObject({ code: 'asset_missing' })
  })

  // `pathSegment()` is proved against a real server in http.test.ts; this
  // confirms the route actually calls it for both robotId and assetId.
  it('encodes a robotId/assetId shaped like a traversal attempt rather than sending it as literal path segments', async () => {
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/..%2Fadmin/assets/..%2F..%2Fother-robot%2Fasset1')
      return bytesResponse(new Uint8Array([1]), { 'content-type': 'model/stl' })
    })

    await client(fetchImpl as unknown as typeof fetch).get('../admin', '../../other-robot/asset1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('assets.urdf', () => {
  it('decodes the served bytes as UTF-8 text, ready for URDFLoader.parse()', async () => {
    const xml = '<?xml version="1.0"?><robot name="demo_robot"></robot>'
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/robot1/urdf')
      return bytesResponse(new TextEncoder().encode(xml), { 'content-type': 'application/xml' })
    })

    await expect(client(fetchImpl as unknown as typeof fetch).urdf('robot1')).resolves.toBe(xml)
  })
})

describe('assets.createMeshLoader', () => {
  const MANAGER = { id: 'manager' }
  const MATERIAL = { id: 'material' }

  // Spied, not mocked — a wrapped call-through, not a replacement. A mock
  // can't tell you whether the real revoke happened; these assertions read
  // real Blob/URL behaviour, as the team lead asked to keep it unmocked.
  // Declared per-test, not in beforeEach, so each spy's inferred type stays
  // precise instead of widening to vi.spyOn's generic overload return type.
  function spyOnUrl() {
    return { revokeSpy: vi.spyOn(URL, 'revokeObjectURL'), createSpy: vi.spyOn(URL, 'createObjectURL') }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('fetches an absolute mesh URL as-is — no baseUrl prefixing — for the same-origin case the cloud always produces', async () => {
    const meshUrl = 'https://api.fleetless.dev/api/robots/robot1/assets/mesh1'
    const bytes = new Uint8Array([1, 2, 3])
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe(meshUrl)
      return bytesResponse(bytes, { 'content-type': 'model/stl' })
    })

    const delegate = vi.fn<MeshLoaderDelegate>((_path, _manager, _material, onComplete) => onComplete({ ok: true }))
    const loadMeshCb = client(fetchImpl as unknown as typeof fetch, 'https://api.fleetless.dev').createMeshLoader('robot1', delegate)

    const done = new Promise<[unknown, Error | undefined]>((resolve) => {
      loadMeshCb(meshUrl, MANAGER, MATERIAL, (obj, err) => resolve([obj, err]))
    })
    const [obj, err] = await done

    expect(obj).toEqual({ ok: true })
    expect(err).toBeUndefined()
  })

  // The vulnerability: `rewriteMeshUris` (cloud) only rewrites `package://`
  // URIs, so a URDF's `<mesh filename="https://evil.example/x.stl">` reaches
  // this callback unchanged — and a URDF is ROS graph input, not
  // first-party data, so this is a real caller risk, not a hypothetical
  // one. Without HttpClient's origin check, this would fetch the attacker's
  // host with this app's own bearer token attached. Confirms the whole path:
  // createMeshLoader -> HttpClient -> refusal -> onComplete(null, err),
  // touching neither the network nor the delegate.
  it("refuses a mesh URL on a foreign origin rather than fetch it with the caller's own credentials attached", async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('must not be called — the origin check must refuse before any network call')
    })
    const delegate = vi.fn<MeshLoaderDelegate>((_path, _manager, _material, onComplete) => onComplete({ shouldNotHappen: true }))

    const loadMeshCb = client(fetchImpl as unknown as typeof fetch, 'https://api.fleetless.dev').createMeshLoader('robot1', delegate)
    const [obj, err] = await new Promise<[unknown, Error | undefined]>((resolve) =>
      loadMeshCb('https://evil.example/x.stl', MANAGER, MATERIAL, (o, e) => resolve([o, e])),
    )

    expect(obj).toBeNull()
    expect(err).toBeInstanceOf(FleetlessError)
    expect((err as FleetlessError).code).toBe('untrusted_absolute_url')
    expect(delegate).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('hands the delegate an object URL, not the original path, and forwards manager/material untouched', async () => {
    const meshUrl = 'https://api.fleetless.dev/api/robots/robot1/assets/mesh1'
    const fetchImpl = fakeFetch(async () => bytesResponse(new Uint8Array([9]), { 'content-type': 'model/stl' }))
    const delegate = vi.fn<MeshLoaderDelegate>((_path, _manager, _material, onComplete) => onComplete(null))

    const loadMeshCb = client(fetchImpl as unknown as typeof fetch).createMeshLoader('robot1', delegate)
    await new Promise<void>((resolve) => loadMeshCb(meshUrl, MANAGER, MATERIAL, () => resolve()))

    expect(delegate).toHaveBeenCalledTimes(1)
    const [calledPath, calledManager, calledMaterial] = delegate.mock.calls[0]!
    expect(calledPath).not.toBe(meshUrl)
    expect(calledPath).toMatch(/^blob:/)
    expect(calledManager).toBe(MANAGER)
    expect(calledMaterial).toBe(MATERIAL)
  })

  it('revokes the object URL exactly once after the delegate reports success', async () => {
    const { revokeSpy, createSpy } = spyOnUrl()
    const fetchImpl = fakeFetch(async () => bytesResponse(new Uint8Array([1]), { 'content-type': 'model/stl' }))
    const delegate = vi.fn<MeshLoaderDelegate>((_path, _manager, _material, onComplete) => onComplete({ mesh: true }))

    const loadMeshCb = client(fetchImpl as unknown as typeof fetch).createMeshLoader('robot1', delegate)
    await new Promise<void>((resolve) => loadMeshCb('https://api.fleetless.dev/x', MANAGER, MATERIAL, () => resolve()))

    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(revokeSpy).toHaveBeenCalledTimes(1)
    expect(revokeSpy).toHaveBeenCalledWith(createSpy.mock.results[0]!.value)
  })

  it('revokes the object URL and reports the error when the delegate reports failure', async () => {
    const { revokeSpy } = spyOnUrl()
    const fetchImpl = fakeFetch(async () => bytesResponse(new Uint8Array([1]), { 'content-type': 'model/stl' }))
    const parseError = new Error('malformed STL')
    const delegate = vi.fn<MeshLoaderDelegate>((_path, _manager, _material, onComplete) => onComplete(null, parseError))

    const loadMeshCb = client(fetchImpl as unknown as typeof fetch).createMeshLoader('robot1', delegate)
    const [obj, err] = await new Promise<[unknown, Error | undefined]>((resolve) =>
      loadMeshCb('https://api.fleetless.dev/x', MANAGER, MATERIAL, (o, e) => resolve([o, e])),
    )

    expect(obj).toBeNull()
    expect(err).toBe(parseError)
    expect(revokeSpy).toHaveBeenCalledTimes(1)
  })

  it('catches a delegate that throws synchronously instead of letting it escape into the caller', async () => {
    const { revokeSpy } = spyOnUrl()
    const fetchImpl = fakeFetch(async () => bytesResponse(new Uint8Array([1]), { 'content-type': 'model/stl' }))
    const delegate = vi.fn<MeshLoaderDelegate>(() => {
      throw new Error('three.js blew up')
    })

    const loadMeshCb = client(fetchImpl as unknown as typeof fetch).createMeshLoader('robot1', delegate)
    const [obj, err] = await new Promise<[unknown, Error | undefined]>((resolve) =>
      loadMeshCb('https://api.fleetless.dev/x', MANAGER, MATERIAL, (o, e) => resolve([o, e])),
    )

    expect(obj).toBeNull()
    expect(err?.message).toBe('three.js blew up')
    expect(revokeSpy).toHaveBeenCalledTimes(1)
  })

  it('reports a fetch failure via onComplete without ever creating an object URL', async () => {
    const { createSpy } = spyOnUrl()
    const fetchImpl = fakeFetch(async () => errorResponse('asset_missing', 'no such mesh', 404))
    const delegate = vi.fn<MeshLoaderDelegate>((_path, _manager, _material, onComplete) => onComplete({ shouldNotHappen: true }))

    const loadMeshCb = client(fetchImpl as unknown as typeof fetch).createMeshLoader('robot1', delegate)
    const [obj, err] = await new Promise<[unknown, Error | undefined]>((resolve) =>
      loadMeshCb('https://api.fleetless.dev/x', MANAGER, MATERIAL, (o, e) => resolve([o, e])),
    )

    expect(obj).toBeNull()
    expect(err).toBeInstanceOf(FleetlessError)
    expect(delegate).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('does not hang forever on a delegate that never calls back — a bounded timeout resolves onComplete(null, err) and revokes the URL', async () => {
    const { revokeSpy } = spyOnUrl()
    vi.useFakeTimers()
    const fetchImpl = fakeFetch(async () => bytesResponse(new Uint8Array([1]), { 'content-type': 'model/stl' }))
    const delegate = vi.fn<MeshLoaderDelegate>(() => {
      /* never calls onComplete — a stuck three.js parser */
    })

    const loadMeshCb = client(fetchImpl as unknown as typeof fetch).createMeshLoader('robot1', delegate, { timeoutMs: 1000 })
    let settled: [unknown, Error | undefined] | undefined
    loadMeshCb('https://api.fleetless.dev/x', MANAGER, MATERIAL, (o, e) => {
      settled = [o, e]
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBeDefined()
    const [obj, err] = settled!
    expect(obj).toBeNull()
    expect(err).toBeInstanceOf(Error)
    expect(revokeSpy).toHaveBeenCalledTimes(1)
  })

  it('a late delegate callback after the timeout already fired is a no-op — onComplete does not fire twice and revoke does not double-fire', async () => {
    const { revokeSpy } = spyOnUrl()
    vi.useFakeTimers()
    const fetchImpl = fakeFetch(async () => bytesResponse(new Uint8Array([1]), { 'content-type': 'model/stl' }))
    let lateCallback: ((obj: unknown, err?: Error) => void) | undefined
    const delegate = vi.fn<MeshLoaderDelegate>((_path, _manager, _material, onComplete) => {
      lateCallback = onComplete
    })

    const loadMeshCb = client(fetchImpl as unknown as typeof fetch).createMeshLoader('robot1', delegate, { timeoutMs: 100 })
    let callCount = 0
    loadMeshCb('https://api.fleetless.dev/x', MANAGER, MATERIAL, () => {
      callCount += 1
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(callCount).toBe(1)
    expect(revokeSpy).toHaveBeenCalledTimes(1)

    lateCallback?.({ tooLate: true })
    expect(callCount).toBe(1)
    expect(revokeSpy).toHaveBeenCalledTimes(1)
  })
})

describe('assets.prepareUrdfScene', () => {
  function assetFixture(overrides: Partial<Asset>): Asset {
    return {
      id: 'asset-id',
      robot_id: 'robot1',
      kind: 'mesh',
      name: 'package://robot_description/meshes/x',
      media_type: 'model/stl',
      size_bytes: 1,
      sha256: 'a'.repeat(64),
      created_at: '2026-08-13T00:00:00.000Z',
      ...overrides,
    }
  }

  /** A recording, resettable stand-in for a three.js `LoadingManager` — no three.js dependency, same discipline as the SDK itself. */
  function fakeManager(): UrdfSceneManager & { resolve(url: string): string } {
    let modifier: (url: string) => string = (url) => url
    return {
      setURLModifier(callback) {
        modifier = callback
        return this
      },
      resolve(url) {
        return modifier(url)
      },
    }
  }

  function spyOnUrl() {
    return { revokeSpy: vi.spyOn(URL, 'revokeObjectURL'), createSpy: vi.spyOn(URL, 'createObjectURL') }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const RAW_URDF_TEXT = '<?xml version="1.0"?><robot name="demo_robot"><!-- the developer\'s own comment --></robot>'

  const URDF_ASSET = assetFixture({ id: 'urdf1', kind: 'urdf', name: 'robot_description', media_type: 'application/xml' })
  const MESH_ASSET = assetFixture({ id: 'mesh1', kind: 'mesh', name: 'package://robot_description/meshes/arm.stl' })
  // A .dae's internal texture, named per @fleetless/contracts' rule: the
  // .dae's own package:// directory, joined with its internal reference.
  const DAE_ASSET = assetFixture({
    id: 'dae1',
    kind: 'mesh',
    name: 'package://robot_description/meshes/arm.dae',
    media_type: 'model/vnd.collada+xml',
  })
  const TEXTURE_ASSET = assetFixture({
    id: 'tex1',
    kind: 'texture',
    name: 'package://robot_description/meshes/textures/skin.png',
    media_type: 'image/png',
  })

  const SCENE_LIST_RESPONSE: AssetListResponse = {
    assets: [URDF_ASSET, MESH_ASSET, DAE_ASSET, TEXTURE_ASSET],
    urdf: { present: true, mesh_count: 2, missing: [{ uri: 'package://robot_description/meshes/gripper.stl', element: 'mesh' }] },
    urdf_available: true,
    active_sync: null,
    store: { bytes: 1_000_000_000, used_bytes: 8192 },
    joint_state_slug: null,
  }

  function sceneFetch() {
    return fakeFetch(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/robots/robot1/assets')) return jsonResponse(SCENE_LIST_RESPONSE)
      if (url.endsWith(`/assets/${URDF_ASSET.id}`)) {
        return bytesResponse(new TextEncoder().encode(RAW_URDF_TEXT), { 'content-type': 'application/xml' })
      }
      if (url.endsWith(`/assets/${MESH_ASSET.id}`)) return bytesResponse(new Uint8Array([1, 2, 3]), { 'content-type': 'model/stl' })
      if (url.endsWith(`/assets/${DAE_ASSET.id}`)) {
        return bytesResponse(new Uint8Array([4, 5, 6]), { 'content-type': 'model/vnd.collada+xml' })
      }
      if (url.endsWith(`/assets/${TEXTURE_ASSET.id}`)) return bytesResponse(new Uint8Array([7, 8, 9]), { 'content-type': 'image/png' })
      throw new Error(`unexpected fetch in this test: ${url}`)
    })
  }

  it("fetches the URDF's raw bytes (not the cloud-rewritten urdf() text) and installs a modifier resolving every mesh/texture asset by its package:// name", async () => {
    const fetchImpl = sceneFetch()
    const manager = fakeManager()

    const result = await client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', manager)

    // Raw, not re-serialized — the developer's own comment survives, which
    // urdf()'s rewrite (parse + re-emit) would drop.
    expect(result.urdfText).toBe(RAW_URDF_TEXT)
    // Not reduced to a bare string — `element` must survive
    // this call the same way it survives list()'s untouched passthrough.
    expect(result.missing).toEqual([{ uri: 'package://robot_description/meshes/gripper.stl', element: 'mesh' }])

    const meshUrl = manager.resolve(MESH_ASSET.name)
    const daeUrl = manager.resolve(DAE_ASSET.name)
    // The naming rule's whole point: the .dae's internal reference,
    // normalized into the .dae's own package:// directory, resolves too.
    const textureUrl = manager.resolve(TEXTURE_ASSET.name)
    expect(meshUrl).toMatch(/^blob:/)
    expect(daeUrl).toMatch(/^blob:/)
    expect(textureUrl).toMatch(/^blob:/)
    expect(new Set([meshUrl, daeUrl, textureUrl]).size).toBe(3)

    // The urdf asset's own name ('robot_description') is not a package://
    // reference and not root-relative, so it's outside this method's
    // namespace — passed through unchanged, like anything else unrelated to
    // this robot's assets. Nothing should ask the modifier to resolve it,
    // since it's never referenced by a <mesh>/<texture>.
    expect(manager.resolve(URDF_ASSET.name)).toBe(URDF_ASSET.name)

    // A foreign absolute URL never reaches the browser's own fetch —
    // resolved to an inert, page-local blob: URL instead of the original
    // string, so nothing leaves the browser for it. See the dedicated test
    // below for the full claim.
    expect(manager.resolve('https://evil.example/x.stl')).toMatch(/^blob:/)
    expect(manager.resolve('https://evil.example/x.stl')).not.toBe('https://evil.example/x.stl')
  })

  // URDFLoader.resolvePath() passes a non-package:// filename through
  // unchanged, so an unmapped <mesh filename="http://attacker.example/x.stl">
  // (or an off-origin <texture>) would otherwise reach the browser's own
  // fetch verbatim — no credential travels with it, but it's still a real
  // network request to an attacker-named host, for every viewer who renders
  // the URDF. http.ts's untrusted_absolute_url check already refuses this
  // for createMeshLoader; this proves the newer path does too, one layer
  // down.
  it('never lets an owned-but-unresolvable reference (a foreign absolute URL, in particular) reach the network — resolves to a shared, inert, page-local blob instead', async () => {
    const fetchImpl = fakeFetch(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/robots/robot1/assets')) return jsonResponse(SCENE_LIST_RESPONSE)
      if (url.endsWith(`/assets/${URDF_ASSET.id}`)) {
        return bytesResponse(new TextEncoder().encode(RAW_URDF_TEXT), { 'content-type': 'application/xml' })
      }
      if (url.endsWith(`/assets/${MESH_ASSET.id}`)) return bytesResponse(new Uint8Array([1, 2, 3]), { 'content-type': 'model/stl' })
      if (url.endsWith(`/assets/${DAE_ASSET.id}`)) return bytesResponse(new Uint8Array([4, 5, 6]), { 'content-type': 'model/vnd.collada+xml' })
      if (url.endsWith(`/assets/${TEXTURE_ASSET.id}`)) return bytesResponse(new Uint8Array([7, 8, 9]), { 'content-type': 'image/png' })
      throw new Error(`must never fetch an owned-but-unresolvable reference: ${url}`)
    })
    const manager = fakeManager()

    await client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', manager)

    // Refused regardless of ownership — an absolute network URL, D4's
    // original guarantee, holds even for a package a robot's meshes never
    // named at all.
    const attackerUrl = manager.resolve('http://attacker.example/beacon.stl')
    // Refused because it's ours (package:// scheme) and unmapped — the
    // exact reference urdf.missing itself reports.
    const missingRef = manager.resolve('package://robot_description/meshes/gripper.stl')
    // Refused because it's ours (root-relative, known package prefix) and
    // unmapped — a mesh within a KNOWN package that this robot simply
    // never had, as distinct from content outside the namespace entirely.
    const unsyncedInKnownPackage = manager.resolve('/robot_description/meshes/nonexistent.stl')
    expect(attackerUrl).toMatch(/^blob:/)
    expect(missingRef).toMatch(/^blob:/)
    expect(unsyncedInKnownPackage).toMatch(/^blob:/)
    // The same shared sentinel every time, not a per-input blob — nothing
    // about the unmapped reference is ever encoded into what gets returned.
    expect(attackerUrl).toBe(missingRef)
    expect(attackerUrl).toBe(unsyncedInKnownPackage)
    expect(fetchImpl).not.toHaveBeenCalledWith('http://attacker.example/beacon.stl', expect.anything())
  })

  // setURLModifier is a single global hook on whatever LoadingManager the
  // caller passed in, and nothing requires that manager to be dedicated to
  // this call — it's routinely the app's own scene-wide one, shared for an
  // HDRI, an environment map, a font atlas, a ground texture. Refusing
  // everything unmapped would silently empty all of those the moment a
  // caller shared their manager: the robot renders correctly and everything
  // around it vanishes, with no error naming the cause.
  it("leaves the caller's own unrelated content (loaded through the same shared manager) completely alone — same-origin, relative, root-relative under a different namespace, all pass through unchanged", async () => {
    const fetchImpl = sceneFetch()
    const manager = fakeManager()

    await client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', manager)

    // A relative path — an HDRI or ground texture bundled by the app's own
    // build tool.
    expect(manager.resolve('textures/env.hdr')).toBe('textures/env.hdr')
    // Root-relative, but under a package name this robot's assets never
    // mention — the app's own static asset route, not this robot's
    // namespace at all.
    expect(manager.resolve('/fonts/atlas.png')).toBe('/fonts/atlas.png')
    // Absolute, but a scheme that never causes network egress on its own —
    // left alone rather than mistaken for something to refuse.
    expect(manager.resolve('data:image/png;base64,AA==')).toBe('data:image/png;base64,AA==')
  })

  it("treats a reference to an entirely-unsynced package as ours to refuse, not a coincidence to pass through — derived from urdf.missing, not only from what actually fetched", async () => {
    const unsyncedPackageRef = 'package://gripper_description/meshes/claw.stl'
    const listResponse: AssetListResponse = {
      assets: [URDF_ASSET, MESH_ASSET], // no gripper_description asset was ever synced
      urdf: { present: true, mesh_count: 2, missing: [{ uri: unsyncedPackageRef, element: 'mesh' }] },
      urdf_available: true,
      active_sync: null,
      store: { bytes: 1_000_000_000, used_bytes: 8192 },
      joint_state_slug: null,
    }
    const fetchImpl = fakeFetch(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/robots/robot1/assets')) return jsonResponse(listResponse)
      if (url.endsWith(`/assets/${URDF_ASSET.id}`)) {
        return bytesResponse(new TextEncoder().encode(RAW_URDF_TEXT), { 'content-type': 'application/xml' })
      }
      if (url.endsWith(`/assets/${MESH_ASSET.id}`)) return bytesResponse(new Uint8Array([1, 2, 3]), { 'content-type': 'model/stl' })
      throw new Error(`unexpected fetch in this test: ${url}`)
    })
    const manager = fakeManager()

    await client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', manager)

    // The root-relative form of a package this robot has NO synced asset
    // for at all — still refused, not passed through as if it were the
    // app's own unrelated content.
    const resolved = manager.resolve('/gripper_description/meshes/claw.stl')
    expect(resolved).toMatch(/^blob:/)
    expect(resolved).not.toBe('/gripper_description/meshes/claw.stl')
  })

  // three.js builds the request for a .dae's internal reference by plain
  // concatenation (this.path + url, no ../. collapsing), while asset.name
  // carries the NORMALIZED tail — so a .dae in meshes/ whose <init_from>
  // says ../textures/skin.png or ./textures/skin.png asks the modifier for
  // /pkg/meshes/../textures/skin.png or /pkg/meshes/./textures/skin.png,
  // neither the direct key. Both are ordinary exporter output: a sibling
  // textures/ directory is the standard ROS layout, and Blender writes ./
  // routinely.
  it("resolves a .dae's own unnormalized internal reference (../, ./) via the second-chance normalized lookup, not only the direct key", async () => {
    const fetchImpl = sceneFetch()
    const manager = fakeManager()

    await client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', manager)

    // TEXTURE_ASSET.name is package://robot_description/meshes/textures/skin.png
    // -> direct key /robot_description/meshes/textures/skin.png. Neither of
    // these is that string, but both normalize to it.
    //
    // viaDotDot: a .dae one level deeper (meshes/sub/arm.dae) whose
    // <init_from> says ../textures/skin.png -> path (meshes/sub/) + url
    // (../textures/skin.png).
    const viaDotDot = manager.resolve('/robot_description/meshes/sub/../textures/skin.png')
    // viaDot: a .dae in meshes/ whose <init_from> says ./textures/skin.png.
    const viaDot = manager.resolve('/robot_description/meshes/./textures/skin.png')
    const textureUrl = manager.resolve(TEXTURE_ASSET.name)

    expect(viaDotDot).toBe(textureUrl)
    expect(viaDot).toBe(textureUrl)
  })

  it('does not normalize a package:// reference or an absolute URL when trying the second-chance lookup — only a bare path', async () => {
    const fetchImpl = sceneFetch()
    const manager = fakeManager()

    await client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', manager)

    // A package:// string containing '..' is refused at the producer (the
    // bridge's own containment check), never reaches asset.name — so this
    // method must not go looking for one by normalizing what looks like a
    // package:// reference. And an off-origin URL must never be rewritten
    // into something that could coincidentally land on a real asset name.
    const stillRefused = manager.resolve('http://attacker.example/../robot_description/meshes/arm.stl')
    const meshUrl = manager.resolve(MESH_ASSET.name)
    expect(stillRefused).not.toBe(meshUrl)
    expect(stillRefused).toMatch(/^blob:/) // refused, not resolved to a real asset
  })

  // urdf-loader's own URDFLoader.parse() resolves package:// itself, via
  // resolvePath(), BEFORE loadMeshCb/manager.resolveURL ever run — under
  // its default `packages: ''` that turns `package://pkg/rel` into the
  // root-relative `/pkg/rel`, which is what the modifier is actually asked
  // to resolve, not the literal package:// string. Without the second key
  // this method registers, the lookup always missed and every mesh request
  // fell through to the app's own origin (confirmed live: an STL parser
  // choking on a Vite dev-server's index.html).
  it("also resolves urdf-loader's own default-resolved (root-relative) form of each name, not only the literal package:// string", async () => {
    const fetchImpl = sceneFetch()
    const manager = fakeManager()

    await client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', manager)

    const meshUrlByName = manager.resolve(MESH_ASSET.name)
    const meshUrlByResolvedPath = manager.resolve('/robot_description/meshes/arm.stl')
    expect(meshUrlByResolvedPath).toMatch(/^blob:/)
    expect(meshUrlByResolvedPath).toBe(meshUrlByName) // same blob, either key

    // The .dae-internal case: ColladaLoader computes its own working path
    // from the ALREADY-resolved .dae URL (/robot_description/meshes/), so the
    // internal reference resolves to the root-relative form too, one level
    // deeper — the exact case that renders a texture at all.
    const textureUrlByResolvedPath = manager.resolve('/robot_description/meshes/textures/skin.png')
    expect(textureUrlByResolvedPath).toBe(manager.resolve(TEXTURE_ASSET.name))
  })

  it.each([0, -1, -6, 1.5, NaN])(
    'throws invalid_option for a non-positive-integer options.concurrency (%s), before any fetch — a silent 0-worker batch would otherwise return a scene that renders completely blank with no error',
    async (concurrency) => {
      const fetchImpl = fakeFetch(async (input) => {
        throw new Error(`must not fetch anything for an invalid concurrency: ${String(input)}`)
      })

      await expect(
        client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', fakeManager(), { concurrency }),
      ).rejects.toMatchObject({ code: 'invalid_option' })
    },
  )

  it('throws no_urdf_synced, without fetching anything else, when the asset list has no urdf-kind row', async () => {
    const listWithoutUrdf: AssetListResponse = {
      assets: [MESH_ASSET],
      urdf: { present: false, mesh_count: 0, missing: [] },
      urdf_available: null,
      active_sync: null,
      store: { bytes: 1_000_000_000, used_bytes: 8192 },
      joint_state_slug: null,
    }
    const fetchImpl = fakeFetch(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/robots/robot1/assets')) return jsonResponse(listWithoutUrdf)
      throw new Error(`must not fetch anything once no urdf asset was found: ${url}`)
    })

    await expect(
      client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', fakeManager()),
    ).rejects.toMatchObject({ code: 'no_urdf_synced' })
  })

  it('dispose revokes every real asset blob URL it created (and only those — never the shared refused-reference sentinel) and keeps refusing owned references afterwards', async () => {
    const { revokeSpy } = spyOnUrl()
    const fetchImpl = sceneFetch()
    const manager = fakeManager()

    const { dispose } = await client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', manager)
    const meshUrlBeforeDispose = manager.resolve(MESH_ASSET.name)
    expect(meshUrlBeforeDispose).toMatch(/^blob:/)

    dispose()

    // mesh + dae + texture only — not the urdf asset (never blobbed), and
    // not the shared refused-reference sentinel, which is deliberately
    // never revoked.
    expect(revokeSpy).toHaveBeenCalledTimes(3)
    expect(revokeSpy).toHaveBeenCalledWith(meshUrlBeforeDispose)

    // The installed modifier is NOT reset to identity — a mesh reference
    // is still "ours" and, with the map now
    // cleared, still correctly refused, not handed back raw.
    const meshUrlAfterDispose = manager.resolve(MESH_ASSET.name)
    expect(meshUrlAfterDispose).toMatch(/^blob:/)
    expect(meshUrlAfterDispose).not.toBe(meshUrlBeforeDispose) // the old blob is gone; this is the sentinel
    // Still ownership-aware post-dispose too: unrelated content keeps
    // passing through, exactly like the active state.
    expect(manager.resolve('/some-other-app/asset.png')).toBe('/some-other-app/asset.png')

    dispose() // safe to call again — no double-revoke
    expect(revokeSpy).toHaveBeenCalledTimes(3)
  })

  it('bounds concurrent asset fetches to options.concurrency', async () => {
    const meshes = Array.from({ length: 5 }, (_, i) =>
      assetFixture({ id: `mesh${i}`, kind: 'mesh', name: `package://robot_description/meshes/m${i}.stl` }),
    )
    const listResponse: AssetListResponse = {
      assets: [URDF_ASSET, ...meshes],
      urdf: { present: true, mesh_count: meshes.length, missing: [] },
      urdf_available: true,
      active_sync: null,
      store: { bytes: 1_000_000_000, used_bytes: 8192 },
      joint_state_slug: null,
    }

    let inFlight = 0
    let maxInFlight = 0
    const releases: Array<() => void> = []

    const fetchImpl = fakeFetch(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/robots/robot1/assets')) return jsonResponse(listResponse)
      if (url.endsWith(`/assets/${URDF_ASSET.id}`)) {
        return bytesResponse(new TextEncoder().encode(RAW_URDF_TEXT), { 'content-type': 'application/xml' })
      }
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>((resolve) => {
        releases.push(() => {
          inFlight -= 1
          resolve()
        })
      })
      return bytesResponse(new Uint8Array([1]), { 'content-type': 'model/stl' })
    })

    const manager = fakeManager()
    const resultPromise = client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', manager, { concurrency: 2 })

    let done = false
    resultPromise.then(() => {
      done = true
    })

    // Real-timer drain: release whatever is currently blocked and give the
    // pool a tick to start the next one, until the whole call settles.
    for (let i = 0; i < 500 && !done; i++) {
      if (releases.length > 0) releases.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 2))
    }

    await resultPromise
    expect(done).toBe(true)
    expect(maxInFlight).toBe(2) // reached the cap, and never exceeded it
  })

  it('rejects the whole call (no partial scene) and revokes any blob URLs already created before the failure — the caller never gets a dispose() to do it themselves', async () => {
    const { revokeSpy, createSpy } = spyOnUrl()
    const fetchImpl = fakeFetch(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/robots/robot1/assets')) return jsonResponse(SCENE_LIST_RESPONSE)
      if (url.endsWith(`/assets/${URDF_ASSET.id}`)) {
        return bytesResponse(new TextEncoder().encode(RAW_URDF_TEXT), { 'content-type': 'application/xml' })
      }
      if (url.endsWith(`/assets/${MESH_ASSET.id}`)) return bytesResponse(new Uint8Array([1, 2, 3]), { 'content-type': 'model/stl' })
      if (url.endsWith(`/assets/${DAE_ASSET.id}`)) return errorResponse('asset_missing', 'gone', 404) // this one fails
      if (url.endsWith(`/assets/${TEXTURE_ASSET.id}`)) return bytesResponse(new Uint8Array([7, 8, 9]), { 'content-type': 'image/png' })
      throw new Error(`unexpected fetch in this test: ${url}`)
    })

    await expect(
      client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', fakeManager()),
    ).rejects.toMatchObject({ code: 'asset_missing' })

    // forEachWithConcurrency guarantees every item is attempted before
    // this rejects — deterministic now, not a race against whichever
    // fetches happened to resolve before the catch ran: mesh and texture
    // succeed (2 real blobs), dae fails (0). Plus the shared refused-
    // reference sentinel, created unconditionally and deliberately NEVER
    // revoked — so revokeSpy is one short of createSpy, not equal to
    // it, and that gap is itself the thing under test.
    expect(createSpy.mock.results.length).toBe(3) // mesh + texture + the sentinel
    expect(revokeSpy).toHaveBeenCalledTimes(2) // mesh + texture only
    // Exactly one of the three created values (the sentinel — created
    // first, before the fetch loop, so not necessarily last) is never
    // revoked; the other two are.
    const created = createSpy.mock.results.map((r) => r.value)
    const revoked = revokeSpy.mock.calls.map((c) => c[0])
    expect(revoked.every((url) => created.includes(url))).toBe(true)
    expect(created.filter((url) => !revoked.includes(url)).length).toBe(1)
  })

  // Racing Promise.all over the worker loops rejects on the first failure —
  // but another worker, mid-flight on a different item, isn't cancelled by
  // that. Its eventual success creates a blob: URL after the catch already
  // decided what to clean up, and the caller never gets a dispose() to
  // revoke it with. For 24 meshes with one 404 that's 23 blob URLs created
  // and none revoked. Engineered here with a controllable delay so the
  // failure is guaranteed observed first — proving the fix for the timing
  // that actually happens, not the timing a same-microtask fixture happens
  // to construct, which is exactly what this test's predecessor did and
  // could not have caught.
  it('does not leak a blob URL created by a fetch that is still in flight when an earlier fetch in the same batch has already failed', async () => {
    const { revokeSpy, createSpy } = spyOnUrl()
    let releaseMesh: (() => void) | undefined
    const fetchImpl = fakeFetch(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/robots/robot1/assets')) return jsonResponse(SCENE_LIST_RESPONSE)
      if (url.endsWith(`/assets/${URDF_ASSET.id}`)) {
        return bytesResponse(new TextEncoder().encode(RAW_URDF_TEXT), { 'content-type': 'application/xml' })
      }
      if (url.endsWith(`/assets/${DAE_ASSET.id}`)) return errorResponse('asset_missing', 'gone', 404) // fails immediately
      if (url.endsWith(`/assets/${MESH_ASSET.id}`)) {
        // Deliberately still pending when the dae failure is observed —
        // the exact ordering the review measured.
        await new Promise<void>((resolve) => {
          releaseMesh = resolve
        })
        return bytesResponse(new Uint8Array([1, 2, 3]), { 'content-type': 'model/stl' })
      }
      if (url.endsWith(`/assets/${TEXTURE_ASSET.id}`)) return bytesResponse(new Uint8Array([7, 8, 9]), { 'content-type': 'image/png' })
      throw new Error(`unexpected fetch in this test: ${url}`)
    })

    const resultPromise = client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', fakeManager())

    // Real timers, no fake clock: give the dae failure and the texture
    // success a chance to land while mesh is still deliberately held open.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(releaseMesh).toBeDefined() // confirms mesh really was still in flight at this point
    releaseMesh?.()

    await expect(resultPromise).rejects.toMatchObject({ code: 'asset_missing' })

    // texture + mesh (once released) + the sentinel — every one revoked
    // except the sentinel.
    expect(createSpy.mock.results.length).toBe(3)
    expect(revokeSpy).toHaveBeenCalledTimes(2)
  })

  // Without an AbortSignal there's no cancel handle — a caller who
  // navigates away or switches robots mid-load can't stop the in-flight
  // fetches; they run to completion or failure regardless. Same cleanup
  // discipline as the tests above, triggered by an abort instead of a fetch
  // failure.
  it('rejects with aborted, before any fetch, when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = fakeFetch(async () => {
      throw new Error('must not fetch anything once the signal is already aborted')
    })

    await expect(
      client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', fakeManager(), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('forwards the signal to the underlying fetch() — proof, not acceptance: the exact AbortSignal instance reaches the network call, not merely an option this SDK accepted and did nothing with', async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | null | undefined
    const fetchImpl = fakeFetch(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/robots/robot1/assets')) return jsonResponse(SCENE_LIST_RESPONSE)
      if (url.endsWith(`/assets/${URDF_ASSET.id}`)) {
        observedSignal = init?.signal
        return bytesResponse(new TextEncoder().encode(RAW_URDF_TEXT), { 'content-type': 'application/xml' })
      }
      return bytesResponse(new Uint8Array([1]), { 'content-type': 'model/stl' })
    })

    await client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', fakeManager(), { signal: controller.signal })

    expect(observedSignal).toBe(controller.signal)
  })

  it('an abort firing MID-FLIGHT actually rejects the in-flight fetch — not merely stops the SDK from scheduling more — and revokes every blob URL already created before it, the same as any other mid-batch failure', async () => {
    const { revokeSpy, createSpy } = spyOnUrl()
    const controller = new AbortController()
    let confirmStillInFlight: (() => void) | undefined

    const fetchImpl = fakeFetch(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/robots/robot1/assets')) return jsonResponse(SCENE_LIST_RESPONSE)
      if (url.endsWith(`/assets/${URDF_ASSET.id}`)) {
        return bytesResponse(new TextEncoder().encode(RAW_URDF_TEXT), { 'content-type': 'application/xml' })
      }
      if (url.endsWith(`/assets/${DAE_ASSET.id}`)) {
        // Held open until the controller aborts — resolved the same way a
        // real fetch() rejects an in-flight request when ITS OWN signal
        // fires, so this proves the abort actually reaches the request
        // rather than merely being noticed by this SDK afterwards.
        return new Promise<Response>((_resolve, reject) => {
          confirmStillInFlight = () => undefined
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
        })
      }
      if (url.endsWith(`/assets/${MESH_ASSET.id}`)) return bytesResponse(new Uint8Array([1, 2, 3]), { 'content-type': 'model/stl' })
      if (url.endsWith(`/assets/${TEXTURE_ASSET.id}`)) return bytesResponse(new Uint8Array([7, 8, 9]), { 'content-type': 'image/png' })
      throw new Error(`unexpected fetch in this test: ${url}`)
    })

    const resultPromise = client(fetchImpl as unknown as typeof fetch).prepareUrdfScene('robot1', fakeManager(), {
      signal: controller.signal,
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(confirmStillInFlight).toBeDefined() // the dae fetch really was still pending at this point
    controller.abort()

    await expect(resultPromise).rejects.toMatchObject({ code: 'aborted' })

    // mesh + texture had already resolved into real blobs before the abort;
    // the sentinel is created unconditionally too — three creates. Every
    // create except the sentinel is revoked (a successful call keeps
    // relying on the sentinel after `dispose()`; an aborted call never
    // returns a `dispose()` at all, but that doesn't change what created
    // it).
    expect(createSpy.mock.results.length).toBe(3)
    expect(revokeSpy).toHaveBeenCalledTimes(2)
  })

  // Combining createMeshLoader and prepareUrdfScene on one manager is a
  // mistake, and it does not "double-fetch every mesh" — what happens is
  // asymmetric breakage a developer would debug as the wrong problem. So
  // it's refused loudly at the point it would manifest, not only
  // documented.
  it('refuses createMeshLoader on the same manager prepareUrdfScene already installed its modifier on', async () => {
    const fetchImpl = sceneFetch()
    const manager = fakeManager()
    const api = client(fetchImpl as unknown as typeof fetch)

    await api.prepareUrdfScene('robot1', manager)

    const delegate = vi.fn<MeshLoaderDelegate>((_path, _mgr, _material, onComplete) => onComplete({ shouldNotHappen: true }))
    const loadMeshCb = api.createMeshLoader('robot1', delegate)

    const [obj, err] = await new Promise<[unknown, Error | undefined]>((resolve) =>
      loadMeshCb('https://api.fleetless.dev/api/robots/robot1/assets/mesh1', manager, { id: 'material' }, (o, e) => resolve([o, e])),
    )

    expect(obj).toBeNull()
    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toMatch(/createMeshLoader and prepareUrdfScene/)
    expect(delegate).not.toHaveBeenCalled()
  })

  it('does not refuse createMeshLoader on a DIFFERENT manager — only the exact instance prepareUrdfScene installed on', async () => {
    const fetchImpl = sceneFetch()
    const preparedManager = fakeManager()
    const otherManager = { id: 'unrelated-manager' }
    const api = client(fetchImpl as unknown as typeof fetch)

    await api.prepareUrdfScene('robot1', preparedManager)

    const meshUrl = 'https://api.fleetless.dev/api/robots/robot1/assets/mesh1'
    const meshFetchImpl = fakeFetch(async () => bytesResponse(new Uint8Array([1]), { 'content-type': 'model/stl' }))
    const delegate = vi.fn<MeshLoaderDelegate>((_path, _mgr, _material, onComplete) => onComplete({ ok: true }))
    const loadMeshCb = client(meshFetchImpl as unknown as typeof fetch, 'https://api.fleetless.dev').createMeshLoader('robot1', delegate)

    const [obj, err] = await new Promise<[unknown, Error | undefined]>((resolve) =>
      loadMeshCb(meshUrl, otherManager, { id: 'material' }, (o, e) => resolve([o, e])),
    )

    expect(err).toBeUndefined()
    expect(obj).toEqual({ ok: true })
    expect(delegate).toHaveBeenCalledTimes(1)
  })
})
