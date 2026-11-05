// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from 'vitest'
import type { CollectionDefinitionsResponse, CollectionRecord, CollectionRecordHistoryResponse } from '@fleetless/contracts'
import {
  createClient,
  FleetlessError,
  InMemoryTokenStore,
  recordChangedDetails,
  recordReferencedDetails,
  referenceInvalidDetails,
  requiredMissingDetails,
} from '../src/index.js'
import { listen, type LocalApi, type RecordedRequest, type StubReply } from './local-api.js'

// Every test here drives the SDK's default `fetch` against a real `node:http`
// server, like the auth suites: what these calls put on the wire is the whole
// point of the namespace, and a `vi.fn()` standing in for `fetch` would only
// show what the call site meant to send. See test/local-api.ts.

let api: LocalApi | undefined

afterEach(async () => {
  await api?.close()
  api = undefined
})

async function start(reply: (request: RecordedRequest) => StubReply): Promise<LocalApi> {
  api = await listen(reply)
  return api
}

/** A server-key client: no login, the key is the bearer. */
function keyClient(local: LocalApi) {
  return createClient({ apiUrl: local.url, appIdentifier: 'app_x', serverKey: 'flk_abc' })
}

const ROBOT = '4f2c1a90-7b3e-4d51-9c86-0a1b2c3d4e5f'
const RECORD_ID = '0b9a4f0e-5d36-4c44-8b0a-2f6d2b8d7c11'
const NIL = '00000000-0000-0000-0000-000000000000'

function record(overrides: Partial<CollectionRecord> = {}): CollectionRecord {
  return {
    id: RECORD_ID,
    robot_id: ROBOT,
    created_at: '2026-11-05T08:00:00.000Z',
    created_by: { kind: 'app_user', id: '7a1d3a52-0d0e-4f4b-9d57-6a0f5c7f8e21', label: 'ada@example.com' },
    updated_at: '2026-11-05T08:00:00.000Z',
    updated_by: { kind: 'app_user', id: '7a1d3a52-0d0e-4f4b-9d57-6a0f5c7f8e21', label: 'ada@example.com' },
    revision: 1,
    display: 'Wheel swapped',
    values: { text: 'Wheel swapped' },
    ...overrides,
  }
}

describe('collections.definitions', () => {
  it('reads GET /api/client/collections and unwraps `collections`', async () => {
    const body: CollectionDefinitionsResponse = {
      version: 3,
      collections: [
        {
          key: 'logbook',
          label: 'Logbook',
          description: 'What happened to a robot.',
          binding: 'per_robot',
          display: '{{text}}',
          fields: { text: { type: 'text', label: 'Entry' } },
          can: { read: true, create: true, update: 'own', delete: false },
        },
      ],
    }
    const local = await start(() => ({ status: 200, body }))

    await expect(keyClient(local).collections.definitions()).resolves.toEqual(body.collections)
    expect(local.requests).toHaveLength(1)
    expect(local.requests[0]).toMatchObject({ method: 'GET', path: '/api/client/collections' })
    expect([...local.requests[0]!.query.keys()]).toEqual([])
  })

  it('resolves an empty list for an app with nothing readable', async () => {
    const local = await start(() => ({ status: 200, body: { version: null, collections: [] } }))
    await expect(keyClient(local).collections.definitions()).resolves.toEqual([])
  })
})

describe('collections.list', () => {
  it('sends GET /api/client/collections/logbook/records with search, a JSON filter, sort=-created_at,id, limit and cursor, and returns nextCursor/total', async () => {
    const filter = { and: [{ 'location.name': { eq: 'XTD1' } }, { position_m: { gte: 2.5 } }] }
    const first = record()
    const local = await start(() => ({ status: 200, body: { records: [first], next_cursor: 'c2', total: 41 } }))

    const page = await keyClient(local).collections.list('logbook', {
      search: 'quad xtd1',
      filter,
      sort: ['-created_at', 'id'],
      limit: 20,
      cursor: 'c1',
      count: true,
    })

    expect(page).toEqual({ records: [first], nextCursor: 'c2', total: 41 })
    const request = local.requests[0]!
    expect(request.method).toBe('GET')
    expect(request.path).toBe('/api/client/collections/logbook/records')
    expect(request.query.get('search')).toBe('quad xtd1')
    expect(JSON.parse(request.query.get('filter')!)).toEqual(filter)
    expect(request.query.get('sort')).toBe('-created_at,id')
    expect(request.query.get('limit')).toBe('20')
    expect(request.query.get('cursor')).toBe('c1')
    expect(request.query.get('count')).toBe('true')
    expect(request.body).toBe('')
  })

  it('sends no query string for no options, reads the last page as nextCursor null and leaves `total` off when the cloud sent none', async () => {
    const local = await start(() => ({ status: 200, body: { records: [], next_cursor: null } }))

    const page = await keyClient(local).collections.list('logbook')

    expect(page).toEqual({ records: [], nextCursor: null })
    expect('total' in page).toBe(false)
    expect([...local.requests[0]!.query.keys()]).toEqual([])
  })

  it('comma-joins expand, and sends robot and deleted=true when asked for', async () => {
    const local = await start(() => ({ status: 200, body: { records: [], next_cursor: null } }))

    await keyClient(local).collections.list('components', { expand: ['location', 'vendor'], robot: ROBOT, deleted: true })

    const { query } = local.requests[0]!
    expect(query.get('expand')).toBe('location,vendor')
    expect(query.get('robot')).toBe(ROBOT)
    expect(query.get('deleted')).toBe('true')
    expect(query.has('count')).toBe(false)
  })

  it('leaves out an empty sort or expand, and a count or deleted that is false, instead of sending them blank', async () => {
    const local = await start(() => ({ status: 200, body: { records: [], next_cursor: null } }))

    await keyClient(local).collections.list('logbook', { sort: [], expand: [], count: false, deleted: false })

    expect([...local.requests[0]!.query.keys()]).toEqual([])
  })
})

describe('collections.get', () => {
  it('reads one record with GET …/records/:id and sends expand comma-joined', async () => {
    const found = record()
    const local = await start(() => ({ status: 200, body: found }))

    await expect(keyClient(local).collections.get('components', RECORD_ID, { expand: ['location'] })).resolves.toEqual(found)

    const request = local.requests[0]!
    expect(request.method).toBe('GET')
    expect(request.path).toBe(`/api/client/collections/components/records/${RECORD_ID}`)
    expect(request.query.get('expand')).toBe('location')
  })

  it('by robot sends robot= and limit=1, and resolves the one record', async () => {
    const settings = record({ values: { max_linear_speed: 0.6 } })
    const local = await start(() => ({ status: 200, body: { records: [settings], next_cursor: null } }))

    await expect(keyClient(local).collections.get('robot_settings', { robot: ROBOT })).resolves.toEqual(settings)

    const request = local.requests[0]!
    expect(request.path).toBe('/api/client/collections/robot_settings/records')
    expect(request.query.get('robot')).toBe(ROBOT)
    expect(request.query.get('limit')).toBe('1')
  })

  it('by robot rejects not_found when the robot has no record', async () => {
    const local = await start(() => ({ status: 200, body: { records: [], next_cursor: null } }))

    const failure = await keyClient(local).collections.get('robot_settings', { robot: ROBOT }).catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(FleetlessError)
    expect(failure).toMatchObject({ code: 'not_found' })
  })

  it('by robot relays robot_not_attached for a robot the app does not have, instead of calling it not_found', async () => {
    const local = await start(() => ({ status: 400, body: { code: 'robot_not_attached', message: 'The robot is not attached to this app.' } }))

    const failure = await keyClient(local).collections.get('robot_settings', { robot: ROBOT }).catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(FleetlessError)
    expect(failure).toMatchObject({ code: 'robot_not_attached', status: 400 })
    expect(local.requests).toHaveLength(1)
  })

  it('by robot also takes expand', async () => {
    const local = await start(() => ({ status: 200, body: { records: [record()], next_cursor: null } }))

    await keyClient(local).collections.get('robot_settings', { robot: ROBOT }, { expand: ['profile'] })

    expect(local.requests[0]!.query.get('expand')).toBe('profile')
  })

  it('rejects collection_not_found the way the cloud answers it', async () => {
    const local = await start(() => ({ status: 404, body: { code: 'collection_not_found', message: 'No such collection.' } }))

    await expect(keyClient(local).collections.get('nope', RECORD_ID)).rejects.toMatchObject({ code: 'collection_not_found', status: 404 })
  })
})

describe('collections.create', () => {
  it('posts { values, robot_id } and resolves the created record', async () => {
    const created = record()
    const local = await start(() => ({ status: 201, body: created }))

    await expect(keyClient(local).collections.create('logbook', { text: 'Wheel swapped' }, { robot: ROBOT })).resolves.toEqual(created)

    const request = local.requests[0]!
    expect(request.method).toBe('POST')
    expect(request.path).toBe('/api/client/collections/logbook/records')
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.json()).toEqual({ values: { text: 'Wheel swapped' }, robot_id: ROBOT })
  })

  it('sends no robot_id for a global collection', async () => {
    const local = await start(() => ({ status: 201, body: record({ robot_id: null }) }))

    await keyClient(local).collections.create('locations', { name: 'XTD1' })

    expect(local.requests[0]!.json()).toEqual({ values: { name: 'XTD1' } })
  })
})

describe('collections.update', () => {
  it('patches { values, expected_revision } and resolves the updated record', async () => {
    const updated = record({ revision: 8, values: { max_linear_speed: 0.6 } })
    const local = await start(() => ({ status: 200, body: updated }))

    await expect(
      keyClient(local).collections.update('robot_settings', RECORD_ID, { max_linear_speed: 0.6, note: null }, { expectedRevision: 7 }),
    ).resolves.toEqual(updated)

    const request = local.requests[0]!
    expect(request.method).toBe('PATCH')
    expect(request.path).toBe(`/api/client/collections/robot_settings/records/${RECORD_ID}`)
    // `null` is how a field is cleared, so it has to survive serialisation.
    expect(request.json()).toEqual({ values: { max_linear_speed: 0.6, note: null }, expected_revision: 7 })
  })

  it('sends no expected_revision unless asked to', async () => {
    const local = await start(() => ({ status: 200, body: record() }))

    await keyClient(local).collections.update('logbook', RECORD_ID, { text: 'x' })

    expect(local.requests[0]!.json()).toEqual({ values: { text: 'x' } })
  })
})

describe('collections.delete', () => {
  it('resolves void on 204', async () => {
    const local = await start(() => ({ status: 204 }))

    await expect(keyClient(local).collections.delete('logbook', RECORD_ID)).resolves.toBeUndefined()

    const request = local.requests[0]!
    expect(request.method).toBe('DELETE')
    expect(request.path).toBe(`/api/client/collections/logbook/records/${RECORD_ID}`)
    // A bodyless DELETE must not claim a JSON body: the cloud refuses that combination.
    expect(request.headers['content-type']).toBeUndefined()
  })
})

describe('collections.history', () => {
  it('maps beforeSeq to before_seq, and the page back to camelCase', async () => {
    const body: CollectionRecordHistoryResponse = {
      revisions: [
        {
          seq: 41,
          op: 'update',
          at: '2026-11-05T09:00:00.000Z',
          actor: { kind: 'fleetless', id: NIL, label: 'Fleetless' },
          reason: 'schema v5',
          revision: 2,
          changes: { text: { old: 'a', new: 'b' } },
          record: null,
        },
      ],
      next_before_seq: 12,
      purged: {
        before: '2026-01-01T00:00:00.000Z',
        by: { kind: 'developer', id: '7a1d3a52-0d0e-4f4b-9d57-6a0f5c7f8e21', label: 'owner@example.com' },
        at: '2026-11-01T10:00:00.000Z',
      },
    }
    const local = await start(() => ({ status: 200, body }))

    const page = await keyClient(local).collections.history('logbook', RECORD_ID, { limit: 10, beforeSeq: 42 })

    expect(page).toEqual({ revisions: body.revisions, nextBeforeSeq: 12, purged: body.purged })
    const request = local.requests[0]!
    expect(request.path).toBe(`/api/client/collections/logbook/records/${RECORD_ID}/history`)
    expect(request.query.get('limit')).toBe('10')
    expect(request.query.get('before_seq')).toBe('42')
    expect(request.query.has('beforeSeq')).toBe(false)
  })

  it('sends no query string for no options, and passes nextBeforeSeq null and purged null through', async () => {
    const local = await start(() => ({ status: 200, body: { revisions: [], next_before_seq: null, purged: null } }))

    const page = await keyClient(local).collections.history('logbook', RECORD_ID)

    expect(page).toEqual({ revisions: [], nextBeforeSeq: null, purged: null })
    expect([...local.requests[0]!.query.keys()]).toEqual([])
  })
})

describe('collections errors', () => {
  it('a 409 record_changed rejects FleetlessError with code record_changed and details.revision', async () => {
    const local = await start(() => ({ status: 409, body: { code: 'record_changed', message: 'The record changed.', details: { revision: 9 } } }))

    const failure = await keyClient(local)
      .collections.update('robot_settings', RECORD_ID, { max_linear_speed: 1 }, { expectedRevision: 7 })
      .catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(FleetlessError)
    const error = failure as FleetlessError
    expect(error.code).toBe('record_changed')
    expect(error.status).toBe(409)
    expect((error.details as { revision: number }).revision).toBe(9)
    // The exported schema is how a caller reads `details` without guessing.
    expect(recordChangedDetails.parse(error.details)).toEqual({ revision: 9 })
  })

  it('a 400 required_missing exposes details.fields', async () => {
    const local = await start(() => ({ status: 400, body: { code: 'required_missing', message: 'Required fields are empty.', details: { fields: ['text', 'severity'] } } }))

    const failure = await keyClient(local).collections.create('logbook', {}, { robot: ROBOT }).catch((e: unknown) => e)

    expect(failure).toMatchObject({ code: 'required_missing', status: 400 })
    expect(requiredMissingDetails.parse((failure as FleetlessError).details).fields).toEqual(['text', 'severity'])
  })

  it('a 409 record_referenced carries the referencing collections and counts', async () => {
    const details = { references: [{ collection: 'components', count: 3 }] }
    const local = await start(() => ({ status: 409, body: { code: 'record_referenced', message: 'Still referenced.', details } }))

    const failure = await keyClient(local).collections.delete('locations', RECORD_ID).catch((e: unknown) => e)

    expect(failure).toMatchObject({ code: 'record_referenced', status: 409 })
    expect(recordReferencedDetails.parse((failure as FleetlessError).details)).toEqual(details)
  })

  it('a 429 rate_limited write rejects with details.retry_after_ms and is sent once, not retried', async () => {
    const local = await start(() => ({ status: 429, body: { code: 'rate_limited', message: 'Too many writes.', details: { retry_after_ms: 800 } } }))

    const failure = await keyClient(local).collections.create('logbook', { text: 'x' }, { robot: ROBOT }).catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(FleetlessError)
    expect(failure).toMatchObject({ code: 'rate_limited', status: 429, details: { retry_after_ms: 800 } })
    expect(local.requests).toHaveLength(1)
  })

  it('a 400 reference_invalid names the field and why', async () => {
    const details = { field: 'location', reason: 'other_robot' }
    const local = await start(() => ({ status: 400, body: { code: 'reference_invalid', message: 'Bad reference.', details } }))

    const failure = await keyClient(local).collections.create('components', { location: RECORD_ID }, { robot: ROBOT }).catch((e: unknown) => e)

    expect(failure).toMatchObject({ code: 'reference_invalid', status: 400 })
    expect(referenceInvalidDetails.parse((failure as FleetlessError).details)).toEqual(details)
  })
})

describe('collections request safety and credentials', () => {
  it('encodes a collection and a record id shaped like a traversal, instead of sending them as path segments', async () => {
    const local = await start(() => ({ status: 200, body: record() }))
    const { collections } = keyClient(local)

    await collections.get('../../admin', '../records/x')
    await collections.history('../../admin', '../x')

    expect(local.requests.map((r) => r.path)).toEqual([
      '/api/client/collections/..%2F..%2Fadmin/records/..%2Frecords%2Fx',
      '/api/client/collections/..%2F..%2Fadmin/records/..%2Fx/history',
    ])
  })

  it('refuses a collection or a record id of only dots without sending a request, since `..` would climb out of the route', async () => {
    const local = await start(() => ({ status: 200, body: record() }))
    const { collections } = keyClient(local)

    for (const dots of ['.', '..']) {
      const calls = [
        () => collections.list(dots),
        () => collections.create(dots, { text: 'x' }),
        () => collections.get('logbook', dots),
        () => collections.update('logbook', dots, { text: 'x' }),
        () => collections.delete('logbook', dots),
        () => collections.history('logbook', dots),
      ]
      for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'invalid_option' })
    }

    expect(local.requests).toEqual([])
  })

  it('a server-key client sends its Authorization header', async () => {
    const local = await start(() => ({ status: 200, body: { records: [], next_cursor: null } }))

    await keyClient(local).collections.list('logbook')

    expect(local.requests[0]!.headers.authorization).toBe('Bearer flk_abc')
  })

  it('a session client sends the access token it holds', async () => {
    const local = await start(() => ({ status: 200, body: { records: [], next_cursor: null } }))
    const tokenStore = new InMemoryTokenStore()
    tokenStore.save({ access_token: 'at1', refresh_token: 'rt1', expires_in: 900 })
    const client = createClient({ apiUrl: local.url, appIdentifier: 'app_x', tokenStore })

    await client.collections.list('logbook')

    expect(local.requests[0]!.headers.authorization).toBe('Bearer at1')
  })
})
