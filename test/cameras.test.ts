// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from 'vitest'
import { SNAPSHOT_HEADERS, type LiveSessionResponse } from '@fleetless/contracts'
import { HttpClient, noCredentials } from '../src/http.js'
import { createCamerasApi } from '../src/cameras.js'
import { FleetlessError } from '../src/errors.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function errorResponse(code: string, message: string, status = 404): Response {
  return jsonResponse({ code, message }, status)
}

function snapshotResponse(bytes: Uint8Array, headers: Record<string, string>, status = 200): Response {
  return new Response(bytes as BodyInit, { status, headers })
}

function fakeFetch(impl: (input: string | URL | RequestInfo, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl)
}

function client(fetchImpl: typeof fetch) {
  const http = new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl, credentials: noCredentials })
  return createCamerasApi(http)
}

describe('cameras.list', () => {
  it('reads the camera descriptors for a robot', async () => {
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/robot1/cameras')
      return jsonResponse({ cameras: [{ slug: 'front', width: 1280, height: 720, fps: 15, snapshot_interval_ms: 5000 }] })
    })

    await expect(client(fetchImpl as unknown as typeof fetch).list('robot1')).resolves.toEqual([
      { slug: 'front', width: 1280, height: 720, fps: 15, snapshot_interval_ms: 5000 },
    ])
  })
})

describe('cameras — path traversal defence', () => {
  // `pathSegment()` is proved against a real server in http.test.ts; this
  // confirms every camera route calls it for both robotId and slug, so
  // reverting a call site to raw interpolation fails here, not just on a
  // real server.
  it('encodes a robotId/slug shaped like a traversal attempt rather than sending it as literal path segments', async () => {
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/..%2F..%2Fadmin/cameras/..%2F..%2Fother-robot%2Ffront/snapshot/meta')
      return jsonResponse({ mime: 'image/jpeg', width: 1, height: 1, timestamp_ms: 1, age_ms: 1 })
    })

    await client(fetchImpl as unknown as typeof fetch).snapshotMeta('../../admin', '../../other-robot/front')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('cameras.snapshot', () => {
  it('returns the image bytes and metadata read from the named headers, not recomputed', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/robot1/cameras/front/snapshot')
      return snapshotResponse(bytes, {
        'content-type': 'image/jpeg',
        [SNAPSHOT_HEADERS.ageMs]: '1234',
        [SNAPSHOT_HEADERS.timestampMs]: '1786440000000',
        [SNAPSHOT_HEADERS.width]: '1280',
        [SNAPSHOT_HEADERS.height]: '720',
      })
    })

    const snapshot = await client(fetchImpl as unknown as typeof fetch).snapshot('robot1', 'front')
    expect(snapshot.image).toEqual(bytes)
    expect(snapshot.mime).toBe('image/jpeg')
    expect(snapshot.age_ms).toBe(1234)
    expect(snapshot.timestamp_ms).toBe(1786440000000)
    expect(snapshot.width).toBe(1280)
    expect(snapshot.height).toBe(720)
  })

  it('strips content-type parameters, keeping only the mime', async () => {
    const fetchImpl = fakeFetch(async () =>
      snapshotResponse(new Uint8Array([1]), {
        'content-type': 'image/jpeg; charset=binary',
        [SNAPSHOT_HEADERS.ageMs]: '1',
        [SNAPSHOT_HEADERS.timestampMs]: '1',
        [SNAPSHOT_HEADERS.width]: '1',
        [SNAPSHOT_HEADERS.height]: '1',
      }),
    )
    const snapshot = await client(fetchImpl as unknown as typeof fetch).snapshot('robot1', 'front')
    expect(snapshot.mime).toBe('image/jpeg')
  })

  it('turns no_snapshot_yet into a non-throwing null read — a state, not a failure', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse('no_snapshot_yet', 'nothing captured yet'))

    const snapshot = await client(fetchImpl as unknown as typeof fetch).snapshot('robot1', 'front')
    expect(snapshot).toEqual({ image: null, mime: null, width: null, height: null, timestamp_ms: null, age_ms: null })
  })

  it('still throws for a real refusal (camera_offline is not the same as no_snapshot_yet)', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse('camera_offline', 'no bridge connected', 409))

    await expect(client(fetchImpl as unknown as typeof fetch).snapshot('robot1', 'front')).rejects.toMatchObject({
      code: 'camera_offline',
    })
  })

  it('still throws for a permission refusal, indistinguishable from an unknown slug', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse('not_found', 'no such camera', 404))

    await expect(client(fetchImpl as unknown as typeof fetch).snapshot('robot1', 'front')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('cameras.snapshotMeta', () => {
  it('reads age without downloading bytes', async () => {
    const fetchImpl = fakeFetch(async (input) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/robot1/cameras/front/snapshot/meta')
      return jsonResponse({ slug: 'front', timestamp_ms: 1000, age_ms: 500, width: 1280, height: 720, mime: 'image/jpeg' })
    })

    await expect(client(fetchImpl as unknown as typeof fetch).snapshotMeta('robot1', 'front')).resolves.toEqual({
      mime: 'image/jpeg',
      width: 1280,
      height: 720,
      timestamp_ms: 1000,
      age_ms: 500,
    })
  })

  it('represents "nothing captured yet" as nulls when the JSON body already says so', async () => {
    const fetchImpl = fakeFetch(async () =>
      jsonResponse({ slug: 'front', timestamp_ms: null, age_ms: null, width: null, height: null, mime: null }),
    )

    await expect(client(fetchImpl as unknown as typeof fetch).snapshotMeta('robot1', 'front')).resolves.toEqual({
      mime: null,
      width: null,
      height: null,
      timestamp_ms: null,
      age_ms: null,
    })
  })

  it('also absorbs no_snapshot_yet if the meta route answers with the error code instead', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse('no_snapshot_yet', 'nothing captured yet'))

    await expect(client(fetchImpl as unknown as typeof fetch).snapshotMeta('robot1', 'front')).resolves.toEqual({
      mime: null,
      width: null,
      height: null,
      timestamp_ms: null,
      age_ms: null,
    })
  })
})

/**
 * A `liveSessionResponse` fixture, one distinct `session_id` per tab a test
 * simulates.
 *
 * Typed against `LiveSessionResponse` on purpose — `jsonResponse()` takes
 * `unknown`, so a bare object literal can go stale against a newly-required
 * field (`session_id` did, silently, every test still green because each
 * only asserted what it cared about). This is the one fixture checked
 * structurally; `jsonResponse()` stays untyped so it can still serve loose
 * shapes (error bodies, partial responses for other routes).
 */
function liveSessionBody(sessionId: string, token = 'tok'): LiveSessionResponse {
  return { session_id: sessionId, url: 'wss://media.fleetless.dev', room: 'r-1', token, expires_at: '2026-08-11T12:00:00.000Z' }
}

describe('cameras.live', () => {
  it('POSTs to take a hold and resolves the LiveKit session, including its own session_id', async () => {
    const fetchImpl = fakeFetch(async (input, init) => {
      expect(String(input)).toBe('https://api.fleetless.dev/api/robots/robot1/cameras/front/live')
      expect(init?.method).toBe('POST')
      return jsonResponse(liveSessionBody('sess-1'))
    })

    const session = await client(fetchImpl as unknown as typeof fetch).live('robot1', 'front')
    expect(session.session_id).toBe('sess-1')
    expect(session.url).toBe('wss://media.fleetless.dev')
    expect(session.room).toBe('r-1')
    expect(session.token).toBe('tok')
    expect(session.expires_at).toBe('2026-08-11T12:00:00.000Z')
    expect(typeof session.release).toBe('function')
  })

  it('release() DELETEs the hold with this session\'s own session_id as a query parameter', async () => {
    const calls: Array<{ method?: string; url?: string }> = []
    const fetchImpl = fakeFetch(async (input, init) => {
      calls.push({ method: init?.method, url: String(input) })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return jsonResponse(liveSessionBody('sess-1'))
    })

    const session = await client(fetchImpl as unknown as typeof fetch).live('robot1', 'front')
    await session.release()

    const deletes = calls.filter((c) => c.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    // Parsed with the platform's own URL/URLSearchParams, the way a real
    // client (and the cloud route) would read it — not a substring match,
    // which would also pass for a malformed query string.
    const url = new URL(deletes[0]!.url!)
    expect(url.pathname).toBe('/api/robots/robot1/cameras/front/live')
    expect(url.searchParams.get('session_id')).toBe('sess-1')
  })

  it('release() is idempotent: calling it twice (even concurrently) sends exactly one DELETE', async () => {
    let deleteCount = 0
    const fetchImpl = fakeFetch(async (_input, init) => {
      if (init?.method === 'DELETE') {
        deleteCount += 1
        return new Response(null, { status: 204 })
      }
      return jsonResponse(liveSessionBody('sess-1'))
    })

    const session = await client(fetchImpl as unknown as typeof fetch).live('robot1', 'front')
    await Promise.all([session.release(), session.release()])
    await session.release()

    expect(deleteCount).toBe(1)
  })

  it('release() never rejects, even when the DELETE fails — it is a courtesy notification, not what actually stops the stream', async () => {
    const fetchImpl = fakeFetch(async (_input, init) => {
      if (init?.method === 'DELETE') return errorResponse('not_found', 'already released', 404)
      return jsonResponse(liveSessionBody('sess-1'))
    })

    const session = await client(fetchImpl as unknown as typeof fetch).live('robot1', 'front')
    await expect(session.release()).resolves.toBeUndefined()
  })

  it('propagates camera_offline from the POST as a thrown error — a live request must be refused, never queued', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse('camera_offline', 'bridge not connected', 409))

    await expect(client(fetchImpl as unknown as typeof fetch).live('robot1', 'front')).rejects.toMatchObject({
      code: 'camera_offline',
    })
  })

  it('propagates live_unavailable from the POST as a thrown error', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse('live_unavailable', 'LiveKit is down', 503))

    await expect(client(fetchImpl as unknown as typeof fetch).live('robot1', 'front')).rejects.toMatchObject({
      code: 'live_unavailable',
    })
  })

  it('two live() calls for the same (robot, slug) are independent — no local dedup, each gets its own POST and its own session', async () => {
    let postCount = 0
    const fetchImpl = fakeFetch(async (_input, init) => {
      if (init?.method === 'POST') {
        postCount += 1
        return jsonResponse(liveSessionBody(`sess-${postCount}`, `tok-${postCount}`))
      }
      return new Response(null, { status: 204 })
    })

    const cam = client(fetchImpl as unknown as typeof fetch)
    const [a, b] = await Promise.all([cam.live('robot1', 'front'), cam.live('robot1', 'front')])

    expect(postCount).toBe(2)
    expect(a.token).not.toBe(b.token)
    expect(a.session_id).not.toBe(b.session_id)
  })

  it("two tabs' sessions release only their own hold", async () => {
    // Bug: a DELETE with no id released every hold this identity had on
    // the slug, so tab A's cleanup stopped tab B's stream too. Simulates
    // two independent sessions and asserts each release() names only its
    // own session_id.
    const deletedSessionIds: string[] = []
    let postCount = 0
    const fetchImpl = fakeFetch(async (input, init) => {
      if (init?.method === 'POST') {
        postCount += 1
        return jsonResponse(liveSessionBody(`sess-${postCount}`))
      }
      deletedSessionIds.push(new URL(String(input)).searchParams.get('session_id')!)
      return new Response(null, { status: 204 })
    })

    const cam = client(fetchImpl as unknown as typeof fetch)
    const tabA = await cam.live('robot1', 'front')
    const tabB = await cam.live('robot1', 'front')

    await tabA.release()
    expect(deletedSessionIds).toEqual(['sess-1'])

    await tabB.release()
    expect(deletedSessionIds).toEqual(['sess-1', 'sess-2'])
  })
})

describe('cameras — no realtime involvement', () => {
  it('createCamerasApi only needs an HttpClient, never a RealtimeChannel or slug-subscriptions', () => {
    // Type-level proof by construction: if this compiles and runs without
    // ever touching a socket, cameras really are REST-only in this SDK.
    const fetchImpl = fakeFetch(async () => jsonResponse({ cameras: [] }))
    expect(() => createCamerasApi(new HttpClient({ baseUrl: 'https://api.fleetless.dev', fetch: fetchImpl as unknown as typeof fetch, credentials: noCredentials }))).not.toThrow()
  })
})

describe('regression guard: FleetlessError instanceof check', () => {
  it('a non-FleetlessError thrown by fetch itself still propagates from snapshot()', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new TypeError('network down')
    })

    await expect(client(fetchImpl as unknown as typeof fetch).snapshot('robot1', 'front')).rejects.toThrow(TypeError)
  })
})
